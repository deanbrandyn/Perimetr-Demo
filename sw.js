self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open('perimetr-mapbox-demo-v14').then((cache) => cache.addAll([
      './','./index.html','./styles.css','./app.js','./manifest.webmanifest',
      './assets/logo-192.png','./assets/logo-512.png','./assets/favicon.png'
    ])).catch(()=>{})
  );
});
self.addEventListener('fetch', (event) => {
  event.respondWith(caches.match(event.request).then((resp) => resp || fetch(event.request)));
});
