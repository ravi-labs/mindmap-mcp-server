# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — call log & activity console

- **Every MCP tool call is logged** (redacted) to `~/.mindmap/calls.jsonl` and
  echoed to stderr — a single shared log across *all* clients (Claude Code,
  Cursor…), not one process. One wrapper at `registerTools` covers every tool;
  args are secret-redacted and truncated; the file self-rotates.
- **Dashboard "Activity" tab** — a live console of recent calls (tool, time,
  duration, ok/error, redacted args), newest-first, with an "errors only" filter.
  Auto-refreshes. On by default; toggle with the `logCalls` config.

### Added — restart a topic, not just a memory

- **Cluster-resume.** `mindmap_resume` now resolves a fuzzy, natural-language
  query ("restart the promotion-roadmap discussion") to a whole **topic cluster**
  — the best match plus its linked and closely-related fragments — and merges them
  into one chronological thread to continue from. This addresses *topic
  fragmentation*: a discussion is usually spread across several sessions/tools, not
  one record. Degrades to single-record resume when nothing else clusters.
  (New `resolveTopicCluster` in `search.ts`.)
- **Capture "next steps".** `mindmap_capture` gains `next_steps` (open work / where
  you left off). Resume surfaces a **"Where you left off"** block and `brainstorm`
  shows open threads, so you *continue* a topic instead of re-reading it. Shown in
  the dashboard detail; redacted like other content. (#2)

### Added — secret redaction

- **Secrets are masked before anything is persisted.** A local, no-LLM scan runs
  at the storage choke point (`saveThread`), so no capture/import/hook/passport
  path can write a plaintext credential to `~/.mindmap`. Detects common token
  shapes (OpenAI/Anthropic keys, GitHub PATs, AWS/Google keys, Slack/Stripe/npm
  tokens, private-key blocks, JWTs, bearer tokens) and replaces them with
  `[REDACTED:<kind>]`. Matters most for **imports**, which can drag in keys pasted
  into past sessions. Flags the memory (`redacted`) and shows a 🔒 in the
  dashboard. On by default; toggle with the `redactSecrets` config. (#1)

### Changed / Added — better search

- **BM25 relevance** replaces token-overlap in `searchEntries`: IDF weighting
  (rare query terms matter more), document-length normalization (a tight title
  match beats an incidental mention in a long trace), and a title field-boost.
  Improves `mindmap_resume` / `mindmap_search` / `mindmap_brainstorm` ranking.
- **Hybrid search (optional, BYO-key)**: with an embeddings-capable provider
  (OpenAI / Google / Ollama), `hybridSearch` fuses BM25 with semantic similarity
  via reciprocal rank fusion. Vectors are cached locally in
  `~/.mindmap/embeddings.json` (only new/changed memories are re-embedded). Build
  with the new `embed` command. Anthropic has no embeddings API, so it (and the
  no-key path) gracefully stays on BM25 — never worse.
  - New: `llm.embed()` / `canEmbed()`, `embeddings.ts` cache, `embed` CLI command.

## [0.4.0] — 2026-06-11

### Added

- **Auto-capture (Claude Code SessionEnd hook).** `install` now wires a `SessionEnd`
  hook into `~/.claude/settings.json` so every substantive Claude Code session is
  **automatically distilled into a memory** — no need to remember to save. It's
  deduped by session id (resuming + re-ending updates in place), skips trivial and
  automated sessions, and never blocks Claude Code. Opt out with `install --no-hook`;
  `uninstall` removes it cleanly (merges with / preserves your other hooks).
  - New internal command: `hook session-end` (reads the hook payload from stdin).

## [0.3.2] — 2026-06-11

### Fixed

- **ChatGPT & Claude.ai export importers** hardened for real export formats:
  - ChatGPT (`passport import-chatgpt`): skips hidden system / custom-instruction
    messages and `tool`/`system` roles; handles `multimodal_text` parts that mix
    strings with objects (image/DALL·E pointers); falls back to `content.text`.
  - Claude (`passport import-claude`): handles the newer `content[]` array form
    where the top-level `text` is empty.
  - Both now give a clear "wrong file" error pointing to the right export file,
    while a genuinely empty export remains a valid no-op.

## [0.3.1] — 2026-06-10

### Added

- **Brainstorm across tools.** Brainstorms are now a first-class memory kind, so an
  idea you start in one AI tool continues in another — without re-explaining it.
  - `mindmap_brainstorm` tool: loads your persona + prior idea-threads on a topic
    (brainstorm threads boosted), promotes the ones you reuse, and hands them back
    so you brainstorm *with* memory using each tool's own ability. Mind Map stays
    the shared memory layer — it doesn't drive other tools.
  - `mindmap_capture` gains a `kind` arg (`discussion` | `brainstorm`).
  - **Companion Skill** (`skills/mindmap-brainstorm`): orchestrates load → brainstorm
    → save. Auto-installed into `~/.claude/skills` by `install`; also `skill-install`.
  - Dashboard: 💡 badge + "brainstorms only" filter; brainstorm marked in detail.

## [0.3.0] — 2026-06-10

The **own-your-context** release. Three features built around a single thesis:
*interoperability isn't portability — a memory you can't extract, inspect, or
carry isn't a memory you own.*

### Added

- **Memory Passport** — export every memory + persona to one portable, open JSON
  file (back it up, move machines, hand to a fork), and import it back with clean
  dedup. Crucially, **pull your context OUT of walled gardens**: import the
  *data-export files* from ChatGPT (`conversations.json`) and Claude.ai as
  distilled memories.
  - Tools: `mindmap_passport_export`, `mindmap_passport_import`.
  - CLI: `passport export [path]`, `passport import <file>`,
    `passport import-chatgpt <file>`, `passport import-claude <file>`.
  - Dashboard: export button + import (passport / ChatGPT / Claude) in the
    Persona tab.
- **Glass-box memory** — see and control exactly what's stored. Every memory now
  shows its **provenance** (where it came from), **trust** (promote-on-reuse
  count), and a **decay forecast** (when it fades to a one-line trace), plus a
  one-click **Forget**. Answers the "memory you can't audit" gap that opaque
  vector stores have.
  - Tool: `mindmap_audit`. CLI: `audit`. Dashboard: provenance/lifecycle block +
    Forget button on every memory.
- **Persona projection** — write your persona into each tool's *native* config
  (Claude `CLAUDE.md`, Cursor rules, Copilot instructions, Windsurf rules) from
  one source, so even non-MCP tools know how you work. Writes only inside a
  managed block; never clobbers your own content.
  - Tool: `mindmap_persona_sync`. CLI: `persona-sync [--force]`. Dashboard:
    target detection + selective sync in the Persona tab.

## [0.2.1] — 2026-06-10

The **persona** release: Mind Map now remembers *how you work*, not just what you
discussed — plus an optional bring-your-own-key LLM layer, all opt-in and
local-first.

### Added

- **Persona layer** — a distilled, evolving profile (stack, style, communication,
  constraints, workflow, goals) any tool can read to stop re-asking setup
  questions. Facts are **declared** by you or **inferred** from your memories.
  - New tools: `mindmap_persona`, `mindmap_persona_set`, `mindmap_persona_forget`,
    `mindmap_persona_learn`.
  - Stored in `~/.mindmap/persona.json` with confidence + scope (global/project);
    inferred facts never override declared ones.
- **Bring-your-own-key LLM (optional)** — vendor-neutral provider support
  (`anthropic`, `openai`, `google`, local `ollama`) for richer persona inference
  and graph labels.
  - New tool: `mindmap_llm` to set provider/model.
  - **Your API key is never stored** — Mind Map persists only the provider + model
    name (`~/.mindmap/llm.json`); the key is read from your environment.
  - Fully opt-in and graceful: no key (or a failed call) falls back to the no-LLM
    path. Cost figures are clearly-labelled rough estimates, never billing.
- **Dashboard: Persona tab** — view/add/forget persona facts, run inference, and
  configure the optional LLM (provider/model only — no key field) from the browser.
- **Dashboard: opt-in `✨ LLM labels`** in the Graph view — relabels TF-IDF topic
  clusters with your LLM on a deliberate click; cached by cluster signature so it
  doesn't re-bill; reverts to raw terms with a second click.
- **Dashboard: `⟳ Sync`** button to import new sessions and refresh existing ones.
- **Dashboard: 📜 transcript badge + filter** to find memories with a full
  reconstructable discussion.

### Fixed

- Dashboard reindexes on startup so transcript flags and new index fields are
  current.
- LLM/persona form controls now match the dark theme (styled selects/inputs).
- README license corrected to **Apache-2.0** (matches `LICENSE`/`package.json`).

## [0.2.0]

- Multi-source import (Claude Code CLI, Cowork, VS Code Copilot, Cursor) with
  per-source adapters; Cursor read via Node's built-in SQLite (Node 22.5+).
- On-demand full-discussion reconstruction from source transcripts.
- Topic graph (TF-IDF categories + relatedness edges) and full-discussion view
  with a dependency-free Markdown renderer.
- Dashboard List / Tree / Graph views.

## [0.1.0]

- Initial release: local-first MCP memory & context-handoff server — capture /
  resume loop, promote-on-reuse, tiered decay, and the gamified cleanliness score.
