// Settings → Network, Apple Home, Server, Security, Firmware, System (06 §B.3, 04 §3).
import type { DeviceInfo, HomekitInfo, NetworkSettings, WifiNetwork } from "@doublelamp/protocol/local";
import { ApiError, admin, api, errMsg, session, uploadFirmware } from "../lib/api";
import { type Child, delay, fill, h } from "../lib/dom";
import { live } from "../live";
import { bars, icon } from "../ui/icons";
import {
  askLogin,
  btn,
  busy,
  card,
  confirmDialog,
  errorBox,
  input,
  isCancel,
  kv,
  note,
  passwordInput,
  spinner,
  toast,
  toggle,
} from "../ui/widgets";
import { homekitCode } from "./homekit";
import { apName, checkServer, hostName, normCode } from "./setup";
import { type WifiPick, isOpen, wifiList } from "./wifi";

const loading = () => h("p", { class: "boot" }, spinner(), " Loading…");

/** Shows an error with a retry button, or leaves the section if the login was cancelled. */
function failed(body: HTMLElement, e: unknown, retry: () => void): void {
  if (isCancel(e)) {
    location.hash = "#settings";
    return;
  }
  fill(body, note(errMsg(e), "bad"), btn("Try again", { kind: "ghost", onclick: retry }));
}

// ---------------------------------------------------------------------------------- Network

const MODES: Record<string, string> = {
  sta: "Connected to WiFi",
  ap: "Direct mode only (the lamp's own WiFi)",
  apsta: "WiFi, plus the lamp's own WiFi",
};

export function networkSection(body: HTMLElement, info: DeviceInfo): void {
  const net = info.net;
  const status = card(
    "Connection",
    kv([
      ["Mode", MODES[net.mode] || net.mode],
      ["Network", net.ssid || "-"],
      ["Signal", net.rssi ? h("span", { class: "row" }, bars(net.rssi), h("span", null, net.rssi + " dBm")) : "-"],
      ["IP address", net.ip || "-"],
      ["Name", "http://" + hostName(info)],
    ]),
  );

  const change = h("div");
  const startChange = () => {
    fill(
      change,
      wifiList(
        () => admin<WifiNetwork[]>("GET", "/wifi/scan", undefined, { timeout: 20000 }),
        (p) => askPassword(p),
        net.ssid,
      ),
      btn("Cancel", { kind: "ghost wide", onclick: () => fill(change, changeBtn) }),
    );
  };
  const changeBtn = btn("Change WiFi", { kind: "ghost wide", icon: "wifi", onclick: startChange });
  fill(change, changeBtn);

  function askPassword(p: WifiPick) {
    const ssid = p.hidden ? input({ label: "Network name (SSID)", maxlength: 32 }) : null;
    const pw = isOpen(p.auth) && !p.hidden ? null : passwordInput({ label: "Password for " + (p.ssid || "the network") });
    const err = errorBox();
    const go = btn("Connect", { kind: "primary", type: "submit" });
    fill(
      change,
      h(
        "form",
        {
          class: "stack",
          novalidate: true,
          onsubmit: async (e: Event) => {
            e.preventDefault();
            const name = ssid ? ssid.input.value.trim() : p.ssid;
            const pass = pw ? pw.input.value : "";
            if (!name) return err.set("Enter the network name.");
            if (/^wpa/i.test(p.auth) && !p.hidden && pass.length < 8) return err.set("WiFi passwords are at least 8 characters.");
            const ok = await confirmDialog({
              title: "Switch to " + name + "?",
              text:
                "The lamp leaves " +
                (net.ssid || "its current network") +
                " and joins " +
                name +
                ". If it can't connect within 2 minutes, it opens its own WiFi " +
                apName(info) +
                " (with the direct-mode password) so you can fix it.",
              ok: "Switch",
            });
            if (!ok) return;
            busy(go, true);
            try {
              await admin("PUT", "/wifi", { ssid: name, password: pass });
              fill(
                change,
                note(
                  [
                    "The lamp is joining " + name + ". If that's a different network, connect your phone to it too, then open ",
                    h("b", null, "http://" + hostName(info)),
                    ".",
                  ],
                  "good",
                ),
              );
            } catch (x) {
              if (!isCancel(x)) err.set(errMsg(x));
            } finally {
              busy(go, false);
            }
          },
        },
        ssid && ssid.el,
        pw && pw.el,
        err.el,
        h("div", { class: "row end" }, btn("Back", { kind: "ghost", onclick: startChange }), go),
      ),
    );
    (ssid || pw) && (ssid || pw)!.input.focus();
  }

  const direct = h("div", null, loading());
  const loadDirect = () =>
    admin<NetworkSettings>("GET", "/network").then(
      (ns) => {
        const t = toggle(
          "Direct mode always on",
          !!(ns && ns.ap_always_on),
          async (on) => {
            t.input.disabled = true;
            try {
              await admin("PUT", "/network", { ap_always_on: on });
              toast(on ? "Direct mode stays on" : "Direct mode turns on only when needed", "good");
            } catch (e) {
              t.input.checked = !on;
              if (!isCancel(e)) toast(errMsg(e), "bad");
            } finally {
              t.input.disabled = false;
            }
          },
          [
            "Keeps the lamp's own WiFi ",
            h("b", null, apName(info)),
            " up even while it's online, so a phone can always join it with the direct-mode password.",
          ],
        );
        fill(direct, t.el);
      },
      (e) => failed(direct, e, loadDirect),
    );
  loadDirect();

  fill(body, status, card("Change WiFi", change), card("Direct mode", direct));
}

