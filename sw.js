// Service worker: makes repeat visits instant and lets the planner work offline.
// App files are precached per build and served cache-first, so a page always gets
// files from one build; a deploy changes VERSION, and the new worker takes over for
// the next visit. Remote art: cache-first, refreshed in the background after a week.
const VERSION = "798d76c2ca";
const APP_CACHE = `dijiang-app-${VERSION}`;
// v1 held opaque (no-cors) responses, which a CORS image request cannot use
const ART_CACHE = "dijiang-art-v2";
/** Precached files and the SHA-256 of the content this build expects (build.mjs). */
const APP_FILES = {
  "./": "27b506a44f636333fa4585f3efa5bae31c39197bd970ac00b47ecfbf4dd6cf37",
  "./index.html": "27b506a44f636333fa4585f3efa5bae31c39197bd970ac00b47ecfbf4dd6cf37",
  "./style.css": "0b269649db1ab7e13597758fd6169dbfb33e414d053cb5d56a19b7284ae8d9c0",
  "./dist/app.js": "269ac331103408956a1591d74b5f5788732440ac07c9379d675723cd090d2373"
};
const ART_MAX_AGE = 7 * 24 * 3600 * 1000;
const STAMP = "x-sw-cached-at";

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
  const stale = (k) => (k.startsWith("dijiang-app-") && k !== APP_CACHE) || (k.startsWith("dijiang-art-") && k !== ART_CACHE);
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter(stale).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keep a copy of a good response (never an opaque one: Chrome counts each as megabytes of quota). */
function store(event, cache, req, res, stamp) {
  if (!res.ok || res.type === "opaque") return;
  let copy = res.clone();
  if (stamp) {
    const headers = new Headers(copy.headers);
    headers.set(STAMP, String(Date.now()));
    copy = new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers });
  }
  // a full quota only means it is not cached
  event.waitUntil(cache.put(req, copy).catch(() => undefined));
}

const isArt = (url) => url.hostname === "raw.githubusercontent.com" && url.pathname.endsWith(".png");
const isThumb = (url) => url.origin === self.location.origin && url.pathname.includes("/assets/");

async function art(event) {
  const req = event.request;
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(req);
  const refresh = () => fetch(req).then((res) => {
    store(event, cache, req, res, true);
    return res;
  });
  if (!hit) return refresh();
  if (Date.now() - Number(hit.headers.get(STAMP) || 0) > ART_MAX_AGE) event.waitUntil(refresh().catch(() => undefined));
  return hit;
}

/** This build's files from the precache; others (the shipped thumbnails) are cached into it on first use. */
async function app(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (isThumb(new URL(req.url))) store(event, cache, req, res, false);
  return res;
}

/** Art the page loaded before this worker controlled it (the first visit); usually still in the HTTP cache. */
async function keepCopy(event, href) {
  const url = new URL(href, self.location.href);
  if (!isArt(url) && !isThumb(url)) return;
  const cache = await caches.open(isArt(url) ? ART_CACHE : APP_CACHE);
  if (await cache.match(url.href)) return;
  const req = new Request(url.href);
  const res = await fetch(req).catch(() => null);
  if (res) store(event, cache, req, res, isArt(url));
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
  if (isArt(url)) event.respondWith(art(event));
  else if (url.origin === self.location.origin) event.respondWith(app(event));
});
