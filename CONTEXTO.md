# The Blu Club — contexto del proyecto

Sitio web de joyería (anillos, collares, aros, pulseras) de acero inoxidable.
Negocio real en Paraná, Entre Ríos. Dueña: Belén.

## Archivos

```
index.html        ← el sitio entero (Design Component: template + lógica en un solo archivo)
support.js        ← runtime que hace funcionar el archivo. No editar.
assets/
  logo-bc-bordo.svg     ← monograma BC bordó (header con fondo blanco)
  logo-bc-clarito.svg   ← monograma BC claro (header sobre la portada, y footer)
  logo-bc-negro.svg     ← monograma BC negro (para impresos o fondos claros)
  logo-bc-cuadrado.svg  ← monograma sobre fondo crema, cuadrado (favicon)
  logo-bc-cuadrado.png  ← lo mismo en PNG 1024px (vista previa al compartir el link, foto de perfil)
  favicon-180.png       ← ícono de pestaña y acceso directo en iPhone
  logo-bc-bordo.png / logo-bc-clarito.png ← PNG grandes, para redes o impresión
  logo-bordo.png, logo-clarito.png, logo-cuadrado.png ← logo viejo "the Blu Club", ya no se usa
```

Se abre haciendo doble clic en `index.html` para probar el diseño, pero **el catálogo real ahora vive en Firebase**, no en el archivo — ver más abajo.

## Backend: Firebase (proyecto "BluShop")

El sitio se conecta a un proyecto de Firebase real (no es un mock). Se usan tres productos, todos del plan gratuito Spark:

- **Firestore** (base de datos): guarda productos, categorías y materiales en un único documento `store/main`, compartido por todos los visitantes — así lo que carga Belén se ve al instante desde cualquier celular, en tiempo real (vía `onSnapshot`).
- **Authentication**: maneja el login de verdad (correo/contraseña). Reemplaza por completo el sistema casero que se armó antes (ya no existe ningún hash propio en el código — Google se encarga de guardar las contraseñas de forma segura).
- **Cloudinary** (no es un producto de Firebase): guarda las fotos que la dueña sube desde el panel de admin. Se usa en vez de Firebase Storage porque, desde febrero de 2026, Storage exige tener una tarjeta de banco vinculada (plan Blaze) — Cloudinary no pide tarjeta y tiene un plan gratis de sobra para esta tienda (25GB/mes entre almacenamiento y tráfico).

Las claves (`firebaseConfig` en `index.html`, líneas cerca del inicio del `<script>`) **no son secretas** — Firebase está diseñado para que vayan en el código público del sitio. La seguridad real está en las **reglas de seguridad** configuradas en la consola de Firebase (Firestore → Reglas, y Storage → Reglas):

```
// Firestore
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /store/main {
      allow read: if true;
      allow write: if request.auth != null && request.auth.token.email == 'belengrimaldidb1@gmail.com';
    }
  }
}
```

```
// Storage — SIN USAR. Ver más abajo por qué se pasó a Cloudinary en vez de Firebase Storage.
```

Con esto: cualquiera puede *leer* el catálogo (para que el sitio funcione para las clientas), pero sólo la cuenta de Belén puede *escribir* — reforzado del lado del servidor, no sólo en el código del navegador.

### Por qué las fotos van a Cloudinary y no a Firebase Storage
Desde el 3 de febrero de 2026, Google exige tener una tarjeta de banco vinculada (plan de pago por uso "Blaze") para usar Firebase Storage, aunque el uso real sea $0. Belén no tiene una tarjeta de banco (sólo prepagas, que Google no acepta), así que las fotos de producto se suben a **Cloudinary** en cambio — un servicio aparte, gratis hasta 25GB/mes, sin pedir tarjeta nunca.

Configuración necesaria (`CLOUDINARY_CLOUD_NAME` y `CLOUDINARY_UPLOAD_PRESET`, constantes cerca del inicio del `<script>` en `index.html`):
1. Crear cuenta gratis en cloudinary.com (sin tarjeta).
2. Copiar el "Cloud name" del panel principal.
3. Ir a Configuración → Upload → Upload presets → crear uno nuevo con **Signing Mode: Unsigned**, carpeta `products`, y (recomendado) restringir formato a jpg/png/webp y tamaño máximo a unos 5MB.
4. Pegar el cloud name y el nombre del preset en las constantes del código.

⚠️ Al ser una subida "unsigned" (sin login de servidor), cualquiera que mire el código fuente del sitio técnicamente podría mandar archivos directo a ese preset de Cloudinary, sin pasar por el panel de admin. Las restricciones del preset (tamaño, formato, carpeta) limitan el daño posible, y Cloudinary tiene protecciones propias contra abuso. Para una tienda de este tamaño el riesgo es bajo, pero si en algún momento esto crece mucho, ahí sí conviene un backend propio que valide antes de subir.

## Acceso de administradora

Se entra por el ícono de persona, arriba a la derecha, igual que cualquier clienta — con la opción "Crear cuenta" la primera vez.

