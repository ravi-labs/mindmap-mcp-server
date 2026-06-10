/**
 * Memory Passport — own your context, take it anywhere.
 *
 * Two jobs:
 *   1. EXPORT/IMPORT an open, portable Mind Map file (memories + persona) so you
 *      can move your context between machines, back it up, or hand it to a fork.
 *   2. PULL CONTEXT OUT OF WALLED GARDENS — import the *data-export files* from
 *      ChatGPT and Claude.ai into Mind Map. (Those products can't be reached
 *      live from a local server, but their export files are yours to read.)
 *
 * The thesis: interoperability isn't portability. A memory you can't extract is
 * a memory you don't own. The passport is the extraction.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { SERVER_VERSION } from "./constants.js";
import { makeTrace } from "./decay.js";
import { composeSummary } from "./import.js";
import { mergeFacts, type PersonaFact } from "./persona.js";
import { allEntries, getThread, newId, nowIso, saveThread } from "./store.js";
import { type Thread } from "./types.js";

const PASSPORT_FORMAT = "mindmap-passport";
const PASSPORT_VERSION = 1;

export interface Passport {
  format: typeof PASSPORT_FORMAT;
  version: number;
  generator: string;
  exportedAt: string;
  counts: { memories: number; persona: number };
  memories: Thread[];
  persona: PersonaFact[];
}

export interface IngestCount {
  source: string;
  total: number;
  imported: number;
  skippedDup: number;
}

// --- A common draft shape for anything we ingest -----------------------------

interface Draft {
  sourceId: string;
  source: string;
  title: string;
  summary: string;
  keyPoints: string[];
  firstTs: string;
  lastTs: string;
}

function draftToThread(d: Draft): Thread {
  return {
    id: newId(),
    title: d.title,
    summary: d.summary,
    keyPoints: d.keyPoints,
    tags: [d.source, "imported"],
    source: d.source,
    tier: "warm",
    status: "captured",
    trace: makeTrace({ title: d.title, keyPoints: d.keyPoints, summary: d.summary }),
    links: [],
    createdAt: d.firstTs,
    updatedAt: d.lastTs,
    lastAccessedAt: d.lastTs,
    accessCount: 0,
    sourceId: d.sourceId,
  };
}

/** Save drafts that aren't already present (dedup by sourceId). */
async function ingestDrafts(drafts: Draft[], source: string): Promise<IngestCount> {
  const existing = new Set(
    (await allEntries()).map((e) => e.sourceId).filter(Boolean) as string[],
  );
  let imported = 0;
  let skippedDup = 0;
  for (const d of drafts) {
    if (existing.has(d.sourceId)) {
      skippedDup++;
      continue;
    }
    await saveThread(draftToThread(d));
    existing.add(d.sourceId);
    imported++;
  }
  return { source, total: drafts.length, imported, skippedDup };
}

function expand(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

// --- Export ------------------------------------------------------------------

/** Write a portable passport of every memory + persona fact to `outPath`. */
export async function exportPassport(outPath?: string): Promise<{ path: string; counts: Passport["counts"] }> {
  const entries = await allEntries();
  const memories: Thread[] = [];
  for (const e of entries) {
    const t = await getThread(e.id);
    if (t) memories.push(t);
  }
  // persona facts (lazy import avoids a hard cycle at module load)
  const { allFacts } = await import("./persona.js");
  const persona = await allFacts();

  const passport: Passport = {
    format: PASSPORT_FORMAT,
    version: PASSPORT_VERSION,
    generator: `mindmap-mcp-server@${SERVER_VERSION}`,
    exportedAt: nowIso(),
    counts: { memories: memories.length, persona: persona.length },
    memories,
    persona,
  };

  const dest = outPath
    ? expand(outPath)
    : path.join(os.homedir(), `mindmap-passport-${nowIso().slice(0, 10)}.json`);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, JSON.stringify(passport, null, 2), "utf8");
  return { path: dest, counts: passport.counts };
}

// --- Import: a Mind Map passport --------------------------------------------

export interface PassportImportResult {
  memories: { imported: number; skippedDup: number; total: number };
  persona: { added: number; updated: number };
}

/** Ingest a passport file produced by exportPassport (this or another machine). */
export async function importPassport(file: string): Promise<PassportImportResult> {
  const raw = await fs.readFile(expand(file), "utf8");
  const p = JSON.parse(raw) as Partial<Passport>;
  if (p.format !== PASSPORT_FORMAT) {
    throw new Error(`Not a Mind Map passport (format: ${String(p.format)}).`);
  }

  const existing = new Set(
    (await allEntries()).map((e) => e.sourceId).filter(Boolean) as string[],
  );
  let imported = 0;
  let skippedDup = 0;
  const mems = Array.isArray(p.memories) ? p.memories : [];
  for (const m of mems) {
    // A stable marker so re-importing the same passport dedups cleanly.
    const marker = `passport:${m.sourceId || m.id}`;
    if (existing.has(marker)) {
      skippedDup++;
      continue;
    }
    const thread: Thread = {
      ...m,
      id: newId(), // fresh local id; original id may collide
      sourceId: marker,
      tags: Array.from(new Set([...(m.tags || []), "passport"])),
    };
    await saveThread(thread);
    existing.add(marker);
    imported++;
  }

  const persona = Array.isArray(p.persona) ? await mergeFacts(p.persona) : { added: 0, updated: 0 };
  return { memories: { imported, skippedDup, total: mems.length }, persona };
}

