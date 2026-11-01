// Offline shell (06 A.5): the cached app with no server behind it.
import { useEffect, useState } from "react";
import { LocalAddressHint } from "../components/Chrome";
import { BrandMark } from "../components/Icons";
import { boot } from "../live/session";

export function OfflineScreen() {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const retry = () => void boot();
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, []);
  return (
    <main className="login" id="main">
      <section className="login-card card" aria-labelledby="offline-h">
        <div className="login-brand">
          <BrandMark size={44} />
          <h1 id="offline-h">No connection to server</h1>
        </div>
        <p>The DoubleLamp server can't be reached right now. The lamps keep working on their own, and this page retries by itself.</p>
        <LocalAddressHint />
        <button
          type="button"
          className="btn btn-primary wide"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void boot().finally(() => setBusy(false));
          }}
        >
          {busy ? "Trying…" : "Try again"}
        </button>
      </section>
    </main>
  );
}