// ---------------------------------------------------------------------------------- Apple Home

export function homekitSection(body: HTMLElement, info: DeviceInfo): void {
  const load = () => {
    fill(body, loading());
    admin<HomekitInfo>("GET", "/homekit").then(
      (hk) => render(hk),
      (e) => failed(body, e, load),
    );
  };
  const render = (hk: HomekitInfo) => {
    const n = hk.controllers || 0;
    const state: Child =
      hk.state === "paired"
        ? [icon("check", "ic sm"), " Added to Apple Home · " + n + (n === 1 ? " iPhone or iPad" : " iPhones or iPads") + " paired"]
        : hk.state === "unpaired"
          ? "Not added to Apple Home yet."
          : "Off: Apple Home runs only while the lamp is connected to your WiFi (not in direct mode).";
    const code = homekitCode(hk.setup_code, info.name, false);
    const reset = btn("Reset Apple Home", {
      kind: "danger wide",
      onclick: async () => {
        const ok = await confirmDialog({
          title: "Reset Apple Home?",
          text: "This removes every Apple Home pairing. The lamp disappears from the Home app on all iPhones and iPads; you can add it again with the same setup code.",
          ok: "Reset",
          danger: true,
        });
        if (!ok) return;
        busy(reset, true);
        try {
          await admin("POST", "/homekit/reset", {});
          toast("Apple Home pairings removed", "good");
          live.refreshInfo().catch(() => undefined);
          setTimeout(load, 1500);
        } catch (e) {
          if (!isCancel(e)) toast(errMsg(e), "bad");
        } finally {
          busy(reset, false);
        }
      },
    });
    fill(
      body,
      card("Status", h("p", null, state)),
      hk.state === "paired"
        ? card(
            "Setup code",
            h("p", { class: "hint" }, "Apple Home accepts a new pairing only while the lamp has none. To give someone else access, invite them to your home in the Home app."),
            h("details", { class: "more" }, h("summary", null, "Show setup code"), code),
          )
        : card("Add to Apple Home", code),
      card("Reset", h("p", { class: "hint" }, "Use this if the Home app shows the lamp as unresponsive after a reset, or to start over."), reset),
    );
  };
  load();
}

// ---------------------------------------------------------------------------------- Server

const CLAIM_ERR: Record<string, string> = {
  invalid_code: "That pairing code isn't valid. Check it, or make a new one in the web app.",
  code_expired: "That pairing code has expired. Make a new one in the web app (Settings → Add lamp).",
  rate_limited: "Too many attempts. Wait a minute and try again.",
};

