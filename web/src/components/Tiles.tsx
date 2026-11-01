// LampTile, the joined tile for linked lamps, and LinkToggle (06 A.2, A.3).
import { Fragment, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { findEffect, type GroupView, type LampState } from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { colorName } from "../lib/color";
import { cls, percent } from "../lib/format";
import { lampHref, navigate } from "../lib/route";
import { sendCommand } from "../live/commands";
import { describeError, groupLabel } from "../live/names";
import { deviceKey, groupKey, reduceGroupUpdated } from "../live/reducers";
import { pixelsOf } from "../live/selectors";
import { selectDevice, toast, useApp } from "../live/store";
import { Dialog } from "./Dialog";
import { OnlineDot, PowerButton } from "./controls";
import { IconChevronRight, IconLink, IconSwap, IconUnlink } from "./Icons";
import { StripPreview } from "./StripPreview";

/** Short spoken summary: "on, 72 %, warm white, Candle". */
export function describeState(st: LampState | null): string {
  if (!st) return "no state yet";
  if (!st.on) return "off";
  const e = findEffect(st.effect.id);
  const usesColor = e ? e.uses.includes("colors1") : true;
  return [`on, ${percent(st.brightness)} %`, usesColor ? colorName(st.colors[0] ?? "#000000") : null, e && e.id !== "solid" ? e.name : null]
    .filter(Boolean)
    .join(", ");
}

/** Long press opens the Lamp screen (06 A.3); the details link is the keyboard/screen-reader path. */
function useLongPress(onLong: () => void, ms = 550) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    fired,
    handlers: {
      onPointerDown: (e: ReactPointerEvent) => {
        fired.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLong();
        }, ms);
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const o = origin.current;
        if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > 10) clear();
      },
      onPointerUp: clear,
      onPointerCancel: clear,
      onPointerLeave: clear,
      onContextMenu: (e: { preventDefault: () => void }) => {
        if (fired.current) e.preventDefault();
      },
    },
  };
}

function tileColor(st: LampState | null): string | undefined {
  if (!st || !st.on) return undefined;
  return st.colors[0];
}