- Email: `belengrimaldidb1@gmail.com`
- Contraseña: la elige y la guarda Belén. No está escrita en ningún archivo del repo ni del código — vive únicamente en Firebase Authentication.

No existe ninguna lista especial de "admins": el sitio simplemente compara el email de la sesión activa contra `Component.ADMIN_EMAIL` (constante en `index.html`). Si coincide, aparece "Administrar tienda". Cualquier otro email que se registre entra como clienta normal. Para cambiar quién es la admin, hay que cambiar esa constante Y loguearse con ese email.

La primera vez que Belén entra con su cuenta admin, el sitio detecta que el catálogo compartido todavía no existe en Firestore y lo crea automáticamente con los productos por defecto.

## Qué puede hacer cada uno

**Visitante / clienta**
- Portada con carrusel automático de 3 fotos (rota cada 7s, con puntos para cambiar a mano)
- Banda de garantías: waterproof, acero inoxidable, hipoalergénico, uso diario
- Grilla de categorías que filtra al hacer clic
- Sección de destacados
- Sección Sale (fondo negro) con los productos rebajados
- Bloque editorial, galería de Instagram y preguntas frecuentes desplegables
- Menú lateral (3 rayitas): todos los productos, Sale, categorías, FAQ, cuenta
- Logo centrado = volver al inicio
- Página de productos: filtro por categoría (incluye Sale), por material, orden por precio o destacados, botón "Agregar" rápido
- Página de producto: foto grande, precio (tachado + rebajado si está en oferta), descripción, cantidad, agregar al carrito, consultar por WhatsApp, datos de envío/cambios, relacionados
- Carrito lateral: sumar/restar/quitar, subtotal, botón que arma el pedido completo en WhatsApp
- Registro e inicio de sesión de clientas (Firebase Authentication)
- Etiquetas de "Agotado", "Destacado" y porcentaje de descuento

**Dueña (con su cuenta admin)**
- Aparece "Administrar tienda" en el menú lateral y en su cuenta; nadie más lo ve
- Agregar producto: nombre, precio, precio de oferta (opcional), categoría, material, descripción, foto (botón "Subir foto", sube a Firebase Storage)
- Editar y eliminar productos
- Marcar/desmarcar destacado o agotado con un clic
- Crear y eliminar categorías nuevas (ej. tobilleras) sin tocar código
- Crear y eliminar materiales nuevos (ej. acero rosé)
- Protección: no deja borrar una categoría o material que tenga productos asignados
- Validación: el precio de oferta tiene que ser menor al normal
- Todos los cambios se guardan en Firestore y los ven todas las clientas al instante, desde cualquier dispositivo

**Panel de ajustes (Tweaks)** — props del componente
- `whatsappNumber` — número al que llegan los pedidos (por ahora `5493434000000`, hay que poner el real)
- `instagramHandle` — usuario de Instagram (por ahora `theblu.club`)
- `showInstagramSection` — mostrar/ocultar la galería

## Cómo funciona la oferta

Cada producto tiene `price` y `salePrice`. Si `salePrice` existe y es menor a `price`, el producto se considera en oferta: entra en la sección Sale, en el filtro Sale, muestra el precio viejo tachado y una etiqueta con el % calculado. El carrito y el mensaje de WhatsApp usan siempre el precio con descuento.
Métodos: `onSale(p)` y `effPrice(p)`.

## Fotos y videos de productos

Cada producto tiene una lista `media`: `[{ url, type: 'image' | 'video' }]`. La primera es la **principal** (la que se ve en el catálogo, destacados, Sale y carrito). El campo `image` se sigue guardando con la foto principal, por compatibilidad con productos viejos. Si un producto no tiene `media`, se usa `image` (función `productMedia(p)`).

En el panel de admin se pueden elegir varios archivos a la vez (fotos y videos). Se suben de a uno a Cloudinary (carpeta `products`), se ven como miniaturas, y cada una tiene "Hacer principal" y "Quitar". En la página del producto se ve la foto o el video grande, con las miniaturas abajo para cambiar.

**Nunca se usa la URL original de Cloudinary en el sitio.** Se le agregan transformaciones:
- Fotos: `f_auto,q_auto,c_limit,w_…` (función `cldImage`). Convierte cada foto al formato que entienda cada navegador. Esto arregla las fotos HEIC de iPhone, que se veían en el celular pero no en Chrome/Edge de la compu.
- Videos: `q_auto,vc_auto,c_limit,w_1080` con extensión `.mp4` (función `cldVideo`), así un `.mov` de iPhone se reproduce en cualquier navegador.
- Miniatura de video: primer fotograma como `.jpg` (función `cldPoster`).

Límites del plan gratis de Cloudinary: fotos hasta 10 MB (si pesa más, el sitio la achica sola antes de subirla) y videos hasta 100 MB. El preset `BluShop_product` tiene que permitir formatos de video (mp4, mov) o no tener restricción de formatos.

