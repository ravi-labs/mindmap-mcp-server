/** Core domain types for Mind Map. */

/** Storage/decay tier. hot=mem, warm=files, cold=drive (trace only). */
export type Tier = "hot" | "warm" | "cold";

/**
 * Lifecycle status:
 *  - captured : silently saved, not yet vouched for by a human
 *  - promoted : pulled forward / blessed at least once -> trusted memory
 *  - archived : explicitly forgotten; kept only as a searchable trace
 */
export type Status = "captured" | "promoted" | "archived";

/** A single unit of memory — a portable context artifact for one topic/thread. */
export interface Thread {
  id: string;
  title: string;
  /** The portable summary you inject into a new session. Markdown. */
  summary: string;
  /** Scannable bullet points — the "discussion points" to relocate fast. */
  keyPoints: string[];
  tags: string[];
  /** Origin tool: claude-code | chatgpt | chat | cowork | claude-desktop | ... */
  source: string;
  tier: Tier;
  status: Status;
  /** One-line distillation kept when a thread decays to cold. */
  trace: string;
  /** ids of related threads — the connective tissue of the map. */
  links: string[];
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
  promotedAt?: string;
  archivedAt?: string;
}

/** Lightweight record kept in index.json for fast listing/search. */
export interface IndexEntry {
  id: string;
  title: string;
  trace: string;
  tags: string[];
  source: string;
  tier: Tier;
  status: Status;
  links: string[];
  updatedAt: string;
  lastAccessedAt: string;
  accessCount: number;
}

export function toIndexEntry(t: Thread): IndexEntry {
  return {
    id: t.id,
    title: t.title,
    trace: t.trace,
    tags: t.tags,
    source: t.source,
    tier: t.tier,
    status: t.status,
    links: t.links,
    updatedAt: t.updatedAt,
    lastAccessedAt: t.lastAccessedAt,
    accessCount: t.accessCount,
  };
}
