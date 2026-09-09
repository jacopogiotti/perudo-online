/**
 * sw.js — service worker della PWA.
 *
 * Strategia NETWORK-FIRST: con rete si scarica sempre la versione fresca dal
 * server (i deploy arrivano subito a tutti) e la copia viene salvata in cache;
 * la cache si usa SOLO quando la rete manca. Il traffico realtime di Socket.IO
 * non viene mai intercettato.
 */
'use strict';

const CACHE = 'perudo-cache-v2';
const CORE = [
  '/',
  '/index.html',
  '/styles.css',
  '/client.js',
  '/local.js',
  '/i18n.js',
  '/lib/engine.js',
  '/lib/bots.js',
  '/socket.io/socket.io.js',
  '/manifest.webmanifest',
  '/icons/icon-192-v2.png',
  '/icons/icon-512-v2.png',
  '/icons/apple-touch-icon-v2.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Realtime Socket.IO (polling/handshake): mai dalla cache, mai intercettato.
  if (url.pathname.startsWith('/socket.io/') && url.search) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      })
  );
});
