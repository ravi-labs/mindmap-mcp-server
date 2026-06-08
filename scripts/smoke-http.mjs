// HTTP-transport smoke test: spawn the server in http mode with a token,
// verify auth rejection, then drive it through a real Streamable HTTP client.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3939;
const TOKEN = "secret-test-token";
const BASE = `http://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), "mindmap-http-"));

const child = spawn("node", ["dist/index.js"], {
  env: { ...process.env, TRANSPORT: "http", MINDMAP_PORT: String(PORT), MINDMAP_TOKEN: TOKEN, MINDMAP_DIR: dir },
  stdio: ["ignore", "inherit", "inherit"],
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error("server did not become ready");
}

try {
  await waitReady();
  console.log("✓ server up; /healthz ok");

  // 1. unauthorized request must be rejected
  const noAuth = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  if (noAuth.status !== 401) throw new Error(`expected 401 without token, got ${noAuth.status}`);
  console.log("✓ unauthenticated request rejected (401)");

  // 2. authenticated client works end-to-end
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: "smoke-http", version: "1.0.0" });
  await client.connect(transport);
  const tools = await client.listTools();
  console.log(`✓ authenticated connect — ${tools.tools.length} tools`);

  const cap = await client.callTool({
    name: "mindmap_capture",
    arguments: { title: "HTTP transport works", summary: "Remote memory over streamable HTTP.", source: "chatgpt" },
  });
  const id = cap.structuredContent?.id;
  if (!id) throw new Error("capture returned no id");
  console.log("✓ capture over HTTP:", id);

  const res = await client.callTool({ name: "mindmap_resume", arguments: { query: "http transport" } });
  if (res.structuredContent?.id !== id) throw new Error("resume mismatch over HTTP");
  console.log("✓ resume over HTTP:", res.structuredContent.status, res.structuredContent.tier);

  await client.close();
  console.log("\nHTTP SMOKE TESTS PASSED ✅");
} finally {
  child.kill("SIGTERM");
}
