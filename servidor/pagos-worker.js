// ============================================================================
//  Servidor de pagos de The Blu Club (Cloudflare Worker)
// ============================================================================
//  Hace lo que la web sola no puede hacer de forma segura:
//   1. Arma el cobro en Mercado Pago con los precios REALES del catálogo
//      (no con los que manda el navegador de la clienta).
//   2. Reserva el stock en el momento. Si el pago no se completa en 30 minutos,
//      lo devuelve a la tienda solo.
//   3. Cuando Mercado Pago avisa que el pago se aprobó, crea el pedido en Firebase
//      (aparece en Panel → Ventas como "Pagado con Mercado Pago").
//
//  Este archivo NO tiene claves: se puede ver sin problema. Las claves van como
//  "secretos" en Cloudflare (Settings → Variables and Secrets):
//    MP_ACCESS_TOKEN  Access Token de producción de Mercado Pago (empieza con APP_USR-)
//    FIREBASE_SA      el archivo .json de la cuenta de servicio de Firebase, pegado entero
//  Opcional (variable común, no secreta):
//    SITE_URL         dirección de la tienda (por defecto https://blushop.com.ar)
//
//  Además, en Settings → Triggers → Cron Triggers: agregar "*/10 * * * *"
//  (cada 10 minutos revisa los pagos que quedaron sin terminar).
// ============================================================================

const VERSION = '1.0';
const ALLOWED_ORIGINS = ['https://blushop.com.ar', 'https://www.blushop.com.ar', 'https://joaco03.github.io'];
const HOLD_MINUTES = 30;          // cuánto tiempo queda reservado el stock mientras la clienta paga
const MAX_LINES = 20;             // productos distintos por compra
const MAX_QTY = 10;               // unidades de un mismo producto y color
const RATE_MAX = 6, RATE_WINDOW = 10 * 60 * 1000; // compras iniciadas por persona cada 10 minutos

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    try {
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin, env) });
      if (url.pathname === '/webhook') return await handleWebhook(request, url, env);
      if (url.pathname === '/checkout' && request.method === 'POST') return await handleCheckout(request, url, env, ctx, origin);
      if (url.pathname === '/status') return await handleStatus(url, env, origin);
      if (url.pathname === '/health') return await handleHealth(env, origin);
      if (url.pathname === '/') return json({ ok: true, servicio: 'pagos The Blu Club', version: VERSION }, 200, origin, env);
      return json({ ok: false, error: 'no_existe' }, 404, origin, env);
    } catch (e) {
      if (e && e.userError) return json({ ok: false, error: e.code, message: e.message, ...(e.extra || {}) }, e.httpStatus || 400, origin, env);
      console.error('Error del servidor de pagos:', e && e.stack || e);
      return json({ ok: false, error: 'servidor', message: 'Algo falló de nuestro lado. Probá de nuevo en un rato o pedí por WhatsApp.' }, 500, origin, env);
    }
  },
  // Cron: libera el stock de los pagos que no se terminaron.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpired(new Store(env), env));
  }
};

