// End-to-end smoke test: drive the built server through a real MCP client.
// Uses an isolated MINDMAP_DIR so it never touches real data.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mindmap-test-"));
const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, MINDMAP_DIR: dir },
});
const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`✓ connected — ${tools.tools.length} tools:`, tools.tools.map((t) => t.name).join(", "));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.structuredContent ?? r.content?.[0]?.text;
};

// 1. capture two memories
const cap1 = await call("mindmap_capture", {
  title: "Mind Map MCP design",
  summary: "Context-handoff engine. Bet A loop first, consolidation engine is the moat.",
  key_points: ["promote-on-reuse", "decay to traces", "opt-in gamification"],
  tags: ["mindmap", "design"],
  source: "claude-code",
});
console.log("✓ capture 1:", cap1.id, cap1.tier, cap1.status);

const cap2 = await call("mindmap_capture", {
  title: "Pricing brainstorm",
  summary: "Explored tiered pricing for the memory product.",
  tags: ["pricing"],
  source: "chatgpt",
});
console.log("✓ capture 2:", cap2.id);

// 2. link them
await call("mindmap_link", { id: cap1.id, target_id: cap2.id });
console.log("✓ linked");

// 3. resume by topic -> should promote cap1 to hot
const res = await call("mindmap_resume", { query: "mind map design handoff" });
if (res.id !== cap1.id) throw new Error(`resume picked wrong thread: ${res.id}`);
if (res.status !== "promoted" || res.tier !== "hot")
  throw new Error(`promote-on-reuse failed: ${res.status}/${res.tier}`);
console.log("✓ resume promoted:", res.id, res.status, res.tier);

// 4. search
const search = await call("mindmap_search", { query: "pricing" });
if (!search.results.some((r) => r.id === cap2.id)) throw new Error("search missed pricing");
console.log("✓ search found pricing:", search.count, "result(s)");

// 5. health (gamified)
const h = await call("mindmap_health", {});
console.log("✓ health:", h.cleanlinessScore + "%", `hot=${h.hot} warm=${h.warm} cold=${h.cold}`);

// 6. forget (soft) then confirm it's archived out of default list
await call("mindmap_forget", { id: cap2.id, hard: false });
const list = await call("mindmap_list", {});
if (list.results.some((r) => r.id === cap2.id)) throw new Error("archived item still listed");
console.log("✓ soft-forget archived cap2; default list hides it");

// 7. prune dry-run
const prune = await call("mindmap_prune", { dry_run: true });
console.log("✓ prune dry-run scanned:", prune.scanned);

await client.close();
console.log("\nALL SMOKE TESTS PASSED ✅  (data dir:", dir + ")");
