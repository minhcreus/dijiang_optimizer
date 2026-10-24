// HTML string helpers. Every value that comes from data or from the user goes
// through esc(), so names in imported profiles cannot inject markup.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function esc(v: unknown): string {
  return String(v).replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Attribute for the custom hover tooltip (newlines kept). */
export function tip(text: string): string {
  return `data-tip="${esc(text)}"`;
}

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

/** Images that failed to load: drawn hidden from then on, so re-rendered markup matches the page. */
export const failedArt = new Set<string>();

/** The site's own image file: assets/<kind>/<name>.webp. */
export function asset(kind: string, name: string): string {
  return `assets/${kind}/${encodeURIComponent(name)}.webp`;
}

/** One capturing "error" listener in main.ts hides an image that fails, and keeps it in failedArt. */
export function img(kind: string, name: string, cls: string, alt = ""): string {
  const [w, h] = IMG_SIZE[cls] ?? [24, 24];
  const src = asset(kind, name);
  const hidden = failedArt.has(src) ? ' style="visibility:hidden"' : "";
  return `<img class="${cls}" src="${esc(src)}"${hidden} alt="${esc(alt)}" width="${w}" height="${h}" loading="lazy" decoding="async">`;
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