export function LampTile({ id, selected }: { id: string; selected: boolean }) {
  const d = useApp((s) => s.devices[id]);
  const st = useApp((s) => s.view.devices[id] ?? null);
  const applyAt = useApp((s) => s.meta[deviceKey(id)]?.applyAt ?? null);
  const live = useApp((s) => s.live);
  const lp = useLongPress(() => navigate(lampHref(id)));
  if (!d) return null;
  const glow = tileColor(st);
  return (
    <div
      className={cls("tile", selected && "selected", !d.online && "offline")}
      style={glow ? ({ "--lamp": glow } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="tile-select"
        aria-pressed={selected}
        aria-label={`${d.name}: ${describeState(st)}${d.online ? "" : ", offline"}. Select to control.`}
        onClick={() => {
          if (lp.fired.current) {
            lp.fired.current = false;
            return;
          }
          selectDevice(id);
        }}
        {...lp.handlers}
      />
      <div className="tile-head">
        <span className="tile-name">{d.name}</span>
        <OnlineDot online={d.online} lastSeen={d.last_seen_at} />
      </div>
      <div className="strip">
        <StripPreview state={st} pixels={pixelsOf(d)} applyAt={applyAt} />
      </div>
      <div className="tile-foot">
        <PowerButton
          on={!!st?.on}
          label={`${d.name} power`}
          disabled={!live || !st}
          onToggle={() => st && sendCommand({ device: id }, { on: !st.on })}
        />
        <span className="tile-pct" aria-hidden="true">
          {st ? (st.on ? `${percent(st.brightness)} %` : "Off") : "–"}
        </span>
        <a className="icon-btn tile-more" href={lampHref(id)} aria-label={`${d.name} details`}>
          <IconChevronRight />
        </a>
      </div>
    </div>
  );
}

/** Both lamps as one wide tile while linked (06 principle 5). */
export function LinkedTile({ group, members, selected }: { group: GroupView; members: string[]; selected: boolean }) {
  const devices = useApp((s) => s.devices);
  const view = useApp((s) => s.view);
  const applyAt = useApp((s) => s.meta[groupKey(group.id)]?.applyAt ?? null);
  const live = useApp((s) => s.live);
  const st = view.groups[group.id] ?? null;
  const lp = useLongPress(() => navigate(lampHref(members[0]!)));
  const label = groupLabel(group);
  const glow = tileColor(st);
  const offline = members.filter((m) => !devices[m]?.online).map((m) => devices[m]?.name ?? m);
  return (
    <div
      className={cls("tile", "tile-linked", selected && "selected")}
      style={glow ? ({ "--lamp": glow } as CSSProperties) : undefined}
    >
      <button
        type="button"
        className="tile-select"
        aria-pressed={selected}
        aria-label={`${label}, linked: ${describeState(st)}${offline.length ? `. Offline: ${offline.join(", ")}` : ""}. Select to control.`}
        onClick={() => {
          if (lp.fired.current) {
            lp.fired.current = false;
            return;
          }
          selectDevice(members[0]!);
        }}
        {...lp.handlers}
      />
      <div className="tile-head linked-head">
        {members.map((m) => {
          const d = devices[m];
          return (
            <span key={m} className="linked-name">
              <span className="tile-name">{d?.name ?? m}</span>
              <OnlineDot online={!!d?.online} lastSeen={d?.last_seen_at} />
              <a className="icon-btn small tile-more" href={lampHref(m)} aria-label={`${d?.name ?? m} details`}>
                <IconChevronRight size={18} />
              </a>
            </span>
          );
        })}
      </div>
      <div className="strips">
        {members.map((m) => (
          <div key={m} className="strip">
            <StripPreview state={view.devices[m] ?? null} pixels={pixelsOf(devices[m])} applyAt={applyAt} />
          </div>
        ))}
      </div>
      <div className="tile-foot">
        <PowerButton
          on={!!st?.on}
          label={`${label} power`}
          disabled={!live || !st}
          onToggle={() => st && sendCommand({ group: group.id }, { on: !st.on })}
        />
        <span className="tile-pct" aria-hidden="true">
          {st ? (st.on ? `${percent(st.brightness)} %` : "Off") : "–"}
        </span>
        <LinkToggle group={group} members={members} />
      </div>
    </div>
  );
}

/**
 * Link toggle (06 A.3). Linking asks "Match Lamp B to Lamp A?" with a swap option and sends
 * PATCH /groups/{id} {linked, match_from}. Unlinking changes nothing visible, so it doesn't ask.
 */
export function LinkToggle({ group, members }: { group: GroupView; members: string[] }) {
  const live = useApp((s) => s.live);
  const devices = useApp((s) => s.devices);
  const [asking, setAsking] = useState(false);
  const [from, setFrom] = useState(members[0]!);
  const [busy, setBusy] = useState(false);
  const name = (id: string) => devices[id]?.name ?? id;
  const others = members.filter((m) => m !== from);

  const patch = async (body: { linked: boolean; match_from?: string }) => {
    setBusy(true);
    try {
      const g = await api.patchGroup(group.id, body);
      useApp.setState((s) => reduceGroupUpdated(s, g));
      if (body.linked) selectDevice(members[0]!);
    } catch (e) {
      toast("error", describeError(e, groupLabel(group)));
    } finally {
      setBusy(false);
    }
  };

  const swap = () => setFrom(members[(members.indexOf(from) + 1) % members.length]!);
  const target = others.length === 1 ? name(others[0]!) : "the others";

  return (
    <>
      <button
        type="button"
        className={cls("link-toggle", group.linked && "on")}
        aria-pressed={group.linked}
        aria-label={group.linked ? "Linked. Unlink the lamps" : "Link the lamps"}
        title={group.linked ? "Unlink" : "Link"}
        disabled={!live || busy}
        onClick={() => {
          if (group.linked) void patch({ linked: false });
          else {
            setFrom(members[0]!);
            setAsking(true);
          }
        }}
      >
        {group.linked ? <IconLink /> : <IconUnlink />}
      </button>
      {asking && (
        <Dialog
          title="Link the lamps"
          onClose={() => setAsking(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={swap}>
                <IconSwap size={18} /> Swap direction
              </button>
              <button
                type="button"
                className="btn btn-primary"
                data-autofocus
                onClick={() => {
                  setAsking(false);
                  void patch({ linked: true, match_from: from });
                }}
              >
                Link
              </button>
            </>
          }
        >
          <p className="lead">
            Match {target} to {name(from)}?
          </p>
          <div className="link-preview" aria-hidden="true">
            <LinkPreviewStrip id={from} />
            <span className="link-arrow">→</span>
            {others.map((m) => (
              <Fragment key={m}>
                <LinkPreviewStrip id={m} />
              </Fragment>
            ))}
          </div>
          <p className="muted">
            {target === "the others" ? "The other lamps change" : `${target} changes`} to look like {name(from)}. After that,
            every change applies to both lamps and their animations stay in step.
          </p>
        </Dialog>
      )}
    </>
  );
}

function LinkPreviewStrip({ id }: { id: string }) {
  const d = useApp((s) => s.devices[id]);
  const st = useApp((s) => s.view.devices[id] ?? null);
  return (
    <span className="link-preview-item">
      <span className="strip small">
        <StripPreview state={st} pixels={pixelsOf(d)} />
      </span>
      <span className="muted">{d?.name ?? id}</span>
    </span>
  );
}

/** Two tiles with the link toggle between them, or one joined tile when linked. */
export function GroupRow({ group, members, selected }: { group: GroupView; members: string[]; selected: string | null }) {
  if (group.linked) {
    return <LinkedTile group={group} members={members} selected={!!selected && members.includes(selected)} />;
  }
  return (
    <div className="pair">
      {members.map((m, i) => (
        <Fragment key={m}>
          {i === 1 && (
            <div className="pair-link">
              <LinkToggle group={group} members={members} />
            </div>
          )}
          <LampTile id={m} selected={selected === m} />
        </Fragment>
      ))}
    </div>
  );
}