// --- Import: ChatGPT data export (conversations.json) ------------------------

interface GptNode {
  message?: {
    author?: { role?: string };
    create_time?: number;
    content?: { content_type?: string; parts?: unknown[] };
  };
}
interface GptConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, GptNode>;
}

function gptText(node: GptNode): string {
  const parts = node.message?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((x) => typeof x === "string").join("\n").trim();
}

/** Parse ChatGPT's exported conversations.json into draft memories. */
export async function importChatGPT(file: string): Promise<IngestCount> {
  const data = JSON.parse(await fs.readFile(expand(file), "utf8")) as unknown;
  const convos: GptConversation[] = Array.isArray(data)
    ? (data as GptConversation[])
    : Array.isArray((data as { conversations?: unknown[] }).conversations)
      ? ((data as { conversations: GptConversation[] }).conversations)
      : [];

  const drafts: Draft[] = [];
  for (const c of convos) {
    const nodes = Object.values(c.mapping || {})
      .filter((n) => n.message && gptText(n))
      .map((n) => ({
        role: n.message!.author?.role || "",
        text: gptText(n),
        t: typeof n.message!.create_time === "number" ? n.message!.create_time : 0,
      }))
      .filter((m) => m.role === "user" || m.role === "assistant")
      .sort((a, b) => a.t - b.t);
    if (nodes.length === 0) continue;

    const prompts = nodes.filter((n) => n.role === "user").map((n) => n.text);
    const answers = nodes.filter((n) => n.role === "assistant" && n.text.length > 60).map((n) => n.text);
    const times = nodes.map((n) => n.t).filter((t) => t > 0).sort((a, b) => a - b);
    const firstMs = (times[0] || c.create_time || 0) * 1000;
    const lastMs = (times[times.length - 1] || c.update_time || c.create_time || 0) * 1000;
    if (!firstMs) continue;

    drafts.push({
      sourceId: `chatgpt:${c.id || c.conversation_id || c.title || prompts[0]?.slice(0, 40)}`,
      source: "chatgpt",
      title: c.title || prompts[0]?.slice(0, 80) || "ChatGPT conversation",
      summary: composeSummary(prompts, answers),
      keyPoints: prompts.slice(0, 8).map((p) => p.slice(0, 200)),
      firstTs: new Date(firstMs).toISOString(),
      lastTs: new Date(lastMs || firstMs).toISOString(),
    });
  }
  return ingestDrafts(drafts, "chatgpt");
}

// --- Import: Claude.ai data export (conversations.json) ----------------------

interface ClaudeMsg {
  sender?: string; // "human" | "assistant"
  text?: string;
  created_at?: string;
  content?: { type?: string; text?: string }[];
}
interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  updated_at?: string;
  chat_messages?: ClaudeMsg[];
}

function claudeText(m: ClaudeMsg): string {
  if (typeof m.text === "string" && m.text.trim()) return m.text.trim();
  if (Array.isArray(m.content)) {
    return m.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n")
      .trim();
  }
  return "";
}

/** Parse Claude.ai's exported conversations.json into draft memories. */
export async function importClaudeExport(file: string): Promise<IngestCount> {
  const data = JSON.parse(await fs.readFile(expand(file), "utf8")) as unknown;
  const convos: ClaudeConversation[] = Array.isArray(data) ? (data as ClaudeConversation[]) : [];

  const drafts: Draft[] = [];
  for (const c of convos) {
    const msgs = (c.chat_messages || [])
      .map((m) => ({ role: m.sender || "", text: claudeText(m), at: m.created_at || "" }))
      .filter((m) => (m.role === "human" || m.role === "assistant") && m.text);
    if (msgs.length === 0) continue;

    const prompts = msgs.filter((m) => m.role === "human").map((m) => m.text);
    const answers = msgs.filter((m) => m.role === "assistant" && m.text.length > 60).map((m) => m.text);
    const first = c.created_at || msgs[0].at;
    const last = c.updated_at || msgs[msgs.length - 1].at || first;
    if (!first) continue;

    drafts.push({
      sourceId: `claude-web:${c.uuid || c.name || prompts[0]?.slice(0, 40)}`,
      source: "claude-web",
      title: c.name || prompts[0]?.slice(0, 80) || "Claude conversation",
      summary: composeSummary(prompts, answers),
      keyPoints: prompts.slice(0, 8).map((p) => p.slice(0, 200)),
      firstTs: new Date(first).toISOString(),
      lastTs: new Date(last).toISOString(),
    });
  }
  return ingestDrafts(drafts, "claude-web");
}

/** Dispatch a walled-garden import by kind. */
export async function importExport(kind: string, file: string): Promise<IngestCount> {
  if (kind === "chatgpt") return importChatGPT(file);
  if (kind === "claude" || kind === "claude-web") return importClaudeExport(file);
  throw new Error(`Unknown export kind '${kind}'. Use 'chatgpt' or 'claude'.`);
}