// ---------------------------------------------------------------------------
//  Respuestas
// ---------------------------------------------------------------------------
function allowedOrigin(origin, env) {
  const extra = String((env && env.EXTRA_ORIGINS) || '').split(',').map(s => s.trim()).filter(Boolean);
  return ALLOWED_ORIGINS.includes(origin) || extra.includes(origin);
}
function cors(origin, env) {
  const h = { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (allowedOrigin(origin, env)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}
function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors(origin, env) } });
}
function userError(code, message, extra, httpStatus) {
  const e = new Error(message);
  e.userError = true; e.code = code; e.extra = extra; e.httpStatus = httpStatus;
  return e;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ts = (d) => ({ __ts: (d || new Date()).toISOString() });
const tsMillis = (v) => (v && v.__ts) ? Date.parse(v.__ts) : 0;

// ---------------------------------------------------------------------------
//  Google / Firestore (con la cuenta de servicio, sin librerías)
// ---------------------------------------------------------------------------
function serviceAccount(env) {
  let sa = null;
  try { sa = typeof env.FIREBASE_SA === 'string' ? JSON.parse(env.FIREBASE_SA) : env.FIREBASE_SA; } catch (e) {}
  if (!sa || !sa.client_email || !sa.private_key || !sa.project_id) throw new Error('Falta el secreto FIREBASE_SA (el JSON de la cuenta de servicio) o está incompleto');
  return sa;
}
function b64urlBytes(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64url = (str) => b64urlBytes(new TextEncoder().encode(str));
function pemToDer(pem) {
  const b = atob(String(pem).replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, ''));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u.buffer;
}
let tokenCache = null;
async function googleToken(env) {
  if (tokenCache && tokenCache.exp > Date.now() + 60000) return tokenCache.token;
  const sa = serviceAccount(env);
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + claims));
  const jwt = head + '.' + claims + '.' + b64urlBytes(new Uint8Array(sig));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('Google no dio permiso: ' + (d.error_description || d.error || r.status));
  tokenCache = { token: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

// Valores de Firestore <-> JavaScript
function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: v.length ? { values: v.map(enc) } : {} };
  if (typeof v === 'object') return v.__ts ? { timestampValue: v.__ts } : { mapValue: { fields: encFields(v) } };
  return { nullValue: null };
}
function encFields(o) { const f = {}; Object.keys(o || {}).forEach(k => { if (o[k] !== undefined) f[k] = enc(o[k]); }); return f; }
function dec(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return { __ts: v.timestampValue };
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  if ('referenceValue' in v) return v.referenceValue;
  return null;
}
function decFields(f) { const o = {}; Object.keys(f || {}).forEach(k => { o[k] = dec(f[k]); }); return o; }

class Store {
  constructor(env) {
    this.env = env;
    const sa = serviceAccount(env);
    this.root = `projects/${sa.project_id}/databases/(default)/documents`;
    this.base = 'https://firestore.googleapis.com/v1/' + this.root;
  }
  async call(path, opts) {
    opts = opts || {};
    const token = await googleToken(this.env);
    const r = await fetch(this.base + path, {
      method: opts.method || 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (opts.allow404 && r.status === 404) return null;
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error('Firestore ' + r.status + ': ' + ((d.error && d.error.message) || (Array.isArray(d) && d[0] && d[0].error && d[0].error.message) || ''));
      e.status = r.status; e.fsStatus = (d.error && d.error.status) || '';
      throw e;
    }
    return d;
  }
  name(path) { return this.root + '/' + path; }
  async get(path, tx) {
    const d = await this.call('/' + path + (tx ? '?transaction=' + encodeURIComponent(tx) : ''), { allow404: true });
    return d ? decFields(d.fields || {}) : null;
  }
  async query(collectionId, field, value, limit) {
    const d = await this.call(':runQuery', { method: 'POST', body: { structuredQuery: { from: [{ collectionId }], where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: enc(value) } }, limit: limit || 50 } } });
    return (Array.isArray(d) ? d : []).filter(x => x && x.document).map(x => ({ id: x.document.name.split('/').pop(), data: decFields(x.document.fields || {}) }));
  }
  commit(writes, tx) { return this.call(':commit', { method: 'POST', body: tx ? { writes, transaction: tx } : { writes } }); }
  async rollback(tx) { try { await this.call(':rollback', { method: 'POST', body: { transaction: tx } }); } catch (e) {} }
  // fn(tx) devuelve { writes, result }. Si otro cambio se cruzó, se reintenta.
  async tx(fn) {
    for (let i = 0; i < 5; i++) {
      const begin = await this.call(':beginTransaction', { method: 'POST', body: { options: { readWrite: {} } } });
      const t = begin.transaction;
      let out;
      try { out = await fn(t); } catch (e) { await this.rollback(t); throw e; }
      if (!out || !out.writes || !out.writes.length) { await this.rollback(t); return out ? out.result : undefined; }
      try { await this.commit(out.writes, t); return out.result; }
      catch (e) {
        if (e.status === 409 || e.fsStatus === 'ABORTED') { await sleep(100 * (i + 1) + Math.random() * 100); continue; }
        throw e;
      }
    }
    throw new Error('Firestore ocupado: no se pudo guardar');
  }
  setDoc(path, data, mustNotExist) {
    const w = { update: { name: this.name(path), fields: encFields(data) } };
    if (mustNotExist) w.currentDocument = { exists: false };
    return w;
  }
  patchDoc(path, data) {
    return { update: { name: this.name(path), fields: encFields(data) }, updateMask: { fieldPaths: Object.keys(data).map(k => /^[A-Za-z_][A-Za-z_0-9]*$/.test(k) ? k : '`' + k + '`') } };
  }
}

