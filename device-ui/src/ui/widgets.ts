// Shared widgets: buttons, form fields, toasts and in-page dialogs.
// No window.alert/confirm/prompt: captive-portal webviews may not show them (06 §B.1).
import { ApiError, errMsg, login } from "../lib/api";
import { type Child, h, nextId } from "../lib/dom";
import { type IconName, icon, svg } from "./icons";

export interface BtnOpts {
  kind?: string;
  icon?: IconName;
  type?: "button" | "submit";
  onclick?: (e: MouseEvent) => void;
  label?: string;
  disabled?: boolean;
}

export function btn(text: Child, o: BtnOpts = {}): HTMLButtonElement {
  return h(
    "button",
    {
      type: o.type || "button",
      class: "btn" + (o.kind ? " " + o.kind : ""),
      onclick: o.onclick,
      "aria-label": o.label,
      disabled: o.disabled,
    },
    o.icon ? icon(o.icon) : null,
    text,
  );
}

/** Icon-only button with an accessible label. */
export function ibtn(name: IconName, label: string, onclick: (e: MouseEvent) => void, cls = ""): HTMLButtonElement {
  return h("button", { type: "button", class: "ib " + cls, "aria-label": label, title: label, onclick, html: svg(name) });
}

/** Marks a button as working: disabled, with a spinner. */
export function busy(b: HTMLButtonElement, on: boolean): void {
  b.disabled = on;
  b.classList.toggle("busy", on);
  b.setAttribute("aria-busy", String(on));
}

export function spinner(): HTMLSpanElement {
  return h("span", { class: "spin", "aria-hidden": "true" });
}

export function field(label: Child, control: Child, hint?: Child, forId?: string): HTMLDivElement {
  return h(
    "div",
    { class: "field" },
    h("label", { class: "lbl", for: forId }, label),
    control,
    hint ? h("div", { class: "hint" }, hint) : null,
  );
}

export interface InputOpts {
  label: string;
  value?: string | number;
  type?: string;
  hint?: Child;
  placeholder?: string;
  autocomplete?: string;
  inputmode?: string;
  min?: number;
  max?: number;
  step?: number | string;
  maxlength?: number;
  autocapitalize?: string;
  oninput?: (e: Event) => void;
}

export function input(o: InputOpts): { el: HTMLDivElement; input: HTMLInputElement } {
  const id = nextId("in");
  const inp = h("input", {
    class: "in",
    id,
    type: o.type || "text",
    min: o.min,
    max: o.max,
    step: o.step,
    value: o.value == null ? "" : String(o.value),
    placeholder: o.placeholder,
    autocomplete: o.autocomplete || "off",
    inputmode: o.inputmode,
    maxlength: o.maxlength,
    autocapitalize: o.autocapitalize || "off",
    autocorrect: "off",
    spellcheck: "false",
    oninput: o.oninput,
  });
  return { el: field(o.label, inp, o.hint, id), input: inp };
}

export function passwordInput(o: InputOpts): { el: HTMLDivElement; input: HTMLInputElement } {
  const id = nextId("pw");
  const inp = h("input", {
    class: "in",
    id,
    type: "password",
    value: o.value == null ? "" : String(o.value),
    placeholder: o.placeholder,
    autocomplete: o.autocomplete || "off",
    autocapitalize: "off",
    autocorrect: "off",
    spellcheck: "false",
    maxlength: o.maxlength,
    oninput: o.oninput,
  });
  const eye: HTMLButtonElement = ibtn(
    "eye",
    "Show password",
    () => {
      const showing = inp.type === "text";
      inp.type = showing ? "password" : "text";
      eye.innerHTML = svg(showing ? "eye" : "eyeOff");
      eye.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      eye.setAttribute("aria-pressed", String(!showing));
    },
    "in-btn",
  );
  eye.setAttribute("aria-pressed", "false");
  return { el: field(o.label, h("div", { class: "in-wrap" }, inp, eye), o.hint, id), input: inp };
}

export function select(
  label: string,
  options: Array<[string, string]>,
  value: string,
  hint?: Child,
  onchange?: (v: string) => void,
): { el: HTMLDivElement; input: HTMLSelectElement } {
  const id = nextId("se");
  const s = h(
    "select",
    { class: "in", id, onchange: onchange ? () => onchange(s.value) : undefined },
    options.map(([v, t]) => h("option", { value: v, selected: v === value }, t)),
  );
  s.value = value;
  return { el: field(label, s, hint, id), input: s };
}

/** A switch: a styled checkbox inside its label row. */
export function toggle(label: Child, checked: boolean, onchange: (on: boolean) => void, hint?: Child) {
  const id = nextId("sw");
  const cb = h("input", { type: "checkbox", class: "sw", id, checked, onchange: () => onchange(cb.checked) });
  const el = h(
    "div",
    { class: "field" },
    h("div", { class: "sw-row" }, h("label", { for: id, class: "lbl" }, label), cb),
    hint ? h("div", { class: "hint" }, hint) : null,
  );
  return { el, input: cb };
}

export function errorBox(): { el: HTMLDivElement; set(msg: string): void } {
  const el = h("div", { class: "err", role: "alert", hidden: true });
  return {
    el,
    set(msg: string) {
      el.textContent = msg;
      el.hidden = !msg;
    },
  };
}

export function note(text: Child, kind = ""): HTMLDivElement {
  return h("div", { class: "note " + kind }, text);
}

// ---------- toasts ----------

let toastBox: HTMLElement | null = null;

