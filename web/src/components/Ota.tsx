// OTA job progress (05 §10), fed live by `ota.job` events.
import { useEffect } from "react";
import type { OtaJob } from "@doublelamp/protocol";
import { api } from "../api/endpoints";
import { cls, timeAgo } from "../lib/format";
import { reduceOtaJob } from "../live/reducers";
import { useApp } from "../live/store";

const LABEL: Record<OtaJob["status"], string> = {
  pending: "Queued",
  sent: "Starting",
  download: "Downloading",
  verify: "Verifying",
  reboot: "Restarting",
  done: "Updated",
  failed: "Failed",
};

export const jobActive = (j: OtaJob): boolean => j.status !== "done" && j.status !== "failed";

/** Seeds the store from GET /ota-jobs; later changes arrive as `ota.job`. */
export function useOtaJobs(): void {
  useEffect(() => {
    let alive = true;
    api.otaJobs().then(
      (r) => {
        if (alive) useApp.setState((s) => r.jobs.reduce((acc, j) => reduceOtaJob(acc, j), s));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, []);
}

export function OtaJobRow({ job, showDevice }: { job: OtaJob; showDevice?: boolean }) {
  const name = useApp((s) => s.devices[job.device_id]?.name ?? job.device_id);
  const pct = job.status === "done" ? 100 : job.status === "download" ? job.pct : job.status === "pending" ? 0 : job.pct;
  const label = `${showDevice ? `${name}: ` : ""}${job.version} · ${LABEL[job.status]}${job.status === "download" ? ` ${job.pct} %` : ""}`;
  return (
    <div className={cls("ota-job", job.status)}>
      <div className="ota-line">
        <span>{label}</span>
        <span className="muted small">{timeAgo(job.updated_at)}</span>
      </div>
      {jobActive(job) && (
        <div
          className="progress"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {job.status === "failed" && job.error && <p className="error small">{job.error}</p>}
    </div>
  );
}
