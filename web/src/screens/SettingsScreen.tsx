// Settings (06 A.1): lamps and "Add lamp", firmware library and "Update both", the shared password,
// signed-in browsers, about.
import { useMemo, useRef, useState, type FormEvent } from "react";
import { PROTO_VERSION, passwordChangeSchema, type FirmwareInfo, type SessionInfo } from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { ConfirmDialog } from "../components/Dialog";
import { IconChevronRight, IconPlus, IconTrash, IconUpload } from "../components/Icons";
import { OtaJobRow, jobActive, useOtaJobs } from "../components/Ota";
import { OnlineDot } from "../components/controls";
import { clock } from "../lib/clock";
import { compareVersions, formatBytes, formatDateTime, timeAgo } from "../lib/format";
import { useAsync, useNow } from "../lib/hooks";
import { lampHref } from "../lib/route";
import { describeError } from "../live/names";
import { reduceOtaJob } from "../live/reducers";
import { logout } from "../live/session";
import { toast, useApp } from "../live/store";
import { PairingDialog } from "./PairingDialog";

export default function SettingsScreen() {
  useOtaJobs();
  return (
    <div className="screen narrow">
      <h1>Settings</h1>
      <LampsSection />
      <FirmwareLibrary />
      <PasswordSection />
      <SessionsSection />
      <About />
    </div>
  );
}

