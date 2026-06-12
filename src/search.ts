/**
 * Lightweight federated search across all tiers.
 *
 * BM25 relevance over a per-memory document (title field-boosted, plus trace,
 * tags and source), then weighted by tier (live memory ranks above cold) and
 * recency. No external index or embeddings — pure in-memory, cheap enough to run
 * on every keystroke. BM25 gives rare query terms more weight (IDF) and
 * normalizes for document length, so a tight title match beats an incidental
 * mention in a long trace — a real upgrade over raw token-overlap counting.
 */

import { type IndexEntry, type Tier } from "./types.js";

const TIER_WEIGHT: Record<Tier, number> = { hot: 1.5, warm: 1.0, cold: 0.6 };

// BM25 parameters (Lucene-style defaults).
const K1 = 1.5; // term-frequency saturation
const B = 0.75; // length normalization strength
// Title matters most for relocating a memory — boost it by repeating its tokens.
const TITLE_BOOST = 3;

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter((t) => t.length > 1);
}

/** The searchable token bag for an entry, with the title field-boosted. */
function entryTokens(e: IndexEntry): string[] {
  const title = tokenize(e.title);
  const rest = tokenize([e.trace, e.tags.join(" "), e.source].join(" "));
  const out: string[] = [];
  for (let i = 0; i < TITLE_BOOST; i++) out.push(...title);
  out.push(...rest);
  return out;
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

  // Build per-document term frequencies + lengths for BM25.
  const docs = filtered.map((entry) => {
    const toks = entryTokens(entry);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { entry, tf, len: toks.length };
  });

  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N || 1;

  // Inverse document frequency per (unique) query term — rare terms weigh more.
  const uniqTerms = [...new Set(terms)];
  const idf = new Map<string, number>();
  for (const t of uniqTerms) {
    let df = 0;
    for (const d of docs) if (d.tf.has(t)) df += 1;
    // Lucene BM25 idf: always >= 0, smoothed.
    idf.set(t, Math.log(1 + (N - df + 0.5) / (df + 0.5)));
  }

  const scored: ScoredEntry[] = [];
  for (const d of docs) {
    let bm = 0;
    let matched = false;
    for (const t of uniqTerms) {
      const f = d.tf.get(t);
      if (!f) continue;
      matched = true;
      const norm = f + K1 * (1 - B + B * (d.len / avgdl));
      bm += (idf.get(t) ?? 0) * ((f * (K1 + 1)) / norm);
    }
    if (!matched) continue; // keep only entries that match at least one term

    const ageDays = (now - new Date(d.entry.lastAccessedAt).getTime()) / dayMs;
    const recency = 1 / (1 + ageDays / 30);
    const score = bm * TIER_WEIGHT[d.entry.tier] * (0.7 + 0.3 * recency);
    scored.push({ entry: d.entry, score });
  }

  return scored.sort((a, b) => b.score - a.score);
}
