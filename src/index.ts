#!/usr/bin/env node
/**
 * Mind Map — a memory consolidation / context-handoff MCP server.
 *
 * Capture context from any AI tool, resume it anywhere, and let it decay
 * gracefully. Local-file storage under ~/.mindmap (override with MINDMAP_DIR).
 *
 * Transports:
 *   stdio (default)        — local clients (Claude Code/Desktop, Cursor, …)
 *   http  (TRANSPORT=http) — remote clients (ChatGPT, web, multi-device)
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DATA_DIR, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { prune } from "./decay.js";
import { runDashboard } from "./dashboard.js";
import { runHttp } from "./http.js";
import { importTranscriptFile, runCleanup, runImport } from "./import.js";
import { installSkill, runInstall, runUninstall } from "./install.js";
import { buildEmbeddings } from "./embeddings.js";
import { canEmbed } from "./llm.js";
import { auditLedger } from "./ledger.js";
import { exportPassport, importExport, importPassport } from "./passport.js";
import { syncPersona } from "./project.js";
import { createServer } from "./server.js";
import { allEntries, getConfig, getThread } from "./store.js";

const PKG = "@ravi-labs/mindmap-mcp-server";
const HELP = `${SERVER_NAME} v${SERVER_VERSION} — local-first memory & context handoff for AI tools

Usage (via npx, or the installed 'mindmap-mcp-server' command):
  npx ${PKG}                 Run the MCP server over stdio (default)
  TRANSPORT=http npx ${PKG}  Run over HTTP (for self-hosting; see README)
  npx ${PKG} install         Auto-configure detected MCP clients + auto-capture hook
  npx ${PKG} install --dry-run   Preview install without writing
  npx ${PKG} install --local     Point clients at this checkout (pre-publish)
  npx ${PKG} install --no-hook   Skip the Claude Code auto-capture SessionEnd hook
  npx ${PKG} uninstall       Remove Mind Map from client configs
  npx ${PKG} import          Import past sessions (--dry-run, --limit N, --project X, --source, --reimport)
  npx ${PKG} cleanup         Remove automated + duplicate imported memories (--dry-run)
  npx ${PKG} passport export [path]        Export memories + persona to a portable file
  npx ${PKG} passport import <file>        Import a Mind Map passport
  npx ${PKG} passport import-chatgpt <conversations.json>   Pull in a ChatGPT data export
  npx ${PKG} passport import-claude  <conversations.json>   Pull in a Claude.ai data export
  npx ${PKG} audit           Glass-box ledger: what's stored, provenance, decay
  npx ${PKG} embed           Build the embedding cache for semantic search (needs an embeddings provider)
  npx ${PKG} persona-sync    Write your persona into your tools' config files (--force)
  npx ${PKG} dashboard       Open the local web UI (http://127.0.0.1:7777)
  npx ${PKG} quickstart      Print the getting-started guide
  npx ${PKG} --help          Show this help
  npx ${PKG} --version       Print version

Data dir: ${DATA_DIR} (override with MINDMAP_DIR)`;

const QUICKSTART = `🧠 Mind Map — quickstart

Mind Map gives your AI tools a shared memory. Capture context in one session,
resume it in another — no re-explaining. Everything stays in local files
(${DATA_DIR}); no account, no cloud.

1) CONNECT (once)
   npx ${PKG} install
   …then restart your AI client. (Auto-configures Claude Code/Desktop/Cursor.)

2) USE IT — just talk naturally inside your AI tool:
   • "Save this to mind map"        → captures the current context
   • "Resume my work on <topic>"    → pulls it back into a fresh session
   • "What's in my mind map?"       → lists your memories
   • "Show my mind map health"      → cleanliness score (rewards tidy, not big)

3) BRING IN YOUR HISTORY (optional)
   npx ${PKG} import --dry-run      → preview
   npx ${PKG} import                → import past Claude Code + Cowork sessions

4) SEE IT
   npx ${PKG} dashboard             → http://127.0.0.1:7777

How memory ages: new captures are 🌤️ warm; resuming one promotes it to 🔥 hot;
untouched memory cools to ❄️ cold one-line traces (searchable, never deleted).

Make capture automatic: add one line to your client's instructions (e.g. Claude
Code's CLAUDE.md) — "At the end of a substantive session, call mindmap_capture
to save the context." Then you won't have to ask.`;

/**
 * Background consolidation: re-tier memory on a timer. Server-independent, so it
 * runs once per process regardless of transport (HTTP builds a server per
 * request, but pruning operates directly on the store).
 */
