// 오프라인 동작용 서비스 워커
// index.html을 고친 뒤 다시 올릴 때는 아래 VERSION 숫자를 올려 주세요.
const VERSION = 'v3';
const CACHE = 'checkin-desk-' + VERSION;
const JSQR = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await c.addAll(SHELL);
    try {                                   // QR 인식 모듈도 미리 받아둠 (아이폰 오프라인 스캔용)
      const r = await fetch(JSQR, { mode: 'cors' });
      if (r.ok) await c.put(JSQR, r);
    } catch (err) {}
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
        const c = await caches.open(CACHE);
        c.put('./index.html', r.clone());
        return r;
      } catch (err) {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // 아이콘·모듈 등: 저장본 우선
  if (url.origin === location.origin || req.url === JSQR) {
    e.respondWith((async () => {
      const hit = await caches.match(req.url);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok) (await caches.open(CACHE)).put(req.url, r.clone());
      return r;
    })());
  }
});
