# 🧠 Mind Map — MCP memory & context-handoff server

[![npm](https://img.shields.io/npm/v/@ravi-labs/mindmap-mcp-server?logo=npm)](https://www.npmjs.com/package/@ravi-labs/mindmap-mcp-server)
[![CI](https://github.com/ravi-labs/mindmap-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/ravi-labs/mindmap-mcp-server/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/@ravi-labs/mindmap-mcp-server)](https://nodejs.org)

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

## Using it day to day

Just talk naturally inside your AI tool — the model calls the right tool:

- **"Save this to mind map"** → captures the current context
- **"Resume my work on \<topic\>"** → pulls it back into a fresh session
- **"What's in my mind map?"** / **"Show my mind map health"** → browse / score
- **"What do you know about how I work?"** → reads your **persona** (see below)
- **"Brainstorm \<topic\> with me"** → loads your prior thinking so ideas continue across tools

Run `npx @ravi-labs/mindmap-mcp-server quickstart` for the full getting-started guide.

### Brainstorm across tools

Start an idea in Claude, keep going in Cursor — without re-explaining it. Mind Map is
the **shared memory**; each tool brings its own brainstorming muscle. `mindmap_brainstorm`
loads your persona and prior idea-threads on the topic, you brainstorm, and saving with
`kind: "brainstorm"` lets it resume anywhere. A bundled **brainstorm Skill** (installed
into `~/.claude/skills` by `install`) wires the load → brainstorm → save flow for Claude.

### Make capture automatic

So you don't have to ask each time, add one line to your client's instructions
(e.g. Claude Code's `CLAUDE.md`):

> At the end of a substantive session, call `mindmap_capture` to save the context.
> When I reference past work, call `mindmap_resume` first.

The tools are also described to encourage the model to do this proactively.

## Bring in your past sessions

Import your existing Claude history into Mind Map — distilled, not raw dumps:

```bash
npx @ravi-labs/mindmap-mcp-server import --dry-run   # preview
npx @ravi-labs/mindmap-mcp-server import             # apply
```

Covers **Claude Code** (CLI — full prompts), **Cowork** (title + opening
message), **VS Code Copilot** (full prompts), and **Cursor** (chat titles +
prompts); each memory is tagged by source. Filters: `--source code|cowork|copilot|cursor`,
`--project <name>`, `--limit N`. Imported memories keep their original dates, so
old ones settle into cold traces automatically.

Imported memories capture the **discussion** (your prompts + the assistant's
substantive answers), not just titles — for the transcript-backed sources
(Claude Code, Cursor, Copilot). Re-run with `--reimport` to refresh existing
memories in place after an upgrade.

Notes:
- **Cursor** stores chats in a (often multi-GB) SQLite DB, read via Node's
  built-in SQLite — so Cursor import needs **Node 22.5+** (other sources don't).
- **ChatGPT** and **Claude.ai web chats** can't be imported — they live in the
  cloud, not local files. (A future "import from data-export file" is planned.)

### Tidy up

```bash
npx @ravi-labs/mindmap-mcp-server cleanup --dry-run   # preview
npx @ravi-labs/mindmap-mcp-server cleanup             # apply
```

Removes automated/scheduled-task memories and collapses duplicate sessions.
Anything you've **promoted** is always kept.

## Persona — a profile every tool can read

Beyond individual discussions, Mind Map keeps a **persona**: a distilled,
evolving profile of *how you work* — your stack, style, communication
preferences, and constraints — so any tool can apply it and **stop re-asking the
same setup questions.** It's separate from your discussion memories.

- **Declared** facts: tell a tool *"I prefer concise, code-first answers"* and it
  calls `mindmap_persona_set`. High confidence, yours, editable.
- **Inferred** facts: `mindmap_persona_learn` derives recurring signals from your
  existing memories. No LLM needed (keyword heuristic); richer if you enable one.
- Tools call `mindmap_persona` at the start of a session and apply what's there.

Add this to your client's instructions so it happens automatically:

> At the start of a session call `mindmap_persona` and apply it. When I state a
> durable preference, call `mindmap_persona_set`.

## Own your context

A memory you can't extract, inspect, or carry isn't a memory you own. Three
features make Mind Map's memory genuinely yours:

**Memory Passport** — export everything to one portable, open file, and pull your
context *out of the walled gardens*:

```bash
npx @ravi-labs/mindmap-mcp-server passport export                 # → ~/mindmap-passport-<date>.json
npx @ravi-labs/mindmap-mcp-server passport import <file>          # from another machine
npx @ravi-labs/mindmap-mcp-server passport import-chatgpt conversations.json   # your ChatGPT export
npx @ravi-labs/mindmap-mcp-server passport import-claude  conversations.json   # your Claude.ai export
```

The cloud chats can't be reached live from a local server — but their **data
export files are yours**, and this imports them as distilled memories.

**Glass-box memory** — see exactly what's stored and why:

```bash
npx @ravi-labs/mindmap-mcp-server audit
```

Every memory shows its **provenance** (where it came from), **trust** (how many
times you reused it), and **decay forecast** (when it fades to a one-line trace).
In the dashboard, each memory has a one-click **Forget**. Unlike opaque vector
stores, nothing about your memory is hidden from you.

**Persona projection** — write your persona into each tool's own config, so even
non-MCP tools know how you work:

```bash
npx @ravi-labs/mindmap-mcp-server persona-sync          # Claude, Cursor, Copilot, Windsurf
```

It edits only a managed block (`<!-- mindmap:persona:start -->`…`:end`), so your
own content is never touched.

## Optional: bring your own LLM key

Mind Map runs **fully without any LLM** — every feature has a no-LLM path. If you
*want* smarter persona inference and topic-graph labels, plug in your **own**
provider (`anthropic`, `openai`, `google`, or local `ollama`). It's opt-in and
graceful: no key, or a failed call, simply falls back to the no-LLM path, and any
cost notes are rough estimates — never a bill.

**Mind Map never stores your API key.** It saves only the provider + model name
in `~/.mindmap/llm.json`; the key is read from an **environment variable** at
call time. You set the key; Mind Map just reads it.

### Step 1 — choose a provider

From the dashboard's **Persona** tab (LLM section), or via the `mindmap_llm` tool
(e.g. "set my mindmap llm provider to anthropic"). This writes `{provider, model}`
to `~/.mindmap/llm.json`. Per provider, Mind Map looks for one env var:

| Provider | Env var it reads | Default model |
| --- | --- | --- |
| `anthropic` | `ANTHROPIC_API_KEY` | claude-sonnet-4-6 |
| `openai` | `OPENAI_API_KEY` | gpt-4o |
| `google` | `GOOGLE_API_KEY` | gemini-1.5-pro |
| `ollama` | *(none — local)* | llama3.1 |

### Step 2 — give it the key

The key must be visible **to the process that needs it**. There are two ways, and
which one you need depends on the surface:

**A. Shell profile** — for the **dashboard / CLI**, and for **Claude Code** (its
MCP servers inherit your shell environment):

```bash
# ~/.zshrc (or ~/.bashrc)
export ANTHROPIC_API_KEY="sk-ant-…"
```

Then `source ~/.zshrc` and restart. Run the dashboard from that same shell and
it'll pick the key up.

**B. The client's MCP config `env` block** — for **GUI clients** (Claude Desktop,
Cursor, Windsurf), which launch MCP servers *without* your shell environment, so
the `export` above won't reach them. Add an `env` map to Mind Map's entry:

```json
{
  "mcpServers": {
    "mindmap": {
      "command": "npx",
      "args": ["-y", "@ravi-labs/mindmap-mcp-server"],
      "env": { "ANTHROPIC_API_KEY": "sk-ant-…" }
    }
  }
}
```

> Trade-off: method **B** writes the key into that client's config file in plain
> text. That's the only way some GUI clients can pass it through — but if you'd
> rather not have a key on disk, prefer method **A** (or launch the GUI app from a
> terminal that already has the variable exported, so it inherits it).

There is **no key field in the dashboard or tools by design** — a key typed into a
web form would have to be transmitted and stored to be useful, which is exactly the
credential-on-disk pattern Mind Map avoids. You set the env var yourself.

For **ollama** there's no key at all — just run `ollama serve` locally and pick the
`ollama` provider.

### Step 3 — verify

Call `mindmap_llm` with no arguments (or open the dashboard Persona tab). When the
key is visible it reports **ready** — e.g. *"✓ `ANTHROPIC_API_KEY` detected."*
After setting the env var, **restart** the server/client so it's picked up.

## See your memory — the dashboard

```bash
npx @ravi-labs/mindmap-mcp-server dashboard   # http://127.0.0.1:7777
```

A local web UI (loopback-only) with four views:

- **List** — memories grouped by 🔥/🌤️/❄️ tier, searchable; click one to read its
  summary, key points, and **full discussion** (the complete conversation,
  reconstructed on demand and rendered as Markdown). A 📜 badge + filter mark
  memories that have a full transcript.
- **Tree** — 🧠 → source → project → discussion, with linked threads joined.
- **Graph** — an auto-derived **topic map**: categories as hubs, sessions
  connected by relatedness, with category filter chips and live search. An opt-in
  **✨ LLM labels** button relabels the topic clusters using your own LLM.
- **Persona** — view and edit your profile (see above), add preferences, run
  inference, and configure the optional LLM — all from the browser.

A **⟳ Sync** button imports new sessions on demand, and a **cleanliness score**
rewards a tidy, trusted memory — not a big one.

## Tools

| Tool | What it does |
| --- | --- |
| `mindmap_capture` | Silently save a context summary (the effortless half of the loop). |
| `mindmap_resume` | Find + return the best context for a topic; **promotes on reuse**. |
| `mindmap_brainstorm` | Brainstorm a topic *with* your memory — loads prior idea-threads so ideas continue across tools. |
| `mindmap_search` | Read-only search across every tier and tool. |
| `mindmap_list` | Browse memories with filters. |
| `mindmap_get` | Fetch one memory's full content. |
| `mindmap_transcript` | Reconstruct the **full original conversation** for a memory (Claude Code / Cursor / Copilot). |
| `mindmap_promote` | Explicitly bless a memory as trusted (→ hot). |
| `mindmap_update` | Trim / edit / retag — the human curation moment. |
| `mindmap_link` | Connect related threads (the lightweight "map"). |
| `mindmap_prune` | Run the consolidation pass on demand (`dry_run` to preview). |
| `mindmap_forget` | Soft-archive to a trace, or `hard` delete. |
| `mindmap_health` | Gamified cleanliness score (opt-in). |
| `mindmap_tidy` | Batch of stalest memories to keep / trim / forget. |
| `mindmap_config` | View / change decay windows and toggles. |
| `mindmap_persona` | Read your persona — apply it at session start to stop re-asking. |
| `mindmap_persona_set` | Record a durable preference (stack/style/constraints…). |
| `mindmap_persona_forget` | Mute or delete a persona fact. |
| `mindmap_persona_learn` | Infer persona facts from your memories (LLM-assisted if configured). |
| `mindmap_persona_sync` | Write your persona into your tools' native config files. |
| `mindmap_llm` | Configure the optional BYO-key LLM (provider/model; key stays in your env). |
| `mindmap_audit` | Glass-box ledger: provenance, trust, and decay forecast for every memory. |
| `mindmap_passport_export` | Export all memories + persona to one portable file. |
| `mindmap_passport_import` | Import a passport, or a ChatGPT / Claude.ai data export. |

## How it stores things

```
~/.mindmap/
├── threads/<id>.json   # one file per memory (human-readable JSON)
├── index.json          # fast list/search index
├── config.json         # tunable thresholds + gamification toggle
├── persona.json        # your evolving profile (declared + inferred facts)
└── llm.json            # optional LLM provider + model (never your API key)
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
- LLM-assisted relatedness edges in the graph (labels already opt-in).
- OAuth + per-user data isolation (only needed if a hosted tier ever happens).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
