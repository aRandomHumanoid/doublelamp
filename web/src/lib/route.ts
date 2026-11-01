// Hash routing: works behind any static server and with the service worker's single cached shell.
import { useMemo, useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "lamp"; id: string }
  | { name: "scenes" }
  | { name: "schedules" }
  | { name: "activity" }
  | { name: "settings" };

export function parseRoute(hash: string): Route {
  const [head, arg] = hash.replace(/^#\/?/, "").split("/");
  switch (head) {
    case "lamp":
      return arg ? { name: "lamp", id: decodeURIComponent(arg) } : { name: "home" };
    case "scenes":
    case "schedules":
    case "activity":
    case "settings":
      return { name: head };
    default:
      return { name: "home" };
  }
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => "");
  return useMemo(() => parseRoute(hash), [hash]);
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export const lampHref = (id: string): string => `#/lamp/${encodeURIComponent(id)}`;
