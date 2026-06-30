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

import { cosine, loadVectors } from "./embeddings.js";
import { canEmbed, embed } from "./llm.js";
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

/** Apply the source/tag/tier/archived filters (shared by lexical + semantic). */
export function applyFilters(entries: IndexEntry[], filters: SearchFilters): IndexEntry[] {
  return entries.filter((e) => {
    if (!filters.includeArchived && e.status === "archived") return false;
    if (filters.source && e.source !== filters.source) return false;
    if (filters.tier && e.tier !== filters.tier) return false;
    if (filters.tag && !e.tags.includes(filters.tag)) return false;
    return true;
  });
}

export function searchEntries(
  entries: IndexEntry[],
  query: string,
  filters: SearchFilters,
  now: number,
): ScoredEntry[] {
  const terms = tokenize(query);
  const dayMs = 24 * 60 * 60 * 1000;

  const filtered = applyFilters(entries, filters);

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

/**
 * Hybrid search: BM25 (always) fused with semantic similarity (when embeddings
 * are available + a cache exists) via Reciprocal Rank Fusion. Degrades to plain
 * BM25 for browse queries, when no embeddings provider is configured, or when
 * the embedding cache is empty — so it's never worse than lexical search.
 */
export async function hybridSearch(
  entries: IndexEntry[],
  query: string,
  filters: SearchFilters,
  now: number,
): Promise<ScoredEntry[]> {
  const bm = searchEntries(entries, query, filters, now);
  if (!query.trim()) return bm; // browse mode — no semantic step

  let embeddingsReady = false;
  try {
    embeddingsReady = await canEmbed();
  } catch {
    /* treat as unavailable */
  }
  if (!embeddingsReady) return bm;

  const vectors = await loadVectors();
  if (vectors.size === 0) return bm; // no cache built yet (run `embed`)

  let qvec: number[] | undefined;
  try {
    qvec = (await embed([query]))[0];
  } catch {
    return bm; // embedding the query failed — fall back
  }
  if (!qvec) return bm;

  // Semantic ranking over the same filtered set (can surface non-keyword matches).
  const sem: ScoredEntry[] = [];
  for (const e of applyFilters(entries, filters)) {
    const v = vectors.get(e.id);
    if (!v) continue;
    sem.push({ entry: e, score: cosine(qvec, v) });
  }
  sem.sort((a, b) => b.score - a.score);

  // Reciprocal Rank Fusion — robust blend without normalizing score scales.
  const K = 60;
  const fused = new Map<string, { entry: IndexEntry; score: number }>();
  const add = (list: ScoredEntry[]) =>
    list.forEach((r, i) => {
      const cur = fused.get(r.entry.id) ?? { entry: r.entry, score: 0 };
      cur.score += 1 / (K + i + 1);
      fused.set(r.entry.id, cur);
    });
  add(bm);
  add(sem);

  return [...fused.values()].sort((a, b) => b.score - a.score);
}

export interface TopicCluster {
  /** Best single match — the entry promoted on reuse. */
  anchor: IndexEntry;
  /** Anchor + related fragments of the same topic, oldest → newest. */
  members: IndexEntry[];
  /** Full ranked list, for surfacing alternatives / near-misses. */
  ranked: ScoredEntry[];
}

/**
 * Resolve a fuzzy query to a *topic cluster*, not a single memory — the answer
 * to topic fragmentation. Takes the best hybrid match as the anchor, then pulls
 * its explicit links plus high-relevance siblings (above a relative floor),
 * capped and ordered chronologically so the caller can reassemble one thread.
 * Falls back to a 1-member cluster when nothing else clusters.
 */
export async function resolveTopicCluster(
  entries: IndexEntry[],
  query: string,
  filters: SearchFilters,
  now: number,
  opts: { max?: number; floor?: number; anchorId?: string } = {},
): Promise<TopicCluster | null> {
  const byId = new Map(entries.map((e) => [e.id, e]));

  // Seeded by a specific id (user picked a choice): anchor on it, no search.
  let anchor: IndexEntry;
  let ranked: ScoredEntry[] = [];
  if (opts.anchorId) {
    const a = byId.get(opts.anchorId);
    if (!a) return null;
    anchor = a;
  } else {
    ranked = await hybridSearch(entries, query, filters, now);
    if (ranked.length === 0) return null;
    anchor = ranked[0].entry;
  }

  const max = opts.max ?? 5;
  const relFloor = opts.floor ?? 0.4;

  const chosen = new Map<string, IndexEntry>();
  chosen.set(anchor.id, anchor);

  // Explicit links of the anchor — strong topic signal, regardless of score
  // (but still subject to the same filters, e.g. archived/source).
  for (const id of anchor.links || []) {
    if (chosen.size >= max) break;
    const e = byId.get(id);
    if (e && applyFilters([e], filters).length) chosen.set(id, e);
  }
  // Reverse links — entries that link TO the anchor (links are directional, but
  // a topic cluster should be bidirectional).
  for (const e of entries) {
    if (chosen.size >= max) break;
    if ((e.links || []).includes(anchor.id) && applyFilters([e], filters).length) {
      chosen.set(e.id, e);
    }
  }

  // High-relevance siblings above a floor relative to the anchor's score
  // (only when we ran a search — an id-seeded cluster uses links only).
  if (ranked.length > 0) {
    const floor = ranked[0].score * relFloor;
    for (const r of ranked.slice(1)) {
      if (chosen.size >= max) break;
      if (r.score >= floor) chosen.set(r.entry.id, r.entry);
    }
  }

  const members = [...chosen.values()].sort(
    (a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime(),
  );
  return { anchor, members, ranked };
}
