/**
 * Import past Claude sessions into Mind Map, across multiple local stores.
 *
 *   npx @ravi-labs/mindmap-mcp-server import [--dry-run] [--limit N]
 *        [--project <substr>] [--source code|cowork|all] [--min-prompts N]
 *
 * Sources (macOS paths):
 *   - claude-code (CLI):  ~/.claude/projects (jsonl transcripts)   — RICH (all prompts)
 *   - claude-code (app):  ~/Library/Application Support/Claude/claude-code-sessions (local_*.json)
 *   - cowork:             ~/Library/Application Support/Claude/local-agent-mode-sessions (local_*.json)
 *
 * App/Cowork files store metadata only (title + opening message + timestamps),
 * so those memories are lighter than CLI imports. Each session becomes ONE
 * distilled thread tagged by source, with its ORIGINAL timestamps so decay tiers
 * it correctly. Dedup is by source id (the app store's cliSessionId links back to
 * the CLI transcript, so richer CLI imports win).
 */

import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type Config } from "./constants.js";
import { makeTrace, prune } from "./decay.js";
import {
  allEntries,
  deleteThread,
  getConfig,
  getThread,
  newId,
  nowIso,
  saveThread,
} from "./store.js";
import { type IndexEntry, type SourceRef, type Thread } from "./types.js";

const HOME = os.homedir();

/** The Claude desktop data dir, per OS (holds Cowork + app Code sessions). */
function appSupportClaudeDir(): string {
  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "Claude");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    return path.join(appData, "Claude");
  }
  return path.join(HOME, ".config", "Claude");
}

