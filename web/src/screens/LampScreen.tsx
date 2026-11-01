// Lamp screen (06 A.1): status, identify, LED config, firmware update, unpair. Test patterns and the
// Apple Home setup code live on the lamp's own page, which this links to.
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  COLOR_ORDERS,
  DEFAULT_LED_CONFIG,
  LIMITS,
  POWER_PRESETS,
  STRIP_PIXELS_PER_M,
  devicePatchSchema,
  ledConfigSchema,
  type DeviceView,
  type FirmwareInfo,
  type LedConfig,
} from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { ConfirmDialog } from "../components/Dialog";
import { IconBolt, IconChevronLeft, IconExternal, IconPencil, IconWave } from "../components/Icons";
import { OtaJobRow, jobActive, useOtaJobs } from "../components/Ota";
import { StripPreview } from "../components/StripPreview";
import { OnlineDot } from "../components/controls";
import { compareVersions, formatBytes, formatUptime, signal, timeAgo } from "../lib/format";
import { useAsync } from "../lib/hooks";
import { navigate } from "../lib/route";
import { describeError, groupLabel } from "../live/names";
import { deviceKey, groupOf, reduceDeviceRemoved, reduceDeviceUpdated } from "../live/reducers";
import { pixelsOf } from "../live/selectors";
import { toast, useApp } from "../live/store";

function upsertDevice(d: DeviceView): void {
  useApp.setState((s) => reduceDeviceUpdated(s, d));
}

export default function LampScreen({ id }: { id: string }) {
  const d = useApp((s) => s.devices[id]);
  const everLive = useApp((s) => s.serverTime !== null);
  useOtaJobs();
  if (!d) {
    return (
      <div className="screen narrow">
        <a className="back" href="#/">
          <IconChevronLeft size={18} /> Home
        </a>
        <h1>{everLive ? "Lamp not found" : "Loading…"}</h1>
        {everLive && <p className="muted">It may have been unpaired.</p>}
      </div>
    );
  }
  return (
    <div className="screen narrow">
      <a className="back" href="#/">
        <IconChevronLeft size={18} /> Home
      </a>
      <LampHeader d={d} />
      <LampStatus d={d} />
      <LampActions d={d} />
      <LedConfigForm d={d} />
      <FirmwareUpdate d={d} />
      <DangerZone d={d} />
    </div>
  );
}

