// Dragging the shift handles on the 24h bar, at most one update per frame.
import { DAY_MIN, dragHandle } from "../core/index.ts";
import { renderDraft } from "./render.ts";
import { S } from "./state.ts";
import { hideTip } from "./tooltip.ts";
import { barOf, draftOf, sameBar } from "./views/overview.ts";

let frame = 0;
let lastX = 0;

function dragTo(clientX: number): void {
  if (!S.drag) return;
  const { room, handle } = S.drag;
  const bar = document.getElementById(`bar-${room}`);
  if (!bar) return;
  const rect = bar.getBoundingClientRect();
  const frac = rect.width ? (clientX - rect.left) / rect.width : 0;
  const minute = Math.max(0, Math.min(1, frac)) * DAY_MIN;
  const draft = draftOf(room);
  const next = dragHandle(draft, handle, minute);
  if (!sameBar(next, draft)) {
    S.drafts[room] = barOf(next);
    renderDraft(room);
  }
}

function onFrame(): void {
  frame = 0;
  dragTo(lastX);
}

export function onPointerDown(evt: PointerEvent): void {
  const h = evt.target instanceof Element ? evt.target.closest<HTMLElement>(".handle") : null;
  if (!h || evt.button !== 0 || !evt.isPrimary) return;
  evt.preventDefault();
  hideTip();
  S.drag = { room: h.dataset.room ?? "", handle: h.dataset.handle === "q" ? "q" : "p" };
  lastX = evt.clientX;
  document.body.classList.add("dragging");
}

export function onPointerMove(evt: PointerEvent): void {
  if (!S.drag) return;
  // the release was missed (e.g. it landed on a context menu or another window)
  if ((evt.buttons & 1) === 0) return onPointerUp();
  evt.preventDefault();
  lastX = evt.clientX;
  frame ||= requestAnimationFrame(onFrame);
}

export function onPointerUp(): void {
  if (!S.drag) return;
  if (frame) {
    cancelAnimationFrame(frame);
    onFrame();
  }
  S.drag = null;
  document.body.classList.remove("dragging");
}
