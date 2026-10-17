// The custom hover tooltip (#tip), positioned above its target or below when
// there is no room, and always inside the viewport.
import { S } from "./state.ts";

let shown: Element | null = null;

export function hideTip(): void {
  document.getElementById("tip")?.classList.remove("show");
  shown = null;
}

export function onMouseOver(evt: MouseEvent): void {
  if (S.drag) return;
  const t = document.getElementById("tip");
  if (!t) return;
  const target = evt.target instanceof Element ? evt.target.closest("[data-tip]") : null;
  if (!target) {
    if (shown) hideTip();
    return;
  }
  if (target === shown) return;
  shown = target;
  t.textContent = target.getAttribute("data-tip");
  // measure at the origin so the previous position cannot squeeze the box
  t.style.left = "0px";
  t.style.top = "0px";
  t.classList.add("show");
  const r = target.getBoundingClientRect();
  const tr = t.getBoundingClientRect();
  const left = Math.max(8, Math.min(window.innerWidth - tr.width - 8, r.left + r.width / 2 - tr.width / 2));
  let top = r.top - tr.height - 8;
  if (top < 8) top = r.bottom + 8;
  // neither side fits on a short screen: keep it inside (.tip has a max-height)
  top = Math.max(8, Math.min(top, window.innerHeight - tr.height - 8));
  t.style.left = `${left}px`;
  t.style.top = `${top}px`;
}
