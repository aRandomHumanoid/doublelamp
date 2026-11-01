// DoubleLamp device UI (docs/06-web-apps.md Part B): setup wizard, local control and settings,
// served by the lamp itself as one gzipped HTML file.
import "./styles.css";
import type { DeviceInfo, LampState } from "@doublelamp/protocol/local";
import { api, errMsg, onLoginNeeded } from "./lib/api";
import { fill, h } from "./lib/dom";
import { live } from "./live";
import { btn, askLogin, note, spinner } from "./ui/widgets";
import { controlView, loadEffects } from "./views/control";
import { settingsView } from "./views/settings";
import { startSetup } from "./views/setup";

const root = document.getElementById("app")!;
onLoginNeeded(askLogin);

async function boot(): Promise<void> {
  fill(root, h("p", { class: "boot" }, spinner(), " Connecting to the lamp…"));
  let info: DeviceInfo;
  try {
    info = await api<DeviceInfo>("GET", "/info");
  } catch (e) {
    fill(
      root,
      h(
        "main",
        { class: "page" },
        h("h1", null, "Can't reach the lamp"),
        note(errMsg(e), "bad"),
        h("p", { class: "muted" }, "Check that your phone is on the same WiFi as the lamp, or on the lamp's own WiFi."),
        btn("Try again", { kind: "primary", onclick: () => boot() }),
      ),
    );
    return;
  }
  if (info.setup_mode) startSetup(root, info, () => startApp(info));
  else startApp(info);
}

let started = false;

async function startApp(info: DeviceInfo): Promise<void> {
  if (started) return;
  started = true;
  fill(root, h("p", { class: "boot" }, spinner(), " Loading…"));
  const [state] = await Promise.all([
    api<LampState>("GET", "/state").catch(() => undefined),
    loadEffects().catch(() => undefined),
  ]);
  live.start(info, state);
  const control = controlView();
  const other = h("div", { hidden: true });
  fill(root, control.el, other);

  const route = () => {
    const hash = location.hash.replace(/^#\/?/, "");
    if (hash.lastIndexOf("settings", 0) === 0) {
      control.el.hidden = true;
      fill(other, settingsView(hash.split("/")[1] || ""));
      other.hidden = false;
      window.scrollTo(0, 0);
      const t = other.querySelector<HTMLElement>("h1");
      if (t) t.focus();
    } else {
      fill(other);
      other.hidden = true;
      control.el.hidden = false;
      control.shown();
    }
  };
  window.addEventListener("hashchange", route);
  route();
}

boot();