Los productos de ejemplo usan placeholders de Pexels (función `PX(id, ancho)`).

## Navegación, carrito y animaciones

- **Direcciones por pantalla:** `#/` (inicio), `#/productos`, `#/productos/<categoría>` (o `sale`), `#/producto/<id>`, `#/admin`. El botón "Atrás" del navegador funciona, vuelve a la misma altura de la página, y cada producto tiene su link para compartir. Todo pasa por `navigate()` y `applyRoute()`.
- **Carrito:** se guarda en el navegador de cada clienta (`localStorage`, clave `blublub_cart_v1`), así no se pierde al recargar. Al agregar un producto, la foto vuela hasta el ícono del carrito (`flyToCart`) y la burbuja con la cantidad rebota; el carrito no se abre solo.
- **Tarjetas:** con el mouse encima se van pasando las fotos y videos del producto (1,9 s por foto, 4,5 s por video, con fundido). En celulares no, porque no hay "mouse encima". El botón "Agregar" no aparece en productos agotados.
- **Página de producto:** flechas, flechas del teclado y deslizar con el dedo para pasar las fotos. La foto principal se achica en pantallas bajas para que las miniaturas se vean sin bajar.
- **Carga:** mientras llegan los datos de Firebase se muestran cuadros de carga en vez de los productos de ejemplo. Si un link apunta a un producto que ya no existe, aparece un aviso con botón al catálogo.
- **Accesibilidad:** contorno visible al navegar con teclado y animaciones reducidas si la persona lo pidió en su sistema.
- **Arreglo importante:** `migrate()` ya no vuelve a agregar productos o categorías de ejemplo que la dueña borró (antes reaparecían al recargar).

## Estilo visual

Inspirado en caitlynminimalist.com: minimalista, editorial, **todo recto — cero esquinas redondeadas**.

- Títulos: Cormorant Garamond (serif, peso 300)
- Texto e interfaz: Jost (sans, 300/400/500)
- Mayúsculas chicas con mucho espaciado (`letter-spacing: 0.2em`) para etiquetas y botones
- Negro `#1C1A19` · Bordó `#7C2620` · Rojo oferta `#A6322A` · Beige `#F6F1EC` · Dorado `#C7A98C`
- Header transparente sobre el hero, se vuelve blanco al scrollear (estado `scrolled`)
- El logo cambia entre claro y oscuro según eso
- Logo: monograma "BC" vectorizado (color `#5F291E`, sacado de la imagen original). En el footer va el monograma con "The Blu Club" escrito abajo. Se vectorizó desde una imagen de 1024px: sirve para web, stickers y tarjetas; para impresiones muy grandes conviene redibujarlo.

## Pendientes / decisiones tomadas

- **Mercado Pago**: pendiente. Requiere un endpoint de servidor propio (no sólo Firestore) para que la clave secreta de la cuenta de Mercado Pago no viva en el navegador. Decisión: arrancar con WhatsApp y migrar cuando el volumen lo justifique.
- **Mercado Libre**: pendiente, más complejo (sincronizar publicaciones vía su API). Solo si ya vende fuerte ahí.
- El número de WhatsApp y el Instagram son de prueba, hay que poner los reales.
- Envíos: 1 a 3 días hábiles **dentro de Paraná**.
- Cambios: 30 días.
- Moneda: pesos argentinos.
- **SEO / metadata**: resuelto — `index.html` tiene `<title>`, meta description, favicon (`logo-cuadrado.png`) y etiquetas Open Graph. Cuando tengan el dominio definitivo, conviene cambiar las URLs relativas de `og:image` por la URL absoluta.
- **Repo público en GitHub**: `index.html`, `support.js` y `assets/` pueden ser públicos sin problema — no hay ninguna clave secreta ni contraseña en el código. Este archivo (`CONTEXTO.md`) sigue afuera del repo (ver `.gitignore`) porque tiene notas internas del negocio, no porque tenga datos sensibles.
- **Plan gratuito de Firebase (Spark)**: alcanza de sobra para el volumen de esta tienda. Si en algún momento crece mucho el tráfico, hay que revisar los límites de lecturas/escrituras de Firestore y el almacenamiento de Storage.

## Notas técnicas

Es un Design Component: `<x-dc>` con el template, y abajo un `<script>` con `class Component extends DCLogic`. El template usa `{{ }}` solo para valores (nada de expresiones), `<sc-for>` para listas y `<sc-if>` para condicionales. Todos los estilos son inline — no hay hojas de estilo ni clases CSS. La lógica va en `renderVals()`, que devuelve todo lo que el template consume por nombre.

Los SDK de Firebase se cargan a mano con una función `loadScript()` al principio del `<script>` (en vez de tags `<script>` dentro de `<helmet>`), para garantizar que `firebase-app` termine de cargar antes que los módulos que dependen de él (Firestore, Auth, Storage). La promesa `firebaseReady` se espera antes de cualquier operación que toque Firebase.