async function startBackgroundPruner(): Promise<void> {
  const cfg = await getConfig();
  const tick = async () => {
    try {
      const res = await prune(cfg, false);
      if (res.changes.length > 0) {
        console.error(
          `[mindmap] background prune: ${res.changes.length} memor${res.changes.length === 1 ? "y" : "ies"} re-tiered`,
        );
      }
    } catch (err) {
      console.error("[mindmap] background prune failed:", err);
    }
  };
  await tick();
  const timer = setInterval(tick, cfg.prunerIntervalMs);
  timer.unref();
}

async function runPassport(argv: string[]): Promise<void> {
  const sub = argv[0];
  const arg = argv[1];
  if (sub === "export") {
    const r = await exportPassport(arg);
    console.log(`✓ Exported ${r.counts.memories} memories + ${r.counts.persona} persona facts`);
    console.log(`  → ${r.path}`);
    return;
  }
  if (sub === "import") {
    if (!arg) return console.error("Usage: passport import <file>");
    const r = await importPassport(arg);
    console.log(
      `✓ Imported ${r.memories.imported} memories (${r.memories.skippedDup} dup of ${r.memories.total}); persona +${r.persona.added}/${r.persona.updated}.`,
    );
    return;
  }
  if (sub === "import-chatgpt" || sub === "import-claude") {
    if (!arg) return console.error(`Usage: passport ${sub} <conversations.json>`);
    const kind = sub === "import-chatgpt" ? "chatgpt" : "claude";
    const r = await importExport(kind, arg);
    console.log(`✓ Imported ${r.imported} of ${r.total} ${kind} conversations (${r.skippedDup} already present).`);
    return;
  }
  console.error("Usage: passport export|import|import-chatgpt|import-claude [file]");
}

async function runEmbed(): Promise<void> {
  if (!(await canEmbed())) {
    console.log("Semantic search needs an embeddings-capable provider (openai, google, or ollama).");
    console.log("Set one with the mindmap_llm tool or the dashboard. (Anthropic has no embeddings API.)");
    console.log("Without it, search still works great via BM25 — no action needed.");
    return;
  }
  const entries = await allEntries();
  console.log(`Embedding ${entries.length} memories (only new/changed ones are re-embedded)…`);
  const r = await buildEmbeddings(entries);
  console.log(
    `✓ ${r.embedded} embedded, ${r.reused} reused, ${r.removed} stale removed (model: ${r.model}).`,
  );
  console.log("Hybrid (BM25 + semantic) search is now active for resume / search / brainstorm.");
}

async function runAudit(): Promise<void> {
  const cfg = await getConfig();
  const rows = await auditLedger(await allEntries(), getThread, cfg, Date.now());
  if (rows.length === 0) {
    console.log("No memories stored yet.");
    return;
  }
  console.log(`🔍 Glass-box ledger — ${rows.length} memories (most-trusted first)\n`);
  for (const r of rows.slice(0, 50)) {
    console.log(`• ${r.title}`);
    console.log(`    ${r.provenance}`);
    console.log(`    trust ${r.trust}× · ${r.tier} · ${r.fades} · used ${r.lastUsedDays}d ago\n`);
  }
}

async function runPersonaSync(argv: string[]): Promise<void> {
  const r = await syncPersona({ force: argv.includes("--force") });
  console.log(`Persona projected (project: ${r.project}):\n`);
  for (const o of r.outcomes) {
    console.log(`  ${o.action === "skipped" ? "–" : "✓"} ${o.id}: ${o.action}${o.reason ? ` (${o.reason})` : ""}`);
    if (o.action !== "skipped") console.log(`      ${o.file}`);
  }
  console.log("\nTip: pass --force to write into tools that aren't auto-detected.");
}

