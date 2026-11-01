// The Apple Home setup code with the add-accessory steps (03 §11), shown on the setup "done" page
// and in Settings → Apple Home. The code comes only from GET /homekit, which needs admin auth.
import { h } from "../lib/dom";
import { icon } from "../ui/icons";
import { btn, copyText, toast } from "../ui/widgets";

export function homekitCode(code: string, lampName: string, afterSetup: boolean): HTMLElement {
  const digits = (code || "").replace(/\D/g, "");
  const copy = btn("Copy code", {
    kind: "ghost",
    icon: "copy",
    onclick: async () => {
      const ok = await copyText(digits);
      toast(ok ? "Code copied" : "Couldn't copy: press and hold the code to select it", ok ? "good" : "");
    },
  });
  return h(
    "div",
    { class: "hk" },
    h(
      "div",
      { class: "hk-box" },
      h("div", { class: "lbl" }, "Apple Home setup code"),
      h("div", { class: "hk-code", "aria-hidden": "true" }, code),
      h("span", { class: "sr" }, "Setup code: " + digits.split("").join(" ")),
      copy,
    ),
    h(
      "ol",
      { class: "steps" },
      h("li", null, afterSetup ? "Switch your phone back to your home WiFi." : "Make sure your iPhone is on the same WiFi as the lamp."),
      h("li", null, "Open the Home app, tap ", h("b", null, "+"), ", then ", h("b", null, "Add Accessory"), "."),
      h("li", null, "Tap ", h("b", null, "More options…"), " and pick ", h("b", null, lampName || "the lamp"), "."),
      h("li", null, "Enter the setup code."),
      h("li", null, "At the ", h("b", null, "Uncertified Accessory"), " prompt, tap ", h("b", null, "Add Anyway"), "."),
    ),
    h(
      "p",
      { class: "hint" },
      icon("alert", "ic sm"),
      " The warning appears because the lamp uses the open-source HomeKit stack. Apple Home works on the same WiFi only: there's no remote access without a home hub.",
    ),
  );
}
