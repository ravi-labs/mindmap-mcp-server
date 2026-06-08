/**
 * The consolidation engine: deciding what stays hot, what cools, what decays.
 *
 * This is the moat — anyone can store summaries; the value is in graceful
 * forgetting. Cold threads collapse to a one-line `trace` (still searchable)
 * instead of vanishing, so recall never hard-fails.
 */

import { type Config } from "./constants.js";
import { allEntries, getThread, saveThread } from "./store.js";
import { type IndexEntry, type Thread, type Tier } from "./types.js";

/** Decide which tier a thread *should* be in, given age, usage and status. */
export function computeTier(
  t: Pick<Thread, "status" | "lastAccessedAt" | "accessCount">,
  cfg: Config,
  now: number,
): Tier {
  if (t.status === "archived") return "cold";

  const ageMs = now - new Date(t.lastAccessedAt).getTime();
  // Promoted (human-blessed) memories are allowed to live longer.
  const factor = t.status === "promoted" ? cfg.promotedLongevityFactor : 1;
  const hotWindow = cfg.hotWindowMs * factor;
  const warmWindow = cfg.warmWindowMs * factor;

  const usedEnough = t.accessCount >= cfg.hotMinAccessCount || t.status === "promoted";

  if (ageMs <= hotWindow && usedEnough) return "hot";
  if (ageMs <= warmWindow) return "warm";
  return "cold";
}

/** Build the one-line trace kept when a thread goes cold. */
export function makeTrace(t: Pick<Thread, "title" | "keyPoints" | "summary">): string {
  const firstPoint = t.keyPoints[0]?.trim();
  const fallback = t.summary.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  const detail = (firstPoint || fallback).slice(0, 140);
  return detail ? `${t.title} — ${detail}` : t.title;
}

export interface PruneChange {
  id: string;
  title: string;
  from: Tier;
  to: Tier;
}

export interface PruneResult {
  scanned: number;
  changes: PruneChange[];
  dryRun: boolean;
}

/**
 * Walk every thread, recompute its tier, and write back any that moved.
 * This is what the background thread calls. `dryRun` reports without writing.
 */
export async function prune(cfg: Config, dryRun: boolean): Promise<PruneResult> {
  const entries = await allEntries();
  const now = Date.now();
  const changes: PruneChange[] = [];

  for (const entry of entries) {
    const target = computeTier(entry, cfg, now);
    if (target === entry.tier) continue;

    const thread = await getThread(entry.id);
    if (!thread) continue;

    const from = thread.tier;
    thread.tier = target;
    // Collapsing into cold (re)generates the trace from current content.
    if (target === "cold") thread.trace = makeTrace(thread);
    thread.updatedAt = new Date(now).toISOString();

    if (!dryRun) await saveThread(thread);
    changes.push({ id: thread.id, title: thread.title, from, to: target });
  }

  return { scanned: entries.length, changes, dryRun };
}

export interface HealthReport {
  total: number;
  hot: number;
  warm: number;
  cold: number;
  promoted: number;
  captured: number;
  archived: number;
  /** Share of memory that is still "live" (hot+warm), 0..100. */
  cleanlinessScore: number;
  /** Cold, non-archived threads worth reviewing in a tidy pass. */
  staleCandidates: IndexEntry[];
}

/** The gamified, opt-in surface: a cleanliness score rewards pruning, not hoarding. */
export async function health(cfg: Config, now: number): Promise<HealthReport> {
  const entries = await allEntries();
  const total = entries.length;
  const count = (pred: (e: IndexEntry) => boolean) => entries.filter(pred).length;

  const hot = count((e) => e.tier === "hot");
  const warm = count((e) => e.tier === "warm");
  const cold = count((e) => e.tier === "cold");
  const live = hot + warm;
  const active = entries.filter((e) => e.status !== "archived").length;

  const staleCandidates = entries
    .filter((e) => e.tier === "cold" && e.status !== "archived")
    .sort(
      (a, b) =>
        new Date(a.lastAccessedAt).getTime() - new Date(b.lastAccessedAt).getTime(),
    );

  return {
    total,
    hot,
    warm,
    cold,
    promoted: count((e) => e.status === "promoted"),
    captured: count((e) => e.status === "captured"),
    archived: count((e) => e.status === "archived"),
    cleanlinessScore: active === 0 ? 100 : Math.round((live / active) * 100),
    staleCandidates,
  };
}
