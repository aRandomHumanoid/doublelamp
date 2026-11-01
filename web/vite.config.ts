import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };

/** The DoubleLamp server the dev proxy talks to. */
const SERVER = process.env.VITE_SERVER ?? "http://localhost:8080";
/**
 * The server checks `Origin` against its PUBLIC_URL on every change and every WS upgrade (05 §7, 07 T6).
 * In dev the browser's origin is Vite's, so the proxy rewrites it. Set VITE_PUBLIC_URL when the server's
 * PUBLIC_URL differs from VITE_SERVER (e.g. a LAN IP).
 */
const PUBLIC_ORIGIN = new URL(process.env.VITE_PUBLIC_URL ?? SERVER).origin;

function proxyTo(ws = false): ProxyOptions {
  return {
    target: SERVER,
    changeOrigin: true,
    ws,
    // Host-only cookie for the dev origin, whatever Domain the server sets.
    cookieDomainRewrite: "",
    configure(proxy) {
      proxy.on("proxyReq", (req) => {
        if (req.getHeader("origin")) req.setHeader("origin", PUBLIC_ORIGIN);
      });
      proxy.on("proxyReqWs", (req) => {
        req.setHeader("origin", PUBLIC_ORIGIN);
      });
    },
  };
}

/**
 * Emits dist/sw.js from sw/sw.js with the list of app-shell files of this build (06 A.5).
 * The service worker precaches only these files and never touches /api, /ws, /fw or /healthz.
 */
function shellServiceWorker(): Plugin {
  return {
    name: "doublelamp-shell-sw",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((f) => !f.endsWith(".map") && f !== "sw.js")
        .map((f) => (f === "index.html" ? "/" : `/${f}`));
      const shell = [...new Set(["/", ...files, "/manifest.webmanifest", "/icon.svg", "/icon-maskable.svg"])].sort();
      const hash = createHash("sha256");
      for (const f of shell) hash.update(f);
      const html = bundle["index.html"];
      if (html && html.type === "asset") hash.update(String(html.source));
      const template = readFileSync(new URL("./sw/sw.js", import.meta.url), "utf8");
      const source = template
        .replace("__SHELL_FILES__", JSON.stringify(shell))
        .replace("__SHELL_VERSION__", hash.digest("hex").slice(0, 12));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

/**
 * react-colorful appends a runtime <style> element, which the server's strict CSP (`default-src 'self'`,
 * 07 T7) blocks and reports. Its rules are copied into src/styles.css instead, so the build drops the
 * injection. If a future version changes the code, the build warns and the injection stays (harmless,
 * just a console report).
 */
function reactColorfulStaticStyles(): Plugin {
  const pattern = /,(\w+)\.appendChild\((\w+)\)(\}\}\},\[\]\))/;
  return {
    name: "doublelamp-react-colorful-static-styles",
    apply: "build",
    transform(code, id) {
      if (!/[\\/]react-colorful[\\/]dist[\\/]/.test(id)) return null;
      if (!pattern.test(code)) {
        this.warn("react-colorful style injection not found; check src/styles.css still matches its CSS");
        return null;
      }
      return { code: code.replace(pattern, ",void 0$3"), map: null };
    },
  };
}

export default defineConfig({
  plugins: [react(), shellServiceWorker(), reactColorfulStaticStyles()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      "/api": proxyTo(),
      "/ws": proxyTo(true),
      "/fw": proxyTo(),
      "/healthz": proxyTo(),
    },
  },
  preview: {
    proxy: {
      "/api": proxyTo(),
      "/ws": proxyTo(true),
      "/fw": proxyTo(),
      "/healthz": proxyTo(),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