function LampHeader({ d }: { d: DeviceView }) {
  const st = useApp((s) => s.view.devices[d.id] ?? null);
  const applyAt = useApp((s) => s.meta[deviceKey(d.id)]?.applyAt ?? null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(d.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = devicePatchSchema.safeParse({ name: name.trim() });
    if (!parsed.success) {
      setError(name.trim() ? (parsed.error.issues[0]?.message ?? "Check the name") : "Enter a name");
      return;
    }
    setBusy(true);
    try {
      upsertDevice(await api.patchDevice(d.id, { name: name.trim() }));
      setEditing(false);
      setError(null);
    } catch (err) {
      setError(describeError(err, d.name));
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="lamp-header">
      {editing ? (
        <form className="rename" onSubmit={save}>
          <label className="sr-only" htmlFor="rename-input">
            Lamp name
          </label>
          <input
            id="rename-input"
            value={name}
            maxLength={LIMITS.nameMaxLength}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            aria-invalid={!!error}
            aria-describedby="rename-err"
          />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Save
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setEditing(false);
              setName(d.name);
              setError(null);
            }}
          >
            Cancel
          </button>
          <p id="rename-err" className="error" role="alert">
            {error}
          </p>
        </form>
      ) : (
        <div className="title-row">
          <h1>{d.name}</h1>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Rename ${d.name}`}
            onClick={() => {
              setName(d.name);
              setEditing(true);
            }}
          >
            <IconPencil />
          </button>
          {d.info?.insecure_server_allowed && (
            <span className="badge warn" title="This firmware accepts plain ws:// servers (07 T16)">
              dev build
            </span>
          )}
        </div>
      )}
      <div className="strip large">
        <StripPreview state={st} pixels={pixelsOf(d)} applyAt={applyAt} />
      </div>
    </header>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function LampStatus({ d }: { d: DeviceView }) {
  const group = useApp((s) => groupOf(s, d.id));
  const info = d.info;
  const rssi = d.telemetry?.rssi ?? info?.net.rssi;
  const sig = rssi !== undefined ? signal(rssi) : null;
  const ip = info?.net.ip;
  const host = info?.host;
  const uptime = d.telemetry?.uptime_s ?? info?.uptime_s;
  const hk = info?.homekit;
  return (
    <section className="card" aria-labelledby="status-h">
      <h2 id="status-h">Status</h2>
      <dl className="kv-list">
        <Row label="Connection">
          <OnlineDot online={d.online} lastSeen={d.last_seen_at} /> {d.online ? "Online" : `Offline · seen ${timeAgo(d.last_seen_at)}`}
        </Row>
        {sig && rssi !== undefined && (
          <Row label="WiFi signal">
            <span className={`bars b${sig.bars}`} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>{" "}
            {rssi} dBm, {sig.label}
            {info?.net.ssid ? ` · ${info.net.ssid}` : ""}
          </Row>
        )}
        <Row label="Firmware">
          {d.fw ?? info?.fw ?? "unknown"}
          {info?.build ? <span className="muted"> · {info.build}</span> : null}
          {d.pending_verify && <span className="badge">verifying update</span>}
        </Row>
        <Row label="Local address">
          {ip ? (
            <>
              <a href={`http://${ip}/`} target="_blank" rel="noopener noreferrer">
                http://{ip}/ <IconExternal size={14} />
              </a>
              {host && (
                <span className="muted">
                  {" "}
                  or{" "}
                  <a href={`http://${host}/`} target="_blank" rel="noopener noreferrer">
                    {host}
                  </a>
                </span>
              )}
              <br />
              <span className="muted small">Its own page works on the same WiFi; test patterns are there under Settings → LEDs.</span>
            </>
          ) : (
            "unknown"
          )}
        </Row>
        <Row label="Apple Home">
          {!hk
            ? "unknown"
            : hk.state === "paired"
              ? `Paired (${hk.controllers} ${hk.controllers === 1 ? "controller" : "controllers"})`
              : hk.state === "unpaired"
                ? "Not paired. The setup code is on the lamp's own page."
                : "Off"}
        </Row>
        {group && <Row label="Link">{group.linked ? `Linked (${groupLabel(group)})` : "Not linked"}</Row>}
        {info && (
          <Row label="Strip">
            {info.hw.pixels} pixels · {info.hw.channels} channels
            {info.hw.color_order ? ` · ${info.hw.color_order} order` : ""}
          </Row>
        )}
        {uptime !== undefined && <Row label="Uptime">{formatUptime(uptime)}</Row>}
        {d.telemetry && (
          <Row label="Health">
            {d.telemetry.fps.toFixed(0)} fps · {formatBytes(d.telemetry.heap_free)} free (min {formatBytes(d.telemetry.heap_min)}) ·{" "}
            {d.telemetry.temp_c.toFixed(0)} °C · {d.telemetry.reconnects} reconnects
          </Row>
        )}
      </dl>
    </section>
  );
}

function LampActions({ d }: { d: DeviceView }) {
  const live = useApp((s) => s.live);
  const color = useApp((s) => s.view.devices[d.id]?.colors[0]);
  const run = async (what: () => Promise<void>, ok: string) => {
    try {
      await what();
      toast("ok", ok);
    } catch (e) {
      toast("error", describeError(e, d.name));
    }
  };
  return (
    <section className="card" aria-labelledby="actions-h">
      <h2 id="actions-h">Find this lamp</h2>
      <div className="button-row">
        <button type="button" className="btn" disabled={!live} onClick={() => void run(() => api.identify(d.id, 3000), `${d.name} is blinking`)}>
          <IconBolt size={18} /> Identify
        </button>
        <button
          type="button"
          className="btn"
          disabled={!live}
          onClick={() => void run(() => api.nudge(d.id, color ? { color, count: 3 } : { count: 3 }), `Nudged ${d.name}`)}
        >
          <IconWave size={18} /> Nudge
        </button>
      </div>
      <p className="muted small">Identify blinks the strip white three times. Nudge sends three soft pulses.</p>
    </section>
  );
}

type ConfigDraft = { [K in keyof LedConfig]: LedConfig[K] };

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
  hint,
  error,
  unit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  hint?: string;
  error?: string;
  unit?: string;
}) {
  const hintId = `${label.replace(/\W+/g, "-")}-hint`;
  return (
    <label className="field">
      <span>
        {label}
        {unit ? <span className="muted"> ({unit})</span> : null}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        aria-invalid={!!error}
        aria-describedby={hint || error ? hintId : undefined}
      />
      {(hint || error) && (
        <small id={hintId} className={error ? "error" : "muted"}>
          {error ?? hint}
        </small>
      )}
    </label>
  );
}