export function serverSection(body: HTMLElement, info0: DeviceInfo): void {
  const render = (info: DeviceInfo) => {
    const c = info.cloud;
    const partner = ((c as { peers?: string[] }).peers || []).filter(Boolean).join(" and ") || c.group_name;
    const paired = !!c.url || c.state !== "off";
    if (paired) {
      const unpair = btn("Unpair", {
        kind: "danger wide",
        onclick: async () => {
          const ok = await confirmDialog({
            title: "Unpair from the server?",
            text: "The lamp keeps working on its own and with Apple Home, but linking, scenes, schedules and remote control stop until it's paired again.",
            ok: "Unpair",
            danger: true,
          });
          if (!ok) return;
          busy(unpair, true);
          try {
            await admin("DELETE", "/cloud", {});
            toast("Unpaired", "good");
            render(await live.refreshInfo());
          } catch (e) {
            if (!isCancel(e)) toast(errMsg(e), "bad");
          } finally {
            busy(unpair, false);
          }
        },
      });
      fill(
        body,
        card(
          "Status",
          kv([
            ["Connection", c.state === "online" ? "Online" : c.state === "connecting" ? "Connecting…" : "Off"],
            ["Server", c.url || "-"],
            ["Linked", c.linked ? "Yes" + (partner ? ", with " + partner : "") : "No"],
          ]),
          c.state === "connecting"
            ? h("p", { class: "hint" }, "The lamp keeps trying in the background. Local control and Apple Home work meanwhile.")
            : null,
        ),
        card("Unpair", unpair),
      );
      return;
    }
    const url = input({ label: "Server address", type: "url", inputmode: "url", placeholder: "https://lamps.example.com" });
    const code = input({
      label: "Pairing code",
      placeholder: "XXXX-XXXX",
      maxlength: 9,
      autocapitalize: "characters",
      hint: "Make one in the web app: Settings → Add lamp. Codes work once and expire after 10 minutes.",
      oninput: () => (code.input.value = normCode(code.input.value)),
    });
    const err = errorBox();
    const go = btn("Pair", { kind: "primary wide", type: "submit" });
    fill(
      body,
      card(
        "Pair with a server",
        h("p", { class: "hint" }, "Pairing links this lamp with its partner and lets the web app control it from anywhere."),
        h(
          "form",
          {
            class: "stack",
            novalidate: true,
            onsubmit: async (e: Event) => {
              e.preventDefault();
              err.set("");
              const [u, cd, msg] = checkServer(url.input.value, code.input.value, !!info.insecure_server_allowed);
              if (!u && !cd) return err.set("Enter the server address and a pairing code.");
              if (msg) return err.set(msg);
              busy(go, true);
              try {
                await admin("POST", "/cloud/claim", { server_url: u, code: cd }, { timeout: 30000 });
                toast("Paired with the server", "good");
                render(await live.refreshInfo());
              } catch (x) {
                if (!isCancel(x)) err.set((x instanceof ApiError && CLAIM_ERR[x.code]) || errMsg(x));
              } finally {
                busy(go, false);
              }
            },
          },
          url.el,
          code.el,
          err.el,
          go,
        ),
      ),
    );
  };
  render(info0);
  live.refreshInfo().then(render, () => undefined);
}

// ---------------------------------------------------------------------------------- Security

export function securitySection(body: HTMLElement, info: DeviceInfo): void {
  const cur = passwordInput({ label: "Current admin password", autocomplete: "current-password" });
  const a1 = passwordInput({ label: "New admin password", autocomplete: "new-password", maxlength: 63 });
  const a2 = passwordInput({ label: "Repeat new admin password", autocomplete: "new-password", maxlength: 63 });
  const p1 = passwordInput({ label: "New direct-mode password", autocomplete: "new-password", maxlength: 63 });
  const p2 = passwordInput({ label: "Repeat new direct-mode password", autocomplete: "new-password", maxlength: 63 });
  const err = errorBox();
  const go = btn("Save", { kind: "primary wide", type: "submit" });

  const check = (a: string, b: string, what: string) =>
    !a ? "" : a.length < 8 || a.length > 63 ? what + " needs 8 to 63 characters." : a !== b ? "The two " + what + "s don't match." : "";

  /** PUT /security answers 401 for a wrong current password and for a lost session: tell them apart. */
  async function put(req: object): Promise<void> {
    try {
      await api("PUT", "/security", req);
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      if (e.field === "current_password") throw new ApiError(401, "wrong", "The current password is wrong.");
      let sessionOk = true;
      try {
        await api("GET", "/network");
      } catch (x) {
        sessionOk = !(x instanceof ApiError && x.status === 401);
      }
      if (sessionOk) throw new ApiError(401, "wrong", "The current password is wrong.");
      session.clear();
      await askLogin();
      await api("PUT", "/security", req);
    }
  }

  fill(
    body,
    h(
      "form",
      {
        class: "stack",
        novalidate: true,
        onsubmit: async (e: Event) => {
          e.preventDefault();
          err.set("");
          const admin_password = a1.input.value;
          const ap_password = p1.input.value;
          const msg =
            (!cur.input.value ? "Enter the current admin password." : "") ||
            (!admin_password && !ap_password ? "Enter a new admin password, a new direct-mode password, or both." : "") ||
            check(admin_password, a2.input.value, "admin password") ||
            check(ap_password, p2.input.value, "direct-mode password");
          if (msg) return err.set(msg);
          const req: Record<string, string> = { current_password: cur.input.value };
          if (admin_password) req.admin_password = admin_password;
          if (ap_password) req.ap_password = ap_password;
          busy(go, true);
          try {
            await put(req);
            for (const p of [cur, a1, a2, p1, p2]) p.input.value = "";
            toast("Passwords updated", "good");
          } catch (x) {
            if (!isCancel(x)) err.set(errMsg(x));
          } finally {
            busy(go, false);
          }
        },
      },
      card("Current password", cur.el),
      card("Admin password", h("p", { class: "hint" }, "Protects these settings."), a1.el, a2.el),
      card(
        "Direct-mode password",
        h("p", { class: "hint" }, ["The WiFi password of the lamp's own network ", h("b", null, apName(info)), ". Leave empty to keep it."]),
        p1.el,
        p2.el,
      ),
      err.el,
      go,
    ),
  );
}

