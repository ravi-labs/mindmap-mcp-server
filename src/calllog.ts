/**
 * MCP call log — observability for the memory layer.
 *
 * Every tool call is appended (redacted) to ~/.mindmap/calls.jsonl and echoed to
 * stderr. The dashboard reads this file to show a live activity console. Because
 * it's a shared file, it captures calls from EVERY client (Claude Code, Cursor,
 * …), not just one process. Logging must never break a tool, so all errors here
 * are swallowed.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./constants.js";
import { redactText } from "./redact.js";
import { getConfig } from "./store.js";

const CALLS_FILE = path.join(DATA_DIR, "calls.jsonl");
const MAX_BYTES = 2 * 1024 * 1024; // rotate past ~2MB
const KEEP_LINES = 1500;
const ARG_CAP = 600;

export interface CallEntry {
  ts: string;
  tool: string;
  ok: boolean;
  ms: number;
  args?: string; // redacted + truncated
  error?: string;
}

function summarizeArgs(args: unknown): string {
  let s: string;
  try {
    s = typeof args === "string" ? args : JSON.stringify(args);
  } catch {
    s = String(args);
  }
  if (!s) return "";
  s = redactText(s).text;
  return s.length > ARG_CAP ? s.slice(0, ARG_CAP) + "…" : s;
}

export async function logCall(e: {
  tool: string;
  ok: boolean;
  ms: number;
  args?: unknown;
  error?: string;
}): Promise<void> {
  try {
    if ((await getConfig()).logCalls === false) return;
    const entry: CallEntry = {
      ts: new Date().toISOString(),
      tool: e.tool,
      ok: e.ok,
      ms: e.ms,
      ...(e.args !== undefined ? { args: summarizeArgs(e.args) } : {}),
      ...(e.error ? { error: redactText(String(e.error)).text.slice(0, 300) } : {}),
    };
    // Echo to stderr so it shows in the MCP server's own logs too.
    console.error(`[mindmap] tool ${entry.tool} ${entry.ok ? "ok" : "ERR"} ${entry.ms}ms`);
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(CALLS_FILE, JSON.stringify(entry) + "\n", "utf8");
    await rotateIfNeeded();
  } catch {
    /* never let logging break a tool */
  }
}

async function rotateIfNeeded(): Promise<void> {
  try {
    const st = await fs.stat(CALLS_FILE);
    if (st.size <= MAX_BYTES) return;
    const lines = (await fs.readFile(CALLS_FILE, "utf8")).split("\n").filter(Boolean);
    await fs.writeFile(CALLS_FILE, lines.slice(-KEEP_LINES).join("\n") + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

/** Most-recent-first list of recent calls (for the dashboard console). */
export async function readCalls(limit = 100): Promise<CallEntry[]> {
  try {
    const lines = (await fs.readFile(CALLS_FILE, "utf8")).split("\n").filter(Boolean);
    const out: CallEntry[] = [];
    for (const l of lines.slice(-limit)) {
      try {
        out.push(JSON.parse(l) as CallEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out.reverse();
  } catch {
    return [];
  }
}
