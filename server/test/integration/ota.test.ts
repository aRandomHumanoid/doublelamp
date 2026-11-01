// Firmware upload, OTA jobs and "Update both" rollouts (05 §10, 08 §1.5 scenario 9).
import { afterEach, describe, expect, it } from "vitest";
import { buildTestImage } from "../../src/ota/app-desc";
import { setupPair, waitUntil, type Json, type TestServer } from "./harness";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function upload(srv: TestServer, cookie: string, version: string): Promise<Json> {
  const r = await srv.api("POST", `/api/v1/firmware?notes=${encodeURIComponent(`build ${version}`)}`, {
    cookie,
    raw: buildTestImage({ version, size: 96 * 1024 }),
  });
  expect(r.status).toBe(201);
  return r.body;
}

function job(srv: TestServer, id: number) {
  return srv.ctx.ota.get(id)!;
}

describe("OTA", () => {
  it("rejects images that aren't DoubleLamp apps, and lists uploads", async () => {
    const s = await setupPair();
    server = s.server;
    const bad = await s.server.api("POST", "/api/v1/firmware", { cookie: s.cookie, raw: buildTestImage({ version: "1.0.0", project: "blinky" }) });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid");
    const notBin = await s.server.api("POST", "/api/v1/firmware", { cookie: s.cookie, body: { hello: 1 } });
    expect(notBin.status).toBe(400);
    const fw = await upload(s.server, s.cookie, "1.1.0");
    expect(fw).toMatchObject({ version: "1.1.0", size: 96 * 1024, notes: "build 1.1.0", idf: "v5.3.1" });
    const again = await s.server.api("POST", "/api/v1/firmware", { cookie: s.cookie, raw: buildTestImage({ version: "1.1.0", size: 96 * 1024 }) });
    expect(again.status).toBe(200);
    const list = await s.server.api("GET", "/api/v1/firmware", { cookie: s.cookie });
    expect(list.body.firmware.map((f: Json) => f.sha256)).toEqual([fw.sha256]);
    // Over 4 MB: 413. (Over the network Fastify answers before reading the body and resets the socket, which
    // fetch reports as ECONNRESET, so check the response through inject.)
    const big = await s.server.app.app.inject({
      method: "POST",
      url: "/api/v1/firmware",
      headers: { cookie: s.cookie, origin: s.server.url, "content-type": "application/octet-stream" },
      payload: Buffer.alloc(4 * 1024 * 1024 + 1),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("too_large");
  });

  it("serves the image only with a valid token, never cached, with Content-Length", async () => {
    const s = await setupPair();
    server = s.server;
    const fw = await upload(s.server, s.cookie, "1.1.0");
    const r = await s.server.api("POST", `/api/v1/devices/${s.A.id}/ota`, { cookie: s.cookie, body: { sha256: fw.sha256 } });
    expect(r.status).toBe(201);
    // Wait for the job to complete so the lamp's own download has happened, then try the URL ourselves.
    await waitUntil(() => job(s.server!, r.body.id).status === "done", "the update to finish", 10_000);
    const url = `/fw/${fw.sha256}.bin`;
    const noToken = await fetch(s.server.url + url);
    expect(noToken.status).toBe(403);
    expect(noToken.headers.get("cache-control")).toBe("no-store");
    const forged = await fetch(`${s.server.url}${url}?t=dl-00000a.${Date.now() + 60_000}.AAAA`);
    expect(forged.status).toBe(403);
    // A fresh token, signed the same way the server signs ota.start URLs.
    const { signDownloadToken } = await import("../../src/ota/token");
    const t = signDownloadToken(s.server.ctx.secret, s.A.id, fw.sha256, Date.now() + 60_000);
    const ok = await fetch(`${s.server.url}${url}?t=${encodeURIComponent(t)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("content-length")).toBe(String(96 * 1024));
    expect(ok.headers.get("content-type")).toBe("application/octet-stream");
    expect((await ok.arrayBuffer()).byteLength).toBe(96 * 1024);
    const expired = signDownloadToken(s.server.ctx.secret, s.A.id, fw.sha256, Date.now() - 1);
    expect((await fetch(`${s.server.url}${url}?t=${encodeURIComponent(expired)}`)).status).toBe(403);
  });

  it("single lamp: ota.start → download/verify/reboot → hello with pending_verify → done", async () => {
    const s = await setupPair();
    server = s.server;
    const fw = await upload(s.server, s.cookie, "1.2.0");
    const phases: string[] = [];
    s.A.on("ota", (o: { phase: string }) => phases.push(o.phase));
    const r = await s.server.api("POST", `/api/v1/devices/${s.A.id}/ota`, { cookie: s.cookie, body: { version: "1.2.0" } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ device_id: s.A.id, version: "1.2.0", sha256: fw.sha256 });
    await waitUntil(() => job(s.server!, r.body.id).status === "done", "job done", 10_000);
    expect(phases).toContain("download");
    expect(phases).toContain("verify");
    expect(phases).toContain("reboot");
    expect(phases.at(-1)).toBe("done");
    expect(s.A.firmware).toBe("1.2.0");
    const dev = await s.server.api("GET", `/api/v1/devices/${s.A.id}`, { cookie: s.cookie });
    expect(dev.body.fw).toBe("1.2.0");
    expect(dev.body.pending_verify).toBe(false);
    const events = await s.browser.waitFor("ota.job", (m) => m.data.id === r.body.id && m.data.status === "done");
    expect(events.data.pct).toBe(100);
    const unknown = await s.server.api("POST", `/api/v1/devices/${s.A.id}/ota`, { cookie: s.cookie, body: { sha256: "f".repeat(64) } });
    expect(unknown.status).toBe(404);
    const neither = await s.server.api("POST", `/api/v1/devices/${s.A.id}/ota`, { cookie: s.cookie, body: {} });
    expect(neither.status).toBe(400);
  });

  it("an offline lamp's job stays pending and is sent after its next welcome", async () => {
    const s = await setupPair();
    server = s.server;
    const fw = await upload(s.server, s.cookie, "1.2.0");
    s.B.setOffline(true);
    await waitUntil(() => !s.server!.ctx.engine.isOnline(s.B.id), "B offline");
    const r = await s.server.api("POST", `/api/v1/devices/${s.B.id}/ota`, { cookie: s.cookie, body: { sha256: fw.sha256 } });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("pending");
    const conflict = await s.server.api("POST", `/api/v1/devices/${s.B.id}/ota`, { cookie: s.cookie, body: { sha256: fw.sha256 } });
    expect(conflict.status).toBe(409);
    s.B.setOffline(false);
    await waitUntil(() => job(s.server!, r.body.id).status === "done", "job done after reconnect", 10_000);
    expect(s.B.firmware).toBe("1.2.0");
  });

  it("9. OTA failure: --crash-on-ota rolls back, the job fails and the rollout doesn't go on to the second lamp", async () => {
    const s = await setupPair({ a: { crashOnOta: true } });
    server = s.server;
    const fw = await upload(s.server, s.cookie, "1.3.0");
    const bMessages: string[] = [];
    s.B.on("message", (type: string) => bMessages.push(type));
    const r = await s.server.api("POST", "/api/v1/ota/rollout", { cookie: s.cookie, body: { sha256: fw.sha256 } });
    expect(r.status).toBe(200);
    const jobs = r.body.jobs as Json[];
    expect(jobs.map((j) => j.device_id)).toEqual([s.A.id, s.B.id]);
    expect(jobs[0].status).toBe("sent");
    expect(jobs[1].status).toBe("pending");
    await waitUntil(() => job(s.server!, jobs[0].id).status === "failed", "A's job to fail", 10_000);
    expect(job(s.server, jobs[0].id).error).toMatch(/rolled back/);
    await waitUntil(() => job(s.server!, jobs[1].id).status === "failed", "the rollout to stop");
    expect(job(s.server, jobs[1].id).error).toMatch(/rollout stopped/);
    expect(bMessages).not.toContain("ota.start");
    expect(s.B.firmware).toBe("1.0.0");
    // A came back on its old firmware.
    await s.A.waitOnline();
    expect(s.A.firmware).toBe("1.0.0");
    const listed = await s.server.api("GET", "/api/v1/ota-jobs", { cookie: s.cookie });
    expect(listed.body.jobs.map((j: Json) => j.status)).toEqual(["failed", "failed"]);
    const ev = s.server.ctx.activity.query({ deviceId: s.A.id }).find((e) => e.kind === "ota");
    expect(ev?.data).toMatchObject({ status: "failed", version: "1.3.0" });
    await s.browser.waitFor("ota.job", (m) => m.data.id === jobs[1].id && m.data.status === "failed");
  });

  it("rollout success: one lamp at a time, the second only after the first is done", async () => {
    const s = await setupPair();
    server = s.server;
    const fw = await upload(s.server, s.cookie, "1.3.0");
    let bStartedWhileAActive = false;
    const r = await s.server.api("POST", "/api/v1/ota/rollout", { cookie: s.cookie, body: { sha256: fw.sha256 } });
    const jobs = r.body.jobs as Json[];
    s.B.on("message", (type: string) => {
      if (type === "ota.start" && job(s.server!, jobs[0].id).status !== "done") bStartedWhileAActive = true;
    });
    await waitUntil(() => job(s.server!, jobs[1].id).status === "done", "both updates", 15_000);
    expect(job(s.server, jobs[0].id).status).toBe("done");
    expect(bStartedWhileAActive).toBe(false);
    expect(s.A.firmware).toBe("1.3.0");
    expect(s.B.firmware).toBe("1.3.0");
    // Everyone is on 1.3.0 now, so a second rollout has nothing to do.
    const again = await s.server.api("POST", "/api/v1/ota/rollout", { cookie: s.cookie, body: { sha256: fw.sha256 } });
    expect(again.body.jobs).toEqual([]);
    // The firmware can't be deleted while in use, but can afterwards.
    const del = await s.server.api("DELETE", `/api/v1/firmware/${fw.sha256}`, { cookie: s.cookie });
    expect(del.status).toBe(204);
  });

  it("a job with no progress for the timeout fails", async () => {
    const s = await setupPair({ overrides: { otaTimeoutMs: 300 } });
    server = s.server;
    const fw = await upload(s.server, s.cookie, "1.4.0");
    // A lamp that reported 10 % a while ago and then went silent.
    const t = Date.now() - 1000;
    const id = Number(
      s.server.ctx.db
        .prepare("INSERT INTO ota_jobs (device_id, sha256, version, status, pct, created_at, updated_at) VALUES (?, ?, '1.4.0', 'download', 10, ?, ?)")
        .run(s.A.id, fw.sha256, t, t).lastInsertRowid,
    );
    await waitUntil(() => job(s.server!, id).status === "failed", "the no-progress timeout", 5000);
    expect(job(s.server, id).error).toMatch(/no progress/);
  });
});