// ---------------------------------------------------------------------------------- Firmware

const SLOT_BYTES = 1920 * 1024; // one OTA slot (03 §15)

/** Polls /info until the lamp answers after a restart. Returns null after 3 minutes. */
export async function waitForRestart(before: DeviceInfo, newVersion: boolean): Promise<DeviceInfo | null> {
  const t0 = Date.now();
  let wentAway = false;
  await delay(3000);
  while (Date.now() - t0 < 180000) {
    try {
      const i = await api<DeviceInfo>("GET", "/info", undefined, { timeout: 3000 });
      if (newVersion && (i.fw !== before.fw || i.build !== before.build)) return i;
      if (wentAway || i.uptime_s < before.uptime_s) return i;
    } catch {
      wentAway = true;
    }
    await delay(2000);
  }
  return null;
}

function readHead(f: Blob): Promise<number> {
  return new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(new Uint8Array(r.result as ArrayBuffer)[0] || 0);
    r.onerror = () => res(-1);
    r.readAsArrayBuffer(f.slice(0, 1));
  });
}

export function firmwareSection(body: HTMLElement, info: DeviceInfo): void {
  const fileIn = h("input", { type: "file", accept: ".bin,application/octet-stream", class: "offscreen", id: "fw-file" });
  const pick = h("label", { class: "btn ghost wide", for: "fw-file" }, icon("upload"), "Choose a .bin file");
  const chosen = h("p", { class: "muted" });
  const err = errorBox();
  const bar = h("div", { class: "prog", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, hidden: true }, h("span"));
  const stage = h("p", { class: "status-line", "aria-live": "polite" });
  const go = btn("Install", { kind: "primary wide", disabled: true });
  let file: File | null = null;

  fileIn.addEventListener("change", async () => {
    err.set("");
    file = (fileIn.files && fileIn.files[0]) || null;
    go.disabled = true;
    if (!file) return fill(chosen);
    fill(chosen, file.name + " · " + Math.round(file.size / 1024) + " KB");
    if (file.size > SLOT_BYTES) return err.set("That file is larger than the lamp's firmware slot (1920 KB).");
    if ((await readHead(file)) !== 0xe9) return err.set("That doesn't look like an ESP32 firmware image (.bin).");
    go.disabled = false;
  });

  go.onclick = async () => {
    if (!file) return;
    const ok = await confirmDialog({
      title: "Install " + file.name + "?",
      text: "The lamp checks the file's signature, installs it and restarts. The light keeps running until the restart. If the new firmware doesn't start properly, the lamp goes back to version " + info.fw + " by itself.",
      ok: "Install",
    });
    if (!ok) return;
    if (!session.token) {
      try {
        await askLogin();
      } catch {
        return;
      }
    }
    err.set("");
    busy(go, true);
    pick.classList.add("dis");
    bar.hidden = false;
    const inner = bar.firstChild as HTMLElement;
    const before = await api<DeviceInfo>("GET", "/info").catch(() => info);
    try {
      await uploadFirmware(file, (sent, total) => {
        const p = Math.round((sent * 100) / (total || 1));
        inner.style.width = p + "%";
        bar.setAttribute("aria-valuenow", String(p));
        fill(stage, "Uploading… " + p + " %");
      });
    } catch (e) {
      busy(go, false);
      pick.classList.remove("dis");
      bar.hidden = true;
      fill(stage);
      err.set(e instanceof ApiError && e.status === 401 ? "Your login expired. Log in again and retry." : errMsg(e));
      if (e instanceof ApiError && e.status === 401) askLogin().catch(() => undefined);
      return;
    }
    inner.style.width = "100%";
    fill(stage, spinner(), " Installing. The lamp restarts in a moment…");
    session.clear(); // sessions live in RAM and end with the restart
    const after = await waitForRestart(before, true);
    live.reconnect();
    busy(go, false);
    pick.classList.remove("dis");
    fileIn.value = "";
    file = null;
    go.disabled = true;
    fill(chosen);
    if (!after) {
      fill(stage, "The lamp hasn't come back yet. Give it a minute, then reload this page.");
      return;
    }
    live.setInfo(after);
    paintInstalled(after);
    if (after.fw !== before.fw || after.build !== before.build) {
      fill(stage, icon("check", "ic sm"), " Updated to version " + after.fw + (after.build ? " (" + after.build + ")" : "") + ".");
    } else {
      fill(stage, "The lamp restarted but still runs version " + after.fw + ": the update was refused or rolled back. Check System → Logs.");
    }
  };

  const installed = h("div");
  const paintInstalled = (i: DeviceInfo) =>
    fill(
      installed,
      kv([
        ["Version", i.fw],
        ["Build", i.build || "-"],
        ["Protocol", String(i.proto)],
        ["Board", (i.hw.chip || "esp32c3").toUpperCase()],
      ]),
      i.insecure_server_allowed ? note("Development build", "warn") : null,
    );
  paintInstalled(info);

  fill(
    body,
    card("Installed", installed),
    card(
      "Update",
      h("p", { class: "hint" }, "Only firmware signed with the project key is accepted. Older versions are refused."),
      fileIn,
      pick,
      chosen,
      err.el,
      bar,
      stage,
      go,
    ),
  );
}

