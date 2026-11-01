// The built web app (../web/dist) at / with an SPA fallback, or a short page explaining how to build it.
import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { errorBody } from "../util/errors";

const RESERVED = /^\/(api|ws|fw|healthz)(\/|$|\?)/;

const BUILD_HINT = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DoubleLamp server</title>
<style>
  :root { color-scheme: dark light; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; background: #111; color: #eee; }
  code, pre { background: #222; padding: .1rem .3rem; border-radius: 4px; }
  pre { padding: .75rem; overflow-x: auto; }
  @media (prefers-color-scheme: light) { body { background: #fafafa; color: #111; } code, pre { background: #eee; } }
</style>
</head>
<body>
<h1>DoubleLamp server is running</h1>
<p>The web app hasn't been built yet, so there's nothing to show here. Build it from the repository root:</p>
<pre>npm run build -w web</pre>
<p>Then reload this page. For development, run the Vite dev server instead (<code>npm run dev:web</code>) and add its
origin to <code>EXTRA_ORIGINS</code>.</p>
<p>The API is at <code>/api/v1</code>, lamps connect to <code>/ws/device</code>, and <code>/healthz</code> reports health.</p>
</body>
</html>
`;

export async function registerStatic(app: FastifyInstance, webDist: string): Promise<void> {
  const index = path.join(webDist, "index.html");
  const hasDist = existsSync(index);
  if (hasDist) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      wildcard: true,
      index: ["index.html"],
      cacheControl: false, // set below instead
      setHeaders(res, filePath) {
        // Vite puts content-hashed files in /assets; everything else (index.html, sw.js, manifest) must revalidate.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "no-cache");
      },
    });
  } else {
    app.log.warn({ webDist }, "web app not built; serving a placeholder page at /");
  }

  app.setNotFoundHandler((req, reply) => {
    const url = req.url;
    const pathname = url.split(/[?#]/, 1)[0]!;
    // Missing files (anything with an extension, e.g. an old hashed chunk after a redeploy) get a real 404;
    // only app routes fall back to index.html.
    const isFile = /\.[A-Za-z0-9]{1,12}$/.test(pathname);
    if (RESERVED.test(url) || isFile || (req.method !== "GET" && req.method !== "HEAD")) {
      return reply.code(404).send(errorBody("not_found", "not found"));
    }
    if (hasDist) return reply.header("Cache-Control", "no-cache").sendFile("index.html");
    return reply.code(200).type("text/html; charset=utf-8").send(BUILD_HINT);
  });
}
