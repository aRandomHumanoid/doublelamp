// App chrome: top bar with navigation, the "Reconnecting…" banner, toasts.
import { load, KEYS } from "../lib/storage";
import { cls } from "../lib/format";
import type { Route } from "../lib/route";
import type { LocalAddress } from "../live/dispatch";
import { dismissToast, useApp } from "../live/store";
import { BrandMark, IconActivity, IconClock, IconGear, IconScenes, IconX } from "./Icons";

const NAV = [
  { name: "scenes", label: "Scenes", Icon: IconScenes },
  { name: "schedules", label: "Schedules", Icon: IconClock },
  { name: "activity", label: "Activity", Icon: IconActivity },
  { name: "settings", label: "Settings", Icon: IconGear },
] as const;

export function TopBar({ route }: { route: Route }) {
  return (
    <header className="topbar">
      <a className="brand" href="#/" aria-current={route.name === "home" ? "page" : undefined}>
        <BrandMark />
        <span>DoubleLamp</span>
      </a>
      <nav aria-label="Main">
        <ul className="nav">
          {NAV.map(({ name, label, Icon }) => (
            <li key={name}>
              <a className="nav-btn" href={`#/${name}`} aria-current={route.name === name ? "page" : undefined}>
                <Icon />
                <span className="nav-label">{label}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}

/** Lamp pages to open directly when the server can't be reached (06 A.5). */
export function LocalAddressHint() {
  const list = load<LocalAddress[]>(KEYS.localAddresses, []);
  return (
    <div className="local-hint">
      <p>On the same WiFi as a lamp, you can open it directly at its local address{list.length ? ":" : "."}</p>
      {list.length > 0 ? (
        <ul>
          {list.map((a) => {
            const href = `http://${a.ip || a.host}/`;
            return (
              <li key={a.id}>
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {a.name}: {a.ip || a.host}
                </a>
                {a.ip && a.host && <span className="muted"> or http://{a.host}/</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">The lamp shows it at the end of setup, e.g. http://doublelamp-3fa2c1.local</p>
      )}
    </div>
  );
}

/** "Reconnecting…" while the socket is down (06 A.4). The live region stays mounted so changes are announced. */
export function ConnectionBanner() {
  const live = useApp((s) => s.live);
  const conn = useApp((s) => s.conn);
  const failures = useApp((s) => s.failures);
  const everLive = useApp((s) => s.serverTime !== null);
  const text = !everLive && failures === 0 ? "Connecting…" : "Reconnecting…";
  return (
    <div className="conn-live" role="status" aria-live="polite">
      {!live && (
        <div className={cls("conn-banner", conn === "closed" && "down")}>
          <span className="spinner" aria-hidden="true" />
          <span>{text} Controls are paused until the server is back.</span>
          {failures >= 3 && (
            <details className="banner-details">
              <summary>Can't reach the server?</summary>
              <LocalAddressHint />
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const lastError = toasts.findLast((t) => t.kind === "error");
  const lastNote = toasts.findLast((t) => t.kind !== "error");
  return (
    <>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={cls("toast", `toast-${t.kind}`)}>
            <span>{t.text}</span>
            <button type="button" className="icon-btn small" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <IconX size={18} />
            </button>
          </div>
        ))}
      </div>
      {/* Persistent live regions: errors interrupt, everything else waits. */}
      <div className="sr-only" role="alert">
        {lastError?.text}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {lastNote?.text}
      </div>
    </>
  );
}
