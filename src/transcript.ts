/**
 * On-demand full-discussion reconstruction.
 *
 * The memory store keeps only distilled summaries. When a user wants the FULL
 * conversation, we read it live from the original source via the thread's
 * sourceRef — keeping the store lean while making every turn accessible.
 *
 * Available only for transcript-backed sources (Claude Code CLI, Copilot,
 * Cursor). Metadata-only sources (Cowork, Claude desktop-app) never saved a
 * transcript, so there is nothing to reconstruct.
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Thread } from "./types.js";

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

export interface TranscriptResult {
  available: boolean;
  turns: Turn[];
  reason?: string;
  truncated?: boolean;
}

const MAX_TURNS = 400;

function cursorGlobalDb(): string {
  let base: string;
  if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support", "Cursor");
  } else if (process.platform === "win32") {
    base = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor");
  } else {
    base = path.join(os.homedir(), ".config", "Cursor");
  }
  return path.join(base, "User", "globalStorage", "state.vscdb");
}

function isHumanText(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const t = s.trim();
  return t.length > 0 && !t.startsWith("<") && !t.startsWith("Caveat:") && !t.startsWith("[Request interrupted");
}

function cap(turns: Turn[]): TranscriptResult {
  if (turns.length > MAX_TURNS) {
    return { available: true, turns: turns.slice(0, MAX_TURNS), truncated: true };
  }
  return { available: true, turns };
}

async function fromClaudeCli(file: string): Promise<TranscriptResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return { available: false, turns: [], reason: "Original Claude Code transcript no longer on disk." };
  }
  const turns: Turn[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const content = (o.message as { content?: unknown } | undefined)?.content;
    if (o.type === "user" && isHumanText(content)) {
      turns.push({ role: "user", text: content.trim() });
    } else if (o.type === "assistant" && Array.isArray(content)) {
      const parts: string[] = [];
      for (const b of content) {
        if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
          const txt = String((b as { text?: unknown }).text ?? "").trim();
          if (txt) parts.push(txt);
        }
      }
      if (parts.length) turns.push({ role: "assistant", text: parts.join("\n\n") });
    }
  }
  return cap(turns);
}

async function fromCopilot(file: string): Promise<TranscriptResult> {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return { available: false, turns: [], reason: "Original Copilot chat no longer on disk." };
  }
  const requests = Array.isArray(o.requests) ? (o.requests as Record<string, unknown>[]) : [];
  const turns: Turn[] = [];
  for (const r of requests) {
    const userText = (r.message as { text?: unknown } | undefined)?.text;
    if (isHumanText(userText)) turns.push({ role: "user", text: userText.trim() });
    if (Array.isArray(r.response)) {
      const parts: string[] = [];
      for (const block of r.response as Record<string, unknown>[]) {
        if (block && typeof block.value === "string") parts.push(block.value);
      }
      const joined = parts.join("").trim();
      if (joined) turns.push({ role: "assistant", text: joined });
    }
  }
  return cap(turns);
}

const CURSOR_TRANSCRIPT_READER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.MM_CURSOR_DB, { readOnly: true });
const cid = process.env.MM_COMPOSER_ID;
const head = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get('composerData:' + cid);
let headers = [];
if (head) { try { const o = JSON.parse(head.value); headers = o.fullConversationHeadersOnly || []; } catch {} }
const get = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
const turns = [];
for (const h of headers) {
  const bid = (h && h.bubbleId) ? h.bubbleId : h;
  const r = get.get('bubbleId:' + cid + ':' + bid);
  if (!r) continue;
  try { const b = JSON.parse(r.value); const t = (b.text || '').trim();
    if (t) turns.push({ role: b.type === 1 ? 'user' : 'assistant', text: t }); } catch {}
}
db.close();
process.stdout.write(JSON.stringify(turns));
`;

async function fromCursor(composerId: string): Promise<TranscriptResult> {
  const dbPath = cursorGlobalDb();
  try {
    await fs.access(dbPath);
  } catch {
    return { available: false, turns: [], reason: "Cursor database not found." };
  }
  const child = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", "-e", CURSOR_TRANSCRIPT_READER],
    { env: { ...process.env, MM_CURSOR_DB: dbPath, MM_COMPOSER_ID: composerId }, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    return { available: false, turns: [], reason: "Could not read Cursor transcript (needs Node 22.5+)." };
  }
  let turns: Turn[];
  try {
    turns = JSON.parse(child.stdout || "[]") as Turn[];
  } catch {
    return { available: false, turns: [], reason: "Could not parse Cursor transcript." };
  }
  return cap(turns);
}

export async function getTranscript(thread: Thread): Promise<TranscriptResult> {
  const ref = thread.sourceRef;
  if (!ref) {
    return {
      available: false,
      turns: [],
      reason: "Full discussion isn't available for this source (only a title + opening message was saved).",
    };
  }
  if (ref.kind === "claude-code-cli" && ref.file) return fromClaudeCli(ref.file);
  if (ref.kind === "copilot" && ref.file) return fromCopilot(ref.file);
  if (ref.kind === "cursor" && ref.composerId) return fromCursor(ref.composerId);
  return { available: false, turns: [], reason: "Unrecognized source reference." };
}

/** Markdown rendering of a transcript, for the MCP tool. */
export function formatTranscript(t: Thread, res: TranscriptResult): string {
  if (!res.available) return `# ${t.title}\n\n_${res.reason}_`;
  const lines = [`# Full discussion: ${t.title}`, `_${res.turns.length} turns · source: ${t.source}_`, ""];
  for (const turn of res.turns) {
    lines.push(turn.role === "user" ? "## 🧑 You" : "## 🤖 Assistant");
    lines.push(turn.text, "");
  }
  if (res.truncated) lines.push(`_…truncated to ${MAX_TURNS} turns._`);
  return lines.join("\n");
}
