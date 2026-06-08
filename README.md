# 🧠 Mind Map — MCP memory & context-handoff server

Ever lose the thread of a discussion across Claude Code, Claude Desktop, and your
other AI tools? Mind Map is a small, **local-first** [MCP](https://modelcontextprotocol.io)
server that acts as a **shared memory layer** across all your local MCP clients.

You **capture** context at the end of a session, and **resume** it in any other
tool — no more re-explaining your project from scratch. Memory you stop using
**cools and decays gracefully** into one-line traces (it's never silently
deleted), so your shelf stays small and trustworthy instead of becoming another
haystack.

> **Local-first by design.** It runs on your machine; your memories are plain
> files in `~/.mindmap` that never leave your control. No account, no cloud, no
> server to trust. Install once with `npx @ravi-labs/mindmap-mcp-server install`.

> _ChatGPT and other cloud/web clients are out of scope for now — they can't
> reach a local server without a public endpoint, which conflicts with
> local-first. See [Future](#future)._

## The idea in one loop

1. **Capture** (effortless) — at the end of a discussion, save a portable summary.
2. **Resume** (promote-on-reuse) — pull it forward in a new session. The act of
   reusing it is what promotes it to *trusted* memory. Throwaway sessions never
   get promoted, so they never clutter your shelf.
3. **Consolidate** (automatic) — a background pass cools unused memory through
   tiers (🔥 hot → 🌤️ warm → ❄️ cold) and collapses cold items to a searchable
   one-line trace. The moat isn't storing things — it's **forgetting well**.
4. **Tidy** (opt-in, gamified) — a *cleanliness score* rewards pruning, not
   hoarding.

## Install (one command)

Once published to npm, the whole install is:

```bash
npx @ravi-labs/mindmap-mcp-server install
```

This **auto-detects** your local MCP clients (Claude Desktop, Cursor, Windsurf)
and writes the config for you, and configures **Claude Code** via its CLI if
present. Restart your client and Mind Map's tools are there. Preview first with
`npx @ravi-labs/mindmap-mcp-server install --dry-run`; undo with
`npx @ravi-labs/mindmap-mcp-server uninstall`.

Data lives in `~/.mindmap/` by default — override with the `MINDMAP_DIR` env var.

### Manual setup (if you prefer)

Every client uses the same command — `npx -y @ravi-labs/mindmap-mcp-server` over stdio.

**Claude Code:**

```bash
claude mcp add mindmap -- npx -y @ravi-labs/mindmap-mcp-server
```

**Claude Desktop** — edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mindmap": {
      "command": "npx",
      "args": ["-y", "@ravi-labs/mindmap-mcp-server"]
    }
  }
}
```

**Cursor / Windsurf / other clients** — same `command` + `args` shape in that
client's MCP config. Add an `env` block to relocate data:

```json
{ "command": "npx", "args": ["-y", "@ravi-labs/mindmap-mcp-server"],
  "env": { "MINDMAP_DIR": "/path/to/my/memory" } }
```

### From source (development)

```bash
git clone https://github.com/ravi-labs/mindmap-mcp-server.git && cd mindmap-mcp-server
npm install && npm run build
node dist/index.js install --local   # points clients at this checkout
```

## Tools

| Tool | What it does |
| --- | --- |
| `mindmap_capture` | Silently save a context summary (the effortless half of the loop). |
| `mindmap_resume` | Find + return the best context for a topic; **promotes on reuse**. |
| `mindmap_search` | Read-only search across every tier and tool. |
| `mindmap_list` | Browse memories with filters. |
| `mindmap_get` | Fetch one memory's full content. |
| `mindmap_promote` | Explicitly bless a memory as trusted (→ hot). |
| `mindmap_update` | Trim / edit / retag — the human curation moment. |
| `mindmap_link` | Connect related threads (the lightweight "map"). |
| `mindmap_prune` | Run the consolidation pass on demand (`dry_run` to preview). |
| `mindmap_forget` | Soft-archive to a trace, or `hard` delete. |
| `mindmap_health` | Gamified cleanliness score (opt-in). |
| `mindmap_tidy` | Batch of stalest memories to keep / trim / forget. |
| `mindmap_config` | View / change decay windows and toggles. |

## How it stores things

```
~/.mindmap/
├── threads/<id>.json   # one file per memory (human-readable JSON)
├── index.json          # fast list/search index
└── config.json         # tunable thresholds + gamification toggle
```

Plain files you own and can inspect, grep, back up, or sync yourself. Tiers map
to the mental model: **hot = mem**, **warm = files**, **cold = drive (trace)**.

## Tuning decay

```jsonc
// defaults (mindmap_config to change at runtime)
{
  "hotWindowMs":  7 days,    // active memory stays hot this long
  "warmWindowMs": 30 days,   // then warm; past it → cold trace
  "promotedLongevityFactor": 2,  // blessed memories decay 2× slower
  "gamification": true
}
```

## Develop

```bash
npm run dev      # watch mode (tsx)
npm run build    # type-check + emit dist/
npm test         # end-to-end smoke tests (stdio + http) in throwaway data dirs
```

## Future

**ChatGPT / cloud clients (parked).** A cloud client can't reach a local server
without exposing it publicly (a tunnel or a host), which breaks the local-first
promise. An HTTP transport already ships in the codebase
(`TRANSPORT=http`, with bearer-token auth + origin allow-listing) for anyone who
*chooses* to self-host — but it's intentionally not the default path. Revisiting
ChatGPT later likely means an opt-in hosted tier with per-user encryption, a
deliberate trust decision rather than a default.

Other directions:

- Auto-capture hooks per client so the "capture" step is invisible.
- Embedding-based semantic recall (current search is token-overlap).
- Richer graph view of linked threads.
- OAuth + per-user data isolation (only needed if a hosted tier ever happens).

## License

MIT
