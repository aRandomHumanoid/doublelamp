// Home (06 A.2): the lamp tiles with the link toggle, the scenes row, and the control sheet.
import { useState } from "react";
import { ControlSheet } from "../components/ControlSheet";
import { ScenesRow } from "../components/SceneControls";
import { GroupRow, LampTile } from "../components/Tiles";
import { useLayout, useSelectedId } from "../live/selectors";
import { useApp } from "../live/store";
import { PairingDialog } from "./PairingDialog";

export function HomeScreen() {
  const layout = useLayout();
  const selected = useSelectedId();
  const everLive = useApp((s) => s.serverTime !== null);
  const [pairing, setPairing] = useState(false);
  return (
    <div className="home">
      <div className="home-main">
        <h1 className="sr-only">Lamps</h1>
        <section className="lamps" aria-label="Lamps">
          {layout.length === 0 &&
            (everLive ? (
              <div className="empty card">
                <h2>No lamps yet</h2>
                <p className="muted">Pair a lamp with this server to control it from anywhere.</p>
                <button type="button" className="btn btn-primary" onClick={() => setPairing(true)}>
                  Add lamp
                </button>
              </div>
            ) : (
              <div className="pair skeleton" aria-hidden="true">
                <div className="tile" />
                <div className="tile" />
              </div>
            ))}
          {layout.map((item) =>
            item.kind === "group" ? (
              <GroupRow key={`g${item.group.id}`} group={item.group} members={item.members} selected={selected} />
            ) : (
              <LampTile key={item.id} id={item.id} selected={selected === item.id} />
            ),
          )}
        </section>
        <ScenesRow />
      </div>
      <ControlSheet />
      {pairing && <PairingDialog onClose={() => setPairing(false)} />}
    </div>
  );
}
