// "Add lamp" (05 §8, 01 F2): a one-time code, valid 10 minutes, entered on the lamp together with this
// server's URL, in its setup wizard or in its own page under Settings → Server.
import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { Dialog } from "../components/Dialog";
import { IconCheck, IconCopy, IconRefresh } from "../components/Icons";
import { useNow } from "../lib/hooks";
import { formatTime } from "../lib/format";
import { describeError } from "../live/names";
import { toast, useApp } from "../live/store";

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast("ok", `${what} copied`);
  } catch {
    toast("info", `Copy failed. Select the ${what.toLowerCase()} and copy it by hand.`);
  }
}

export function PairingDialog({ onClose }: { onClose: () => void }) {
  const [code, setCode] = useState<{ code: string; expiresAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow(1000);
  const devices = useApp((s) => s.devices);
  const known = useRef<Set<string> | null>(null);
  known.current ??= new Set(Object.keys(devices));
  const joined = Object.values(devices).find((d) => !known.current!.has(d.id));
  const origin = window.location.origin;

  const fetchCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.pairingCode();
      setCode({ code: r.code, expiresAt: Date.now() + r.expires_in * 1000 });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // one code per dialog, also under StrictMode's double effects
    started.current = true;
    void fetchCode();
  }, []);

  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0;
  const expired = !!code && left === 0;
  const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;

  return (
    <Dialog
      title="Add a lamp"
      onClose={onClose}
      className="pairing"
      footer={
        <button type="button" className="btn btn-primary" onClick={onClose}>
          {joined ? "Done" : "Close"}
        </button>
      }
    >
      {joined ? (
        <p className="success-line" role="status">
          <IconCheck /> {joined.name} joined the server.
        </p>
      ) : (
        <>
          <ol className="steps">
            <li>
              On the lamp, open its <strong>setup wizard</strong> (a new lamp), or its own page →{" "}
              <strong>Settings → Server</strong>.
            </li>
            <li>
              Enter this server's address:
              <span className="copy-row">
                <code className="mono">{origin}</code>
                <button type="button" className="icon-btn small" onClick={() => void copy(origin, "Address")} aria-label="Copy server address">
                  <IconCopy size={18} />
                </button>
              </span>
            </li>
            <li>
              Enter the pairing code:
              {code && !expired && (
                <span className="copy-row">
                  <code className="pair-code mono" aria-label={`Pairing code ${code.code.split("").join(" ")}`}>
                    {code.code}
                  </code>
                  <button type="button" className="icon-btn small" onClick={() => void copy(code.code, "Code")} aria-label="Copy pairing code">
                    <IconCopy size={18} />
                  </button>
                </span>
              )}
            </li>
          </ol>
          {busy && !code && <p className="muted">Getting a code…</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {code && !expired && (
            <p className="muted">
              <span aria-hidden="true">Expires in {mmss}</span>
              <span className="sr-only">The code works once and expires at {formatTime(code.expiresAt)}.</span>
            </p>
          )}
          {(expired || error) && (
            <p>
              {expired && <span className="error">This code expired. </span>}
              <button type="button" className="btn" onClick={() => void fetchCode()} disabled={busy}>
                <IconRefresh size={18} /> New code
              </button>
            </p>
          )}
          <p className="muted small">This dialog notices when the lamp joins.</p>
        </>
      )}
    </Dialog>
  );
}
