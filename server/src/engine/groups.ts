// Link-group helpers (05 §4 "Link and unlink"). Pure functions.
import { maxFieldTs, type Replica } from "./state";

export interface MemberReplica {
  id: string;
  replica: Replica | null;
}

/**
 * Which member's state a newly linked group starts from: `matchFrom` when it names a member with state,
 * otherwise the member that changed most recently (highest max(fieldTs)); ties go to the earlier member.
 * Null when no member has any state yet.
 */
export function pickLinkSource(members: readonly MemberReplica[], matchFrom?: string): string | null {
  if (matchFrom !== undefined) {
    const m = members.find((x) => x.id === matchFrom);
    if (m?.replica) return m.id;
  }
  let best: string | null = null;
  let bestTs = -Infinity;
  for (const m of members) {
    if (!m.replica) continue;
    const ts = maxFieldTs(m.replica);
    if (ts > bestTs) {
      best = m.id;
      bestTs = ts;
    }
  }
  return best;
}
