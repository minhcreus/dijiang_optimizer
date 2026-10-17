// Updating rendered HTML in place, so unchanged nodes (images above all) are
// kept instead of being parsed, laid out and decoded again.

export function fromHtml(html: string): Element {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild!;
}

/** Make `a` match `b`, keeping `a`'s nodes wherever the tags line up. For static markup (no form values). */
export function morph(a: Element, b: Element): void {
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of b.attributes) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  const want = [...b.childNodes];
  const have = a.childNodes;
  if (want.length !== have.length) {
    a.replaceChildren(...want);
    return;
  }
  want.forEach((n, i) => {
    const o = have[i];
    if (o instanceof Element && n instanceof Element && o.tagName === n.tagName) morph(o, n);
    else if (o.nodeType === Node.TEXT_NODE && n.nodeType === Node.TEXT_NODE) {
      if (o.nodeValue !== n.nodeValue) o.nodeValue = n.nodeValue;
    } else a.replaceChild(n, o);
  });
}

export interface Pooled { el: Element; html: string }

/**
 * Show `items` ([key, html], in order) in `box`. Elements are kept in `pool` by key, also while
 * filtered out, and only re-rendered when their HTML changed. `empty` is shown for no items.
 */
export function patchList(box: Element, items: readonly [string, string][], pool: Map<string, Pooled>, empty: string): void {
  if (!items.length) {
    box.innerHTML = empty;
    return;
  }
  const els = items.map(([key, html]) => {
    const c = pool.get(key);
    if (!c) {
      const el = fromHtml(html);
      pool.set(key, { el, html });
      return el;
    }
    if (c.html !== html) {
      morph(c.el, fromHtml(html));
      c.html = html;
    }
    return c.el;
  });
  const keep = new Set(els);
  for (const child of [...box.children]) if (!keep.has(child)) child.remove();
  // Move as few cards as possible (a moved node is restyled and loses focus): the longest run
  // already in order stays, the others go in front of their successor, from the end.
  const pos = new Map([...box.children].map((el, i) => [el, i]));
  const stay = increasingRun(els.map((el) => pos.get(el) ?? -1));
  let next: Element | null = null;
  for (let i = els.length - 1; i >= 0; i--) {
    if (!stay.has(i)) box.insertBefore(els[i], next);
    next = els[i];
  }
}

/** Indices of a longest strictly increasing subsequence of the values >= 0 in `a`. */
function increasingRun(a: readonly number[]): Set<number> {
  const tails: number[] = [];
  const prev: number[] = [];
  a.forEach((v, i) => {
    if (v < 0) return;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[tails[m]] < v) lo = m + 1;
      else hi = m;
    }
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const out = new Set<number>();
  for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.add(i);
  return out;
}
