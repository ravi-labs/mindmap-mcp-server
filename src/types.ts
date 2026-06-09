/** Core domain types for Mind Map. */

/** Storage/decay tier. hot=mem, warm=files, cold=drive (trace only). */
export type Tier = "hot" | "warm" | "cold";

/**
 * A pointer back to a session's original transcript, so the full discussion can
 * be reconstructed on demand. Only set for sources whose transcript is on disk
 * (Claude Code CLI, Copilot, Cursor). Metadata-only sources (Cowork, Claude
 * desktop-app) have no transcript and leave this undefined.
 */
export interface SourceRef {
  kind: "claude-code-cli" | "copilot" | "cursor";
  /** Absolute file path for cli/copilot sources. */
  file?: string;
  /** Session id (cli). */
  sessionId?: string;
  /** Composer id (cursor) — looked up in the global SQLite db. */
  composerId?: string;
}

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
  /** Origin id for imported memories (e.g. a Claude Code sessionId) — for dedup. */
  sourceId?: string;
  /** Pointer to the original transcript, for on-demand full-discussion view. */
  sourceRef?: SourceRef;
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
  sourceId?: string;
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
    ...(t.sourceId ? { sourceId: t.sourceId } : {}),
  };
}
