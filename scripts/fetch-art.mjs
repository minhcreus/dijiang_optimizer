#!/usr/bin/env node
// Copies the art of operators the asset repo does not have yet (the ones with an `art` link in
// src/data/operators.json, from warfarin.wiki) into assets/operators/<id>.webp, so the site serves
// its own copy: node scripts/fetch-art.mjs
//
// The Pages workflow runs it before the build. Files already in assets/operators are kept, so
// committing them makes the site independent of those sites. A download that fails only prints
// a warning (the site then loads that picture from the `art` link), unless --strict is given.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const DIR = "assets/operators";
const MAX_BYTES = 2 * 1024 * 1024;
const strict = process.argv.includes("--strict");
const ops = JSON.parse(readFileSync("src/data/operators.json", "utf8"));

const isWebp = (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";

async function download(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "image/webp,image/*", "user-agent": "dijiang-optimizer art copy (+https://minhcreus.github.io/dijiang_optimizer/)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_BYTES) throw new Error(`${body.length} bytes, over the ${MAX_BYTES} limit`);
  if (!isWebp(body)) throw new Error("not a WebP image");
  return body;
}

const counts = { copied: 0, kept: 0, failed: 0 };
for (const [id, op] of Object.entries(ops)) {
  if (!op.art) continue;
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`unexpected operator id ${JSON.stringify(id)}`);
  const file = `${DIR}/${id}.webp`;
  if (existsSync(file)) {
    counts.kept++;
    continue;
  }
  const errors = [];
  for (const url of [op.art, op.artFallback].filter(Boolean)) {
    try {
      const body = await download(url);
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, body);
      console.log(`copied ${file} from ${url} (${body.length} bytes)`);
      counts.copied++;
      break;
    } catch (e) {
      errors.push(`${url}: ${e.message}`);
    }
  }
  if (!existsSync(file)) {
    counts.failed++;
    console.warn(`::warning::no copy of ${id}'s art, the site loads it from ${op.art}\n  ${errors.join("\n  ")}`);
  }
}
console.log(`operator art: ${counts.copied} copied, ${counts.kept} already there, ${counts.failed} failed`);
if (strict && counts.failed) process.exit(1);
