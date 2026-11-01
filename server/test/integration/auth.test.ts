// Shared-password login, sessions, Origin checks, rate limits (05 §6, 07 T5/T6), 08 §1.5 scenario 12.
import { afterEach, describe, expect, it } from "vitest";
import { PASSWORD, TestServer, upgradeStatus } from "./harness";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("login and sessions", () => {
  it("sets an HttpOnly, SameSite=Lax session cookie and reports the session", async () => {
    server = await TestServer.start();
    const res = await fetch(`${server.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: { label: string; current: boolean } };
    expect(body.session).toMatchObject({ label: "iPhone · Safari", current: true });
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^dl_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=2592000/);
    expect(cookie).toMatch(/Secure/); // no DEV_INSECURE in this test
    const me = await server.api("GET", "/api/v1/me", { cookie: cookie.split(";")[0] });
    expect(me.status).toBe(200);
    expect(me.body.session.label).toBe("iPhone · Safari");
    expect(typeof me.body.server_time).toBe("number");
  });

  it("drops the Secure flag with DEV_INSECURE", async () => {
    server = await TestServer.start({ env: { DEV_INSECURE: "1" } });
    const res = await fetch(`${server.url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD, label: "curl" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  it("rejects a wrong password with 401 and rate-limits after 5 failures per IP", async () => {
    server = await TestServer.start();
    for (let i = 0; i < 5; i++) {
      const r = await server.api("POST", "/api/v1/auth/login", { body: { password: "nope" } });
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe("auth_required");
    }
    const limited = await server.api("POST", "/api/v1/auth/login", { body: { password: PASSWORD } });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe("rate_limited");
    const failed = server.ctx.activity.query({}).filter((e) => e.kind === "login_failed");
    expect(failed).toHaveLength(5);
  });

  it("requires a session for the API and an allowed Origin for changes", async () => {
    server = await TestServer.start();
    const cookie = await server.login();
    expect((await server.api("GET", "/api/v1/devices")).status).toBe(401);
    expect((await server.api("GET", "/api/v1/devices", { cookie })).status).toBe(200);
    // GET needs no Origin; state changes do.
    const noOrigin = await server.api("POST", "/api/v1/pairing-codes", { cookie, origin: null });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("forbidden");
    const evil = await server.api("POST", "/api/v1/pairing-codes", { cookie, origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    const ok = await server.api("POST", "/api/v1/pairing-codes", { cookie });
    expect(ok.status).toBe(201);
    expect(ok.body.code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    expect(ok.body.expires_in).toBe(600);
    // A foreign Origin can't log in either (login CSRF).
    expect((await server.api("POST", "/api/v1/auth/login", { body: { password: PASSWORD }, origin: "https://evil.example" })).status).toBe(403);
  });

  it("accepts EXTRA_ORIGINS (the Vite dev server)", async () => {
    server = await TestServer.start({ env: { EXTRA_ORIGINS: "http://localhost:5173" } });
    const cookie = await server.login();
    expect((await server.api("POST", "/api/v1/pairing-codes", { cookie, origin: "http://localhost:5173" })).status).toBe(201);
    const ws = `${server.url.replace("http", "ws")}/ws/client`;
    expect(await upgradeStatus(ws, { cookie, origin: "http://localhost:5173" })).toBe(101);
  });

  it("checks the session cookie and Origin on /ws/client upgrades", async () => {
    server = await TestServer.start();
    const cookie = await server.login();
    const ws = `${server.url.replace("http", "ws")}/ws/client`;
    expect(await upgradeStatus(ws, { origin: server.url })).toBe(401);
    expect(await upgradeStatus(ws, { cookie, origin: "https://evil.example" })).toBe(403);
    expect(await upgradeStatus(ws, { cookie })).toBe(403);
    expect(await upgradeStatus(ws, { cookie: "dl_session=forged", origin: server.url })).toBe(401);
    expect(await upgradeStatus(ws, { cookie, origin: server.url })).toBe(101);
  });

  it("12. changing the password revokes every other session and closes their WebSockets", async () => {
    server = await TestServer.start();
    const mine = await server.login("Kitchen iPad");
    const other = await server.login("Phone");
    const otherWs = await server.browser(other);
    const mineWs = await server.browser(mine);
    const wrong = await server.api("PUT", "/api/v1/auth/password", { cookie: mine, body: { current: "wrong password", next: "a brand new password" } });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error).toMatchObject({ code: "forbidden", field: "current" });
    const short = await server.api("PUT", "/api/v1/auth/password", { cookie: mine, body: { current: PASSWORD, next: "short" } });
    expect(short.status).toBe(400);
    expect(short.body.error.field).toBe("next");
    const r = await server.api("PUT", "/api/v1/auth/password", { cookie: mine, body: { current: PASSWORD, next: "a brand new password" } });
    expect(r.status).toBe(204);
    const closed = await otherWs.waitClosed();
    expect(closed.code).toBe(4001);
    expect((await server.api("GET", "/api/v1/me", { cookie: other })).status).toBe(401);
    expect((await server.api("GET", "/api/v1/me", { cookie: mine })).status).toBe(200);
    expect(mineWs.closeInfo).toBeNull();
    await expect(server.login("x", PASSWORD)).rejects.toThrow(/401/);
    expect(await server.login("x", "a brand new password")).toMatch(/^dl_session=/);
    const ev = server.ctx.activity.query({}).find((e) => e.kind === "password_changed");
    expect(ev?.by_label).toBe("Kitchen iPad");
    expect(ev?.data).toMatchObject({ revoked_sessions: 1 });
  });

  it("lists sessions, revokes one, and logs out", async () => {
    server = await TestServer.start();
    const a = await server.login("A");
    const b = await server.login("B");
    const list = await server.api("GET", "/api/v1/sessions", { cookie: a });
    expect(list.body.sessions.map((s: { label: string }) => s.label).sort()).toEqual(["A", "B"]);
    const bId = list.body.sessions.find((s: { label: string }) => s.label === "B").id;
    expect(list.body.sessions.find((s: { label: string }) => s.label === "A").current).toBe(true);
    expect((await server.api("DELETE", `/api/v1/sessions/${bId}`, { cookie: a })).status).toBe(204);
    expect((await server.api("GET", "/api/v1/me", { cookie: b })).status).toBe(401);
    expect((await server.api("DELETE", "/api/v1/sessions/nope", { cookie: a })).status).toBe(404);
    expect((await server.api("POST", "/api/v1/auth/logout", { cookie: a })).status).toBe(204);
    expect((await server.api("GET", "/api/v1/me", { cookie: a })).status).toBe(401);
  });
});