// ---------------------------------------------------------------------------
//  Catálogo: precios y stock (igual que en la web)
// ---------------------------------------------------------------------------
function stockOf(x) { const n = x && x.stock; return (typeof n === 'number' && isFinite(n)) ? Math.max(0, Math.floor(n)) : null; }
function colorsOf(p) {
  if (!p) return [];
  const bs = stockOf(p);
  const base = { key: p.materialId || 'base', materialId: p.materialId || '', price: +p.price || 0, salePrice: +p.salePrice || 0, stock: bs, out: !!p.outOfStock || bs === 0, vi: -1 };
  const seen = { [base.key]: true };
  const out = [base];
  (Array.isArray(p.variants) ? p.variants : []).forEach((v, i) => {
    if (!v || !v.materialId || seen[v.materialId]) return;
    seen[v.materialId] = true;
    const st = stockOf(v);
    out.push({ key: v.materialId, materialId: v.materialId, price: +v.price || 0, salePrice: +v.salePrice || 0, stock: st, out: !!v.outOfStock || st === 0, vi: i });
  });
  return out;
}
const effPrice = (c) => (c.salePrice > 0 && c.salePrice < c.price) ? c.salePrice : c.price;
function resolveAlias(aliases, id) {
  let a = aliases && aliases[id], n = 0, color = a && a.color;
  while (a && aliases[a.id] && n++ < 6) { a = aliases[a.id]; }
  return a ? { id: a.id, color: color || a.color || '' } : null;
}
// Calcula cada línea con el precio de la tienda y controla el stock. Tira error si algo no se puede comprar.
function priceCart(store, items) {
  const products = Array.isArray(store.products) ? store.products : [];
  const soon = {};
  (store.categories || []).forEach(c => { if (c && c.soon) soon[c.id] = true; });
  const matName = (id) => { const m = (store.materials || []).find(x => x && x.id === id); return m ? m.name : ''; };
  const byKey = {};
  const lines = [];
  for (const it of items) {
    let pid = it.productId, color = it.color || '';
    const al = resolveAlias(store.aliases, pid);
    if (al) { pid = al.id; if (!color || color === 'base') color = al.color; }
    const p = products.find(x => x && x.id === pid);
    if (!p || soon[p.categoryId]) throw userError('no_existe', 'Un producto del carrito ya no está en la tienda. Actualizá la página y revisá el carrito.', { productId: it.productId });
    const cs = colorsOf(p);
    const c = cs.find(x => x.key === color) || cs[0];
    const price = Math.round(effPrice(c));
    if (!(price > 0)) throw userError('sin_precio', `${p.name} no tiene precio cargado. Escribinos por WhatsApp.`, { productId: p.id });
    const k = p.id + '|' + c.key;
    if (byKey[k]) { byKey[k].qty += it.qty; }
    else { byKey[k] = { productId: p.id, name: p.name, color: matName(c.materialId), colorId: c.key, qty: it.qty, price }; lines.push(byKey[k]); }
    if (byKey[k].qty > MAX_QTY) throw userError('cantidad', `Podés comprar hasta ${MAX_QTY} unidades de ${p.name}.`, { productId: p.id });
    if (c.out || (c.stock !== null && byKey[k].qty > c.stock)) {
      const left = c.out ? 0 : c.stock;
      throw userError('sin_stock', left > 0 ? `De ${p.name}${byKey[k].color ? ' (' + byKey[k].color + ')' : ''} quedan ${left} unidad${left === 1 ? '' : 'es'}.` : `${p.name}${byKey[k].color ? ' (' + byKey[k].color + ')' : ''} se agotó.`, { productId: p.id, color: c.key, left });
    }
  }
  return lines;
}
// Suma (sign = +1) o resta (sign = -1) las unidades de las líneas al stock de cada color.
// Solo toca colores que tienen stock cargado.
function applyStock(products, lines, sign, aliases) {
  const list = (products || []).slice();
  for (const l of lines) {
    let pid = l.productId, key = l.colorId || '';
    const al = resolveAlias(aliases, pid);
    if (al) { pid = al.id; if (!key || key === 'base') key = al.color; }
    const i = list.findIndex(p => p && p.id === pid);
    if (i < 0) continue;
    const p = list[i];
    const q = (+l.qty || 0) * sign;
    if (!(Number.isInteger(+l.qty) && +l.qty >= 1 && +l.qty <= 99)) continue;
    const vs = Array.isArray(p.variants) ? p.variants : [];
    const vi = key ? vs.findIndex(v => v && v.materialId === key) : -1;
    if (vi >= 0) {
      if (stockOf(vs[vi]) === null) continue;
      const nv = vs.slice(); nv[vi] = { ...vs[vi], stock: vs[vi].stock + q };
      list[i] = { ...p, variants: nv };
    } else {
      if (key && key !== 'base' && key !== (p.materialId || 'base')) continue;
      if (stockOf(p) === null) continue;
      list[i] = { ...p, stock: p.stock + q };
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
//  Datos que manda la web
// ---------------------------------------------------------------------------
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
function readCustomer(c) {
  c = c || {};
  const name = clip(c.name, 80);
  const phone = clip(c.phone, 30);
  const email = clip(c.email, 120).toLowerCase();
  // La entrega se coordina siempre por WhatsApp después del pago ('coordinar').
  const delivery = ['coordinar', 'retiro', 'parana', 'envio'].includes(c.delivery) ? c.delivery : 'coordinar';
  const address = clip(c.address, 160), city = clip(c.city, 80), zip = clip(c.zip, 12), notes = clip(c.notes, 300);
  if (name.length < 2) throw userError('datos', 'Escribí tu nombre.');
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw userError('datos', 'Escribí un teléfono o WhatsApp válido.');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw userError('datos', 'El email no parece correcto.');
  if ((delivery === 'parana' || delivery === 'envio') && address.length < 4) throw userError('datos', 'Escribí la dirección de entrega.');
  if (delivery === 'envio' && city.length < 2) throw userError('datos', 'Escribí la ciudad y provincia.');
  return { name, phone, email, delivery, address, city, zip, notes };
}
function readItems(items) {
  if (!Array.isArray(items) || !items.length) throw userError('carrito', 'El carrito está vacío.');
  if (items.length > MAX_LINES) throw userError('carrito', `Podés pagar hasta ${MAX_LINES} productos distintos por compra.`);
  return items.map(it => {
    const productId = clip(it && it.productId, 80), color = clip(it && it.color, 60), qty = +(it && it.qty);
    if (!productId || !Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw userError('carrito', 'Hay algo raro en el carrito. Actualizá la página y probá de nuevo.');
    return { productId, color, qty };
  });
}
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > RATE_MAX;
}
function newId() { return 'mp' + crypto.randomUUID().replace(/-/g, '').slice(0, 18); }
function newCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(4));
  let c = '';
  for (let i = 0; i < 4; i++) c += abc[r[i] % abc.length];
  return 'BC-' + c;
}
const validRef = (ref) => typeof ref === 'string' && /^mp[a-f0-9]{18}$/.test(ref);
// Fecha con la hora de Argentina, como le gusta a Mercado Pago (2026-10-27T15:30:00.000-03:00).
function isoAR(ms) { return new Date(ms - 3 * 3600000).toISOString().replace('Z', '-03:00'); }

// ---------------------------------------------------------------------------
//  Mercado Pago
// ---------------------------------------------------------------------------
function mpToken(env) {
  const t = env.MP_ACCESS_TOKEN;
  if (!t || !/^(APP_USR|TEST)-/.test(t)) throw new Error('Falta el secreto MP_ACCESS_TOKEN de Mercado Pago o no es un Access Token');
  return t;
}
async function mp(env, path, opts) {
  opts = opts || {};
  const r = await fetch('https://api.mercadopago.com' + path, {
    method: opts.method || 'GET',
    headers: { Authorization: 'Bearer ' + mpToken(env), 'Content-Type': 'application/json', ...(opts.idem ? { 'X-Idempotency-Key': opts.idem } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error('Mercado Pago ' + r.status + ': ' + (d.message || d.error || '')); e.status = r.status; throw e; }
  return d;
}
async function createPreference(env, o) {
  const body = {
    items: o.lines.map(l => ({ id: (l.productId + (l.colorId ? '-' + l.colorId : '')).slice(0, 250), title: (l.name + (l.color ? ' · ' + l.color : '')).slice(0, 250), quantity: l.qty, unit_price: l.price, currency_id: 'ARS' })),
    external_reference: o.ref,
    payer: { name: o.customer.name, ...(o.customer.email ? { email: o.customer.email } : {}) },
    back_urls: { success: o.site + '/?mp=ok&ref=' + o.ref, pending: o.site + '/?mp=pendiente&ref=' + o.ref, failure: o.site + '/?mp=error&ref=' + o.ref },
    auto_return: 'approved',
    notification_url: o.self + '/webhook',
    statement_descriptor: 'THEBLUCLUB',
    binary_mode: true,
    expires: true,
    expiration_date_from: isoAR(Date.now() - 60000),
    expiration_date_to: isoAR(o.expires),
    // Efectivo (Rapipago, Pago Fácil) no: tarda días en acreditarse.
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
    metadata: { code: o.code }
  };
  const d = await mp(env, '/checkout/preferences', { method: 'POST', body, idem: o.ref });
  const test = /^TEST-/.test(env.MP_ACCESS_TOKEN);
  const url = (test && d.sandbox_init_point) || d.init_point;
  if (!d.id || !url) throw new Error('Mercado Pago no devolvió el link de pago');
  return { id: d.id, url };
}
async function searchPayments(env, ref) {
  const d = await mp(env, '/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(ref));
  return Array.isArray(d.results) ? d.results : [];
}
function payInfo(pay) {
  return {
    provider: 'mercadopago', id: String(pay.id || ''), status: String(pay.status || ''), detail: String(pay.status_detail || ''),
    amount: +pay.transaction_amount || 0, method: String(pay.payment_method_id || ''), type: String(pay.payment_type_id || ''),
    installments: +pay.installments || 1, updatedAt: ts()
  };
}

// ---------------------------------------------------------------------------
//  /checkout: la clienta toca "Pagar con Mercado Pago"
// ---------------------------------------------------------------------------
async function handleCheckout(request, url, env, ctx, origin) {
  if (origin && !allowedOrigin(origin, env)) throw userError('origen', 'Este pago solo se puede iniciar desde la tienda.', null, 403);
  const raw = await request.text();
  if (raw.length > 20000) throw userError('carrito', 'El pedido es demasiado grande.');
  let body;
  try { body = JSON.parse(raw); } catch (e) { throw userError('carrito', 'No se entendió el pedido.'); }
  const items = readItems(body.items);
  const customer = readCustomer(body.customer);
  const ip = request.headers.get('CF-Connecting-IP') || 'x';
  if (rateLimited(ip)) throw userError('espera', 'Hiciste varios intentos seguidos. Esperá unos minutos y probá de nuevo.', null, 429);

  const st = new Store(env);
  const ref = newId(), code = newCode();
  const now = Date.now(), expires = now + HOLD_MINUTES * 60000;
  const site = String(env.SITE_URL || 'https://blushop.com.ar').replace(/\/+$/, '');

  // 1) Precios reales + reserva de stock, todo junto (si dos personas compran la última unidad, una sola la consigue).
  const priced = await st.tx(async (t) => {
    const store = await st.get('store/main', t);
    if (!store || !Array.isArray(store.products)) throw new Error('No se encontró el catálogo');
    const settings = store.settings || {};
    if (settings.maintenance && settings.maintenance.on) throw userError('pausa', 'La tienda está en pausa en este momento. Escribinos por WhatsApp.');
    if (!(settings.payments && settings.payments.mp)) throw userError('apagado', 'El pago con Mercado Pago no está activo en este momento. Podés pedir por WhatsApp.');
    const lines = priceCart(store, items);
    const total = lines.reduce((a, l) => a + l.price * l.qty, 0);
    const products = applyStock(store.products, lines, -1, store.aliases);
    const checkout = { code, status: 'esperando', items: lines.map(l => ({ ...l, state: 'confirmado', held: true })), total, customer, createdAt: ts(new Date(now)), expiresAt: ts(new Date(expires)) };
    return { writes: [st.patchDoc('store/main', { products }), st.setDoc('checkouts/' + ref, checkout, true)], result: { lines, total } };
  });

  // 2) Cobro en Mercado Pago. Si falla, el stock vuelve enseguida.
  let pref;
  try {
    pref = await createPreference(env, { ref, code, lines: priced.lines, customer, site, self: url.origin, expires });
  } catch (e) {
    console.error('No se pudo crear el cobro en Mercado Pago:', e && e.message);
    await releaseCheckout(st, ref, 'error').catch(() => {});
    throw userError('mercadopago', 'Mercado Pago no respondió. Probá de nuevo en un rato o pedí por WhatsApp.', null, 502);
  }
  await st.commit([st.patchDoc('checkouts/' + ref, { preferenceId: pref.id, payUrl: pref.url })]);
  ctx.waitUntil(cleanupExpired(st, env).catch(() => {}));
  return json({ ok: true, ref, code, total: priced.total, url: pref.url, expiresAt: new Date(expires).toISOString() }, 200, origin, env);
}

// ---------------------------------------------------------------------------
//  Pago aprobado (o devuelto): crea o actualiza el pedido
// ---------------------------------------------------------------------------
async function processPayment(st, env, pay) {
  const ref = pay && pay.external_reference;
  if (!validRef(ref)) return 'ajeno';
  const info = payInfo(pay);
  if (info.status === 'approved') {
    return st.tx(async (t) => {
      const co = await st.get('checkouts/' + ref, t);
      if (!co) return { writes: [], result: 'no_existe' };
      if (co.status === 'pagado') return { writes: [], result: 'ya_estaba' };
      const writes = [];
      let held = true;
      if (co.status !== 'esperando') {
        // El stock ya se había devuelto (pagó justo al vencer): se vuelve a tomar si alcanza.
        const store = await st.get('store/main', t);
        try {
          priceCart(store, co.items.map(l => ({ productId: l.productId, color: l.colorId, qty: l.qty })));
          writes.push(st.patchDoc('store/main', { products: applyStock(store.products, co.items, -1, store.aliases) }));
        } catch (e) { held = false; }
      }
      const paidAt = ts();
      const order = {
        code: co.code, status: 'vendido', source: 'mercadopago',
        items: (co.items || []).map(l => ({ productId: l.productId, name: l.name, color: l.color, colorId: l.colorId, qty: l.qty, price: l.price, state: 'confirmado', held })),
        total: co.total, customer: co.customer || null, createdAt: paidAt, stockApplied: held,
        payment: { ...info, amountOk: Math.abs(info.amount - (+co.total || 0)) < 1 }
      };
      if (!held) order.stockProblem = true;
      writes.push(st.setDoc('orders/' + ref, order, true));
      writes.push(st.patchDoc('checkouts/' + ref, { status: 'pagado', paymentId: info.id, paidAt }));
      return { writes, result: 'pagado' };
    });
  }
  // Devoluciones y contracargos: se anota en el pedido (el stock lo decide Belu desde el panel).
  const order = await st.get('orders/' + ref);
  if (order) {
    if (order.payment && order.payment.status === 'approved' && ['refunded', 'charged_back', 'cancelled'].includes(info.status)) {
      await st.commit([st.patchDoc('orders/' + ref, { payment: { ...order.payment, ...info } })]);
      return 'actualizado';
    }
    return 'sin_cambios';
  }
  const co = await st.get('checkouts/' + ref);
  if (co && co.status === 'esperando') await st.commit([st.patchDoc('checkouts/' + ref, { lastPayment: info.status })]);
  return 'anotado';
}

// ---------------------------------------------------------------------------
//  /webhook: aviso de Mercado Pago
// ---------------------------------------------------------------------------
async function handleWebhook(request, url, env) {
  let body = {};
  if (request.method === 'POST') { try { body = JSON.parse((await request.text()).slice(0, 20000) || '{}'); } catch (e) {} }
  const type = body.type || url.searchParams.get('type') || url.searchParams.get('topic') || '';
  const id = String((body.data && body.data.id) || url.searchParams.get('data.id') || (type === 'payment' ? url.searchParams.get('id') : '') || '');
  if (type !== 'payment' || !/^\d{3,25}$/.test(id)) return new Response('ok');
  // No se confía en lo que dice el aviso: se le pregunta a Mercado Pago con la clave propia.
  let pay;
  try { pay = await mp(env, '/v1/payments/' + id); }
  catch (e) { if (e.status === 404) return new Response('ok'); throw e; }
  await processPayment(new Store(env), env, pay);
  return new Response('ok');
}

// ---------------------------------------------------------------------------
//  /status: la clienta vuelve de Mercado Pago
// ---------------------------------------------------------------------------
async function handleStatus(url, env, origin) {
  const ref = url.searchParams.get('ref') || '';
  if (!validRef(ref)) return json({ ok: false, status: 'no_existe' }, 404, origin, env);
  const st = new Store(env);
  let co = await st.get('checkouts/' + ref);
  if (!co) return json({ ok: false, status: 'no_existe' }, 404, origin, env);
  let last = co.lastPayment || '';
  if (co.status === 'esperando' || co.status === 'vencido') {
    // Por si el aviso de Mercado Pago todavía no llegó.
    try {
      const pays = await searchPayments(env, ref);
      const ok = pays.find(p => p.status === 'approved');
      if (ok) { await processPayment(st, env, ok); co = await st.get('checkouts/' + ref); }
      else if (pays[0]) last = pays[0].status;
    } catch (e) { console.warn('No se pudo consultar Mercado Pago:', e.message); }
  }
  const open = co.status === 'esperando' && Date.now() < tsMillis(co.expiresAt);
  return json({
    ok: true, status: co.status, code: co.code, total: co.total, last,
    expiresAt: co.expiresAt ? co.expiresAt.__ts : '', ...(open && co.payUrl ? { url: co.payUrl } : {})
  }, 200, origin, env);
}

// ---------------------------------------------------------------------------
//  /health: "Probar conexión" del panel
// ---------------------------------------------------------------------------
async function handleHealth(env, origin) {
  const out = { ok: false, version: VERSION, mercadopago: false, firebase: false, activo: false };
  try { await mp(env, '/users/me'); out.mercadopago = true; } catch (e) { out.mercadopagoError = String(e.message || e).slice(0, 140); }
  try { const s = await new Store(env).get('store/main'); out.firebase = !!s; out.activo = !!(s && s.settings && s.settings.payments && s.settings.payments.mp); }
  catch (e) { out.firebaseError = String(e.message || e).slice(0, 140); }
  out.ok = out.mercadopago && out.firebase;
  return json(out, 200, origin, env);
}

// ---------------------------------------------------------------------------
//  Pagos que no se terminaron: el stock vuelve a la tienda
// ---------------------------------------------------------------------------
async function releaseCheckout(st, ref, status) {
  return st.tx(async (t) => {
    const co = await st.get('checkouts/' + ref, t);
    if (!co || co.status !== 'esperando') return { writes: [], result: false };
    const store = await st.get('store/main', t);
    const products = applyStock(store.products, co.items || [], +1, store.aliases);
    return { writes: [st.patchDoc('store/main', { products }), st.patchDoc('checkouts/' + ref, { status, releasedAt: ts() })], result: true };
  });
}
async function cleanupExpired(st, env) {
  const list = await st.query('checkouts', 'status', 'esperando', 40);
  const now = Date.now();
  let released = 0;
  for (const c of list) {
    const exp = tsMillis(c.data.expiresAt);
    if (!exp || now < exp + 3 * 60000) continue; // unos minutos de margen después del vencimiento
    try {
      const pays = await searchPayments(env, c.id);
      const ok = pays.find(p => p.status === 'approved');
      if (ok) { await processPayment(st, env, ok); continue; }
      if (pays.some(p => p.status === 'in_process' || p.status === 'pending') && now < exp + 2 * 86400000) continue;
      if (await releaseCheckout(st, c.id, 'vencido')) released++;
    } catch (e) { console.warn('No se pudo revisar el pago', c.id, e.message); }
  }
  return released;
}

