// File export (download) and naming imported files.

export function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The date stamp of an export, plus the suffix a browser or file manager adds to a
// second copy: "(1)" (Chrome, Firefox), "-1" (Safari), " - Copy" (Windows), " copy 2" (macOS).
const STAMP = /-\d{4}-\d{2}-\d{2}(?:\s*\(\d+\)|-\d+|\s*-\s*copy(?:\s*\(\d+\))?|\s+copy(?:\s+\d+)?)?$/i;

/** A profile name from an exported file name: "dijiang-main-2026-10-15 (1).json" -> "Main". */
export function nameFromFile(filename: string): string | undefined {
  const base = filename.replace(/\.[^.]*$/, "").replace(/^dijiang-/i, "").replace(STAMP, "");
  if (/^all-profiles$/i.test(base)) return undefined;
  const words = base.replace(/[-_\s]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : undefined;
}
