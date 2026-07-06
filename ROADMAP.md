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
- Cluster-resume (restart a *topic*, not a single memory) + capture "next steps"
- Workspace-aware resume ("continue in the right folder") + pick-a-topic disambiguation
- Periodic auto-import + voice-triggerable `mindmap_import`; MCP call log + Activity console
- Secret redaction before persist (🔒)
- Auto-capture (Claude Code `SessionEnd` hook)
- Local dashboard; published to npm + the Official MCP Registry
- **0.6.0**: Collections (your organization layer, decay-protected) + auto-organize
  ("apps I started and never finished") + resume-from-collection launcher + Organize tab

## 🔜 Now — make 0.6.0 stick (depth, not breadth)

The guiding rule this cycle: **no new concepts.** Users have capture, resume,
persona, and now collections — that's the full vocabulary. Everything below makes
those four *more true*, not bigger.

- **Ship 0.6.0** — npm + MCP registry + GitHub release.
- **Close the loop at session start** — the SessionStart companion to the existing
  SessionEnd hook: opening a tool in a workspace surfaces "you have N unfinished
  projects here — pick up or start fresh?" Nobody goes looking for their parking
  lot; it has to come to them.
- **Keep collections fresh** — fold curation into the existing auto-import (opt-in):
  new sessions quietly land in existing collections; *new* collections are only
  ever proposed, never auto-created.
- **Hygiene** — purge deleted thread ids from collections; rank-then-chunk LLM
  curation so 300+ session corpora are fully covered.

## 🌓 Next — trust labels & persona (where engaged users are pulling)

- **Influence scope: planning-only vs action-allowed** — [#3](https://github.com/ravi-labs/mindmap-mcp-server/issues/3)
- **Stale-since-capture detection** (files changed) — [#4](https://github.com/ravi-labs/mindmap-mcp-server/issues/4)
- **Provenance-first-class retrieval** ("what did I figure out in the previous tool") — [#5](https://github.com/ravi-labs/mindmap-mcp-server/issues/5)
- **Persona conflict resolution + tool scope** — [#6](https://github.com/ravi-labs/mindmap-mcp-server/issues/6)

## 🌙 Later

- **Phone access, the local-first way** — make the dashboard responsive + a PWA
  (installable, "Add to Home Screen"), reachable from your own devices via the
  existing token-protected HTTP transport (e.g. over Tailscale). Review, tidy,
  and check your parking lot from the couch — **no cloud, no sync service**. A
  native app only makes sense if a hosted-sync story ever exists (a separate,
  deliberate decision — it would touch the "your data never leaves your machine"
  promise).
- **Smarter decay curve** — move beyond tiered windows toward a recall-probability-informed forgetting model (Ebbinghaus-style). On-thesis ("forgetting well"); a research spike.
- **Validate & expand importers** — verify ChatGPT/Claude export parsing against large real exports; consider more sources.
- **Embeddings polish** — auto-refresh the cache on capture; dashboard "build embeddings" control.

---

Have an idea or a strong opinion on priority? Open an [issue](https://github.com/ravi-labs/mindmap-mcp-server/issues) or a [discussion](https://github.com/ravi-labs/mindmap-mcp-server/discussions).
