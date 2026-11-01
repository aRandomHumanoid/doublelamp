// Builds the lamp's built-in UI into one self-contained, gzipped HTML file (docs/06-web-apps.md §B.4):
//
//   src/main.ts (+ styles.css) ─esbuild─► inlined into src/index.html ─► dist/index.html
//                                                     └─gzip -9─► firmware/components/device_ui/index.html.gz
//
//   node build.mjs           build once; exits 1 if the gzipped file is over 60 KB (06 §B.1)
//   node build.mjs --watch   rebuild whenever something in src/ changes
import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, "src");
const DIST = join(here, "dist");
const OUT_GZ = join(here, "..", "firmware", "components", "device_ui", "index.html.gz");
const LIMIT = 60 * 1024;
const WATCH = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: [join(SRC, "main.ts")],
  bundle: true,
  minify: true,
  format: "iife",
  // es2019 for old captive-portal webviews; the browser versions keep esbuild's CSS output compatible too.
  target: ["es2019", "chrome64", "safari12", "firefox62"],
  charset: "utf8",
  legalComments: "none",
  write: false,
  outdir: DIST,
  metafile: true,
  logLevel: "silent",
};

const kb = (n) => (n / 1024).toFixed(1) + " KB";

async function run(ctx) {
  const t0 = Date.now();
  const res = ctx ? await ctx.rebuild() : await esbuild.build(options);
  for (const w of await esbuild.formatMessages(res.warnings, { kind: "warning", color: true })) console.warn(w);

  // Types from @doublelamp/protocol are fine (they're erased); runtime code from it (zod!) is not.
  const leaked = Object.keys(res.metafile.inputs).filter((p) => /packages[\\/]protocol|node_modules[\\/]zod/.test(p));
  if (leaked.length) throw new Error("runtime code from the protocol package ended up in the bundle: " + leaked.join(", "));

  const js = res.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
  const css = res.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const template = readFileSync(join(SRC, "index.html"), "utf8");
  if (!template.includes("<!--CSS-->") || !template.includes("<!--JS-->")) throw new Error("src/index.html needs <!--CSS--> and <!--JS-->");

  // "</script" must not appear inside the inline script; in JS strings "<\/script" means the same.
  const safeJs = js.trim().replace(/<\/script/gi, "<\\/script");
  if (safeJs.includes("<!--")) throw new Error("the bundle contains '<!--', which can't be inlined in a <script>");

  const html = template
    .replace(/>\s+</g, "><")
    .trim()
    // replacer functions: minified code may contain "$&" and similar patterns
    .replace("<!--CSS-->", () => "<style>" + css.trim() + "</style>")
    .replace("<!--JS-->", () => "<script>" + safeJs + "</script>");

  const raw = Buffer.from(html, "utf8");
  const gz = gzipSync(raw, { level: 9 });
  gz[9] = 255; // gzip header OS byte = "unknown", so the output doesn't depend on the build machine's OS

  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, "index.html"), raw);
  mkdirSync(dirname(OUT_GZ), { recursive: true });
  writeFileSync(OUT_GZ, gz);

  const over = gz.length > LIMIT;
  console.log(
    `${over ? "✗" : "✓"} device UI: ${kb(raw.length)} raw, ${kb(gz.length)} gzipped (limit ${kb(LIMIT)})` +
      ` · js ${kb(js.length)}, css ${kb(css.length)} · ${Date.now() - t0} ms`,
  );
  console.log(`  → ${relative(process.cwd(), join(DIST, "index.html"))}\n  → ${relative(process.cwd(), OUT_GZ)}`);
  if (over) console.error(`  gzipped size ${gz.length} B is over the ${LIMIT} B budget (docs/06-web-apps.md §B.1)`);
  return !over;
}

async function report(err) {
  if (err && err.errors) {
    for (const m of await esbuild.formatMessages(err.errors, { kind: "error", color: true })) console.error(m);
  } else console.error(err && err.message ? err.message : err);
}

if (WATCH) {
  const ctx = await esbuild.context(options);
  const once = () => run(ctx).catch(report);
  await once();
  let timer;
  watch(SRC, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(once, 80);
  });
  console.log("watching src/ (Ctrl+C to stop)");
} else {
  try {
    if (!(await run())) process.exit(1);
  } catch (e) {
    await report(e);
    process.exit(1);
  }
}
