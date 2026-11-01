// Tiny DOM toolkit (06 §B.4): an h() element helper and a ~1 KB reactive store.
// Text always goes in through textContent; `html` is only for the static SVG icons.

export type Child = Node | string | number | null | undefined | false | Child[];
export type Props = Record<string, unknown>;

/** Always set as attributes (some exist as properties with different types or names). */
const ATTRS = /^(list|form|role|for|tabindex|spellcheck|autocorrect|autocapitalize|inputmode|enterkeyhint)$|-/;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110) {
        // "on…": event listener
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === "class") {
        el.className = v as string;
      } else if (k === "style") {
        el.style.cssText = v as string;
      } else if (k === "html") {
        el.innerHTML = v as string;
      } else if (k in el && !ATTRS.test(k)) {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  add(el, children);
  return el;
}

export function add(parent: Node, children: Child[] | Child): void {
  if (Array.isArray(children)) {
    for (const c of children) add(parent, c);
  } else if (children != null && children !== false) {
    parent.appendChild(typeof children === "object" ? children : document.createTextNode(String(children)));
  }
}

/** Replaces all children (replaceChildren() is too new for older captive-portal webviews). */
export function fill(parent: Node, ...children: Child[]): void {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  add(parent, children);
}

export function show(el: HTMLElement, on: boolean): void {
  el.hidden = !on;
}

let uid = 0;
export function nextId(prefix = "u"): string {
  return prefix + ++uid;
}

export interface Store<T> {
  get(): T;
  set(v: T): void;
  update(patch: Partial<T>): void;
  sub(fn: (v: T) => void): () => void;
}

export function store<T extends object>(init: T): Store<T> {
  let v = init;
  const subs: Array<(v: T) => void> = [];
  const s: Store<T> = {
    get: () => v,
    set(n) {
      v = n;
      for (const f of subs.slice()) f(v);
    },
    update(patch) {
      s.set(Object.assign({}, v, patch));
    },
    sub(fn) {
      subs.push(fn);
      return () => {
        const i = subs.indexOf(fn);
        if (i >= 0) subs.splice(i, 1);
      };
    },
  };
  return s;
}

/** Runs fn at most once per animation frame. */
export function rafBatch(fn: () => void): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn();
    });
  };
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
