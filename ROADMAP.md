# Roadmap

Mind Map's direction, shaped by its thesis — **memory you own: portable, inspectable, and good at forgetting** — and by early community feedback (much of it from the [r/mcp](https://www.reddit.com/r/mcp/) launch thread).

Horizons are intent, not promises. Issues are where the detail lives — comments welcome.

## ✅ Shipped

- Capture → resume loop across tools (MCP)
- Promote-on-reuse trust model + tiered graceful decay (hot → warm → cold trace)
- Persona layer (declared + inferred) and persona projection into tool configs
- Memory passport (export/import; ChatGPT & Claude data-export import)
- Glass-box provenance + audit ledger
- Search: BM25, with optional hybrid (BM25 + embeddings) via BYO-key
- Auto-capture (Claude Code `SessionEnd` hook)
- Local dashboard; published to npm + the Official MCP Registry

## 🔜 Now

- **Cut the 0.5.0 release** — get BM25 + hybrid search + auto-capture onto npm.
- **Redaction / secret-scan on capture & import** — [#1](https://github.com/ravi-labs/mindmap-mcp-server/issues/1)
- **Capture next-steps / open work** (better handoff) — [#2](https://github.com/ravi-labs/mindmap-mcp-server/issues/2)

## 🌓 Next — trust labels & persona (where engaged users are pulling)

- **Influence scope: planning-only vs action-allowed** — [#3](https://github.com/ravi-labs/mindmap-mcp-server/issues/3)
- **Stale-since-capture detection** (files changed) — [#4](https://github.com/ravi-labs/mindmap-mcp-server/issues/4)
- **Provenance-first-class retrieval** ("what did I figure out in the previous tool") — [#5](https://github.com/ravi-labs/mindmap-mcp-server/issues/5)
- **Persona conflict resolution + tool scope** — [#6](https://github.com/ravi-labs/mindmap-mcp-server/issues/6)

## 🌙 Later

- **Smarter decay curve** — move beyond tiered windows toward a recall-probability-informed forgetting model (Ebbinghaus-style). On-thesis ("forgetting well"); a research spike.
- **Validate & expand importers** — verify ChatGPT/Claude export parsing against large real exports; consider more sources.
- **Embeddings polish** — auto-refresh the cache on capture; dashboard "build embeddings" control.

---

Have an idea or a strong opinion on priority? Open an [issue](https://github.com/ravi-labs/mindmap-mcp-server/issues) or a [discussion](https://github.com/ravi-labs/mindmap-mcp-server/discussions).
