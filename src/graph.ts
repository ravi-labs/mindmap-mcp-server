/**
 * The topic mind-graph engine.
 *
 * Turns the flat list of memories into a semantic graph:
 *  - CATEGORIES: the most distinctive recurring topics across all sessions
 *    (auto-derived via TF-IDF over titles + key terms) — the top-level labels.
 *  - NODES: each session, tagged with the categories it belongs to.
 *  - EDGES: sessions connected when their topic vectors are similar (cosine),
 *    so related discussions link regardless of which tool they came from.
 *
 * Pure local computation — no embeddings, no cloud. Good enough to reveal
 * structure and make "find the related session" work.
 */

import { type IndexEntry } from "./types.js";

const STOPWORDS = new Set([
  // generic English
  "the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by",
  "with", "from", "as", "is", "are", "was", "were", "be", "been", "it", "its", "this",
  "that", "these", "those", "i", "we", "you", "they", "my", "our", "your", "me", "us",
  "so", "if", "then", "than", "into", "out", "up", "down", "over", "about", "can", "will",
  "would", "should", "could", "do", "does", "did", "not", "no", "yes", "how", "what",
  "why", "when", "where", "which", "who", "some", "any", "all", "more", "most", "other",
  "want", "need", "like", "get", "got", "make", "see", "let", "lets", "via", "using",
  "use", "used", "new", "also", "just", "etc", "ect", "am", "pm",
  // generic build/dev verbs that dominate titles (too common to be topics)
  "build", "create", "add", "set", "setup", "implement", "fix", "update", "review",
  "plan", "continue", "research", "brainstorm", "generate", "run", "start", "help",
  "project", "app", "apps", "tool", "code", "file", "files", "simple", "based", "based",
  "system", "feature", "demo", "test", "data", "page", "support",
  // source/meta noise (these are tags or ever-present words, not topics)
  "claude", "cowork", "copilot", "cursor", "imported", "output", "outputs", "session",
  "sessions", "have", "has", "had", "prepare", "prepared", "now", "give", "given", "one",
  "two", "three", "first", "good", "work", "working", "idea", "ideas", "thing", "things",
  "here", "there", "kind", "explore", "really", "actually", "something", "anything",
  // docker-style random worktree codenames (project basenames for git worktrees)
  "relaxed", "elated", "modest", "nice", "hopeful", "friendly", "eager", "happy", "clever",
  "brave", "bold", "calm", "gentle", "jolly", "keen", "vigilant", "serene", "compassionate",
  "confident", "charming", "blissful", "ecstatic", "xenodochial", "sanderson", "bartik",
  "perlman", "fermat", "volhard", "bhaskara", "meitner", "mendel", "planck", "johnson",
]);

/** Light singularization so plurals collapse (agent/agents, team/teams → one term). */
function singularize(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    // Filter stopwords on the RAW token first (so "this"/"does" are dropped before
    // singularize turns them into "thi"/"doe"), then singularize and re-filter.
    .filter((t) => t.length > 2 && t.length < 24 && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(singularize)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/** Weighted bag of terms for one memory — title counts most. */
function docTerms(e: IndexEntry): Map<string, number> {
  const m = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + weight);
  };
  add(e.title, 3);
  add(e.trace, 1);
  add(e.tags.join(" "), 2);
  return m;
}

