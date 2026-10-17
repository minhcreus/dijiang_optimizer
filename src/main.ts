// Entry point: open the store, render, and route DOM events (one delegated
// listener per event type).
import "./ui/start-mark.ts"; // first import, so the mark lands before the other modules run
import { ROOM_IDS, defaultProfile } from "./core/index.ts";
import { createStore } from "./storage.ts";
import { onChange, onClick, onInput, onKeydown, reloadFromStore } from "./ui/actions.ts";
import { onPointerDown, onPointerMove, onPointerUp } from "./ui/drag.ts";
import { normalizeProfile } from "./ui/guard.ts";
import { failedArt } from "./ui/html.ts";
import { render, renderShell, updateSaveBadge } from "./ui/render.ts";
import { initState } from "./ui/state.ts";
import { hideTip, onMouseOver } from "./ui/tooltip.ts";

const store = createStore({ defaults: defaultProfile, normalize: normalizeProfile });
initState(store, ROOM_IDS);

/** Missing art: the original from the asset repo for a shipped thumbnail, else hidden (no broken-image icon). */
function onImageError(evt: Event): void {
  const el = evt.target;
  if (!(el instanceof HTMLImageElement)) return;
  const { fallback } = el.dataset;
  failedArt.add(el.getAttribute("src") ?? "");
  if (fallback) {
    delete el.dataset.fallback;
    el.src = fallback;
  } else {
    el.style.visibility = "hidden";
  }
}

const on = <K extends keyof DocumentEventMap>(type: K, fn: (e: DocumentEventMap[K]) => void, opts?: AddEventListenerOptions): void =>
  document.addEventListener(type, fn, opts);
on("click", onClick);
on("change", onChange);
on("input", onInput);
on("keydown", onKeydown);
on("mouseover", onMouseOver);
on("pointerdown", onPointerDown);
on("pointermove", onPointerMove);
on("pointerup", onPointerUp);
on("pointercancel", onPointerUp);
on("error", onImageError, { capture: true });
window.addEventListener("scroll", hideTip, { capture: true, passive: true });
window.addEventListener("blur", onPointerUp);
window.addEventListener("online", () => failedArt.clear()); // art that failed while offline is tried again on the next render

// The store writes pending changes on pagehide / visibilitychange by itself.
store.subscribe((e) => (e.type === "status" ? updateSaveBadge() : reloadFromStore()));

try {
  renderShell(document.getElementById("app")!);
  render();
} finally {
  document.getElementById("loading")?.remove();
}
performance.mark("app-rendered");

/**
 * The first visit starts loading its art before the worker takes over: hand the worker those
 * URLs (as they finish loading), so that art works offline too.
 */
function cacheEarlyArt(sw: ServiceWorkerContainer): void {
  if (sw.controller) return; // the worker sees every request
  sw.addEventListener("controllerchange", () => {
    const since = performance.now();
    const send = (entries: PerformanceEntryList): void => {
      const urls = entries.filter((e) => (e as PerformanceResourceTiming).initiatorType === "img" && e.startTime < since).map((e) => e.name);
      if (urls.length) sw.controller?.postMessage({ type: "cache-art", urls });
    };
    send(performance.getEntriesByType("resource"));
    const late = new PerformanceObserver((list) => send(list.getEntries()));
    late.observe({ type: "resource" });
    setTimeout(() => late.disconnect(), 30_000);
  }, { once: true });
}

function registerServiceWorker(): void {
  try {
    const { protocol, hostname } = location;
    const local = hostname === "localhost" || hostname === "127.0.0.1";
    if (!("serviceWorker" in navigator) || (protocol !== "https:" && !local)) return;
    cacheEarlyArt(navigator.serviceWorker);
    navigator.serviceWorker.register("sw.js").catch(() => undefined);
  } catch {
    // no service worker support here; the app works without it
  }
}

if (document.readyState === "complete") registerServiceWorker();
else window.addEventListener("load", registerServiceWorker, { once: true });