export function toast(msg: string, kind: "" | "bad" | "good" = ""): void {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.appendChild(toastBox);
  }
  const t = h("div", { class: "toast " + kind }, msg);
  toastBox.appendChild(t);
  while (toastBox.childNodes.length > 3) toastBox.removeChild(toastBox.firstChild!);
  setTimeout(() => t.classList.add("out"), 3800);
  setTimeout(() => t.parentNode && t.parentNode.removeChild(t), 4200);
}

// ---------- dialogs ----------

export interface Modal {
  el: HTMLElement;
  close(): void;
}

export function modal(title: string, body: Child[], onCancel?: () => void): Modal {
  const id = nextId("dlg");
  const prev = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    ov.parentNode && ov.parentNode.removeChild(ov);
    document.body.classList.remove("noscroll");
    if (prev && prev.focus) prev.focus();
  };
  const cancel = () => {
    close();
    if (onCancel) onCancel();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") cancel();
  };
  const dlg = h(
    "div",
    { class: "dlg", role: "dialog", "aria-modal": "true", "aria-labelledby": id },
    h("div", { class: "dlg-head" }, h("h2", { id }, title), ibtn("close", "Close", cancel)),
    body,
  );
  const ov = h("div", { class: "ov", onclick: (e: MouseEvent) => e.target === ov && cancel() }, dlg);
  document.body.appendChild(ov);
  document.body.classList.add("noscroll");
  document.addEventListener("keydown", onKey);
  const first = dlg.querySelector<HTMLElement>("input,select,textarea,.btn");
  if (first) first.focus();
  return { el: dlg, close };
}

export interface ConfirmOpts {
  title: string;
  text: Child;
  ok: string;
  danger?: boolean;
  /** The user must type this word to enable the button (factory reset). */
  typed?: string;
}

export function confirmDialog(o: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let typedIn: HTMLInputElement | null = null;
    const okBtn = btn(o.ok, {
      kind: o.danger ? "danger" : "primary",
      disabled: !!o.typed,
      onclick: () => {
        m.close();
        resolve(true);
      },
    });
    const parts: Child[] = [h("div", { class: "dlg-text" }, o.text)];
    if (o.typed) {
      const word = o.typed;
      const t = input({
        label: "Type " + word + " to confirm",
        autocapitalize: "characters",
        oninput: () => (okBtn.disabled = (typedIn!.value || "").trim().toUpperCase() !== word),
      });
      typedIn = t.input;
      parts.push(t.el);
    }
    parts.push(
      h(
        "div",
        { class: "row end" },
        btn("Cancel", {
          kind: "ghost",
          onclick: () => {
            m.close();
            resolve(false);
          },
        }),
        okBtn,
      ),
    );
    const m = modal(o.title, parts, () => resolve(false));
  });
}

export const CANCELLED = "cancelled";

export function isCancel(e: unknown): boolean {
  return e instanceof ApiError && e.code === CANCELLED;
}

/** The admin login form, used inline (Settings) and in the re-login dialog. */
export function loginForm(onDone: () => void, intro?: Child): HTMLFormElement {
  const pw = passwordInput({ label: "Admin password", autocomplete: "current-password" });
  const err = errorBox();
  const go = btn("Log in", { kind: "primary wide", type: "submit" });
  return h(
    "form",
    {
      class: "stack",
      novalidate: true,
      onsubmit: async (e: Event) => {
        e.preventDefault();
        err.set("");
        if (!pw.input.value) {
          err.set("Enter the admin password.");
          pw.input.focus();
          return;
        }
        busy(go, true);
        try {
          await login(pw.input.value);
          onDone();
        } catch (x) {
          err.set(x instanceof ApiError && x.status === 401 ? "That password isn't right." : errMsg(x));
          pw.input.select();
        } finally {
          busy(go, false);
        }
      },
    },
    intro ? h("p", { class: "muted" }, intro) : null,
    pw.el,
    err.el,
    go,
    h("p", { class: "hint" }, "Forgot it? Hold the lamp's button for 3 s to run setup again and choose a new one."),
  );
}

let pendingLogin: Promise<void> | null = null;

/** Asks for the admin password (once, even if several requests need it). */
export function askLogin(): Promise<void> {
  if (pendingLogin) return pendingLogin;
  pendingLogin = new Promise<void>((resolve, reject) => {
    let ok = false;
    const m = modal(
      "Admin password",
      [
        loginForm(() => {
          ok = true;
          m.close();
          resolve();
        }, "This needs the lamp's admin password."),
      ],
      () => {
        if (!ok) reject(new ApiError(0, CANCELLED, "Login cancelled."));
      },
    );
  }).then(
    () => {
      pendingLogin = null;
    },
    (e) => {
      pendingLogin = null;
      throw e;
    },
  );
  return pendingLogin;
}

/** Copies text. navigator.clipboard needs a secure context, which plain HTTP isn't (06 §B.1). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = h("textarea", { value: text, readOnly: true, class: "offscreen" });
  document.body.appendChild(ta);
  let ok = false;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/** A labelled section card. */
export function card(title: Child, ...body: Child[]): HTMLElement {
  return h("section", { class: "card" }, title ? h("h2", { class: "card-t" }, title) : null, body);
}

export function kv(rows: Array<[string, Child]>): HTMLDListElement {
  return h(
    "dl",
    { class: "kv" },
    rows.map(([k, v]) => [h("dt", null, k), h("dd", null, v)]),
  );
}
