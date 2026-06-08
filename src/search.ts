/**
 * Lightweight federated search across all tiers.
 *
 * No external index/embeddings — token overlap scoring over title, key points,
 * tags and trace, weighted by tier (live memory ranks above cold) and recency.
 * Good enough to relocate a discussion; cheap enough to run on every keystroke.
 */

import { type IndexEntry, type Tier } from "./types.js";

const TIER_WEIGHT: Record<Tier, number> = { hot: 1.5, warm: 1.0, cold: 0.6 };

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1);
}

export interface ScoredEntry {
  entry: IndexEntry;
  score: number;
}

export interface SearchFilters {
  source?: string;
  tag?: string;
  tier?: Tier;
  includeArchived?: boolean;
}

export function searchEntries(
  entries: IndexEntry[],
  query: string,
  filters: SearchFilters,
  now: number,
): ScoredEntry[] {
  const terms = tokenize(query);
  const dayMs = 24 * 60 * 60 * 1000;

  const filtered = entries.filter((e) => {
    if (!filters.includeArchived && e.status === "archived") return false;
    if (filters.source && e.source !== filters.source) return false;
    if (filters.tier && e.tier !== filters.tier) return false;
    if (filters.tag && !e.tags.includes(filters.tag)) return false;
    return true;
  });

  // Empty query -> recency-ordered browse of the filtered set.
  if (terms.length === 0) {
    return filtered
      .map((entry) => ({
        entry,
        score: 1 / (1 + (now - new Date(entry.lastAccessedAt).getTime()) / dayMs),
      }))
      .sort((a, b) => b.score - a.score);
  }

  const scored: ScoredEntry[] = [];
  for (const entry of filtered) {
    const haystack = tokenize(
      [entry.title, entry.trace, entry.tags.join(" "), entry.source].join(" "),
    );
    const hay = new Set(haystack);

    let hits = 0;
    for (const term of terms) {
      if (hay.has(term)) hits += 1;
      // Title matches count double.
      if (tokenize(entry.title).includes(term)) hits += 1;
    }
    if (hits === 0) continue;

    const ageDays = (now - new Date(entry.lastAccessedAt).getTime()) / dayMs;
    const recency = 1 / (1 + ageDays / 30);
    const score = hits * TIER_WEIGHT[entry.tier] * (0.7 + 0.3 * recency);
    scored.push({ entry, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}
