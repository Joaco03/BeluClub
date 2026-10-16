// Service worker de The Blu Club.
// No guarda copias de la página: así siempre se ve la última versión publicada.
// Sirve para que la tienda se pueda instalar como app (y, más adelante, para las notificaciones).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
