// 오프라인 동작용 서비스 워커
// index.html을 고친 뒤 다시 올릴 때는 아래 VERSION 숫자를 올려 주세요.
const VERSION = 'v34';
const CACHE = 'checkin-desk-' + VERSION;
const SHELL = ['./', './index.html', './cert.html', './qr.js', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 페이지: 인터넷이 되면 최신본, 안 되면 저장본
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const r = await fetch(req);
        if (r.ok) {
          const c = await caches.open(CACHE);
          const page = url.pathname.endsWith('cert.html') ? './cert.html' : './index.html';
          c.put(page, r.clone());
        }
        return r;
      } catch (err) {
        if (url.pathname.endsWith('cert.html')) return caches.match('./cert.html');
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // 아이콘 등: 저장본 우선
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      const hit = await caches.match(req.url);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) (await caches.open(CACHE)).put(req.url, r.clone());
      return r;
    })());
  }
});
