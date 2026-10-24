// Service worker: makes repeat visits instant and lets the planner work offline.
// App files are precached per build and served cache-first, so a page always gets
// files from one build; a deploy changes VERSION, and the page reloads when the new
// worker takes over (main.ts). Images in assets/ are cached on first use.
const VERSION = "53f0dd93cf";
const APP_CACHE = `dijiang-app-${VERSION}`;
/** Precached files and the SHA-256 of the content this build expects (build.mjs). */
const APP_FILES = {
  "./": "32e00ba5a6b401868017ebdd1e3730e45b95496c2b134852c0fa32681b9e1e3e",
  "./index.html": "32e00ba5a6b401868017ebdd1e3730e45b95496c2b134852c0fa32681b9e1e3e",
  "./style.css": "0f47d6e85b71aad138c5dad1ce2a300b0561242b96ab7cadfd9b15ae0792c3fd",
  "./dist/app.js": "e5657f86009630f4896a117f4858c56edb7933b191e3170edcf7425747303664"
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Fetches this build's files and checks each one's hash. During a deploy uploaded in several
 * commits the server may still return another build's file: the install then fails and the
 * browser tries again on a later visit, instead of caching a mix of builds under this VERSION.
 */
async function precache() {
  const cache = await caches.open(APP_CACHE);
  await Promise.all(Object.entries(APP_FILES).map(async ([url, sha]) => {
    // cache: "reload" skips the HTTP cache, which may still hold the previous build
    const res = await fetch(new Request(url, { cache: "reload" }));
    const body = await res.arrayBuffer();
    if (!res.ok || hex(await crypto.subtle.digest("SHA-256", body)) !== sha) throw new Error(`${url} is not from build ${VERSION}`);
    const headers = { "content-type": res.headers.get("content-type") || "" };
    await cache.put(url, new Response(body, { status: 200, headers }));
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(
    () => self.skipWaiting(),
    (e) => caches.delete(APP_CACHE).then(() => Promise.reject(e)),
  ));
});

self.addEventListener("activate", (event) => {
  // caches left by older builds
  const stale = (k) => (k.startsWith("dijiang-app-") && k !== APP_CACHE) || k.startsWith("dijiang-art-");
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(stale).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keep a copy of a good response. */
function store(event, cache, req, res) {
  if (!res.ok || res.type === "opaque") return;
  // a full quota only means it is not cached
  event.waitUntil(cache.put(req, res.clone()).catch(() => undefined));
}

const isAsset = (url) => url.origin === self.location.origin && url.pathname.includes("/assets/");

/** This build's files from the precache; others (the images in assets/) are cached into it on first use. */
async function app(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (isAsset(new URL(req.url))) store(event, cache, req, res);
  return res;
}

/** Images the page loaded before this worker controlled it (the first visit); usually still in the HTTP cache. */
async function keepCopy(event, href) {
  const url = new URL(href, self.location.href);
  if (!isAsset(url)) return;
  const cache = await caches.open(APP_CACHE);
  if (await cache.match(url.href)) return;
  const req = new Request(url.href);
  const res = await fetch(req).catch(() => null);
  if (res) store(event, cache, req, res);
}

self.addEventListener("message", (event) => {
  const { type, urls } = event.data || {};
  if (type !== "cache-art" || !Array.isArray(urls)) return;
  event.waitUntil(Promise.all(urls.slice(0, 300).map((u) => keepCopy(event, String(u)).catch(() => undefined))));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(app(event));
});
