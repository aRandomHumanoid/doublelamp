// First-load size check (06: ≤ 250 KB gzipped). Sums the gzip size of index.html plus every script,
// stylesheet and modulepreload it references. Lazy screens are not part of the first load.
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUDGET = 250 * 1024;
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const html = readFileSync(join(dist, "index.html"), "utf8");

const refs = new Set();
for (const m of html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="([^"]+)"[^>]*>/g)) {
  const tag = m[0];
  const ref = m[1];
  if (!ref.startsWith("/") || ref.startsWith("//")) continue;
  if (tag.startsWith("<link") && !/rel="(stylesheet|modulepreload)"/.test(tag)) continue;
  refs.add(ref.slice(1));
}

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const rows = [["index.html", gz(Buffer.from(html))]];
for (const ref of refs) {
  const file = join(dist, ref);
  if (existsSync(file)) rows.push([ref, gz(readFileSync(file))]);
}
const total = rows.reduce((a, [, n]) => a + n, 0);
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
for (const [name, n] of rows) console.log(`  ${name.padEnd(44)} ${kb(n).padStart(9)} gz`);
console.log(`first load: ${kb(total)} gzipped (budget ${kb(BUDGET)})`);
if (total > BUDGET) {
  console.error("first-load budget exceeded");
  process.exit(1);
}
