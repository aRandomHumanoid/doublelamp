import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config";
import { redactUrl } from "../../src/log";

const SERVER_DIR = path.resolve("/srv/doublelamp/server");

describe("config", () => {
  it("has dev-friendly defaults", () => {
    const c = loadConfig({}, SERVER_DIR);
    expect(c.port).toBe(8080);
    expect(c.host).toBe("0.0.0.0");
    expect(c.publicUrl).toBe("http://localhost:8080");
    expect(c.deviceWsUrl).toBe("ws://localhost:8080/ws/device");
    expect(c.dataDir).toBe(path.join(SERVER_DIR, "data"));
    expect(c.webDist).toBe(path.resolve(SERVER_DIR, "../web/dist"));
    expect(c.trustProxy).toBe("false");
    expect(c.secureCookies).toBe(true);
  });

  it("derives wss:// from an https PUBLIC_URL and allows EXTRA_ORIGINS", () => {
    const c = loadConfig({ PUBLIC_URL: "https://lamps.example.com/", EXTRA_ORIGINS: "http://localhost:5173, https://x.example.com/path", TRUST_PROXY: "cloudflare" }, SERVER_DIR);
    expect(c.publicUrl).toBe("https://lamps.example.com");
    expect(c.deviceWsUrl).toBe("wss://lamps.example.com/ws/device");
    expect(c.https).toBe(true);
    expect(c.allowedOrigins).toEqual(["https://lamps.example.com", "http://localhost:5173", "https://x.example.com"]);
    expect(c.trustProxy).toBe("cloudflare");
  });

  it("refuses an http:// PUBLIC_URL without DEV_INSECURE, except on localhost", () => {
    expect(() => loadConfig({ PUBLIC_URL: "http://192.168.1.20:8080" }, SERVER_DIR)).toThrow(ConfigError);
    expect(loadConfig({ PUBLIC_URL: "http://127.0.0.1:9000" }, SERVER_DIR).publicUrl).toBe("http://127.0.0.1:9000");
    const dev = loadConfig({ PUBLIC_URL: "http://192.168.1.20:8080", DEV_INSECURE: "1" }, SERVER_DIR);
    expect(dev.deviceWsUrl).toBe("ws://192.168.1.20:8080/ws/device");
    expect(dev.secureCookies).toBe(false);
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({ PORT: "99999" }, SERVER_DIR)).toThrow(/PORT/);
    expect(() => loadConfig({ TRUST_PROXY: "yes please" }, SERVER_DIR)).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ EXTRA_ORIGINS: "ftp://x" }, SERVER_DIR)).toThrow(/EXTRA_ORIGINS/);
    expect(() => loadConfig({ LOG_LEVEL: "loud" }, SERVER_DIR)).toThrow(/LOG_LEVEL/);
  });

  it("keeps an absolute DATA_DIR", () => {
    expect(loadConfig({ DATA_DIR: path.resolve("/data") }, SERVER_DIR).dataDir).toBe(path.resolve("/data"));
  });
});

describe("log redaction", () => {
  it("removes download tokens from URLs", () => {
    expect(redactUrl("/fw/abc.bin?t=dl-1.2.secret&x=1")).toBe("/fw/abc.bin?t=[redacted]&x=1");
    expect(redactUrl("/healthz")).toBe("/healthz");
  });
});