/** Read all of stdin to a string (hook payloads arrive here as JSON). */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Claude Code hook entrypoint. Invoked as `… hook session-end` with the hook's
 * JSON payload on stdin. On SessionEnd we auto-capture the just-finished session
 * into Mind Map — distilled, deduped, never blocking the user. Always exits 0 so
 * a hiccup never disrupts Claude Code.
 */
async function runHook(argv: string[]): Promise<void> {
  const event = (argv[0] || "").toLowerCase();
  try {
    const raw = await readStdin();
    const payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const transcript = typeof payload.transcript_path === "string" ? payload.transcript_path : "";
    if ((event === "session-end" || event === "stop") && transcript) {
      const r = await importTranscriptFile(transcript);
      if (r.status !== "skipped") {
        console.error(`[mindmap] auto-capture: ${r.status} "${r.title}" (${r.id})`);
      }
    }
  } catch (err) {
    // Never let a hook failure surface to the user.
    console.error("[mindmap] hook error:", (err as Error).message);
  }
}

/**
 * Background auto-import (opt-in). While any AI client has Mind Map running, this
 * periodically pulls in NEW sessions across all sources — so you never have to
 * ask. Runs the import as a detached SUBPROCESS (Cursor's SQLite read is heavy
 * and would otherwise block the server's event loop), and debounces via a shared
 * timestamp so multiple open clients don't double-run.
 */
async function startBackgroundImport(): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.autoImport) return;
  const interval = cfg.autoImportIntervalMs || 6 * 60 * 60 * 1000;
  const stamp = path.join(DATA_DIR, ".autoimport");

  const tick = async () => {
    try {
      const last = Number((await fs.readFile(stamp, "utf8").catch(() => "0")).trim()) || 0;
      if (Date.now() - last < interval * 0.9) return; // another instance handled it
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(stamp, String(Date.now()), "utf8");
      const child = spawn(process.execPath, [process.argv[1] ?? "dist/index.js", "import"], {
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      console.error("[mindmap] auto-import: scanning for new sessions in the background");
    } catch (err) {
      console.error("[mindmap] auto-import scheduling failed:", err);
    }
  };

  void tick(); // fire-and-forget first run (never blocks server startup)
  const timer = setInterval(() => void tick(), interval);
  timer.unref();
}

async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mindmap] ${SERVER_NAME} v${SERVER_VERSION} running (stdio). Data: ${DATA_DIR}`,
  );
}

async function main(): Promise<void> {
  const cmd = process.argv[2];

  // CLI subcommands (no server, no pruner) ----------------------------------
  if (cmd === "install") return runInstall(process.argv.slice(3));
  if (cmd === "uninstall") return runUninstall();
  if (cmd === "skill-install") {
    console.log(await installSkill(process.argv.includes("--dry-run")));
    return;
  }
  if (cmd === "import") return runImport(process.argv.slice(3));
  if (cmd === "cleanup") return runCleanup(process.argv.slice(3));
  if (cmd === "passport") return runPassport(process.argv.slice(3));
  if (cmd === "hook") return runHook(process.argv.slice(3));
  if (cmd === "audit") return runAudit();
  if (cmd === "embed") return runEmbed();
  if (cmd === "persona-sync") return runPersonaSync(process.argv.slice(3));
  if (cmd === "dashboard" || cmd === "ui") return runDashboard();
  if (cmd === "quickstart") {
    console.log(QUICKSTART);
    return;
  }
  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP);
    return;
  }
  if (cmd === "--version" || cmd === "-v") {
    console.log(SERVER_VERSION);
    return;
  }

  // Server modes ------------------------------------------------------------
  await startBackgroundPruner();
  await startBackgroundImport();
  if ((process.env.TRANSPORT || "stdio").toLowerCase() === "http") {
    await runHttp();
  } else {
    await runStdio();
  }
}

main().catch((err) => {
  console.error("[mindmap] fatal:", err);
  process.exit(1);
});