function LedConfigForm({ d }: { d: DeviceView }) {
  const base: LedConfig = d.config ?? DEFAULT_LED_CONFIG;
  const [draft, setDraft] = useState<ConfigDraft>(() => ({ ...base, color_correction: [...base.color_correction] as LedConfig["color_correction"] }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const baseKey = JSON.stringify(base);
  useEffect(() => {
    setDraft({ ...base, color_correction: [...base.color_correction] as LedConfig["color_correction"] });
    setErrors({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);

  const set = <K extends keyof ConfigDraft>(k: K, v: ConfigDraft[K]) => setDraft((x) => ({ ...x, [k]: v }));
  const orders = useMemo(() => COLOR_ORDERS.filter((o) => (draft.channels === 4 ? o.length === 4 : o.length === 3)), [draft.channels]);
  const changed = (Object.keys(draft) as (keyof LedConfig)[]).filter((k) => JSON.stringify(draft[k]) !== JSON.stringify(base[k]));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = ledConfigSchema.safeParse(draft);
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message;
      setErrors(errs);
      return;
    }
    setErrors({});
    const patch: Partial<LedConfig> = {};
    for (const k of changed) (patch as Record<string, unknown>)[k] = parsed.data[k];
    setBusy(true);
    try {
      upsertDevice(await api.patchDevice(d.id, { config: patch }));
      toast("ok", `LED settings saved${d.online ? "" : `. ${d.name} gets them when it reconnects.`}`);
    } catch (err) {
      toast("error", describeError(err, d.name));
    } finally {
      setBusy(false);
    }
  };

  const meters = (draft.pixel_count / STRIP_PIXELS_PER_M).toFixed(3).replace(/\.?0+$/, "");

  return (
    <section className="card" aria-labelledby="led-h">
      <h2 id="led-h">LED settings</h2>
      {!d.config && <p className="muted small">The lamp hasn't reported its settings yet; showing the defaults.</p>}
      <form className="form grid2" onSubmit={submit} noValidate>
        <NumberField
          label="Pixels"
          value={draft.pixel_count}
          min={1}
          max={LIMITS.maxPixels}
          onChange={(v) => set("pixel_count", v)}
          hint={`${STRIP_PIXELS_PER_M} per meter on this strip: ${meters} m`}
          error={errors.pixel_count}
        />
        <label className="field">
          <span>Channels</span>
          <select
            value={draft.channels}
            onChange={(e) => {
              const ch = Number(e.target.value) as 3 | 4;
              setDraft((x) => ({
                ...x,
                channels: ch,
                color_order: x.color_order.length === ch ? x.color_order : ch === 4 ? "GRBW" : "RGB",
              }));
            }}
          >
            <option value={3}>3 (RGB)</option>
            <option value={4}>4 (RGBW)</option>
          </select>
        </label>
        <label className="field">
          <span>Color order</span>
          <select value={draft.color_order} onChange={(e) => set("color_order", e.target.value as LedConfig["color_order"])}>
            {orders.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
          <small className="muted">Find it with the color-order test pattern on the lamp's own page.</small>
        </label>
        <div className="field">
          <NumberField
            label="Current limit"
            unit="mA"
            value={draft.max_current_ma}
            min={100}
            max={20000}
            onChange={(v) => set("max_current_ma", v)}
            error={errors.max_current_ma}
          />
          <div className="preset-row" role="group" aria-label="Power supply presets">
            {Object.values(POWER_PRESETS).map((p) => (
              <button
                key={p.label}
                type="button"
                className="btn small"
                aria-pressed={draft.max_current_ma === p.max_current_ma}
                onClick={() => set("max_current_ma", p.max_current_ma)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <NumberField
          label="Current per pixel at full white"
          unit="mA"
          value={draft.ma_per_pixel_white}
          min={1}
          max={200}
          onChange={(v) => set("ma_per_pixel_white", v)}
          error={errors.ma_per_pixel_white}
        />
        <fieldset className="field cc">
          <legend>Color correction (0–255)</legend>
          <div className="cc-row">
            {(["Red", "Green", "Blue"] as const).map((c, i) => (
              <label key={c} className="cc-item">
                <span className="muted small">{c}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={255}
                  value={Number.isFinite(draft.color_correction[i]) ? draft.color_correction[i] : ""}
                  onChange={(e) => {
                    const next = [...draft.color_correction] as LedConfig["color_correction"];
                    next[i] = e.target.valueAsNumber;
                    set("color_correction", next);
                  }}
                />
              </label>
            ))}
          </div>
          {errors.color_correction && <small className="error">{errors.color_correction}</small>}
        </fieldset>
        <NumberField label="Frame rate" unit="fps" value={draft.fps} min={10} max={100} onChange={(v) => set("fps", v)} error={errors.fps} />
        <label className="field check">
          <input type="checkbox" checked={draft.dither} onChange={(e) => set("dither", e.target.checked)} />
          <span>Dithering (smoother dim fades)</span>
        </label>
        <label className="field">
          <span>At power-on</span>
          <select value={draft.power_on} onChange={(e) => set("power_on", e.target.value as LedConfig["power_on"])}>
            <option value="restore">Restore the last state</option>
            <option value="on">Turn on</option>
            <option value="off">Stay off</option>
          </select>
        </label>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || changed.length === 0}>
            {busy ? "Saving…" : "Save LED settings"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={changed.length === 0}
            onClick={() => setDraft({ ...base, color_correction: [...base.color_correction] as LedConfig["color_correction"] })}
          >
            Reset
          </button>
        </div>
      </form>
    </section>
  );
}

function FirmwareUpdate({ d }: { d: DeviceView }) {
  const lib = useAsync(() => api.firmware(), []);
  const jobs = useApp((s) => s.otaJobs);
  const live = useApp((s) => s.live);
  const [sha, setSha] = useState("");
  const [downgrade, setDowngrade] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = d.fw ?? d.info?.fw ?? "";
  const list = useMemo(
    () => [...(lib.data?.firmware ?? [])].sort((a, b) => compareVersions(b.version, a.version) || b.uploaded_at - a.uploaded_at),
    [lib.data],
  );
  const chosen: FirmwareInfo | undefined = list.find((f) => f.sha256 === sha) ?? list[0];
  const isDowngrade = !!chosen && !!current && compareVersions(chosen.version, current) < 0;
  const isSame = !!chosen && chosen.version === current;
  const myJobs = Object.values(jobs)
    .filter((j) => j.device_id === d.id)
    .sort((a, b) => b.created_at - a.created_at);
  const running = myJobs.find(jobActive);

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const job = await api.startOta(d.id, { sha256: chosen.sha256, ...(isDowngrade ? { allow_downgrade: true } : {}) });
      useApp.setState((s) => ({ otaJobs: { ...s.otaJobs, [job.id]: job } }));
      toast("ok", `Updating ${d.name} to ${chosen.version}`);
    } catch (e) {
      toast("error", describeError(e, d.name));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="fw-h">
      <h2 id="fw-h">Firmware</h2>
      <p>
        Running <strong>{current || "unknown"}</strong>.
      </p>
      {lib.loading && !lib.data && <p className="muted">Loading versions…</p>}
      {lib.error != null && <p className="error">{describeError(lib.error)}</p>}
      {list.length === 0 && lib.data && (
        <p className="muted">
          No firmware uploaded yet. Upload a signed .bin in <a href="#/settings">Settings → Firmware</a>.
        </p>
      )}
      {list.length > 0 && (
        <div className="form">
          <label className="field">
            <span>Update to</span>
            <select value={chosen?.sha256 ?? ""} onChange={(e) => setSha(e.target.value)}>
              {list.map((f) => (
                <option key={f.sha256} value={f.sha256}>
                  {f.version}
                  {f.version === current ? " (running)" : ""} · {formatBytes(f.size)}
                  {f.notes ? ` · ${f.notes}` : ""}
                </option>
              ))}
            </select>
          </label>
          {isDowngrade && (
            <label className="field check">
              <input type="checkbox" checked={downgrade} onChange={(e) => setDowngrade(e.target.checked)} />
              <span>Allow downgrade from {current}</span>
            </label>
          )}
          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!live || busy || !!running || isSame || (isDowngrade && !downgrade) || !d.online}
              onClick={() => void start()}
            >
              {running ? "Update running…" : `Update to ${chosen?.version ?? ""}`}
            </button>
          </div>
          {!d.online && <p className="muted small">{d.name} is offline; it can update once it's back.</p>}
        </div>
      )}
      {myJobs.slice(0, 3).map((j) => (
        <OtaJobRow key={j.id} job={j} />
      ))}
    </section>
  );
}

function DangerZone({ d }: { d: DeviceView }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const unpair = async () => {
    setBusy(true);
    try {
      await api.unpair(d.id);
      useApp.setState((s) => reduceDeviceRemoved(s, { id: d.id }));
      toast("ok", `${d.name} unpaired`);
      navigate("/");
    } catch (e) {
      toast("error", describeError(e, d.name));
      setBusy(false);
      setAsking(false);
    }
  };
  return (
    <section className="card danger" aria-labelledby="danger-h">
      <h2 id="danger-h">Unpair</h2>
      <p className="muted">
        {d.name} keeps working on its own (its own page and Apple Home), but it leaves this server: no remote control, no
        linking, no schedules. Pairing it again needs a new code.
      </p>
      <button type="button" className="btn btn-danger" onClick={() => setAsking(true)}>
        Unpair {d.name}
      </button>
      {asking && (
        <ConfirmDialog
          title={`Unpair ${d.name}?`}
          confirmLabel="Unpair"
          danger
          busy={busy}
          onConfirm={() => void unpair()}
          onClose={() => setAsking(false)}
        >
          <p>The lamp's token is revoked right away. This can't be undone, but you can pair it again with a new code.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
