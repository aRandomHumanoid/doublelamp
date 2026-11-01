// Settings (06 §B.3): admin login, then one page per section. The token stays in memory only.
import type { DeviceInfo } from "@doublelamp/protocol/local";
import { api, errMsg, logout, session } from "../lib/api";
import { type Child, fill, h } from "../lib/dom";
import { live } from "../live";
import { type IconName, icon, svg } from "../ui/icons";
import { btn, busy, card, kv, loginForm, note, spinner, toast } from "../ui/widgets";
import { ledsSection } from "./settings-leds";
import {
  firmwareSection,
  homekitSection,
  networkSection,
  securitySection,
  serverSection,
  systemSection,
} from "./settings-more";

export interface Section {
  id: string;
  title: string;
  icon: IconName;
  sub: (i: DeviceInfo) => string;
  render: (body: HTMLElement, info: DeviceInfo) => void;
}

const CLOUD: Record<string, string> = { off: "Not paired", connecting: "Connecting…", online: "Online" };

export const SECTIONS: Section[] = [
  {
    id: "leds",
    title: "LEDs",
    icon: "strip",
    sub: (i) => i.hw.pixels + " pixels" + (i.hw.color_order ? " · " + i.hw.color_order : ""),
    render: ledsSection,
  },
  {
    id: "network",
    title: "Network",
    icon: "wifi",
    sub: (i) => (i.net.mode === "ap" ? "Direct mode only" : (i.net.ssid || "Not connected") + (i.net.rssi ? " · " + i.net.rssi + " dBm" : "")),
    render: networkSection,
  },
  {
    id: "homekit",
    title: "Apple Home",
    icon: "home",
    sub: (i) =>
      !i.homekit
        ? ""
        : i.homekit.state === "paired"
          ? "Added · " + i.homekit.controllers + " paired"
          : i.homekit.state === "unpaired"
            ? "Not added yet"
            : "Off",
    render: homekitSection,
  },
  {
    id: "server",
    title: "Server",
    icon: "cloud",
    sub: (i) =>
      (i.cloud.url || i.cloud.state !== "off" ? CLOUD[i.cloud.state] || i.cloud.state : "Not paired") + (i.cloud.linked ? " · linked" : ""),
    render: serverSection,
  },
  { id: "security", title: "Security", icon: "shield", sub: () => "Admin and direct-mode passwords", render: securitySection },
  { id: "firmware", title: "Firmware", icon: "upload", sub: (i) => "Version " + i.fw, render: firmwareSection },
  { id: "system", title: "System", icon: "term", sub: () => "Logs, restart, factory reset", render: systemSection },
];

export function uptime(s: number): string {
  const d = Math.floor(s / 86400);
  const hr = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? d + " d " + hr + " h" : hr ? hr + " h " + m + " min" : m + " min";
}

function top(title: string, backHref: string, backLabel: string): HTMLElement {
  return h(
    "header",
    { class: "top" },
    h(
      "div",
      { class: "top-l" },
      h("a", { class: "ib", href: backHref, "aria-label": backLabel, title: backLabel, html: svg("back") }),
      h("h1", { class: "top-t", tabindex: -1 }, title),
    ),
  );
}

export function settingsView(sectionId: string): HTMLElement {
  const sec = SECTIONS.filter((s) => s.id === sectionId)[0];
  const page = h("main", { class: "page" });

  if (!session.token) {
    fill(
      page,
      top("Settings", "#", "Back to the lamp"),
      card(
        null,
        loginForm(() => {
          fill(page, settingsView(sectionId));
          const t = page.querySelector<HTMLElement>("h1");
          if (t) t.focus();
        }, "Settings are protected by the admin password you chose during setup."),
      ),
    );
    return page;
  }

  const info = live.info;
  if (!info) {
    fill(page, top("Settings", "#", "Back to the lamp"), h("p", { class: "boot" }, spinner(), " Loading…"));
    return page;
  }

  if (sec) {
    const body = h("div", { class: "sec-body" });
    fill(page, top(sec.title, "#settings", "Back to settings"), body);
    sec.render(body, info);
    return page;
  }

  const blink = btn("Blink", {
    kind: "ghost sm",
    icon: "bulb",
    onclick: async () => {
      busy(blink, true);
      try {
        await api("POST", "/identify", {});
      } catch (e) {
        toast(errMsg(e), "bad");
      } finally {
        busy(blink, false);
      }
    },
  });
  const rows: Array<[string, Child]> = [
    ["Name", info.name],
    ["ID", info.id],
    ["Address", info.net.ip ? info.net.ip + (info.host ? " · " + info.host : "") : "-"],
    ["Up for", uptime(info.uptime_s || 0)],
  ];
  fill(
    page,
    top("Settings", "#", "Back to the lamp"),
    h("section", { class: "card" }, h("div", { class: "row between" }, h("h2", { class: "card-t" }, "This lamp"), blink), kv(rows)),
    info.insecure_server_allowed ? note("Development build: accepts unencrypted server addresses.", "warn") : null,
    h(
      "nav",
      { class: "list card", "aria-label": "Settings sections" },
      SECTIONS.map((s) =>
        h(
          "a",
          { class: "item", href: "#settings/" + s.id },
          icon(s.icon),
          h("span", { class: "grow" }, h("span", { class: "ssid" }, s.title), h("small", null, s.sub(info))),
          icon("next", "ic dim"),
        ),
      ),
    ),
    btn("Log out", {
      kind: "ghost wide",
      onclick: async () => {
        await logout().catch(() => undefined);
        location.hash = "";
      },
    }),
  );
  return page;
}