// ---------------------------------------------------------------------------------- System

export function systemSection(body: HTMLElement, info: DeviceInfo): void {
  const pre = h("pre", { class: "logs", tabindex: 0, "aria-label": "Lamp logs" }, "Loading…");
  const refresh = btn("Refresh", { kind: "ghost sm", icon: "refresh", onclick: () => loadLogs() });
  async function loadLogs() {
    busy(refresh, true);
    try {
      const t = await admin<string>("GET", "/logs", undefined, { text: true });
      pre.textContent = t || "(empty)";
      pre.scrollTop = pre.scrollHeight;
    } catch (e) {
      if (isCancel(e)) {
        location.hash = "#settings";
        return;
      }
      pre.textContent = errMsg(e);
    } finally {
      busy(refresh, false);
    }
  }
  loadLogs();

  const out = h("div", { "aria-live": "polite" });
  const reboot = btn("Restart", {
    kind: "ghost wide",
    onclick: async () => {
      if (!(await confirmDialog({ title: "Restart the lamp?", text: "The light goes out for a few seconds, then comes back as it was.", ok: "Restart" }))) return;
      busy(reboot, true);
      try {
        const before = await api<DeviceInfo>("GET", "/info").catch(() => info);
        await admin("POST", "/reboot", {});
        session.clear();
        fill(out, h("p", { class: "status-line" }, spinner(), " Restarting…"));
        const after = await waitForRestart(before, false);
        live.reconnect();
        fill(out, note(after ? "The lamp is back. Log in again to change settings." : "The lamp hasn't answered yet. Reload this page in a minute.", after ? "good" : "warn"));
      } catch (e) {
        if (!isCancel(e)) toast(errMsg(e), "bad");
      } finally {
        busy(reboot, false);
      }
    },
  });
  const reset = btn("Factory reset", {
    kind: "danger wide",
    onclick: async () => {
      const ok = await confirmDialog({
        title: "Factory reset?",
        text: "This erases everything on the lamp: WiFi, name, passwords, presets, the server pairing and all Apple Home pairings, and makes a new Apple Home code. The lamp then restarts in setup mode.",
        ok: "Erase everything",
        danger: true,
        typed: "RESET",
      });
      if (!ok) return;
      busy(reset, true);
      try {
        await admin("POST", "/factory-reset", {});
        session.clear();
        fill(
          body,
          card(
            "Erasing…",
            h("p", null, "The lamp restarts in setup mode. To set it up again, join the WiFi network ", h("b", null, apName(info)), " with your phone."),
          ),
        );
      } catch (e) {
        if (!isCancel(e)) toast(errMsg(e), "bad");
        busy(reset, false);
      }
    },
  });

  fill(
    body,
    card(h("span", { class: "row between grow" }, "Logs", refresh), pre),
    card("Restart", reboot, out),
    card("Factory reset", h("p", { class: "hint" }, "Same as holding the button for 10 s."), reset),
  );
}