/** VS Code's per-user data dir, per OS (holds Copilot chat sessions). */
function vscodeUserDir(): string {
  if (process.platform === "darwin") {
    return path.join(HOME, "Library", "Application Support", "Code", "User");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  return path.join(HOME, ".config", "Code", "User");
}

const APP_SUPPORT = appSupportClaudeDir();
const CODE_CLI_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(HOME, ".claude", "projects");
const VSCODE_WS_DIR = path.join(vscodeUserDir(), "workspaceStorage");

/** Cursor's global SQLite key-value DB (holds composer/chat sessions). */
function cursorGlobalDb(): string {
  let base: string;
  if (process.platform === "darwin") {
    base = path.join(HOME, "Library", "Application Support", "Cursor");
  } else if (process.platform === "win32") {
    base = path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Cursor");
  } else {
    base = path.join(HOME, ".config", "Cursor");
  }
  return path.join(base, "User", "globalStorage", "state.vscdb");
}
const CODE_APP_DIR = path.join(APP_SUPPORT, "claude-code-sessions");
const COWORK_DIR = path.join(APP_SUPPORT, "local-agent-mode-sessions");

const MIN_CONTENT = 15; // skip trivial one-liners from metadata stores
const PRUNE_DIRS = new Set(["skills-plugin", "node_modules", ".git"]);

interface ParsedSession {
  sourceId: string;
  source: string;
  title: string;
  summary: string;
  keyPoints: string[];
  project: string;
  firstTs: string;
  lastTs: string;
  ref?: SourceRef;
}

interface Options {
  dryRun: boolean;
  limit: number;
  project?: string;
  source: "all" | "code" | "cowork" | "copilot" | "cursor";
  minPrompts: number;
  reimport: boolean;
}

/** Should this source key be included given the --source filter? */
function wants(opts: Options, key: "claude-code" | "cowork" | "copilot" | "cursor"): boolean {
  if (opts.source === "all") return true;
  if (opts.source === "code") return key === "claude-code";
  return opts.source === key;
}

function parseArgs(argv: string[]): Options {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const src = (get("--source") || "all").toLowerCase();
  const valid =
    src === "code" || src === "cowork" || src === "copilot" || src === "cursor";
  return {
    dryRun: argv.includes("--dry-run"),
    limit: parseInt(get("--limit") || "0", 10) || Infinity,
    project: get("--project"),
    source: valid ? (src as Options["source"]) : "all",
    minPrompts: parseInt(get("--min-prompts") || "1", 10),
    reimport: argv.includes("--reimport"),
  };
}

function msToIso(ms: unknown): string | null {
  if (typeof ms !== "number" || !isFinite(ms)) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Recursively collect files matching a predicate, pruning heavy dirs. */
async function walk(dir: string, match: (name: string) => boolean): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      if (PRUNE_DIRS.has(e.name)) continue;
      out.push(...(await walk(path.join(dir, e.name), match)));
    } else if (match(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// --- Source adapter: Claude Code CLI (rich JSONL transcripts) ---------------

function isHumanPrompt(content: unknown): content is string {
  if (typeof content !== "string") return false;
  const t = content.trim();
  if (t.length < 3) return false;
  if (t.startsWith("<")) return false;
  if (t.startsWith("Caveat:")) return false;
  if (t.startsWith("[Request interrupted")) return false;
  return true;
}

/** Machine-generated/automated sessions (scheduled tasks, slash commands) — not discussions. */
export function isAutomated(text: string | undefined): boolean {
  const t = (text || "").trim();
  return (
    t.startsWith("<scheduled-task") ||
    t.startsWith("<command-name") ||
    t.startsWith("<command-message") ||
    t.startsWith("<local-command")
  );
}

async function parseCodeCli(file: string): Promise<ParsedSession | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
  let sessionId = path.basename(file, ".jsonl");
  let aiTitle = "";
  let project = "";
  const prompts: string[] = [];
  const answers: string[] = []; // assistant text — the substance/outcome
  const seen = new Set<string>();
  const timestamps: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof o.sessionId === "string") sessionId = o.sessionId;
    if (typeof o.timestamp === "string") timestamps.push(o.timestamp);
    if (typeof o.cwd === "string" && !project) project = path.basename(o.cwd);
    if (o.type === "ai-title" && typeof o.aiTitle === "string") aiTitle = o.aiTitle;
    if (o.type === "user") {
      const content = (o.message as { content?: unknown } | undefined)?.content;
      if (isHumanPrompt(content) && !seen.has(content)) {
        seen.add(content);
        prompts.push(content.trim());
      }
    }
    if (o.type === "assistant") {
      const content = (o.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
            const txt = String((block as { text?: unknown }).text ?? "").trim();
            if (txt.length > 60) answers.push(txt); // skip "Got it"/"Done" noise
          }
        }
      }
    }
  }
  if (timestamps.length === 0) return null;
  timestamps.sort();
  return {
    sourceId: sessionId,
    source: "claude-code",
    title: aiTitle || prompts[0]?.slice(0, 80) || "Untitled session",
    summary: composeSummary(prompts, answers),
    keyPoints: prompts.slice(0, 8).map((p) => p.slice(0, 200)),
    project: project || "unknown",
    firstTs: timestamps[0],
    lastTs: timestamps[timestamps.length - 1],
    ref: { kind: "claude-code-cli", file, sessionId },
  };
}

/**
 * Build a summary that captures the discussion AND its outcome — the asks plus
 * the assistant's substantive responses (where the real content lives). Falls
 * back to just the asks when there are no assistant texts (e.g. metadata sources).
 */
export function composeSummary(asks: string[], answers: string[], cap = 2400): string {
  const askGist = asks.slice(0, 3).join("\n").slice(0, 500);
  if (answers.length === 0) {
    return asks.length ? asks.slice(0, 6).join("\n\n").slice(0, 1500) : "(no content)";
  }
  const discussion = answers.join("\n\n");
  return `${askGist}\n\n— Discussion —\n${discussion}`.slice(0, cap).trim();
}

// --- Source adapter: metadata stores (Cowork + Claude Code desktop) ----------

async function parseMetaFile(
  file: string,
  source: string,
): Promise<ParsedSession | null> {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const title = typeof o.title === "string" ? o.title : "";
  const initial = typeof o.initialMessage === "string" ? o.initialMessage.trim() : "";
  if (isAutomated(initial)) return null; // skip scheduled tasks / automated runs
  const content = initial || title;
  if (content.trim().length < MIN_CONTENT) return null; // skip trivial

  const created = msToIso(o.createdAt) || msToIso(o.lastActivityAt);
  const last = msToIso(o.lastActivityAt) || created;
  if (!created || !last) return null;

  // Prefer cliSessionId so app sessions dedup against richer CLI imports.
  const sourceId =
    (typeof o.cliSessionId === "string" && o.cliSessionId) ||
    (typeof o.sessionId === "string" && o.sessionId) ||
    path.basename(file, ".json");
  const project = typeof o.cwd === "string" ? path.basename(o.cwd) : "unknown";

  return {
    sourceId,
    source,
    title: title || initial.slice(0, 80) || "Untitled session",
    summary: content.slice(0, 1500),
    keyPoints: initial ? [initial.slice(0, 200)] : [],
    project,
    firstTs: created,
    lastTs: last,
  };
}

