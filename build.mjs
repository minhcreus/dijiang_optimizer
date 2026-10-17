// Bundles src/main.ts into dist/app.js and stamps the service worker with a
// content hash of the site files, so every deploy refreshes the offline cache.
import { build, context } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
const options = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "esm",
  target: ["es2020"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  outfile: "dist/app.js",
  legalComments: "none",
  logLevel: "info",
};

const SITE_FILES = () => [
  "dist/app.js", "style.css", "index.html",
  ...(existsSync("assets") ? readdirSync("assets", { recursive: true, withFileTypes: true }) : [])
    .filter((d) => d.isFile()).map((d) => `${d.parentPath}/${d.name}`).sort(),
];

/** Precached URL (relative to sw.js) -> file; "./" is served as index.html. */
const PRECACHE = { "./": "index.html", "./index.html": "index.html", "./style.css": "style.css", "./dist/app.js": "dist/app.js" };

const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

function stampServiceWorker() {
  const h = createHash("sha256");
  for (const f of SITE_FILES()) h.update(f).update(readFileSync(f));
  const hash = h.digest("hex").slice(0, 10);
  // the worker checks each precached file against its hash, so a half-finished deploy is not cached
  const files = Object.fromEntries(Object.entries(PRECACHE).map(([url, f]) => [url, sha256(f)]));
  const sw = readFileSync("src/sw.template.js", "utf8")
    .replace("__BUILD_HASH__", hash)
    .replace("__APP_FILES__", JSON.stringify(files, null, 2));
  writeFileSync("sw.js", sw);
  console.log(`sw.js stamped with ${hash}`);
}

mkdirSync("dist", { recursive: true });
if (watch) {
  const ctx = await context({ ...options, plugins: [{ name: "sw", setup(b) { b.onEnd(() => stampServiceWorker()); } }] });
  await ctx.watch();
} else {
  await build(options);
  stampServiceWorker();
}
