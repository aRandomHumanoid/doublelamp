import { describe, expect, it } from "vitest";
import { MIN_PASSWORD_LENGTH, PasswordStore, ensurePassword } from "../../src/auth/password";
import { DualLimiter, SlidingWindow, loginLimiter } from "../../src/auth/rate-limit";
import { SESSION_TTL_MS, SessionStore, shortUserAgent, toSessionInfo } from "../../src/auth/sessions";
import { openDatabase } from "../../src/db/db";
import { sha256Hex } from "../../src/util/crypto";

function setup() {
  const db = openDatabase(":memory:");
  const clock = { now: 1_761_650_000_000 };
  return { db, clock, sessions: new SessionStore(db, () => clock.now), passwords: new PasswordStore(db, () => clock.now) };
}

describe("sessions", () => {
  it("issue a 256-bit token and store only its hash", () => {
    const { db, sessions } = setup();
    const { token, session } = sessions.create("Kitchen iPad", "Mozilla/5.0");
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const row = db.prepare("SELECT token_hash FROM sessions WHERE id = ?").get(session.id) as { token_hash: string };
    expect(row.token_hash).toBe(sha256Hex(token));
    expect(JSON.stringify(db.prepare("SELECT * FROM sessions").all())).not.toContain(token);
    expect(sessions.validate(token)?.label).toBe("Kitchen iPad");
    expect(sessions.validate(token + "x")).toBeNull();
    expect(sessions.validate("")).toBeNull();
  });

  it("expire after 30 days", () => {
    const { sessions, clock } = setup();
    const { token } = sessions.create("A", null);
    clock.now += SESSION_TTL_MS - 1;
    expect(sessions.validate(token)).not.toBeNull();
    clock.now += 2;
    expect(sessions.validate(token)).toBeNull();
  });

  it("can be revoked one by one or all but the current one (password change)", () => {
    const { sessions } = setup();
    const a = sessions.create("A", null);
    const b = sessions.create("B", null);
    const c = sessions.create("C", null);
    expect(sessions.revoke(b.session.id)).toBe(true);
    expect(sessions.validate(b.token)).toBeNull();
    sessions.create("D", null);
    const revoked = sessions.revokeAllExcept(a.session.id);
    expect(revoked).toHaveLength(2);
    expect(revoked).toContain(c.session.id);
    expect(sessions.validate(a.token)).not.toBeNull();
    expect(sessions.validate(c.token)).toBeNull();
    expect(sessions.list().map((s) => s.label)).toEqual(["A"]);
    expect(toSessionInfo(sessions.list()[0]!, a.session.id).current).toBe(true);
  });

  it("default labels come from a short form of the user agent", () => {
    expect(
      shortUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"),
    ).toBe("iPhone · Safari");
    expect(shortUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36")).toBe(
      "Windows · Chrome",
    );
    expect(shortUserAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36")).toBe(
      "Android · Chrome",
    );
    expect(shortUserAgent("curl/8.9.1")).toBe("curl");
    expect(shortUserAgent(undefined)).toBe("Browser");
  });
});

describe("shared password", () => {
  it("is stored as an argon2id hash and checked", async () => {
    const { db, passwords } = setup();
    await passwords.set("correct horse battery staple");
    const row = db.prepare("SELECT value FROM settings WHERE key = 'password_hash'").get() as { value: string };
    expect(row.value.startsWith("$argon2id$")).toBe(true);
    expect(await passwords.check("correct horse battery staple")).toBe(true);
    expect(await passwords.check("wrong")).toBe(false);
  });

  it("first start: APP_PASSWORD (≥ 12 chars), else a generated 16-char password; ignored once stored", async () => {
    const a = setup();
    await expect(ensurePassword(a.passwords, "short")).rejects.toThrow(String(MIN_PASSWORD_LENGTH));
    expect(await ensurePassword(a.passwords, "a long enough secret")).toEqual({ source: "env" });
    expect(await ensurePassword(a.passwords, "something else entirely")).toEqual({ source: "stored" });
    expect(await a.passwords.check("a long enough secret")).toBe(true);

    const b = setup();
    const r = await ensurePassword(b.passwords, undefined);
    expect(r.source).toBe("generated");
    if (r.source === "generated") {
      expect(r.password).toHaveLength(16);
      expect(await b.passwords.check(r.password)).toBe(true);
    }
  });
});

describe("rate limits", () => {
  it("sliding window forgets old hits", () => {
    const clock = { now: 0 };
    const w = new SlidingWindow(3, 1000, () => clock.now);
    w.hit("k");
    w.hit("k");
    w.hit("k");
    expect(w.isLimited("k")).toBe(true);
    clock.now = 1001;
    expect(w.isLimited("k")).toBe(false);
  });

  it("login: 5 failures per 15 min per IP, 30 per hour overall", () => {
    const clock = { now: 0 };
    const l = loginLimiter(() => clock.now);
    for (let i = 0; i < 5; i++) l.hit("1.2.3.4");
    expect(l.limited("1.2.3.4")).toBe(true);
    expect(l.limited("5.6.7.8")).toBe(false);
    clock.now += 15 * 60_000 + 1;
    expect(l.limited("1.2.3.4")).toBe(false);
    for (let i = 0; i < 30; i++) l.hit(`10.0.0.${i}`);
    expect(l.limited("9.9.9.9")).toBe(true);
  });

  it("a dual limiter trips on either window", () => {
    const clock = { now: 0 };
    const l = new DualLimiter({ limit: 2, windowMs: 1000 }, { limit: 3, windowMs: 10_000 }, () => clock.now);
    l.hit("a");
    l.hit("b");
    l.hit("c");
    expect(l.limited("d")).toBe(true);
  });
});
