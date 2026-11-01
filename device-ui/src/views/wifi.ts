// WiFi network picker, shared by the setup wizard (step 2) and Settings → Network.
import type { WifiNetwork } from "@doublelamp/protocol/local";
import { errMsg } from "../lib/api";
import { fill, h } from "../lib/dom";
import { bars, icon, rssiLevel } from "../ui/icons";
import { btn, busy, spinner } from "../ui/widgets";

export interface WifiPick {
  ssid: string;
  auth: string;
  hidden: boolean;
}

export const isOpen = (auth: string) => auth === "open" || auth === "";
const isEnterprise = (auth: string) => auth.indexOf("enterprise") >= 0 || auth === "eap";

/** Strongest entry per SSID, hidden (empty) SSIDs dropped, strongest first. */
export function tidy(list: WifiNetwork[]): WifiNetwork[] {
  const best: Record<string, WifiNetwork> = {};
  for (const n of Array.isArray(list) ? list : []) {
    if (!n || !n.ssid) continue;
    const b = best[n.ssid];
    if (!b || n.rssi > b.rssi) best[n.ssid] = n;
  }
  return Object.keys(best)
    .map((k) => best[k]!)
    .sort((a, b) => b.rssi - a.rssi);
}

export function wifiList(scan: () => Promise<WifiNetwork[]>, onPick: (p: WifiPick) => void, current?: string): HTMLElement {
  const list = h("ul", { class: "list", "aria-label": "WiFi networks" });
  const statusEl = h("div", { class: "muted sm", role: "status" });
  const rescan = btn("Rescan", { kind: "ghost sm", icon: "refresh", onclick: () => run() });
  const hidden = h(
    "button",
    { type: "button", class: "item", onclick: () => onPick({ ssid: "", auth: "wpa2", hidden: true }) },
    icon("plus"),
    h("span", { class: "grow" }, "Hidden network…"),
  );
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    busy(rescan, true);
    fill(statusEl, spinner(), " Looking for networks… this takes a few seconds.");
    try {
      const nets = tidy(await scan());
      fill(
        list,
        nets.map((n) => {
          const ent = isEnterprise(n.auth);
          const lock = !isOpen(n.auth);
          return h(
            "li",
            null,
            h(
              "button",
              {
                type: "button",
                class: "item",
                disabled: ent,
                "aria-label":
                  n.ssid +
                  (lock ? ", secured" : ", open") +
                  ", " +
                  ["no", "weak", "fair", "good", "excellent"][rssiLevel(n.rssi)] +
                  " signal" +
                  (ent ? ", not supported" : "") +
                  (n.ssid === current ? ", current network" : ""),
                onclick: () => onPick({ ssid: n.ssid, auth: n.auth, hidden: false }),
              },
              bars(n.rssi),
              h(
                "span",
                { class: "grow" },
                h("span", { class: "ssid" }, n.ssid),
                ent ? h("small", null, "Enterprise WiFi isn't supported yet") : null,
                n.ssid === current ? h("small", null, "Current network") : null,
              ),
              lock ? icon("lock", "ic dim") : null,
              icon("next", "ic dim"),
            ),
          );
        }),
        h("li", null, hidden),
      );
      fill(
        statusEl,
        nets.length
          ? "The lamp only sees 2.4 GHz networks."
          : "No networks found. Check that your router's 2.4 GHz band is on, then rescan.",
      );
    } catch (e) {
      fill(list, h("li", null, hidden));
      fill(statusEl, "Scan failed: " + errMsg(e));
    } finally {
      running = false;
      busy(rescan, false);
    }
  }

  run();
  return h("div", { class: "wifi" }, h("div", { class: "row between" }, statusEl, rescan), list);
}
