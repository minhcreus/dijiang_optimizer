// HTML string helpers. Every value that comes from data or from the user goes
// through esc(), so names in imported profiles cannot inject markup.
import thumbs from "../data/thumbs.json" with { type: "json" };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Attribute for the custom hover tooltip (newlines kept). */
export function tip(text: string): string {
  return `data-tip="${esc(text)}"`;
}

export const ASSET_ROOT = "https://raw.githubusercontent.com/eldritchtools/endfield-assets/main/assets";

/** Rendered size of each image class in style.css, so the layout does not shift while art loads. */
const IMG_SIZE: Record<string, [number, number]> = {
  "tile-icon": [20, 20],
  face: [30, 30],
  "detail-icon": [40, 40],
  "item-img": [42, 42],
  "slot-img": [76, 90],
  "oc-img": [72, 88],
  bi: [20, 20],
  "chip-icon": [16, 16],
  "op-img": [64, 76],
  "pick-item-img": [60, 60],
};

/** Small copies shipped with the site (scripts/make_thumbs.py), by kind. */
const LOCAL: Record<string, Set<string>> = Object.fromEntries(Object.entries(thumbs).map(([k, ids]) => [k, new Set(ids)]));

/** Art URLs that failed to load: drawn hidden (or from the fallback) from then on, so re-rendered markup matches the page. */
export const failedArt = new Set<string>();

export function asset(kind: string, name: string): string {
  return `${ASSET_ROOT}/${kind}/${encodeURIComponent(name)}.png`;
}

/** The shipped thumbnail when there is one, else the asset repo's original. */
export function artSrc(kind: string, name: string): string {
  return LOCAL[kind]?.has(name) ? `assets/${kind}/${encodeURIComponent(name)}.webp` : asset(kind, name);
}

/**
 * CORS mode, so the service worker can cache real responses (opaque ones count as
 * megabytes of storage quota each). One capturing "error" listener in main.ts tries
 * data-fallback once, then hides the image; both outcomes are kept in failedArt.
 */
export function img(kind: string, name: string, cls: string, alt = ""): string {
  const [w, h] = IMG_SIZE[cls] ?? [24, 24];
  const remote = asset(kind, name);
  const local = artSrc(kind, name);
  const src = failedArt.has(local) ? remote : local;
  const fallback = src === remote ? "" : ` data-fallback="${esc(remote)}"`;
  const hidden = failedArt.has(src) ? ' style="visibility:hidden"' : "";
  return `<img class="${cls}" src="${esc(src)}"${fallback}${hidden} alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async" crossorigin="anonymous">`;
}

/**
 * Art that may fall back to other hosts (the operator pictures). Not in CORS mode, since those
 * hosts may not send CORS headers, and without a referrer, which hotlink checks allow; the
 * service worker leaves other hosts to the browser cache. Fails over to each of `fallbacks` in
 * turn (data-fallback holds the ones left, space-separated), then hides like img().
 */
export function remoteImg(src: string, fallbacks: readonly string[], cls: string, alt = ""): string {
  const [w, h] = IMG_SIZE[cls] ?? [24, 24];
  const chain = [src, ...fallbacks];
  const at = Math.max(0, chain.findIndex((u) => !failedArt.has(u)));
  const cur = failedArt.has(chain[at]) ? chain[chain.length - 1] : chain[at];
  const rest = chain.slice(chain.indexOf(cur) + 1);
  const fb = rest.length ? ` data-fallback="${esc(rest.join(" "))}"` : "";
  const hidden = failedArt.has(cur) ? ' style="visibility:hidden"' : "";
  return `<img class="${cls}" src="${esc(cur)}"${fb}${hidden} alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

/** Python-style string comparison (code units; data ids and names are ASCII). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** str.title() for the single lowercase words used as skill types. */
export function title(s: string): string {
  return s.replace(/\w+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export const pad2 = (n: number): string => String(n).padStart(2, "0");
