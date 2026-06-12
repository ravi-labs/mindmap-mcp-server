/**
 * Local embedding cache for semantic / hybrid search.
 *
 * Embeddings are optional and BYO-key (openai / google / ollama). We cache one
 * vector per memory in ~/.mindmap/embeddings.json, keyed by a content hash so we
 * only (re)embed memories that are new or changed — search never pays to embed
 * the whole corpus, and there's no cloud index. If the embed model changes, the
 * cache is rebuilt. Everything degrades to BM25 when embeddings aren't available.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./constants.js";
import { embed, embedModelName } from "./llm.js";
import { type IndexEntry } from "./types.js";

const EMB_FILE = path.join(DATA_DIR, "embeddings.json");

interface EmbCache {
  /** Which embed model produced these — change ⇒ rebuild all. */
  model: string;
  vectors: Record<string, { hash: string; v: number[] }>;
}

/** The text we embed for an entry — kept consistent with BM25's document. */
function docText(e: IndexEntry): string {
  return [e.title, e.trace, e.tags.join(" ")].filter(Boolean).join("\n");
}

function hash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

async function load(): Promise<EmbCache> {
  try {
    return JSON.parse(await fs.readFile(EMB_FILE, "utf8")) as EmbCache;
  } catch {
    return { model: "", vectors: {} };
  }
}

async function save(c: EmbCache): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${EMB_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(c), "utf8");
  await fs.rename(tmp, EMB_FILE);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** id → vector for every memory with a cached embedding. */
export async function loadVectors(): Promise<Map<string, number[]>> {
  const c = await load();
  const m = new Map<string, number[]>();
  for (const [id, e] of Object.entries(c.vectors)) m.set(id, e.v);
  return m;
}

export interface EmbedBuildResult {
  embedded: number;
  reused: number;
  removed: number;
  total: number;
  model: string;
}

/**
 * Build / refresh the embedding cache for `entries`. Only (re)embeds new or
 * changed memories, drops vectors for deleted ones, and rebuilds everything if
 * the embed model changed. Batched. Throws if embeddings aren't available.
 */
export async function buildEmbeddings(
  entries: IndexEntry[],
  opts: { batch?: number } = {},
): Promise<EmbedBuildResult> {
  const model = await embedModelName();
  if (!model) {
    throw new Error(
      "Embeddings not available — configure an embeddings-capable provider (openai, google, or ollama) via mindmap_llm.",
    );
  }
  const cache = await load();
  const modelChanged = cache.model !== model;
  const next: EmbCache = { model, vectors: {} };
  const toEmbed: { id: string; text: string; h: string }[] = [];
  let reused = 0;

  for (const e of entries) {
    const text = docText(e);
    const h = hash(text);
    const prev = cache.vectors[e.id];
    if (!modelChanged && prev && prev.hash === h) {
      next.vectors[e.id] = prev;
      reused += 1;
    } else {
      toEmbed.push({ id: e.id, text, h });
    }
  }

  const newIds = new Set(entries.map((e) => e.id));
  const removed = Object.keys(cache.vectors).filter((id) => !newIds.has(id)).length;

  const batch = opts.batch ?? 64;
  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += batch) {
    const slice = toEmbed.slice(i, i + batch);
    const vecs = await embed(slice.map((s) => s.text));
    slice.forEach((s, idx) => {
      const v = vecs[idx];
      if (v && v.length) {
        next.vectors[s.id] = { hash: s.h, v };
        embedded += 1;
      }
    });
  }

  await save(next);
  return { embedded, reused, removed, total: entries.length, model };
}
