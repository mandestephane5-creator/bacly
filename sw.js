// Service worker de Bacly Admin : l'app s'ouvre même sans réseau, et reçoit les fichiers « partagés » depuis WhatsApp, Fichiers…
const VERSION = 'bacly-admin-v1';
const COQUILLE = [
  './', './index.html', './config.js', './manifest.webmanifest', './css/app.css', './js/app.js', './js/icones.js',
  './vendor/pdf-lib.min.js', './vendor/instrument-serif.ttf', './vendor/ionicons.ttf',
  './vendor/roboto-latin-400-normal.woff2', './vendor/roboto-latin-500-normal.woff2', './vendor/roboto-latin-700-normal.woff2',
  './icons/icon-192.png', './icons/logo-320.png', './icons/favicon.png',
];
const PARTAGE = 'bacly-admin-partage';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(COQUILLE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((cles) => Promise.all(cles.filter((k) => k !== VERSION && k !== PARTAGE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // fichiers partagés vers l'app (menu « Partager » d'Android)
  if (e.request.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/partage')) {
    e.respondWith((async () => {
      const donnees = await e.request.formData();
      const cache = await caches.open(PARTAGE);
      let i = 0;
      for (const f of donnees.getAll('fichiers')) {
        if (!(f instanceof File)) continue;
        await cache.put(`./partage/${Date.now()}-${i++}`, new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Nom': encodeURIComponent(f.name || 'sujet.pdf') } }));
      }
      return Response.redirect('./?partage=1', 303);
    })());
    return;
  }
  // Supabase et autres sites : jamais en cache
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // fichiers de l'app : réponse du cache tout de suite, mise à jour en arrière-plan
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const enCache = await cache.match(e.request, { ignoreSearch: url.pathname.endsWith('/') || url.pathname.endsWith('index.html') });
    const reseau = fetch(e.request).then((r) => { if (r.ok) cache.put(e.request, r.clone()); return r; }).catch(() => null);
    return enCache || (await reseau) || new Response('Hors connexion', { status: 503 });
  }));
});
