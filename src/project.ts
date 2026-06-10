/**
 * Persona projection — one profile, written into every tool.
 *
 * The persona layer is read by MCP-aware tools that call mindmap_persona. But
 * not every tool speaks MCP. This module *projects* the persona into each tool's
 * own native instruction file (Claude's CLAUDE.md, Cursor rules, Copilot
 * instructions, Windsurf rules) so even non-MCP tools get "how this user works"
 * for free — from a single user-owned source.
 *
 * Writes are confined to a MANAGED BLOCK delimited by markers, so re-syncing
 * replaces only our section and never clobbers the user's own content.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { renderPersona } from "./persona.js";

const START = "<!-- mindmap:persona:start -->";
const END = "<!-- mindmap:persona:end -->";

export interface Target {
  id: string;
  label: string;
  scope: "global" | "project";
  /** Resolve the target file given the working directory. */
  file: (cwd: string) => string;
  /** Dir whose existence signals the tool is in use (gates auto-write). */
  marker: (cwd: string) => string;
}

export function targets(): Target[] {
  const h = os.homedir();
  return [
    {
      id: "claude-global",
      label: "Claude Code / Cowork (global)",
      scope: "global",
      file: () => path.join(h, ".claude", "CLAUDE.md"),
      marker: () => path.join(h, ".claude"),
    },
    {
      id: "claude-project",
      label: "Claude (project CLAUDE.md)",
      scope: "project",
      file: (cwd) => path.join(cwd, "CLAUDE.md"),
      marker: (cwd) => path.join(cwd, "CLAUDE.md"),
    },
    {
      id: "cursor",
      label: "Cursor (project rule)",
      scope: "project",
      file: (cwd) => path.join(cwd, ".cursor", "rules", "mindmap-persona.mdc"),
      marker: (cwd) => path.join(cwd, ".cursor"),
    },
    {
      id: "copilot",
      label: "GitHub Copilot (project instructions)",
      scope: "project",
      file: (cwd) => path.join(cwd, ".github", "copilot-instructions.md"),
      marker: (cwd) => path.join(cwd, ".github"),
    },
    {
      id: "windsurf",
      label: "Windsurf (project rules)",
      scope: "project",
      file: (cwd) => path.join(cwd, ".windsurfrules"),
      marker: (cwd) => path.join(cwd, ".windsurfrules"),
    },
  ];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export interface DetectedTarget {
  id: string;
  label: string;
  scope: "global" | "project";
  file: string;
  /** Tool appears to be in use (marker present) — safe to auto-write. */
  present: boolean;
  /** Mind Map's managed block already exists in the file. */
  managed: boolean;
}

export async function detectTargets(cwd: string): Promise<DetectedTarget[]> {
  const out: DetectedTarget[] = [];
  for (const t of targets()) {
    const file = t.file(cwd);
    const present = await exists(t.marker(cwd));
    let managed = false;
    try {
      managed = (await fs.readFile(file, "utf8")).includes(START);
    } catch {
      /* file not there */
    }
    out.push({ id: t.id, label: t.label, scope: t.scope, file, present, managed });
  }
  return out;
}

function buildBlock(body: string): string {
  return `${START}\n<!-- Managed by Mind Map — edits inside this block are overwritten on sync. -->\n${body}\n${END}`;
}

/** Insert or replace the managed block in `content`. */
function upsert(content: string, block: string): string {
  const s = content.indexOf(START);
  const e = content.indexOf(END);
  if (s >= 0 && e > s) {
    return content.slice(0, s) + block + content.slice(e + END.length);
  }
  const sep = content.length && !content.endsWith("\n") ? "\n\n" : content.length ? "\n" : "";
  return content + sep + block + "\n";
}

export interface SyncOutcome {
  id: string;
  file: string;
  action: "created" | "updated" | "unchanged" | "skipped";
  reason?: string;
}

export interface SyncOptions {
  cwd?: string;
  /** Explicit target ids to write. Omit to use every target that's present. */
  only?: string[];
  /** Write even if the tool's marker isn't detected (creates the file). */
  force?: boolean;
}

/**
 * Render the persona and write it into the selected tool configs. Returns a
 * per-target outcome. Non-present targets are skipped unless `force` or named.
 */
export async function syncPersona(opts: SyncOptions = {}): Promise<{ project: string; rendered: string; outcomes: SyncOutcome[] }> {
  const cwd = opts.cwd || process.cwd();
  const project = path.basename(cwd);
  const r = await renderPersona({ project });
  const block = buildBlock(r.text);

  const outcomes: SyncOutcome[] = [];
  for (const t of targets()) {
    const file = t.file(cwd);
    const named = opts.only?.includes(t.id);
    if (opts.only && !named) continue; // caller restricted to a subset
    const present = await exists(t.marker(cwd));
    if (!present && !named && !opts.force) {
      outcomes.push({ id: t.id, file, action: "skipped", reason: "tool not detected" });
      continue;
    }
    let current = "";
    let had = false;
    try {
      current = await fs.readFile(file, "utf8");
      had = true;
    } catch {
      /* will create */
    }
    const next = upsert(current, block);
    if (next === current) {
      outcomes.push({ id: t.id, file, action: "unchanged" });
      continue;
    }
    // one-time backup before our first edit to a pre-existing, unmanaged file
    if (had && !current.includes(START)) {
      await fs.copyFile(file, `${file}.mindmap-bak`).catch(() => {});
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, next, "utf8");
    outcomes.push({ id: t.id, file, action: had ? "updated" : "created" });
  }
  return { project, rendered: r.text, outcomes };
}

/** Remove Mind Map's managed block from every target (clean uninstall). */
export async function unsyncPersona(cwd = process.cwd()): Promise<SyncOutcome[]> {
  const outcomes: SyncOutcome[] = [];
  for (const t of targets()) {
    const file = t.file(cwd);
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    const s = content.indexOf(START);
    const e = content.indexOf(END);
    if (s < 0 || e < 0) continue;
    const stripped = (content.slice(0, s) + content.slice(e + END.length)).replace(/\n{3,}/g, "\n\n").trimEnd();
    await fs.writeFile(file, stripped ? stripped + "\n" : "", "utf8");
    outcomes.push({ id: t.id, file, action: "updated", reason: "removed managed block" });
  }
  return outcomes;
}