export interface GraphNode {
  id: string;
  title: string;
  source: string;
  tier: string;
  status: string;
  cats: string[];
  terms: string[];
}
export interface GraphEdge {
  s: string;
  t: string;
  w: number;
}
export interface GraphCategory {
  term: string;
  count: number;
}
export interface TopicGraph {
  categories: GraphCategory[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const TOP_TERMS_PER_DOC = 10;
const MAX_CATEGORIES = 16;
const MIN_CATEGORY_DOCS = 3;
const NEIGHBORS_PER_NODE = 6;
const EDGE_THRESHOLD = 0.12;
const CATEGORY_CANDIDATES = 40; // shortlist by frequency before the cohesion filter
const COHESION_MIN = 0.012; // drop categories whose members aren't actually related
const COHESION_SAMPLE = 30; // cap members compared per candidate (perf)

export function buildGraph(entries: IndexEntry[]): TopicGraph {
  const docs = entries.filter((e) => e.status !== "archived");
  const N = docs.length;
  if (N === 0) return { categories: [], nodes: [], edges: [] };

  // Document frequency for IDF + category selection.
  const df = new Map<string, number>();
  const rawTerms: Map<string, number>[] = [];
  for (const e of docs) {
    const terms = docTerms(e);
    rawTerms.push(terms);
    for (const term of terms.keys()) df.set(term, (df.get(term) ?? 0) + 1);
  }

  const idf = (term: string) => Math.log(N / (df.get(term) ?? 1));

  // TF-IDF vectors, keeping each doc's top terms.
  const vectors: Map<string, number>[] = [];
  const topTermsByDoc: string[][] = [];
  const norms: number[] = [];
  for (let i = 0; i < docs.length; i++) {
    const tf = rawTerms[i];
    const scored: [string, number][] = [];
    for (const [term, count] of tf) scored.push([term, count * idf(term)]);
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, TOP_TERMS_PER_DOC);
    const vec = new Map<string, number>(top);
    vectors.push(vec);
    topTermsByDoc.push(top.map(([t]) => t));
    let sum = 0;
    for (const [, w] of top) sum += w * w;
    norms.push(Math.sqrt(sum) || 1);
  }

  // Which docs carry each term in their top terms (for cohesion scoring).
  const membersByTerm = new Map<string, number[]>();
  topTermsByDoc.forEach((terms, i) => {
    for (const t of terms) {
      const arr = membersByTerm.get(t) ?? [];
      arr.push(i);
      membersByTerm.set(t, arr);
    }
  });

  // Cohesion = how related a term's member docs are to EACH OTHER, ignoring the
  // shared term itself. A real topic ("agent") has members that also share other
  // terms; a spurious one ("ride") has members that share nothing else → ~0.
  const cohesion = (term: string): number => {
    const members = (membersByTerm.get(term) ?? []).slice(0, COHESION_SAMPLE);
    if (members.length < 2) return 0;
    let sum = 0;
    let pairs = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        sum += cosineExcluding(vectors[members[a]], vectors[members[b]], norms[members[a]], norms[members[b]], term);
        pairs += 1;
      }
    }
    return pairs ? sum / pairs : 0;
  };

  // Categories: frequent terms, filtered to those whose members are genuinely
  // related (drops noise like "ride"/"tender"), top by frequency.
  const scoredCats = [...df.entries()]
    .filter(([, c]) => c >= MIN_CATEGORY_DOCS && c <= N * 0.6)
    .sort((a, b) => b[1] - a[1])
    .slice(0, CATEGORY_CANDIDATES)
    .map(([term, count]) => ({ term, count, coh: cohesion(term) }));
  if (process.env.MM_DEBUG_COH) {
    console.error(
      scoredCats.map((c) => `${c.term}(${c.count}):${c.coh.toFixed(3)}`).join(" "),
    );
  }
  const categories: GraphCategory[] = scoredCats
    .filter((c) => c.coh >= COHESION_MIN)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_CATEGORIES)
    .map(({ term, count }) => ({ term, count }));
  const catSet = new Set(categories.map((c) => c.term));

  // Nodes with their category memberships.
  const nodes: GraphNode[] = docs.map((e, i) => ({
    id: e.id,
    title: e.title,
    source: e.source,
    tier: e.tier,
    status: e.status,
    cats: topTermsByDoc[i].filter((t) => catSet.has(t)),
    terms: topTermsByDoc[i].slice(0, 5),
  }));

  // Edges via an inverted index (only compare docs that share a top term).
  const postings = new Map<string, number[]>();
  topTermsByDoc.forEach((terms, i) => {
    for (const t of terms) {
      const arr = postings.get(t) ?? [];
      arr.push(i);
      postings.set(t, arr);
    }
  });

  // Cosine over candidate pairs (dedup via key), keep top-K neighbors per node.
  const neighbors = new Map<number, [number, number][]>();
  const seen = new Set<string>();
  for (const ids of postings.values()) {
    if (ids.length < 2 || ids.length > 60) continue;
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a];
        const j = ids[b];
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const sim = cosine(vectors[i], vectors[j], norms[i], norms[j]);
        if (sim < EDGE_THRESHOLD) continue;
        pushNeighbor(neighbors, i, j, sim);
        pushNeighbor(neighbors, j, i, sim);
      }
    }
  }

  const edgeSet = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const [i, ns] of neighbors) {
    ns.sort((a, b) => b[1] - a[1]);
    for (const [j, w] of ns.slice(0, NEIGHBORS_PER_NODE)) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      if (edgeSet.has(key)) continue;
      edgeSet.add(key);
      edges.push({ s: docs[i].id, t: docs[j].id, w: Math.round(w * 100) / 100 });
    }
  }

  return { categories, nodes, edges };
}

function pushNeighbor(
  m: Map<number, [number, number][]>,
  from: number,
  to: number,
  w: number,
): void {
  const arr = m.get(from) ?? [];
  arr.push([to, w]);
  m.set(from, arr);
}

function cosine(
  a: Map<string, number>,
  b: Map<string, number>,
  na: number,
  nb: number,
): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, wa] of small) {
    const wb = large.get(term);
    if (wb) dot += wa * wb;
  }
  return dot / (na * nb);
}

/** Cosine similarity ignoring one shared term — measures relatedness *beyond* it. */
function cosineExcluding(
  a: Map<string, number>,
  b: Map<string, number>,
  na: number,
  nb: number,
  exclude: string,
): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, wa] of small) {
    if (term === exclude) continue;
    const wb = large.get(term);
    if (wb) dot += wa * wb;
  }
  return dot / (na * nb);
}
