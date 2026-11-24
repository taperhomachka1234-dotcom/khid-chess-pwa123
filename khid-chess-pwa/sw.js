const SHELL_CACHE = 'khid-shell-v1';
const SHARE_CACHE = 'khid-shares-v1';
const ROOT = new URL('./', self.registration.scope);
const SHARE = new URL('share', ROOT);
const MAX_IMAGE = 25 * 1024 * 1024;
const SHARE_MAX_AGE = 24 * 60 * 60 * 1000;
const FILES = [
  '', 'index.html', 'styles.css', 'app.js', 'vision.js', 'neo-profiles.js', 'position.js',
  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/chess.js', 'vendor/stockfish-18-lite-single.js', 'vendor/stockfish-18-lite-single.wasm'
].map(path => new URL(path, ROOT).href);
const ASSETS = new Set(FILES);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(FILES.map(url => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('khid-shell-') && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function pruneShares(cache) {
  const now = Date.now();
  await Promise.all((await cache.keys()).map(async key => {
    const item = await cache.match(key);
    if (item && now - Number(item.headers.get('X-Created')) > SHARE_MAX_AGE) await cache.delete(key);
  }));
}

async function receiveShare(request) {
  const redirect = new URL('index.html', ROOT);
  try {
    const form = await request.formData();
    const file = form.getAll('image').find(item => item instanceof Blob &&
      (item.type.startsWith('image/') || /\.(png|jpe?g|webp|avif|gif|bmp|hei[cf])$/i.test(item.name || '')));
    if (!file?.size || file.size > MAX_IMAGE) {
      redirect.searchParams.set('share-error', file?.size > MAX_IMAGE ? 'large' : 'missing');
      return Response.redirect(redirect.href, 303);
    }
    const id = self.crypto.randomUUID();
    const key = new URL('incoming/' + id, ROOT);
    const cache = await caches.open(SHARE_CACHE);
    await pruneShares(cache);
    await cache.put(key.href, new Response(file, {
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Created': String(Date.now()) }
    }));
    redirect.searchParams.set('shared', id);
  } catch {
    redirect.searchParams.set('share-error', 'storage');
  }
  return Response.redirect(redirect.href, 303);
}

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  if (!url.href.startsWith(ROOT.href)) return;
  if (request.method === 'POST' && url.pathname === SHARE.pathname) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  const clean = new URL(url.pathname, ROOT).href;
  if (!ASSETS.has(clean)) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    return await cache.match(clean) || fetch(request);
  })());
});
