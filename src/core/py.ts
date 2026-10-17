// Python-compatible primitives, so the port gives bit-identical results to the
// legacy Python build (truthiness, dict.get, list indexing, %, round, min/max,
// sum() and "{:.Nf}" formatting all differ subtly from their JS look-alikes).

/** Python truthiness for JSON-like values: {} and [] are falsy, NaN is truthy. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string" || Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

export const isDict = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Python's type name, for error messages. */
function typeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "object") return "dict";
  return { string: "str", number: "float", boolean: "bool" }[typeof v as string] ?? typeof v;
}

/** `.get` on a value that may not be a dict (corrupt data): AttributeError, like Python. */
function mustBeDict(o: unknown): void {
  if (!isDict(o)) throw new TypeError(`'${typeName(o)}' object has no attribute 'get'`);
}

/** dict.get(key, fallback) on a record with dynamic keys. */
export function lookup<V, F>(o: Readonly<Record<string, V>>, k: unknown, fallback: F): V | F {
  mustBeDict(o);
  if (typeof k === "object" && k !== null) throw new TypeError(`unhashable type: '${typeName(k)}'`);
  return typeof k === "string" && Object.hasOwn(o, k) ? o[k] : fallback;
}

/** dict.get("key", fallback) on a typed object: a stored null is returned as null. */
export function field<T extends object, K extends keyof T & string, F>(o: T, k: K, fallback: F): Exclude<T[K], undefined> | F {
  mustBeDict(o);
  return Object.hasOwn(o, k) ? (o[k] as Exclude<T[K], undefined>) : fallback;
}

/** dict.update(src): a dict, or an iterable of key/value pairs (lists, or 2-character strings). */
export function pyUpdate(out: Record<string, unknown>, src: unknown): void {
  if (isDict(src)) {
    Object.assign(out, src);
    return;
  }
  if (typeof src !== "string" && !Array.isArray(src)) throw new TypeError(`'${typeName(src)}' object is not iterable`);
  [...src].forEach((el: unknown, n) => {
    const pair: unknown[] | null = typeof el === "string" ? [...el] : Array.isArray(el) ? el : null;
    if (!pair) throw new TypeError(`cannot convert dictionary update sequence element #${n} to a sequence`);
    if (pair.length !== 2) throw new RangeError(`dictionary update sequence element #${n} has length ${pair.length}; 2 is required`);
    const [k, v] = pair;
    if (typeof k === "object" && k !== null) throw new TypeError(`unhashable type: '${typeName(k)}'`);
    out[typeof k === "string" ? k : JSON.stringify(k)] = v; // non-string keys as json.dumps writes them
  });
}

/** dict[key]: throws like a KeyError instead of returning undefined. */
export function req<V>(o: Readonly<Record<string, V>>, k: string): V {
  if (!Object.hasOwn(o, k)) throw new Error(`KeyError: ${JSON.stringify(k)}`);
  return o[k];
}

function index(len: number, i: number): number {
  const j = i < 0 ? i + len : i;
  if (!Number.isInteger(j) || j < 0 || j >= len) throw new RangeError("list index out of range");
  return j;
}

/** o["key"] on a value that may not be a dict (corrupt data): TypeError, or KeyError when missing, like Python. */
export function subscript<V>(o: unknown, k: string): V {
  if (isDict(o)) return req(o as Record<string, V>, k);
  const seq = typeof o === "string" || Array.isArray(o);
  throw new TypeError(seq ? `${typeName(o)} indices must be integers` : `'${typeName(o)}' object is not subscriptable`);
}

/** list[i] (or str[i]) with negative indices and IndexError. */
export function at<T>(a: readonly T[], i: number): T {
  if (!Array.isArray(a) && typeof a !== "string") throw new TypeError(`'${typeName(a)}' object is not subscriptable`);
  return a[index(a.length, i)];
}

/** list[i] = v with negative indices and IndexError. */
export function setAt<T>(a: T[], i: number, v: T): void {
  a[index(a.length, i)] = v;
}

/** a % b for b > 0 (Python: the result takes the sign of the divisor). */
export function pyMod(a: number, b: number): number {
  const r = a % b;
  return r < 0 ? r + b : r + 0;
}

/** round(x): half to even, exact on the binary value. NaN and infinities raise, as in Python. */
export function pyRound(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`cannot convert float ${x} to integer`);
  const f = Math.floor(x);
  const d = x - f; // exact for finite doubles
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** min(a, b): the first argument wins ties (and NaN comparisons). */
export const pyMin = (a: number, b: number): number => (b < a ? b : a);
/** max(a, b): the first argument wins ties (and NaN comparisons). */
export const pyMax = (a: number, b: number): number => (b > a ? b : a);

/** sum() of floats: CPython 3.12+ uses Neumaier compensated summation. */
export function pySum(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0 + xs[0];
  let c = 0;
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i];
    const t = s + x;
    c += Math.abs(s) >= Math.abs(x) ? s - t + x : x - t + s;
    s = t;
  }
  return c !== 0 && Number.isFinite(c) ? s + c : s;
}

/** Comparator matching Python's < on numbers or (ASCII) strings. */
export function cmp<T extends number | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** f"{x:.{digits}f}": correctly rounded like toFixed, but exact ties go to even. */
export function pyFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const sign = x < 0 || Object.is(x, -0) ? "-" : "";
  const a = Math.abs(x);
  // An exact tie needs a * 10^d = k + 1/2, i.e. a * 2^(d+1) is an odd integer.
  const j = a * 2 ** (digits + 1);
  if (Number.isInteger(j) && j % 2 === 1) {
    let n = (BigInt(j) * 5n ** BigInt(digits) - 1n) / 2n; // the lower neighbour
    if (n % 2n === 1n) n += 1n;
    const s = n.toString().padStart(digits + 1, "0");
    return sign + (digits ? `${s.slice(0, -digits)}.${s.slice(-digits)}` : s);
  }
  // toFixed switches to exponent notation from 1e21 (such doubles are integers).
  const body = a < 1e21 ? a.toFixed(digits) : BigInt(a).toString() + (digits ? "." + "0".repeat(digits) : "");
  return sign + body;
}

/** Floor division and modulo on integers (any size). */
export function divmod(a: bigint, b: bigint): [bigint, bigint] {
  let q = a / b;
  let r = a % b;
  if (r !== 0n && r < 0n !== b < 0n) {
    q -= 1n;
    r += b;
  }
  return [q, r];
}
