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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { DATA_DIR, SERVER_NAME, SERVER_VERSION } from "./constants.js";
import { prune } from "./decay.js";
import { runHttp } from "./http.js";
import { runInstall, runUninstall } from "./install.js";
import { createServer } from "./server.js";
import { getConfig } from "./store.js";

const PKG = "@ravi-labs/mindmap-mcp-server";
const HELP = `${SERVER_NAME} v${SERVER_VERSION} — local-first memory & context handoff for AI tools

Usage (via npx, or the installed 'mindmap-mcp-server' command):
  npx ${PKG}                 Run the MCP server over stdio (default)
  TRANSPORT=http npx ${PKG}  Run over HTTP (for self-hosting; see README)
  npx ${PKG} install         Auto-configure detected MCP clients
  npx ${PKG} install --dry-run   Preview install without writing
  npx ${PKG} install --local     Point clients at this checkout (pre-publish)
  npx ${PKG} uninstall       Remove Mind Map from client configs
  npx ${PKG} --help          Show this help
  npx ${PKG} --version       Print version

Data dir: ${DATA_DIR} (override with MINDMAP_DIR)`;

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
