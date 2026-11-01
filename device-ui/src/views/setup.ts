// Setup wizard (06 §B.2, 03 §8). Runs in the phone's captive-portal browser, so nothing is kept in
// browser storage: the answers live in memory and the connection progress lives on the lamp
// (GET /setup/status), which lets a reloaded page resume at the Connecting step.
import type { DeviceInfo, HomekitInfo, PowerPreset, SetupRequest, SetupStatus, WifiNetwork } from "@doublelamp/protocol/local";
import { ApiError, api, errMsg, login, session } from "../lib/api";
import { type Child, fill, h } from "../lib/dom";
import { icon } from "../ui/icons";
import { askLogin, btn, busy, errorBox, input, isCancel, note, passwordInput, spinner, toast } from "../ui/widgets";
import { homekitCode } from "./homekit";
import { type WifiPick, isOpen, wifiList } from "./wifi";

/** Supply choices and their current limits (02 §5). Duplicated from packages/protocol (no runtime imports). */
export const POWER: Array<[PowerPreset, string, number]> = [
  ["12v1a", "12 V 1 A", 600],
  ["12v2a", "12 V 2 A", 1400],
  ["12v3a", "12 V 3 A", 2200],
  ["12v5a", "12 V 5 A", 3800],
];
const SEG_M = 0.0625; // one 62.5 mm segment = one pixel (02 §3)
const MA_PER_PIXEL = 42; // full white, this strip (02 §5)

export const apName = (i: DeviceInfo) => "DoubleLamp-" + i.id.replace(/^dl-/, "").toUpperCase();
export const hostName = (i: DeviceInfo) => i.host || "doublelamp-" + i.id.replace(/^dl-/, "") + ".local";

export function normCode(s: string): string {
  // Crockford base32: O reads as 0, I and L as 1 (05 §8)
  const c = s.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1").slice(0, 8);
  return c.length > 4 ? c.slice(0, 4) + "-" + c.slice(4) : c;
}

/** Returns [normalized url, error]. */
export function checkServer(url: string, code: string, insecureOk: boolean): [string, string, string] {
  let u = url.trim();
  const c = normCode(code);
  if (!u && !c) return ["", "", ""];
  if (!u) return ["", c, "Enter the server address too."];
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = "https://" + u;
  u = u.replace(/\/+$/, "");
  let ok = true;
  try {
    ok = !!new URL(u).hostname;
  } catch {
    ok = false;
  }
  if (!ok) return [u, c, "That doesn't look like a web address."];
  if (/^(http|ws):/i.test(u) && !insecureOk) return [u, c, "Use an https:// address. Plain http:// works only with development firmware."];
  if (!/^(https?|wss?):/i.test(u)) return [u, c, "Use an https:// address."];
  if (!/^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c)) return [u, c, "The pairing code has 8 characters, like K7QM-4ZTX."];
  return [u, c, ""];
}