function LampsSection() {
  const devices = useApp((s) => s.devices);
  const [pairing, setPairing] = useState(false);
  const list = Object.values(devices).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <section className="card" aria-labelledby="lamps-h">
      <div className="card-head">
        <h2 id="lamps-h">Lamps</h2>
        <button type="button" className="btn btn-primary" onClick={() => setPairing(true)}>
          <IconPlus size={18} /> Add lamp
        </button>
      </div>
      {list.length === 0 ? (
        <p className="muted">No lamps paired yet.</p>
      ) : (
        <ul className="link-list">
          {list.map((d) => (
            <li key={d.id}>
              <a href={lampHref(d.id)}>
                <OnlineDot online={d.online} lastSeen={d.last_seen_at} />
                <span className="grow">
                  {d.name} <span className="muted small">{d.fw ?? ""}</span>
                </span>
                <IconChevronRight size={18} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {pairing && <PairingDialog onClose={() => setPairing(false)} />}
    </section>
  );
}

function FirmwareLibrary() {
  const lib = useAsync(() => api.firmware(), []);
  const jobs = useApp((s) => s.otaJobs);
  const devices = useApp((s) => s.devices);
  const live = useApp((s) => s.live);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<FirmwareInfo | null>(null);
  const [rollout, setRollout] = useState<FirmwareInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useMemo(
    () => [...(lib.data?.firmware ?? [])].sort((a, b) => compareVersions(b.version, a.version) || b.uploaded_at - a.uploaded_at),
    [lib.data],
  );
  const recentJobs = Object.values(jobs)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 6);
  const running = recentJobs.some(jobActive);

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setProgress(0);
    try {
      const info = await api.uploadFirmware(file, notes.trim() || undefined, setProgress);
      toast("ok", `Uploaded firmware ${info.version}`);
      setFile(null);
      setNotes("");
      if (fileRef.current) fileRef.current.value = "";
      lib.setData((d) => ({ firmware: [...(d?.firmware ?? []).filter((f) => f.sha256 !== info.sha256), info] }));
    } catch (err) {
      toast("error", describeError(err));
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await api.deleteFirmware(deleting.sha256);
      lib.setData((d) => (d ? { firmware: d.firmware.filter((f) => f.sha256 !== deleting.sha256) } : d));
    } catch (err) {
      toast("error", describeError(err));
    } finally {
      setBusy(false);
      setDeleting(null);
    }
  };

  const startRollout = async () => {
    if (!rollout) return;
    setBusy(true);
    try {
      const r = await api.rollout(rollout.sha256);
      useApp.setState((s) => r.jobs.reduce((acc, j) => reduceOtaJob(acc, j), s));
      toast("ok", `Updating both lamps to ${rollout.version}, one at a time`);
    } catch (err) {
      toast("error", describeError(err));
    } finally {
      setBusy(false);
      setRollout(null);
    }
  };

  const onVersion = (v: string) => Object.values(devices).filter((d) => (d.fw ?? d.info?.fw) === v).map((d) => d.name);

  return (
    <section className="card" aria-labelledby="fwlib-h">
      <h2 id="fwlib-h">Firmware</h2>
      <p className="muted small">
        Upload signed images built with the release key. Lamps check the signature themselves; a bad build rolls back on its own.
      </p>
      <form className="form upload" onSubmit={upload}>
        <label className="field">
          <span>Firmware image (.bin)</span>
          <input
            ref={fileRef}
            type="file"
            accept=".bin,application/octet-stream"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="field">
          <span>
            Notes <span className="muted">(optional)</span>
          </span>
          <input value={notes} maxLength={200} onChange={(e) => setNotes(e.target.value)} placeholder="What changed" />
        </label>
        {progress !== null && (
          <div
            className="progress"
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!file || progress !== null}>
            <IconUpload size={18} /> {progress !== null ? `Uploading ${Math.round(progress * 100)} %` : "Upload"}
          </button>
          {file && <span className="muted small">{formatBytes(file.size)}</span>}
        </div>
      </form>

      {lib.error != null && <p className="error">{describeError(lib.error)}</p>}
      {lib.data && list.length === 0 && <p className="muted">No firmware uploaded yet.</p>}
      {list.length > 0 && (
        <ul className="fw-list">
          {list.map((f) => {
            const running_on = onVersion(f.version);
            return (
              <li key={f.sha256} className="fw-item">
                <div className="grow">
                  <strong>{f.version}</strong>
                  {running_on.length > 0 && <span className="badge">on {running_on.join(", ")}</span>}
                  <div className="muted small">
                    {formatBytes(f.size)}
                    {f.idf ? ` · ESP-IDF ${f.idf}` : ""} · uploaded {timeAgo(f.uploaded_at)} ·{" "}
                    <span className="mono" title={f.sha256}>
                      {f.sha256.slice(0, 12)}
                    </span>
                  </div>
                  {f.notes && <div className="small">{f.notes}</div>}
                </div>
                <div className="icon-row">
                  <button type="button" className="btn small" disabled={!live || running} onClick={() => setRollout(f)}>
                    Update both
                  </button>
                  <button type="button" className="icon-btn danger" aria-label={`Delete firmware ${f.version}`} onClick={() => setDeleting(f)}>
                    <IconTrash />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {recentJobs.length > 0 && (
        <div className="jobs">
          <h3 className="section-label">Updates</h3>
          {recentJobs.map((j) => (
            <OtaJobRow key={j.id} job={j} showDevice />
          ))}
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete firmware ${deleting.version}?`}
          confirmLabel="Delete"
          danger
          busy={busy}
          onConfirm={() => void remove()}
          onClose={() => setDeleting(null)}
        >
          <p>The file is removed from the server. Lamps already running it aren't affected.</p>
        </ConfirmDialog>
      )}
      {rollout && (
        <ConfirmDialog
          title={`Update both lamps to ${rollout.version}?`}
          confirmLabel="Update both"
          busy={busy}
          onConfirm={() => void startRollout()}
          onClose={() => setRollout(null)}
        >
          <p>
            One lamp updates first. The second starts only after the first has restarted and verified the new version, so a
            bad build can't take both down.
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = passwordChangeSchema.safeParse({ current, next });
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      setError(i?.path[0] === "next" ? `New password: ${i.message}` : "Enter the current password");
      return;
    }
    if (next !== confirm) {
      setError("The new passwords don't match");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      toast("ok", "Password changed. Every other browser was signed out.");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="pw-h">
      <h2 id="pw-h">Shared password</h2>
      <p className="muted small">Everyone uses the same password. Changing it signs out every other browser.</p>
      <form className="form" onSubmit={submit} noValidate>
        <input type="text" autoComplete="username" value="doublelamp" readOnly hidden />
        <label className="field">
          <span>Current password</span>
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className="field">
          <span>New password</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            aria-describedby="pw-hint"
          />
          <small id="pw-hint" className="muted">
            At least 12 characters.
          </small>
        </label>
        <label className="field">
          <span>New password again</span>
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <p className="error" role="alert">
          {error}
        </p>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Change password
          </button>
        </div>
      </form>
    </section>
  );
}

function shortAgent(ua: string | null): string {
  if (!ua) return "";
  const os = /iPhone|iPad|Android|Mac OS X|Windows|Linux|CrOS/.exec(ua)?.[0]?.replace("Mac OS X", "macOS") ?? "";
  const br = /Edg\/|Firefox\/|Chrome\/|Safari\//.exec(ua)?.[0]?.replace("/", "").replace("Edg", "Edge") ?? "";
  return [os, br].filter(Boolean).join(" · ");
}

function SessionsSection() {
  const res = useAsync(() => api.sessions(), []);
  const [revoking, setRevoking] = useState<SessionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const list = [...(res.data?.sessions ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || (b.last_seen_at ?? 0) - (a.last_seen_at ?? 0));

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api.revokeSession(revoking.id);
      res.setData((d) => (d ? { sessions: d.sessions.filter((s) => s.id !== revoking.id) } : d));
      toast("ok", `Signed out ${revoking.label}`);
    } catch (err) {
      toast("error", describeError(err));
    } finally {
      setBusy(false);
      setRevoking(null);
    }
  };

  return (
    <section className="card" aria-labelledby="sessions-h">
      <h2 id="sessions-h">Signed-in browsers</h2>
      {res.error != null && <p className="error">{describeError(res.error)}</p>}
      <ul className="session-list">
        {list.map((s) => (
          <li key={s.id}>
            <div className="grow">
              <strong>{s.label}</strong>
              {s.current && <span className="badge">this browser</span>}
              <div className="muted small">
                {shortAgent(s.user_agent)}
                {shortAgent(s.user_agent) ? " · " : ""}signed in {formatDateTime(s.created_at)}
                {s.last_seen_at ? ` · active ${timeAgo(s.last_seen_at)}` : ""}
              </div>
            </div>
            {s.current ? (
              <button type="button" className="btn small" onClick={() => void logout()}>
                Sign out
              </button>
            ) : (
              <button type="button" className="btn small btn-danger" onClick={() => setRevoking(s)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {revoking && (
        <ConfirmDialog title={`Sign out ${revoking.label}?`} confirmLabel="Revoke" danger busy={busy} onConfirm={() => void revoke()} onClose={() => setRevoking(null)}>
          <p>That browser goes back to the login screen right away.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

function About() {
  const session = useApp((s) => s.session);
  const live = useApp((s) => s.live);
  useNow(5000);
  const delay = clock.bestDelay;
  return (
    <section className="card" aria-labelledby="about-h">
      <h2 id="about-h">About</h2>
      <dl className="kv-list">
        <div className="kv">
          <dt>Web app</dt>
          <dd>
            {__APP_VERSION__} <span className="muted small">built {formatDateTime(Date.parse(__BUILD_TIME__))}</span>
          </dd>
        </div>
        <div className="kv">
          <dt>Protocol</dt>
          <dd>{PROTO_VERSION}</dd>
        </div>
        <div className="kv">
          <dt>Server</dt>
          <dd className="mono">{window.location.origin}</dd>
        </div>
        <div className="kv">
          <dt>This browser</dt>
          <dd>{session?.label ?? "–"}</dd>
        </div>
        <div className="kv">
          <dt>Sync clock</dt>
          <dd>
            {live && clock.isSynced && delay !== null
              ? `in sync, ±${Math.max(1, Math.round(delay / 2))} ms (round trip ${Math.round(delay)} ms)`
              : "not synced"}
          </dd>
        </div>
      </dl>
      <p className="muted small">
        DoubleLamp: two linked WiFi lamps. Each lamp also works on its own from its own page and from Apple Home.
      </p>
    </section>
  );
}
