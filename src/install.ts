/**
 * Zero-friction installer: detect local MCP clients and write Mind Map into
 * their config for the user, so onboarding is one command instead of hand-editing
 * JSON.
 *
 *   npx @ravi-labs/mindmap-mcp-server install            # configure detected clients
 *   npx @ravi-labs/mindmap-mcp-server install --dry-run  # preview, write nothing
 *   npx @ravi-labs/mindmap-mcp-server install --local    # point at this checkout
 *   npx @ravi-labs/mindmap-mcp-server uninstall          # remove from configs
 */

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const ENTRY_NAME = "mindmap";

interface ServerEntry {
  command: string;
  args: string[];
}

interface JsonClient {
  id: string;
  label: string;
  /** Absolute path to the client's JSON config. */
  configPath: string;
  /** A directory whose existence implies the app is installed. */
  detectDir: string;
}

function home(): string {
  return os.homedir();
}

/** JSON-config clients with an `mcpServers` object we can merge into. */
function jsonClients(): JsonClient[] {
  const h = home();
  const platform = process.platform;

  let claudeDesktopCfg: string;
  let claudeDesktopDir: string;
  if (platform === "darwin") {
    claudeDesktopDir = path.join(h, "Library", "Application Support", "Claude");
    claudeDesktopCfg = path.join(claudeDesktopDir, "claude_desktop_config.json");
  } else if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(h, "AppData", "Roaming");
    claudeDesktopDir = path.join(appData, "Claude");
    claudeDesktopCfg = path.join(claudeDesktopDir, "claude_desktop_config.json");
  } else {
    claudeDesktopDir = path.join(h, ".config", "Claude");
    claudeDesktopCfg = path.join(claudeDesktopDir, "claude_desktop_config.json");
  }

  return [
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      configPath: claudeDesktopCfg,
      detectDir: claudeDesktopDir,
    },
    {
      id: "cursor",
      label: "Cursor",
      configPath: path.join(h, ".cursor", "mcp.json"),
      detectDir: path.join(h, ".cursor"),
    },
    {
      id: "windsurf",
      label: "Windsurf",
      configPath: path.join(h, ".codeium", "windsurf", "mcp_config.json"),
      detectDir: path.join(h, ".codeium", "windsurf"),
    },
  ];
}

function serverEntry(local: boolean): ServerEntry {
  if (local) {
    // Point at this checkout's built entry — works before npm publish.
    const entry = path.resolve(process.argv[1] ?? "dist/index.js");
    return { command: process.execPath, args: [entry] };
  }
  return { command: "npx", args: ["-y", "@ravi-labs/mindmap-mcp-server"] };
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function mergeJsonClient(
  client: JsonClient,
  entry: ServerEntry,
  dryRun: boolean,
): Promise<"added" | "updated"> {
  const cfg = await readJson(client.configPath);
  const servers = (cfg.mcpServers ??= {}) as Record<string, unknown>;
  const verb = servers[ENTRY_NAME] ? "updated" : "added";
  servers[ENTRY_NAME] = entry;

  if (!dryRun) {
    if (await exists(client.configPath)) {
      await fs.copyFile(client.configPath, `${client.configPath}.mindmap-bak`);
    }
    await fs.mkdir(path.dirname(client.configPath), { recursive: true });
    await fs.writeFile(client.configPath, JSON.stringify(cfg, null, 2), "utf8");
  }
  return verb;
}

async function removeJsonClient(client: JsonClient): Promise<boolean> {
  if (!(await exists(client.configPath))) return false;
  const cfg = await readJson(client.configPath);
  const servers = cfg.mcpServers as Record<string, unknown> | undefined;
  if (!servers || !servers[ENTRY_NAME]) return false;
  delete servers[ENTRY_NAME];
  await fs.copyFile(client.configPath, `${client.configPath}.mindmap-bak`);
  await fs.writeFile(client.configPath, JSON.stringify(cfg, null, 2), "utf8");
  return true;
}

/** Claude Code is configured through its own CLI when available. */
function tryClaudeCode(entry: ServerEntry, dryRun: boolean): string {
  const cmd = `claude mcp add -s user ${ENTRY_NAME} -- ${entry.command} ${entry.args.join(" ")}`;
  if (dryRun) return `would run: ${cmd}`;
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
  } catch {
    return `Claude Code CLI not found — to add manually:\n    ${cmd}`;
  }
  try {
    execFileSync(
      "claude",
      ["mcp", "add", "-s", "user", ENTRY_NAME, "--", entry.command, ...entry.args],
      { stdio: "ignore" },
    );
    return "configured via claude CLI";
  } catch {
    return `claude CLI present but add failed — run manually:\n    ${cmd}`;
  }
}

export async function runInstall(argv: string[]): Promise<void> {
  const dryRun = argv.includes("--dry-run");
  const local = argv.includes("--local");
  const entry = serverEntry(local);

  console.log(`Mind Map installer ${dryRun ? "(dry run — nothing written)" : ""}`);
  console.log(`Server command: ${entry.command} ${entry.args.join(" ")}\n`);

  let configured = 0;
  for (const client of jsonClients()) {
    if (!(await exists(client.detectDir))) {
      console.log(`–  ${client.label}: not detected, skipped`);
      continue;
    }
    const verb = await mergeJsonClient(client, entry, dryRun);
    console.log(`✓  ${client.label}: ${verb}  (${client.configPath})`);
    configured++;
  }

  console.log(`•  Claude Code: ${tryClaudeCode(entry, dryRun)}`);

  console.log(
    `\n${configured > 0 || true ? "Done." : "No clients configured."} Restart any running client to load Mind Map.`,
  );
  if (dryRun) console.log("Re-run without --dry-run to apply.");
}

export async function runUninstall(): Promise<void> {
  console.log("Removing Mind Map from local MCP clients…\n");
  for (const client of jsonClients()) {
    const removed = await removeJsonClient(client);
    console.log(`${removed ? "✓" : "–"}  ${client.label}: ${removed ? "removed" : "not present"}`);
  }
  console.log(
    `•  Claude Code: run 'claude mcp remove ${ENTRY_NAME}' if you added it there.`,
  );
  console.log("\nDone.");
}