function utf8Len(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

export const meters = (seg: number) => String(+(seg * SEG_M).toFixed(4));
export const inches = (seg: number) => ((seg * SEG_M) / 0.0254).toFixed(1);

/** Smallest supply that runs the whole strip at full white without limiting. */
export function recommendedSupply(pixels: number): PowerPreset {
  const ma = pixels * MA_PER_PIXEL;
  for (const p of POWER) if (p[2] >= ma) return p[0];
  return "12v5a";
}

const REASONS: Record<string, [string, number]> = {
  wrong_password: ["The WiFi password is wrong.", 3],
  no_network: ["The lamp couldn't find that network. It only sees 2.4 GHz WiFi, so check that the network is 2.4 GHz and in range.", 2],
  no_ip: ["The lamp joined the network but didn't get an IP address. Check the router's DHCP settings or MAC filtering.", 2],
  timeout: ["Connecting took too long. The signal may be weak where the lamp is, or the password may be wrong.", 2],
};

interface Data {
  ssid: string;
  auth: string;
  hidden: boolean;
  password: string;
  name: string;
  admin: string;
  admin2: string;
  seg: number;
  power: PowerPreset | "custom";
  customMa: string;
  url: string;
  code: string;
}

export function startSetup(root: HTMLElement, info: DeviceInfo, onFinished: () => void): void {
  document.title = "Set up " + (info.name || "DoubleLamp");
  const d: Data = {
    ssid: "",
    auth: "wpa2",
    hidden: false,
    password: "",
    name: info.name && !/^doublelamp/i.test(info.name) ? info.name : "",
    admin: "",
    admin2: "",
    seg: 10,
    power: "12v1a",
    customMa: "",
    url: "",
    code: "",
  };
  /** Set once the answers were submitted; false after a reload (they're gone). */
  let haveAnswers = false;
  /** Came back to fix one answer after a failure: the step's button retries right away. */
  let fixing = false;
  let step = 1;
  let stepErr = "";
  let status: SetupStatus | null = null;
  let pollGen = 0;
  /** What the Connecting step currently shows, so polling only re-renders on a change. */
  let shown = "";

  const page = h("main", { class: "page wiz" });
  fill(root, page);

  function go(n: number, err = "") {
    if (n !== 7) pollGen++; // stop polling
    step = n;
    stepErr = err;
    shown = "";
    render();
    window.scrollTo(0, 0);
    // Move focus to the new step's heading, unless the step focused an input itself.
    const a = document.activeElement;
    if (!a || a === document.body || !page.contains(a)) {
      const t = page.querySelector<HTMLElement>("h1");
      if (t) t.focus();
    }
  }

  /** Lays out a step. Everything sits in one form, so Enter in a field presses the primary button. */
  function shell(title: string, body: Child[], actions: Child[], intro?: Child): void {
    const dots =
      step <= 6
        ? h(
            "div",
            { class: "dots", role: "img", "aria-label": "Step " + step + " of 6" },
            [1, 2, 3, 4, 5, 6].map((i) => h("i", { class: i < step ? "done" : i === step ? "on" : "" })),
          )
        : null;
    const err = errorBox();
    err.set(stepErr);
    fill(
      page,
      h(
        "form",
        { novalidate: true, onsubmit: (e: Event) => e.preventDefault() },
        h("div", { class: "wiz-top" }, h("span", { class: "brand" }, icon("bulb"), "DoubleLamp"), dots),
        h("h1", { tabindex: -1 }, title),
        intro ? h("p", { class: "lead" }, intro) : null,
        err.el,
        body,
        h("div", { class: "wiz-act" }, actions),
      ),
    );
  }

  const back =(n: number) => btn("Back", { kind: "ghost", icon: "back", onclick: () => go(n) });
  /** The primary button: continue, or retry straight away when fixing a failed attempt. */
  const next = (label: string, validate: () => string | null, to: number) =>
    btn(fixing ? "Try again" : label, {
      kind: "primary",
      type: "submit",
      onclick: (e) => {
        e.preventDefault();
        const err = validate();
        if (err) {
          stepErr = err;
          render();
          return;
        }
        if (fixing) submit();
        else go(to);
      },
    });

  function render(): void {
    switch (step) {
      case 1:
        return welcome();
      case 2:
        return wifi();
      case 3:
        return password();
      case 4:
        return nameStep();
      case 5:
        return strip();
      case 6:
        return server();
      case 7:
        return connecting();
      default:
        return done();
    }
  }

  // 1 ---------------------------------------------------------------------------------------
  function welcome() {
    const blink = btn("Blink", {
      kind: "ghost",
      icon: "bulb",
      onclick: async () => {
        busy(blink, true);
        try {
          await api("POST", "/identify", {});
          toast("Watch the lamp: it blinks three times.", "good");
        } catch (e) {
          toast(errMsg(e), "bad");
        } finally {
          busy(blink, false);
        }
      },
    });
    shell(
      "Let's connect your lamp",
      [
        h("p", null, "This takes about two minutes. Have your home WiFi password ready."),
        h("div", { class: "card row between" }, h("span", null, "Not sure which lamp this is?"), blink),
        note("You're connected to " + apName(info) + ", the lamp's setup WiFi.", "subtle"),
      ],
      [btn("Start", { kind: "primary", type: "submit", onclick: (e) => (e.preventDefault(), go(2)) })],
    );
  }

  // 2 ---------------------------------------------------------------------------------------
  function wifi() {
    const scan = () => api<WifiNetwork[]>("GET", "/wifi/scan", undefined, { timeout: 20000 });
    shell(
      "Choose your WiFi",
      [
        wifiList(scan, (p: WifiPick) => {
          const changed = p.ssid !== d.ssid || p.hidden !== d.hidden;
          d.ssid = p.ssid;
          d.auth = p.auth;
          d.hidden = p.hidden;
          if (changed) d.password = "";
          if (!p.hidden && isOpen(p.auth)) {
            d.password = "";
            if (fixing) submit();
            else go(4);
          } else go(3);
        }),
      ],
      [back(1)],
      "The lamp joins this network so you can use it from your phone and Apple Home.",
    );
  }

  // 3 ---------------------------------------------------------------------------------------
  function password() {
    const ssidIn = d.hidden ? input({ label: "Network name (SSID)", value: d.ssid, maxlength: 32 }) : null;
    const pw = passwordInput({
      label: "WiFi password",
      value: d.password,
      autocomplete: "off",
      hint: d.hidden ? "Leave empty if the network is open." : null,
    });
    const validate = () => {
      if (ssidIn) d.ssid = ssidIn.input.value.trim();
      d.password = pw.input.value;
      if (d.hidden && !d.ssid) return "Enter the network name.";
      if (utf8Len(d.ssid) > 32) return "Network names are at most 32 bytes.";
      if (d.password.length > 64) return "WiFi passwords are at most 64 characters.";
      if (!d.hidden && /^wpa/i.test(d.auth) && d.password.length < 8) return "WiFi passwords are at least 8 characters.";
      return null;
    };
    shell(
      d.hidden ? "Hidden network" : "Password for " + d.ssid,
      [h("div", { class: "stack" }, ssidIn && ssidIn.el, pw.el)],
      [back(2), next("Next", validate, 4)],
    );
    (ssidIn ? ssidIn.input : pw.input).focus();
  }

  // 4 ---------------------------------------------------------------------------------------
  function nameStep() {
    const nm = input({
      label: "Lamp name",
      value: d.name,
      maxlength: 32,
      placeholder: "e.g. Lamp A",
      autocapitalize: "words",
      hint: "Shown in the web app and in Apple Home.",
    });
    const a1 = passwordInput({ label: "Admin password", value: d.admin, autocomplete: "new-password", maxlength: 63 });
    const a2 = passwordInput({ label: "Repeat admin password", value: d.admin2, autocomplete: "new-password", maxlength: 63 });
    const validate = () => {
      d.name = nm.input.value.trim();
      d.admin = a1.input.value;
      d.admin2 = a2.input.value;
      if (!d.name) return "Give the lamp a name.";
      if (d.name.length > 32) return "Names are at most 32 characters.";
      if (d.admin.length < 8) return "The admin password needs at least 8 characters.";
      if (d.admin.length > 63) return "The admin password can have at most 63 characters.";
      if (d.admin !== d.admin2) return "The two passwords don't match.";
      return null;
    };
    shell(
      "Name and admin password",
      [
        h("div", { class: "stack" }, nm.el, a1.el, a2.el),
        note(
          [
            "The admin password protects the lamp's settings. It's also the password of the lamp's own WiFi, ",
            h("b", null, apName(info)),
            ", which you can join when your home WiFi is down (direct mode).",
          ],
          "subtle",
        ),
      ],
      [back(d.hidden || !isOpen(d.auth) ? 3 : 2), next("Next", validate, 5)],
    );
  }

  // 5 ---------------------------------------------------------------------------------------
  function strip() {
    const len = input({
      label: "Strip length in meters",
      type: "text",
      inputmode: "decimal",
      value: meters(d.seg),
      oninput: () => {
        const m = parseFloat(len.input.value.replace(",", "."));
        if (m > 0) {
          d.seg = Math.max(1, Math.min(1024, Math.round(m / SEG_M)));
          readout();
        }
      },
    });
    len.input.addEventListener("blur", () => (len.input.value = meters(d.seg)));
    const out = h("div", { class: "readout", "aria-live": "polite" });
    const rec = h("div", { class: "hint" });
    const step1 = (dir: number) => () => {
      d.seg = Math.max(1, Math.min(1024, d.seg + dir));
      len.input.value = meters(d.seg);
      readout();
    };
    const radios = h("div", { class: "radios", role: "radiogroup", "aria-label": "Power supply" });
    const custom = input({
      label: "Current limit (mA)",
      type: "number",
      inputmode: "numeric",
      min: 100,
      max: 20000,
      value: d.customMa,
      hint: "About 80 % of the supply's rating, minus 200 mA for the electronics.",
    });
    function paintRadios() {
      const opts: Array<[PowerPreset | "custom", string, string]> = POWER.map(
        (p) => [p[0], p[1], "Limit " + p[2] + " mA"] as [PowerPreset, string, string],
      );
      opts.push(["custom", "Custom", "Enter a limit"]);
      fill(
        radios,
        opts.map(([id, t, sub]) =>
          h(
            "button",
            {
              type: "button",
              role: "radio",
              class: "radio" + (d.power === id ? " on" : ""),
              "aria-checked": String(d.power === id),
              onclick: () => {
                d.power = id;
                paintRadios();
                if (id === "custom") custom.input.focus();
              },
            },
            h("b", null, t),
            h("small", null, sub),
          ),
        ),
      );
      custom.el.hidden = d.power !== "custom";
    }
    function readout() {
      fill(out, h("b", null, d.seg + (d.seg === 1 ? " pixel" : " pixels")), " · " + inches(d.seg) + " in");
      const r = recommendedSupply(d.seg);
      const label = POWER.filter((p) => p[0] === r)[0]![1];
      fill(rec, "At full white this strip draws about " + ((d.seg * MA_PER_PIXEL) / 1000).toFixed(2) + " A. Recommended: " + label + ".");
    }
    readout();
    paintRadios();
    const validate = () => {
      d.customMa = custom.input.value;
      if (d.power === "custom") {
        const ma = Number(d.customMa);
        if (!(ma >= 100 && ma <= 20000) || Math.round(ma) !== ma) return "Enter a current limit from 100 to 20000 mA.";
      }
      return null;
    };
    shell(
      "Strip and power supply",
      [
        h(
          "div",
          { class: "stack" },
          h("div", { class: "len" }, btn("−", { kind: "ghost sq", label: "One segment shorter", onclick: step1(-1) }), len.el, btn("+", { kind: "ghost sq", label: "One segment longer", onclick: step1(1) })),
          out,
          h("div", { class: "hint" }, "The strip can be cut every 62.5 mm, and each segment is one pixel. This build uses 0.625 m (10 pixels)."),
          h("div", { class: "lbl" }, "Power supply"),
          radios,
          custom.el,
          rec,
        ),
      ],
      [back(4), next("Next", validate, 6)],
    );
  }

  // 6 ---------------------------------------------------------------------------------------
  function server() {
    const url = input({
      label: "Server address",
      type: "url",
      inputmode: "url",
      value: d.url,
      placeholder: "https://lamps.example.com",
    });
    const code = input({
      label: "Pairing code",
      value: d.code,
      placeholder: "XXXX-XXXX",
      maxlength: 9,
      autocapitalize: "characters",
      hint: "Get one in the web app: Settings → Add lamp. Codes work once and expire after 10 minutes.",
      oninput: () => (code.input.value = normCode(code.input.value)),
    });
    const validate = () => {
      const [u, c, err] = checkServer(url.input.value, code.input.value, !!info.insecure_server_allowed);
      d.url = u;
      d.code = c;
      return err || null;
    };
    const skip = btn("Skip: I'll use it on its own", {
      kind: "ghost wide",
      onclick: () => {
        d.url = "";
        d.code = "";
        submit();
      },
    });
    shell(
      "Server (optional)",
      [h("div", { class: "stack" }, url.el, code.el), skip],
      [
        back(5),
        btn("Connect", {
          kind: "primary",
          type: "submit",
          onclick: (e) => {
            e.preventDefault();
            const err = validate();
            if (err) {
              stepErr = err;
              server();
              return;
            }
            submit();
          },
        }),
      ],
      "With a server the lamp can be linked to its partner and controlled from anywhere. You can also pair it later in Settings.",
    );
  }

  // 7 ---------------------------------------------------------------------------------------
  function request(): SetupRequest {
    const r: SetupRequest = {
      ssid: d.ssid,
      password: d.password,
      name: d.name,
      admin_password: d.admin,
      strip_m: d.seg * SEG_M,
      power: d.power === "custom" ? { max_current_ma: Math.round(Number(d.customMa)) } : { preset: d.power },
    };
    if (d.url && d.code) {
      r.server_url = d.url;
      r.pairing_code = d.code;
    }
    return r;
  }

  const FIELD_STEP: Record<string, number> = {
    ssid: 2,
    password: 3,
    name: 4,
    admin_password: 4,
    strip_m: 5,
    power: 5,
    max_current_ma: 5,
    preset: 5,
    server_url: 6,
    pairing_code: 6,
  };

  async function submit() {
    fixing = false;
    status = { state: "connecting" };
    go(7);
    try {
      await api("POST", "/setup", request(), { timeout: 15000 });
      haveAnswers = true;
      poll();
    } catch (e) {
      if (e instanceof ApiError && e.field && FIELD_STEP[e.field]) {
        let s = FIELD_STEP[e.field]!;
        if (s === 2 && d.hidden) s = 3;
        fixing = s !== 6;
        haveAnswers = true;
        go(s, e.message);
      } else if (e instanceof ApiError && e.status === 409) {
        // already connecting (a double tap, or another phone): follow along
        haveAnswers = true;
        poll();
      } else if (e instanceof ApiError && e.status === 403) {
        status = { state: "failed", reason: "not_setup" };
        connecting(errMsg(e) + " The lamp isn't in setup mode anymore: reload this page.");
      } else {
        status = { state: "failed", reason: "submit" };
        connecting(errMsg(e));
      }
    }
  }

  function poll() {
    const gen = ++pollGen;
    let fails = 0;
    let lastOk = Date.now();
    let claimSince = 0;
    let idleSince = 0;
    const tick = async () => {
      if (gen !== pollGen) return;
      try {
        const st = await readStatus();
        if (gen !== pollGen) return;
        fails = 0;
        lastOk = Date.now();
        status = st;
        if (st.state === "online") {
          if (st.cloud === "claiming" && (claimSince = claimSince || Date.now()) > Date.now() - 30000) {
            connecting();
          } else {
            go(8);
            return;
          }
        } else if (st.state === "failed") {
          pollGen++;
          connecting();
          return;
        } else if (st.state === "idle" && (idleSince = idleSince || Date.now()) < Date.now() - 10000) {
          pollGen++;
          status = { state: "failed", reason: "idle" };
          connecting("The lamp didn't start connecting.");
          return;
        } else {
          connecting();
        }
      } catch {
        if (gen !== pollGen) return;
        fails++;
        if (fails >= 3) connecting(undefined, Date.now() - lastOk);
      }
      setTimeout(tick, fails ? 2000 : 1000);
    };
    tick();
  }

  function connecting(extraErr?: string, lostMs = 0) {
    if (step !== 7) {
      step = 7;
      stepErr = "";
    }
    const st = status || { state: "connecting" };
    const key = [st.state, st.reason, st.cloud, extraErr, lostMs > 0, lostMs > 90000].join("|");
    if (key === shown) return;
    shown = key;
    const target = d.ssid || "your WiFi";
    let body: Child[];
    let actions: Child[] = [];
    let title = "Connecting…";
    if (st.state === "failed") {
      title = "Couldn't connect";
      const r = REASONS[st.reason || ""];
      const fixStep = r ? r[1] : 2;
      body = [
        h("div", { class: "err big", role: "alert" }, icon("alert"), h("span", null, extraErr || (r ? r[0] : "Setup failed" + (st.reason ? " (" + st.reason + ")." : ".")))),
        haveAnswers ? null : note("This page was reloaded, so please enter the setup details again.", "subtle"),
      ];
      actions = [
        btn("Back", {
          kind: haveAnswers ? "ghost" : "primary",
          icon: "back",
          onclick: () => {
            fixing = haveAnswers && fixStep !== 6;
            go(haveAnswers ? (fixStep === 2 && d.hidden ? 3 : fixStep) : 2);
          },
        }),
        haveAnswers ? btn("Try again", { kind: "primary", onclick: () => submit() }) : null,
      ];
    } else if (st.state === "online") {
      title = "Connected";
      body = [h("p", { class: "status-line" }, spinner(), " Joined " + target + ". Pairing with the server…")];
    } else {
      body = [
        h("p", { class: "status-line" }, spinner(), " Joining " + target + "…"),
        h("p", { class: "muted" }, "The lamp keeps its setup WiFi on while it connects. This usually takes 10 to 30 seconds."),
      ];
      if (lostMs) {
        body.push(
          note(
            [
              "Lost contact with the lamp. Your phone may have left ",
              h("b", null, apName(info)),
              ": rejoin it in your WiFi settings and this page continues. ",
              lostMs > 90000
                ? ["If the lamp already connected, find it on your home WiFi at ", h("b", null, "http://" + hostName(info)), "."]
                : null,
            ],
            "warn",
          ),
        );
      }
    }
    shell(title, body, actions);
  }

  // 8 ---------------------------------------------------------------------------------------
  let hk: HomekitInfo | null = null;
  let hkPromise: Promise<HomekitInfo> | null = null;
  let lampName = info.name;

  function fetchHomekit(): Promise<HomekitInfo> {
    if (!hkPromise) {
      hkPromise = (async () => {
        if (!session.token) {
          if (haveAnswers && d.admin) await login(d.admin);
          else await askLogin();
        }
        hk = await api<HomekitInfo>("GET", "/homekit");
        // the name the lamp has now (setup just set it; a reloaded page only knows the old one)
        const i = await api<DeviceInfo>("GET", "/info").catch(() => null);
        if (i && i.name) lampName = i.name;
        return hk;
      })();
      hkPromise.catch(() => (hkPromise = null));
    }
    return hkPromise;
  }

  function done() {
    const st = status || { state: "online" };
    const host = st.host || hostName(info);
    const ip = st.ip || "";
    const hkBox = h("div");
    const hkBtn = btn("Add to Apple Home", {
      kind: "ghost wide",
      icon: "home",
      onclick: async () => {
        busy(hkBtn, true);
        try {
          const r = await fetchHomekit();
          hkBtn.hidden = true;
          fill(hkBox, homekitCode(r.setup_code, d.name || lampName, true));
        } catch (e) {
          if (!isCancel(e))
            fill(
              hkBox,
              note(
                e instanceof ApiError && e.status === 0
                  ? "The lamp's setup WiFi has closed. On your home WiFi, open http://" + host + " → Settings → Apple Home to see the code."
                  : errMsg(e),
                "bad",
              ),
            );
        } finally {
          busy(hkBtn, false);
        }
      },
    });
    // Fetch the code right away: the setup WiFi closes about a minute after success (03 §8).
    if (haveAnswers) fetchHomekit().catch(() => undefined);

    const cloud =
      st.cloud === "online"
        ? note([icon("check", "ic sm"), " Paired with your server."], "good")
        : st.cloud === "failed"
          ? note("Couldn't pair with the server" + (st.cloud_error ? ": " + st.cloud_error : ".") + " You can pair it later in Settings → Server.", "warn")
          : st.cloud === "claiming"
            ? note("Still pairing with the server. Check Settings → Server later.", "subtle")
            : null;

    shell(
      "Your lamp is ready",
      [
        h(
          "div",
          { class: "card addr" },
          h("div", { class: "lbl" }, "Open it at"),
          // <wbr>: let a narrow screen break the address at "//" or before ".local", not mid-word
          h("div", { class: "big-addr" }, "http://", h("wbr"), host.replace(/\.local$/, ""), h("wbr"), /\.local$/.test(host) ? ".local" : ""),
          ip ? h("div", { class: "muted" }, "or http://" + ip) : null,
          h(
            "div",
            { class: "row" },
            h("a", { class: "btn primary", href: "http://" + host + "/" }, "Open lamp"),
            ip ? h("a", { class: "btn ghost", href: "http://" + ip + "/" }, "Open by IP") : null,
          ),
          h(
            "p",
            { class: "hint" },
            "Switch your phone back to your home WiFi first. Then bookmark the page, or add it to your home screen. On Android, the IP address may work when the .local name doesn't.",
          ),
        ),
        cloud,
        h("section", { class: "card" }, h("h2", { class: "card-t" }, icon("home"), " Apple Home"), hkBtn, hkBox),
        note("The lamp's setup WiFi " + apName(info) + " closes about a minute after setup.", "subtle"),
      ],
      [],
    );
  }

  /**
   * GET /setup/status. Setup-only routes answer 403 once the lamp has left setup mode (07 §4.5),
   * which after a successful setup means it is online: read the address from /info instead.
   */
  async function readStatus(): Promise<SetupStatus> {
    try {
      return await api<SetupStatus>("GET", "/setup/status", undefined, { timeout: 4000 });
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 403) throw e;
      const i = await api<DeviceInfo>("GET", "/info", undefined, { timeout: 4000 });
      if (i.setup_mode) throw e;
      return { state: "online", ip: i.net.ip, host: i.host || hostName(i), cloud: status ? status.cloud : undefined };
    }
  }

  // Resume: the lamp knows whether setup is already running (the page may have been reloaded).
  readStatus().then(
    (st) => {
      if (!st || st.state === "idle") return go(1);
      status = st;
      // Opened from the home network after setup finished: go straight to the lamp.
      if (st.state === "online" && location.hostname !== "192.168.4.1") return onFinished();
      if (st.state === "online") return go(8);
      step = 7;
      if (st.state === "failed") connecting();
      else {
        connecting();
        poll();
      }
    },
    () => go(1),
  );
  fill(page, h("p", { class: "boot" }, spinner(), " Loading…"));
}