// --- Source adapter: VS Code Copilot Chat (rich JSON sessions) --------------

async function copilotProject(file: string): Promise<string> {
  // file: …/workspaceStorage/<hash>/chatSessions/<id>.json -> sibling workspace.json
  const wsJson = path.join(path.dirname(file), "..", "workspace.json");
  try {
    const w = JSON.parse(await fs.readFile(wsJson, "utf8")) as Record<string, unknown>;
    const folder = (w.folder || w.workspace) as string | undefined;
    if (folder) return path.basename(decodeURIComponent(folder.replace(/^file:\/\//, "")));
  } catch {
    /* no workspace mapping */
  }
  return "vscode";
}

async function parseCopilot(file: string): Promise<ParsedSession | null> {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const requests = Array.isArray(o.requests) ? (o.requests as Record<string, unknown>[]) : [];
  const prompts: string[] = [];
  const answers: string[] = []; // assistant responses — the substance
  const seen = new Set<string>();
  for (const r of requests) {
    const text = (r.message as { text?: unknown } | undefined)?.text;
    if (isHumanPrompt(text) && !seen.has(text)) {
      seen.add(text);
      prompts.push(text.trim());
    }
    // Copilot stores the assistant reply as response: [{ value: "..." }, ...]
    if (Array.isArray(r.response)) {
      const parts: string[] = [];
      for (const block of r.response as Record<string, unknown>[]) {
        if (block && typeof block.value === "string") parts.push(block.value);
      }
      const joined = parts.join("").trim();
      if (joined.length > 60) answers.push(joined);
    }
  }
  const title = typeof o.customTitle === "string" ? o.customTitle : "";
  if (prompts.length === 0 && title.trim().length < MIN_CONTENT) return null;

  const created = msToIso(o.creationDate) || msToIso(o.lastMessageDate);
  const last = msToIso(o.lastMessageDate) || created;
  if (!created || !last) return null;

  const sourceId =
    (typeof o.sessionId === "string" && o.sessionId) || path.basename(file, ".json");
  return {
    sourceId,
    source: "copilot",
    title: title || prompts[0]?.slice(0, 80) || "Untitled chat",
    summary: composeSummary(prompts, answers) || title,
    keyPoints: prompts.slice(0, 8).map((p) => p.slice(0, 200)),
    project: await copilotProject(file),
    firstTs: created,
    lastTs: last,
    ref: { kind: "copilot", file },
  };
}

// --- Source adapter: Cursor (SQLite via node:sqlite in a flagged child) -----
//
// Cursor stores chats in a SQLite KV DB that can be multi-GB, so we can't load
// it into memory (sql.js / Buffers cap at 2GB). Instead we shell out to a child
// `node --experimental-sqlite` that reads it ON DISK and emits JSON. This needs
// Node 22.5+; older Node prints a hint and skips Cursor.

const CURSOR_READER = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.MM_CURSOR_DB, { readOnly: true });
const comps = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all();
const bubble = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE ? LIMIT 60");
const out = [];
for (const c of comps) {
  let o; try { o = JSON.parse(c.value); } catch { continue; }
  if (!o || typeof o !== 'object' || !o.composerId) continue;
  const prompts = []; const answers = []; const seen = new Set();
  for (const b of bubble.all('bubbleId:' + o.composerId + ':%')) {
    try { const bo = JSON.parse(b.value);
      if (!bo || typeof bo.text !== 'string') continue;
      const t = bo.text.trim();
      if (bo.type === 1) { if (t.length > 2 && !seen.has(t)) { seen.add(t); prompts.push(t); } }
      else if (bo.type === 2 && t.length > 60) { answers.push(t); }
    } catch {}
  }
  if (!o.name && prompts.length === 0) continue;
  out.push({ id: o.composerId, name: o.name || '', createdAt: o.createdAt, lastUpdatedAt: o.lastUpdatedAt, prompts: prompts.slice(0, 8), answers: answers.slice(0, 6) });
}
db.close();
process.stdout.write(JSON.stringify(out));
`;

interface CursorRaw {
  id: string;
  name: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  prompts: string[];
  answers?: string[];
}

async function collectCursor(): Promise<ParsedSession[]> {
  const dbPath = cursorGlobalDb();
  try {
    await fs.access(dbPath);
  } catch {
    return []; // Cursor not installed
  }

  const child = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", "-e", CURSOR_READER],
    { env: { ...process.env, MM_CURSOR_DB: dbPath }, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (child.status !== 0) {
    const err = String(child.stderr || "");
    if (/experimental-sqlite|node:sqlite|UNKNOWN_BUILTIN_MODULE/.test(err)) {
      console.error(
        `[mindmap] Cursor import needs Node 22.5+ for built-in SQLite (yours: ${process.version}). Upgrade Node to import Cursor.`,
      );
    } else {
      console.error(`[mindmap] Cursor read failed: ${err.split("\n")[0]}`);
    }
    return [];
  }

  let raw: CursorRaw[];
  try {
    raw = JSON.parse(child.stdout || "[]") as CursorRaw[];
  } catch {
    return [];
  }

  const sessions: ParsedSession[] = [];
  for (const r of raw) {
    const created = msToIso(r.createdAt) || msToIso(r.lastUpdatedAt);
    const last = msToIso(r.lastUpdatedAt) || created;
    if (!created || !last) continue;
    const prompts = r.prompts || [];
    sessions.push({
      sourceId: r.id,
      source: "cursor",
      title: r.name || prompts[0]?.slice(0, 80) || "Cursor chat",
      summary: composeSummary(prompts, r.answers || []),
      keyPoints: prompts.slice(0, 8).map((p) => p.slice(0, 200)),
      project: "cursor",
      firstTs: created,
      lastTs: last,
      ref: { kind: "cursor", composerId: r.id },
    });
  }
  return sessions;
}

async function collectSessions(opts: Options): Promise<ParsedSession[]> {
  const sessions: ParsedSession[] = [];

  if (wants(opts, "claude-code")) {
    for (const f of await walk(CODE_CLI_DIR, (n) => n.endsWith(".jsonl"))) {
      const s = await parseCodeCli(f);
      if (s) sessions.push(s);
    }
    for (const f of await walk(CODE_APP_DIR, (n) => n.startsWith("local_") && n.endsWith(".json"))) {
      const s = await parseMetaFile(f, "claude-code");
      if (s) sessions.push(s);
    }
  }
  if (wants(opts, "cowork")) {
    for (const f of await walk(COWORK_DIR, (n) => n.startsWith("local_") && n.endsWith(".json"))) {
      const s = await parseMetaFile(f, "cowork");
      if (s) sessions.push(s);
    }
  }
  if (wants(opts, "copilot")) {
    const files = await walk(VSCODE_WS_DIR, (n) => n.endsWith(".json"));
    for (const f of files) {
      if (!f.split(path.sep).includes("chatSessions")) continue;
      const s = await parseCopilot(f);
      if (s) sessions.push(s);
    }
  }
  if (wants(opts, "cursor")) {
    sessions.push(...(await collectCursor()));
  }
  // Collapse same (source + title) sessions to the most recent one — kills the
  // "46 × Newsroom daily digest" recurring-task clutter.
  const byTitle = new Map<string, ParsedSession>();
  for (const s of sessions) {
    const key = `${s.source} ${s.title}`;
    const cur = byTitle.get(key);
    if (!cur || new Date(s.lastTs).getTime() > new Date(cur.lastTs).getTime()) {
      byTitle.set(key, s);
    }
  }
  const deduped = [...byTitle.values()];
  // Richer sessions (more key points) first, so they win sourceId dedup later.
  deduped.sort((a, b) => b.keyPoints.length - a.keyPoints.length);
  return deduped;
}

function toThread(s: ParsedSession): Thread {
  return {
    id: newId(),
    title: s.title,
    summary: s.summary,
    keyPoints: s.keyPoints,
    tags: [s.project, s.source, "imported"].filter(Boolean),
    source: s.source,
    tier: "warm",
    status: "captured",
    trace: makeTrace({ title: s.title, keyPoints: s.keyPoints, summary: s.summary }),
    links: [],
    createdAt: s.firstTs,
    updatedAt: s.lastTs,
    lastAccessedAt: s.lastTs,
    accessCount: 0,
    sourceId: s.sourceId,
    ...(s.ref ? { sourceRef: s.ref } : {}),
  };
}

/**
 * Capture a SINGLE Claude Code transcript into Mind Map — the engine behind
 * the auto-capture SessionEnd hook. Distilled (not a log dump): reuses the same
 * parser as import, dedups by session id (so resuming + re-ending updates in
 * place), and skips trivial/automated sessions.
 */
export async function importTranscriptFile(
  file: string,
  opts: { minPrompts?: number } = {},
): Promise<{ status: "created" | "updated" | "skipped"; id?: string; title?: string; reason?: string }> {
  const s = await parseCodeCli(file);
  if (!s) return { status: "skipped", reason: "unparseable transcript" };
  if (isAutomated(s.keyPoints[0])) return { status: "skipped", reason: "automated session" };
  const minPrompts = opts.minPrompts ?? 2;
  if (s.keyPoints.length < minPrompts) return { status: "skipped", reason: "too thin" };

  const entries = await allEntries();
  const existing = entries.find((e) => e.sourceId === s.sourceId);
  if (existing) {
    const t = await getThread(existing.id);
    if (t) {
      // Refresh content, preserve curation (status/tier/access/promotion/dates).
      t.title = s.title;
      t.summary = s.summary;
      t.keyPoints = s.keyPoints;
      if (s.ref) t.sourceRef = s.ref;
      t.trace = makeTrace(t);
      t.updatedAt = nowIso();
      await saveThread(t);
      return { status: "updated", id: t.id, title: t.title };
    }
  }
  const thread = toThread(s);
  await saveThread(thread);
  return { status: "created", id: thread.id, title: thread.title };
}

export interface ImportResult {
  total: number;
  imported: number;
  updated: number;
  skippedDup: number;
  skippedThin: number;
  skippedFilter: number;
  counts: Record<string, number>;
}

/** Fill an Options object with defaults — used by the dashboard endpoint. */
export function importOptions(p: Partial<Options> = {}): Options {
  return {
    dryRun: p.dryRun ?? false,
    limit: p.limit ?? Infinity,
    project: p.project,
    source:
      p.source === "code" || p.source === "cowork" || p.source === "copilot" || p.source === "cursor"
        ? p.source
        : "all",
    minPrompts: p.minPrompts ?? 1,
    reimport: p.reimport ?? false,
  };
}

/** Core import — programmatic, returns a structured result (no console output). */
export async function importSessions(opts: Options): Promise<ImportResult> {
  const sessions = await collectSessions(opts);
  const indexEntries = await allEntries();
  const existing = new Set(indexEntries.map((e) => e.sourceId).filter(Boolean) as string[]);
  const idBySource = new Map<string, string>();
  for (const e of indexEntries) if (e.sourceId) idBySource.set(e.sourceId, e.id);
  const processed = new Set<string>(); // a session can appear via >1 store (same sourceId)
  const counts: Record<string, number> = {};
  let imported = 0;
  let updated = 0;
  let skippedDup = 0;
  let skippedFilter = 0;
  let skippedThin = 0;

  for (const s of sessions) {
    if (imported >= opts.limit) break;
    if (opts.project && !s.project.toLowerCase().includes(opts.project.toLowerCase())) {
      skippedFilter++;
      continue;
    }
    // Sessions sorted richest-first; if we've already handled this sourceId
    // (it can surface from both the CLI store and the desktop metadata store),
    // skip the thinner duplicate so it can't overwrite the rich version.
    if (processed.has(s.sourceId)) continue;
    if (existing.has(s.sourceId)) {
      if (opts.reimport) {
        const id = idBySource.get(s.sourceId);
        const t = id ? await getThread(id) : null;
        if (t) {
          // Refresh content; preserve curation (status/tier/access/promotion/dates).
          t.title = s.title;
          t.summary = s.summary;
          t.keyPoints = s.keyPoints;
          if (s.ref) t.sourceRef = s.ref; // backfill the transcript pointer
          t.trace = makeTrace(t);
          t.updatedAt = nowIso();
          if (!opts.dryRun) await saveThread(t);
          updated++;
          processed.add(s.sourceId);
        }
      } else {
        skippedDup++;
      }
      continue;
    }
    // CLI code sessions are judged by prompt count; metadata sessions already
    // passed the MIN_CONTENT check in their adapter.
    const isCli = s.source === "claude-code" && s.keyPoints.length > 0;
    if (isCli && s.keyPoints.length < opts.minPrompts) {
      skippedThin++;
      continue;
    }
    if (!opts.dryRun) await saveThread(toThread(s));
    existing.add(s.sourceId);
    processed.add(s.sourceId);
    counts[s.source] = (counts[s.source] || 0) + 1;
    imported++;
  }

  if (!opts.dryRun && (imported > 0 || updated > 0)) {
    const cfg: Config = await getConfig();
    await prune(cfg, false);
  }

  return { total: sessions.length, imported, updated, skippedDup, skippedThin, skippedFilter, counts };
}

export async function runImport(argv: string[]): Promise<void> {
  const opts = parseArgs(argv);
  console.log(
    `Importing Claude sessions (source: ${opts.source})${opts.dryRun ? "  (dry run)" : ""}`,
  );
  const r = await importSessions(opts);
  if (r.total === 0) {
    console.log("No sessions found.");
    return;
  }
  const breakdown = Object.entries(r.counts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  console.log(
    `\n${opts.dryRun ? "Would import" : "Imported"} ${r.imported} session(s)` +
      `${breakdown ? ` (${breakdown})` : ""}` +
      `${r.updated ? `; ${opts.dryRun ? "would refresh" : "refreshed"} ${r.updated} existing` : ""}.`,
  );
  console.log(
    `Skipped: ${r.skippedDup} already imported, ${r.skippedThin} thin${opts.project ? `, ${r.skippedFilter} off-filter` : ""}.`,
  );
  if (opts.dryRun) console.log("Re-run without --dry-run to apply.");
  else console.log("Tip: run 'dashboard' to see them, or resume one to promote it.");
}

// ---------------------------------------------------------------------------
// Cleanup: tidy ALREADY-imported memories without a full re-import.
//   npx @ravi-labs/mindmap-mcp-server cleanup [--dry-run]
// Removes automated (scheduled-task) memories and collapses same source+title
// duplicates to the most recent. Promoted memories are always kept.
// ---------------------------------------------------------------------------

export async function runCleanup(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const entries = await allEntries();
  const toDelete = new Set<string>();

  // 1. Automated/scheduled-task memories (never delete promoted ones).
  // The trace starts with the title, so match the marker anywhere in it.
  const autoRe = /<scheduled-task|<command-name|<command-message|<local-command/;
  let automated = 0;
  for (const e of entries) {
    if (e.status === "promoted") continue;
    if (autoRe.test(e.trace) || autoRe.test(e.title)) {
      toDelete.add(e.id);
      automated++;
    }
  }

  // 2. Same (source + title) duplicates — keep most recent (prefer promoted).
  const groups = new Map<string, IndexEntry[]>();
  for (const e of entries) {
    if (toDelete.has(e.id)) continue;
    const key = `${e.source} ${e.title}`;
    const arr = groups.get(key) ?? [];
    arr.push(e);
    groups.set(key, arr);
  }
  let duplicates = 0;
  for (const arr of groups.values()) {
    if (arr.length <= 1) continue;
    arr.sort((a, b) => {
      const pa = a.status === "promoted" ? 1 : 0;
      const pb = b.status === "promoted" ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    for (const e of arr.slice(1)) {
      if (e.status === "promoted") continue; // never delete a promoted memory
      toDelete.add(e.id);
      duplicates++;
    }
  }

  console.log(
    `Cleanup${dryRun ? " (dry run)" : ""}: ${entries.length} memories -> remove ` +
      `${automated} automated + ${duplicates} duplicate(s) = ${toDelete.size} total.`,
  );
  if (!dryRun) {
    for (const id of toDelete) await deleteThread(id);
    console.log(`Done. ${entries.length - toDelete.size} memories remain.`);
  } else {
    console.log("Re-run without --dry-run to apply.");
  }
}
