/**
 * Glass-box memory — see and control everything your AI knows about you.
 *
 * Vector-DB memory is opaque by construction: you can't inspect an embedding.
 * Mind Map's store is plain files, so we can show, for every memory: where it
 * came from (provenance), why it's trusted (promote-on-reuse count), when it was
 * last used, and when it will fade to a one-line trace. That turns "forgetting
 * is the feature" and "not a honeypot" from slogans into something you can audit.
 */

import { type Config } from "./constants.js";
import { computeTier } from "./decay.js";
import { type IndexEntry, type Thread, type Tier } from "./types.js";

const DAY = 86_400_000;

export interface Lifecycle {
  tier: Tier;
  /** promote-on-reuse count — how many times this was pulled forward. */
  trust: number;
  promoted: boolean;
  lastUsedDays: number;
  /** Next tier transition, if any (cold is terminal). */
  next?: { to: Tier; at: string; inDays: number };
}

/** Forecast how a memory will decay from here, given the decay windows. */
export function lifecycle(
  t: Pick<Thread, "status" | "lastAccessedAt" | "accessCount" | "tier">,
  cfg: Config,
  now: number,
): Lifecycle {
  const last = new Date(t.lastAccessedAt).getTime();
  const factor = t.status === "promoted" ? cfg.promotedLongevityFactor : 1;
  const hotUntil = last + cfg.hotWindowMs * factor;
  const warmUntil = last + cfg.warmWindowMs * factor;
  const tier = computeTier(t, cfg, now);

  let next: Lifecycle["next"];
  if (tier === "hot") {
    // hot → warm at hotUntil, then → cold at warmUntil
    const at = now < hotUntil ? hotUntil : warmUntil;
    const to: Tier = now < hotUntil ? "warm" : "cold";
    next = { to, at: new Date(at).toISOString(), inDays: Math.max(0, Math.round((at - now) / DAY)) };
  } else if (tier === "warm") {
    next = {
      to: "cold",
      at: new Date(warmUntil).toISOString(),
      inDays: Math.max(0, Math.round((warmUntil - now) / DAY)),
    };
  } // cold is terminal — no next

  return {
    tier,
    trust: t.accessCount,
    promoted: t.status === "promoted",
    lastUsedDays: Math.max(0, Math.round((now - last) / DAY)),
    next,
  };
}

/** A human-readable "where did this come from" line for a memory. */
export function provenance(t: Pick<Thread, "source" | "sourceRef" | "tags">): string {
  const ref = t.sourceRef;
  if (ref?.kind === "claude-code-cli") {
    return `Claude Code CLI · session ${ref.sessionId?.slice(0, 8) ?? "?"}${ref.file ? ` · ${ref.file}` : ""}`;
  }
  if (ref?.kind === "cursor") return `Cursor · composer ${ref.composerId?.slice(0, 8) ?? "?"}`;
  if (ref?.kind === "copilot") return `VS Code Copilot${ref.file ? ` · ${ref.file}` : ""}`;
  if ((t.tags || []).includes("passport")) return `imported via passport (${t.source})`;
  if ((t.tags || []).includes("imported")) return `imported from ${t.source}`;
  return `captured in ${t.source}`;
}

export interface AuditRow {
  id: string;
  title: string;
  source: string;
  provenance: string;
  trust: number;
  tier: Tier;
  status: string;
  lastUsedDays: number;
  fades: string; // e.g. "→ warm in 3d", "→ cold trace in 20d", "cold (trace)"
}

function fadesLabel(lc: Lifecycle): string {
  if (!lc.next) return lc.tier === "cold" ? "cold (trace)" : lc.tier;
  return `→ ${lc.next.to}${lc.next.to === "cold" ? " trace" : ""} in ${lc.next.inDays}d`;
}

/**
 * The audit ledger: a compact, inspectable list of everything stored, with
 * provenance, trust, and decay forecast — "everything your AI knows about you."
 */
export async function auditLedger(
  entries: IndexEntry[],
  threadFor: (id: string) => Promise<Thread | null>,
  cfg: Config,
  now: number,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  for (const e of entries) {
    const t = await threadFor(e.id);
    const lc = lifecycle(e, cfg, now);
    rows.push({
      id: e.id,
      title: e.title,
      source: e.source,
      provenance: provenance(t ?? { source: e.source, tags: e.tags }),
      trust: e.accessCount,
      tier: lc.tier,
      status: e.status,
      lastUsedDays: lc.lastUsedDays,
      fades: fadesLabel(lc),
    });
  }
  // Most-trusted, most-recent first — the memory the AI leans on most, on top.
  rows.sort((a, b) => b.trust - a.trust || a.lastUsedDays - b.lastUsedDays);
  return rows;
}

export { fadesLabel };
