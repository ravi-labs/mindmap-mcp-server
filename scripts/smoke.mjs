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

// 8. collections: capture two "unfinished" memories, organize, view, launcher-resume
const app1 = await call("mindmap_capture", {
  title: "Weather dashboard side project",
  summary: "Building a weather dashboard, wired up the API calls.",
  next_steps: ["hook up the forecast endpoint"],
  workspace: "/Users/me/code/weather-dash",
  source: "claude-code",
});
const app2 = await call("mindmap_capture", {
  title: "Recipe-sharing app",
  summary: "Started the Next.js recipe app, set up auth and DB schema.",
  next_steps: ["build the recipe detail page"],
  workspace: "/Users/me/code/recipes",
  source: "cursor",
});
const org = await call("mindmap_organize", {
  action: "add",
  collection: "Unfinished projects",
  ids: [app1.id, app2.id],
});
if (org.size !== 2) throw new Error(`organize filed ${org.size}, expected 2`);
console.log("✓ organized 2 into 'Unfinished projects'");

const cols = await call("mindmap_collections", {});
if (!cols.collections.some((c) => c.id === "unfinished-projects" && c.size === 2))
  throw new Error("collections list missing 'Unfinished projects'");
const opened = await call("mindmap_collections", { collection: "unfinished projects" });
const withNext = opened.items.find((i) => i.id === app1.id);
if (!withNext || withNext.nextSteps[0] !== "hook up the forecast endpoint")
  throw new Error("opened collection missing next steps");
console.log("✓ collections view shows next steps + workspace");

// 9. launcher: several items -> pick list (no promote); with hint -> resumes the match
const pickList = await call("mindmap_resume", { collection: "unfinished projects" });
if (!pickList.candidates || pickList.candidates.length !== 2)
  throw new Error(`launcher expected 2 candidates, got ${pickList.candidates?.length}`);
if (!pickList.candidates.every((c) => Array.isArray(c.nextSteps)))
  throw new Error("launcher candidates missing nextSteps");
const resumed = await call("mindmap_resume", { collection: "unfinished projects", query: "weather" });
if (resumed.id !== app1.id) throw new Error(`launcher+hint resumed ${resumed.id}, expected ${app1.id}`);
if (resumed.workspace !== "/Users/me/code/weather-dash") throw new Error("launcher lost workspace");
if (resumed.nextSteps[0] !== "hook up the forecast endpoint") throw new Error("launcher lost next steps");
console.log("✓ resume-from-collection: pick list + hint-resume with workspace & next steps");

// 10. curate preview (heuristic; fresh memories won't be 'unfinished' — just shape-check)
const cur = await call("mindmap_curate", {});
if (!Array.isArray(cur.suggestions)) throw new Error("curate returned no suggestions array");
if (cur.applied) throw new Error("curate wrote without apply=true");
console.log("✓ curate previews without writing (suggestions:", cur.suggestions.length + ")");

// 11. remove + delete collection (memories must survive)
await call("mindmap_organize", { action: "remove", collection: "Unfinished projects", ids: [app2.id] });
const del = await call("mindmap_organize", { action: "delete", collection: "Unfinished projects" });
if (!del.deleted) throw new Error("delete collection failed");
const still = await call("mindmap_get", { id: app1.id });
if (!still || still.error) throw new Error("deleting a collection deleted a memory!");
console.log("✓ collection remove/delete leaves memories intact");

await client.close();
console.log("\nALL SMOKE TESTS PASSED ✅  (data dir:", dir + ")");
