/**
 * Tool definitions for the Mind Map MCP server.
 *
 * The capture/handoff loop, the consolidation engine, and the opt-in gamified
 * curation surface are all registered here against a single McpServer.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { type Config } from "./constants.js";
import { computeTier, health, makeTrace, prune } from "./decay.js";
import { formatList, formatThread, truncate } from "./format.js";
import { auditLedger } from "./ledger.js";
import { exportPassport, importExport, importPassport } from "./passport.js";
import { detectTargets, syncPersona } from "./project.js";
import {
  allFacts,
  forgetFact,
  inferWithLLM,
  renderPersona,
  setFact,
  type PersonaCategory,
} from "./persona.js";
import {
  estimateCost,
  PROVIDER_NAMES,
  setSettings,
  status as llmStatus,
  type ProviderName,
} from "./llm.js";
import { searchEntries, type SearchFilters } from "./search.js";
import { formatTranscript, getTranscript } from "./transcript.js";
import {
  allEntries,
  deleteThread,
  getConfig,
  getThread,
  newId,
  nowIso,
  saveThread,
  setConfig,
} from "./store.js";
import { type Thread, type Tier } from "./types.js";

const tierEnum = z.enum(["hot", "warm", "cold"]);
const sourceDesc =
  "Origin tool, e.g. 'claude-code', 'chatgpt', 'chat', 'cowork', 'claude-desktop'.";

function text(s: string) {
  return { content: [{ type: "text" as const, text: truncate(s) }] };
}

function result(s: string, structured: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: truncate(s) }],
    structuredContent: structured,
  };
}

/** Bump usage stats and re-tier a thread. Promote-on-reuse happens here. */
function applyAccess(t: Thread, cfg: Config): void {
  const now = Date.now();
  t.accessCount += 1;
  t.lastAccessedAt = new Date(now).toISOString();
  if (t.status === "captured") {
    // The one human-cheap moment of judgement: reusing it = vouching for it.
    t.status = "promoted";
    t.promotedAt = t.lastAccessedAt;
  }
  t.tier = computeTier(t, cfg, now);
  t.updatedAt = t.lastAccessedAt;
}

export function registerTools(server: McpServer): void {
  // ----------------------------------------------------------------- capture
  server.registerTool(
    "mindmap_capture",
    {
      title: "Capture context",
      description: `Silently save a portable context summary from the current session so it can be resumed later in any tool. This is the effortless 'capture' half of the loop. New captures start as 'captured' (warm tier); they become trusted 'promoted' memories the first time you resume them.

CALL THIS PROACTIVELY (you don't need to be asked) when: a substantive discussion is wrapping up; the user says they're done / switching tasks / "remember this" / "save this"; a key decision, plan, or conclusion was reached; or the user signals they'll continue later. Write the summary so a future session in a DIFFERENT tool could pick up with full context. Skip trivial one-off exchanges.

Args:
  - title (string): short topic title
  - summary (string): the portable context to inject into a future session (markdown ok)
  - key_points (string[]): scannable discussion points (optional)
  - tags (string[]): topic tags for filtering (optional)
  - source (string): ${sourceDesc}
  - links (string[]): ids of related threads to connect (optional)
  - kind ('discussion'|'brainstorm'): mark brainstorm sessions so they can be resumed/clustered as ideas (default 'discussion')

Returns: the created thread id and its formatted record.`,
      inputSchema: {
        title: z.string().min(1).max(200).describe("Short topic title"),
        summary: z.string().min(1).describe("Portable context summary (markdown ok)"),
        key_points: z
          .array(z.string())
          .default([])
          .describe("Scannable discussion points"),
        tags: z.array(z.string()).default([]).describe("Topic tags for filtering"),
        source: z.string().default("unknown").describe(sourceDesc),
        links: z
          .array(z.string())
          .default([])
          .describe("ids of related threads to link"),
        kind: z.enum(["discussion", "brainstorm"]).default("discussion").describe("Thread kind"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ title, summary, key_points, tags, source, links, kind }) => {
      const now = nowIso();
      const thread: Thread = {
        id: newId(),
        title,
        ...(kind === "brainstorm" ? { kind } : {}),
        summary,
        keyPoints: key_points,
        tags,
        source,
        tier: "warm",
        status: "captured",
        trace: makeTrace({ title, keyPoints: key_points, summary }),
        links,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
        accessCount: 0,
      };
      await saveThread(thread);
      return result(
        `Captured **${title}** as \`${thread.id}\` (warm). Resume it anytime with mindmap_resume.\n\n${formatThread(thread)}`,
        { id: thread.id, tier: thread.tier, status: thread.status },
      );
    },
  );

  // ------------------------------------------------------------------ resume
  server.registerTool(
    "mindmap_resume",
    {
      title: "Resume context",
      description: `Find the best-matching saved context for a topic and return its summary to inject into the current (new) session — so you don't lose context across tools. This is the 'promote-on-reuse' moment: resuming a captured memory promotes it to a trusted (hot) memory and bumps its freshness. After reading, if anything is stale, call mindmap_update to trim it.

CALL THIS PROACTIVELY (you don't need to be asked) at the START of a session when the user references prior work — e.g. "let's continue", "pick up where we left off", "the X project", or any topic that sounds like it may have history. Resuming first means you start with their real context instead of asking them to re-explain.

Args:
  - query (string): topic or keywords describing what you were working on
  - source (string): only resume memories from this origin tool (optional)

Returns: the matched thread's full context plus a freshness nudge, or near-misses if nothing strong matched.`,
      inputSchema: {
        query: z.string().min(1).describe("Topic / keywords to resume"),
        source: z.string().optional().describe("Restrict to this origin tool"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ query, source }) => {
      const cfg = await getConfig();
      const entries = await allEntries();
      const ranked = searchEntries(entries, query, { source }, Date.now());
      if (ranked.length === 0) {
        return text(
          `No saved context matches "${query}". Nothing to resume — start fresh, then mindmap_capture when done.`,
        );
      }
      const top = await getThread(ranked[0].entry.id);
      if (!top) return text(`Index pointed to a missing thread. Try mindmap_prune.`);

      applyAccess(top, cfg);
      await saveThread(top);

      const others = ranked.slice(1, 4);
      let body = `Resuming **${top.title}** (\`${top.id}\`) — now ${top.status}, ${top.tier}.\n\nPaste the summary below into your new session:\n\n---\n${top.summary.trim()}\n---\n`;
      if (top.keyPoints.length) {
        body += `\nKey points:\n${top.keyPoints.map((p) => `- ${p}`).join("\n")}\n`;
      }
      body += `\n_Still accurate? If something's stale, trim it with mindmap_update id="${top.id}"._`;
      if (others.length) {
        body += `\n\nOther near-matches:\n${others
          .map((o) => `- ${o.entry.title} (\`${o.entry.id}\`)`)
          .join("\n")}`;
      }
      return result(body, {
        id: top.id,
        title: top.title,
        summary: top.summary,
        keyPoints: top.keyPoints,
        status: top.status,
        tier: top.tier,
        alternatives: others.map((o) => ({ id: o.entry.id, title: o.entry.title })),
      });
    },
  );

  // -------------------------------------------------------------- brainstorm
  server.registerTool(
    "mindmap_brainstorm",
    {
      title: "Brainstorm with memory",
      description: `Start (or continue) a brainstorm on a topic WITH your shared memory. This pulls your prior thinking on the topic — past brainstorms first, then related discussions and your persona — so an idea you explored in one tool continues seamlessly in another. It does NOT replace your own brainstorming ability: use this to load context, then brainstorm with your full capability (and any brainstorming skill you have), then save the result.

CALL THIS PROACTIVELY when the user wants to brainstorm / ideate / "think through" / "explore options" on something that may have history. Reusing a past brainstorm promotes it (promote-on-reuse).

Flow: 1) call this with the topic → get prior context; 2) brainstorm, building on it; 3) save what's worth keeping with mindmap_capture(kind="brainstorm").

Args:
  - topic (string): what you're brainstorming about
Returns: a brainstorm pack — persona + prior idea-threads to build on.`,
      inputSchema: { topic: z.string().min(1).describe("Brainstorm topic / question") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ topic }) => {
      const cfg = await getConfig();
      const entries = await allEntries();
      const ranked = searchEntries(entries, topic, {}, Date.now());
      // Boost brainstorm-kind threads so ideas resurface ahead of stray chatter.
      const isBrainstorm = (e: { kind?: string; tags: string[] }) =>
        e.kind === "brainstorm" || e.tags.includes("brainstorm");
      const top = ranked
        .map((r) => ({ r, s: r.score * (isBrainstorm(r.entry) ? 2.2 : 1) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
        .map((x) => x.r);

      const loaded: Thread[] = [];
      for (const e of top) {
        const t = await getThread(e.entry.id);
        if (!t) continue;
        // Promote-on-reuse only the brainstorm threads we're explicitly building on.
        if (t.kind === "brainstorm") {
          applyAccess(t, cfg);
          await saveThread(t);
        }
        loaded.push(t);
      }

      const persona = await renderPersona({});
      let body = `# Brainstorm: ${topic}\n\n`;
      if (persona.count) body += `**Who you're brainstorming with:**\n${persona.text}\n\n`;
      if (loaded.length) {
        body += `**Prior thinking to build on (${loaded.length}):**\n\n`;
        for (const t of loaded) {
          body += `### ${t.kind === "brainstorm" ? "💡 " : ""}${t.title} (\`${t.id}\`)\n`;
          body += `${t.summary.trim().slice(0, 800)}\n`;
          if (t.keyPoints.length) body += `${t.keyPoints.slice(0, 5).map((p) => `- ${p}`).join("\n")}\n`;
          body += `\n`;
        }
        body += `_Build on the threads above — diverge widely, then converge. Don't just repeat them._\n`;
      } else {
        body += `No prior brainstorms on this — start fresh: diverge widely, then converge.\n`;
      }
      body += `\n_When something's worth keeping, save it with mindmap_capture(kind="brainstorm") so it travels to your other tools._`;

      return result(body, {
        topic,
        related: loaded.map((t) => ({ id: t.id, title: t.title, kind: t.kind || "discussion" })),
      });
    },
  );

  // ------------------------------------------------------------------ search
  server.registerTool(
    "mindmap_search",
    {
      title: "Search memories",
      description: `Search across all saved context (every tier, every tool) to relocate a past discussion. Read-only — does not change freshness or tiers (use mindmap_resume to actually pull a memory forward).

Args:
  - query (string): keywords; empty string browses by recency
  - source/tag/tier: optional filters
  - include_archived (boolean): include forgotten traces (default false)
  - limit (number): max results (default 10)

Returns: ranked list of matching memories.`,
      inputSchema: {
        query: z.string().default("").describe("Keywords; empty = browse by recency"),
        source: z.string().optional().describe("Filter by origin tool"),
        tag: z.string().optional().describe("Filter by tag"),
        tier: tierEnum.optional().describe("Filter by tier"),
        include_archived: z.boolean().default(false).describe("Include forgotten traces"),
        limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ query, source, tag, tier, include_archived, limit }) => {
      const entries = await allEntries();
      const filters: SearchFilters = { source, tag, tier, includeArchived: include_archived };
      const ranked = searchEntries(entries, query, filters, Date.now()).slice(0, limit);
      const list = ranked.map((r) => r.entry);
      return result(
        formatList(list, `# Search: "${query || "(recent)"}" — ${ranked.length} result(s)`),
        { count: list.length, results: list.map((e) => ({ id: e.id, title: e.title })) },
      );
    },
  );

  // -------------------------------------------------------------------- list
  server.registerTool(
    "mindmap_list",
    {
      title: "List memories",
      description: `List saved memories with optional filters, newest-used first. Read-only.

Args: source/tag/tier filters, include_archived (default false), limit (default 20).
Returns: list of memories.`,
      inputSchema: {
        source: z.string().optional().describe("Filter by origin tool"),
        tag: z.string().optional().describe("Filter by tag"),
        tier: tierEnum.optional().describe("Filter by tier"),
        include_archived: z.boolean().default(false).describe("Include archived traces"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ source, tag, tier, include_archived, limit }) => {
      const entries = await allEntries();
      const filtered = entries
        .filter((e) => (include_archived ? true : e.status !== "archived"))
        .filter((e) => (source ? e.source === source : true))
        .filter((e) => (tag ? e.tags.includes(tag) : true))
        .filter((e) => (tier ? e.tier === tier : true))
        .sort(
          (a, b) =>
            new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime(),
        )
        .slice(0, limit);
      return result(formatList(filtered, `# Memories (${filtered.length})`), {
        count: filtered.length,
        results: filtered.map((e) => ({ id: e.id, title: e.title, tier: e.tier })),
      });
    },
  );

  // --------------------------------------------------------------------- get
  server.registerTool(
    "mindmap_get",
    {
      title: "Get a memory",
      description: `Fetch the full content of one memory by id. Read-only (does not change freshness).

Args: id (string). Returns: the full thread.`,
      inputSchema: { id: z.string().describe("Thread id") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const t = await getThread(id);
      if (!t) return text(`No memory with id "${id}".`);
      return result(formatThread(t), { id: t.id, title: t.title, status: t.status });
    },
  );

  // -------------------------------------------------------------- transcript
  server.registerTool(
    "mindmap_transcript",
    {
      title: "Full discussion",
      description: `Reconstruct and return the FULL original conversation for a memory (every user + assistant turn), read live from its source transcript. The summary is the distilled gist; this is the complete discussion when you need the detail.

Only available for transcript-backed sources (Claude Code, Cursor, Copilot). Cowork / Claude desktop-app sessions saved no transcript, so this returns a notice instead.

Args: id (string). Returns: the full discussion as turns, or why it's unavailable.`,
      inputSchema: { id: z.string().describe("Thread id") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const t = await getThread(id);
      if (!t) return text(`No memory with id "${id}".`);
      const res = await getTranscript(t);
      return result(formatTranscript(t, res), {
        id: t.id,
        available: res.available,
        turns: res.turns.length,
        truncated: res.truncated ?? false,
      });
    },
  );

  // ----------------------------------------------------------------- promote
  server.registerTool(
    "mindmap_promote",
    {
      title: "Promote a memory",
      description: `Explicitly bless a memory as trusted: marks it 'promoted' and moves it to the hot tier so it ranks first and decays slower. Use when you know a memory matters even if you haven't resumed it yet.

Args: id (string). Returns: the updated thread.`,
      inputSchema: { id: z.string().describe("Thread id") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id }) => {
      const t = await getThread(id);
      if (!t) return text(`No memory with id "${id}".`);
      t.status = "promoted";
      t.promotedAt = nowIso();
      t.tier = "hot";
      t.updatedAt = t.promotedAt;
      await saveThread(t);
      return result(`Promoted **${t.title}** (\`${t.id}\`) → hot ★.`, {
        id: t.id,
        status: t.status,
        tier: t.tier,
      });
    },
  );

  // ------------------------------------------------------------------ update
  server.registerTool(
    "mindmap_update",
    {
      title: "Update / trim a memory",
      description: `Edit a memory — the human curation moment. Trim a stale summary, refine key points, retitle, or retag. Any omitted field is left unchanged. Set append=true to append to summary/key_points instead of replacing.

Args: id, title?, summary?, key_points?, tags?, append (default false).
Returns: the updated thread.`,
      inputSchema: {
        id: z.string().describe("Thread id"),
        title: z.string().optional().describe("New title"),
        summary: z.string().optional().describe("New (or appended) summary"),
        key_points: z.array(z.string()).optional().describe("New (or appended) key points"),
        tags: z.array(z.string()).optional().describe("Replace tags"),
        append: z.boolean().default(false).describe("Append instead of replace"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, title, summary, key_points, tags, append }) => {
      const t = await getThread(id);
      if (!t) return text(`No memory with id "${id}".`);
      if (title !== undefined) t.title = title;
      if (summary !== undefined) t.summary = append ? `${t.summary}\n${summary}` : summary;
      if (key_points !== undefined) {
        t.keyPoints = append ? [...t.keyPoints, ...key_points] : key_points;
      }
      if (tags !== undefined) t.tags = tags;
      t.trace = makeTrace(t);
      t.updatedAt = nowIso();
      await saveThread(t);
      return result(`Updated **${t.title}** (\`${t.id}\`).\n\n${formatThread(t)}`, {
        id: t.id,
      });
    },
  );

  // -------------------------------------------------------------------- link
  server.registerTool(
    "mindmap_link",
    {
      title: "Link two memories",
      description: `Connect two memories so related threads (e.g. planning in Chat + code in Claude Code) cross-reference each other. Bidirectional. This is the lightweight 'map' connective tissue.

Args: id (string), target_id (string). Returns: confirmation.`,
      inputSchema: {
        id: z.string().describe("First thread id"),
        target_id: z.string().describe("Second thread id"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ id, target_id }) => {
      if (id === target_id) return text(`Cannot link a memory to itself.`);
      const a = await getThread(id);
      const b = await getThread(target_id);
      if (!a) return text(`No memory with id "${id}".`);
      if (!b) return text(`No memory with id "${target_id}".`);
      if (!a.links.includes(b.id)) a.links.push(b.id);
      if (!b.links.includes(a.id)) b.links.push(a.id);
      a.updatedAt = nowIso();
      b.updatedAt = a.updatedAt;
      await saveThread(a);
      await saveThread(b);
      return result(`Linked **${a.title}** ↔ **${b.title}**.`, {
        linked: [a.id, b.id],
      });
    },
  );

  // ------------------------------------------------------------------- prune
  server.registerTool(
    "mindmap_prune",
    {
      title: "Prune / consolidate memory",
      description: `Run the consolidation pass that the background thread runs automatically: recompute every memory's tier by age + usage, cooling unused ones and collapsing cold ones to a one-line trace (still searchable, never deleted). Nothing is destroyed.

Args: dry_run (boolean, default false) — preview changes without writing.
Returns: what moved between tiers.`,
      inputSchema: {
        dry_run: z.boolean().default(false).describe("Preview without writing changes"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ dry_run }) => {
      const cfg = await getConfig();
      const res = await prune(cfg, dry_run);
      const head = `# Prune ${dry_run ? "(dry run)" : ""}\nScanned ${res.scanned}, ${res.changes.length} re-tiered.`;
      const body = res.changes.length
        ? res.changes.map((c) => `- ${c.title} (\`${c.id}\`): ${c.from} → ${c.to}`).join("\n")
        : "_Everything already in the right tier._";
      return result(`${head}\n\n${body}`, {
        scanned: res.scanned,
        changed: res.changes.length,
        changes: res.changes,
      });
    },
  );

  // ------------------------------------------------------------------ forget
  server.registerTool(
    "mindmap_forget",
    {
      title: "Forget a memory",
      description: `Forget a memory. By default this is a soft forget: status→archived, kept only as a searchable one-line trace (recall never hard-fails). Set hard=true to permanently delete the file.

Args: id (string), hard (boolean, default false).
Returns: confirmation.`,
      inputSchema: {
        id: z.string().describe("Thread id"),
        hard: z.boolean().default(false).describe("Permanently delete instead of archive"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, hard }) => {
      const t = await getThread(id);
      if (!t) return text(`No memory with id "${id}".`);
      if (hard) {
        await deleteThread(id);
        return result(`Permanently deleted **${t.title}** (\`${id}\`).`, {
          id,
          deleted: true,
        });
      }
      t.status = "archived";
      t.tier = "cold";
      t.archivedAt = nowIso();
      t.trace = makeTrace(t);
      t.updatedAt = t.archivedAt;
      await saveThread(t);
      return result(`Archived **${t.title}** (\`${id}\`) — kept as a trace.`, {
        id,
        status: t.status,
      });
    },
  );

  // ------------------------------------------------------------------ health
  server.registerTool(
    "mindmap_health",
    {
      title: "Memory health",
      description: `The opt-in gamified curation surface. Reports a cleanliness score — the share of memory that is still live (hot+warm) vs stale — which rewards pruning, not hoarding. Also lists stale candidates worth a tidy pass.

Args: none. Returns: health report.`,
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      const cfg = await getConfig();
      if (!cfg.gamification) {
        return text(`Gamification is off. Enable it with mindmap_config gamification=true.`);
      }
      const h = await health(cfg, Date.now());
      const bar = scoreBar(h.cleanlinessScore);
      const lines = [
        `# 🧠 Memory health`,
        ``,
        `Cleanliness: **${h.cleanlinessScore}%** ${bar}`,
        `(${h.hot + h.warm} live of ${h.hot + h.warm + h.cold} active)`,
        ``,
        `🔥 hot ${h.hot} · 🌤️ warm ${h.warm} · ❄️ cold ${h.cold}`,
        `★ promoted ${h.promoted} · • captured ${h.captured} · 🗄️ archived ${h.archived}`,
      ];
      if (h.staleCandidates.length) {
        lines.push(``, `## Tidy candidates (${h.staleCandidates.length})`);
        lines.push(`Run mindmap_tidy to review keep / trim / forget.`);
      } else {
        lines.push(``, `Nothing stale — tidy as a whistle. ✨`);
      }
      return result(lines.join("\n"), {
        cleanlinessScore: h.cleanlinessScore,
        hot: h.hot,
        warm: h.warm,
        cold: h.cold,
        staleCount: h.staleCandidates.length,
      });
    },
  );

  // -------------------------------------------------------------------- tidy
  server.registerTool(
    "mindmap_tidy",
    {
      title: "Tidy pass",
      description: `Return a small batch of the stalest memories for a quick keep / trim / forget review — the opt-in curation game. Read-only: it only suggests. Act on items with mindmap_promote (keep), mindmap_update (trim), or mindmap_forget.

Args: limit (number, default 5). Returns: stalest cold memories.`,
      inputSchema: {
        limit: z.number().int().min(1).max(20).default(5).describe("How many to review"),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit }) => {
      const cfg = await getConfig();
      const h = await health(cfg, Date.now());
      const batch = h.staleCandidates.slice(0, limit);
      if (batch.length === 0) return text(`Nothing to tidy — memory is clean. ✨`);
      const lines = [`# 🧹 Tidy ${batch.length} stale memor${batch.length === 1 ? "y" : "ies"}`, ``];
      for (const e of batch) {
        lines.push(`- **${e.title}** (\`${e.id}\`) — last used ${e.lastAccessedAt.slice(0, 10)}`);
        lines.push(`  ${e.trace}`);
        lines.push(`  → keep: mindmap_promote · trim: mindmap_update · forget: mindmap_forget`);
      }
      return result(lines.join("\n"), {
        count: batch.length,
        candidates: batch.map((e) => ({ id: e.id, title: e.title })),
      });
    },
  );

  // ------------------------------------------------------------------ config
  server.registerTool(
    "mindmap_config",
    {
      title: "View / change settings",
      description: `View or change Mind Map settings: decay windows, the promoted longevity factor, and the gamification toggle. Omit all args to just view current settings.

Args (all optional): hot_window_days, warm_window_days, promoted_longevity_factor, gamification.
Returns: the effective config.`,
      inputSchema: {
        hot_window_days: z.number().min(0).optional().describe("Days a thread stays hot"),
        warm_window_days: z.number().min(0).optional().describe("Days before warm→cold"),
        promoted_longevity_factor: z
          .number()
          .min(1)
          .optional()
          .describe("How much slower promoted memories decay"),
        gamification: z.boolean().optional().describe("Enable health/tidy surface"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ hot_window_days, warm_window_days, promoted_longevity_factor, gamification }) => {
      const day = 24 * 60 * 60 * 1000;
      const patch: Partial<Config> = {};
      if (hot_window_days !== undefined) patch.hotWindowMs = hot_window_days * day;
      if (warm_window_days !== undefined) patch.warmWindowMs = warm_window_days * day;
      if (promoted_longevity_factor !== undefined)
        patch.promotedLongevityFactor = promoted_longevity_factor;
      if (gamification !== undefined) patch.gamification = gamification;
      const cfg = Object.keys(patch).length ? await setConfig(patch) : await getConfig();
      const body = [
        `# Settings`,
        `- hot window: ${Math.round(cfg.hotWindowMs / day)} days`,
        `- warm window: ${Math.round(cfg.warmWindowMs / day)} days`,
        `- promoted longevity: ${cfg.promotedLongevityFactor}×`,
        `- gamification: ${cfg.gamification ? "on" : "off"}`,
      ].join("\n");
      return result(body, { ...cfg });
    },
  );

  // ----------------------------------------------------------------- persona
  const personaCategory = z.enum([
    "identity",
    "stack",
    "style",
    "communication",
    "constraints",
    "workflow",
    "goals",
  ]);

  server.registerTool(
    "mindmap_persona",
    {
      title: "Get user persona",
      description: `Return the user's persona — a distilled profile of how they work (stack, style, communication, constraints), so you can make aligned defaults and AVOID re-asking things they've already established.

CALL THIS PROACTIVELY at the start of a session before asking the user setup-style questions (their stack, preferences, conventions). Apply high-confidence facts silently; only ask when something needed isn't covered.

Args:
  - project (string, optional): include preferences scoped to this project on top of global ones.
Returns: an "About this user" block + fact count.`,
      inputSchema: { project: z.string().optional().describe("Current project name for scoped prefs") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ project }) => {
      const r = await renderPersona({ project });
      return result(r.text, { count: r.count });
    },
  );

  server.registerTool(
    "mindmap_persona_set",
    {
      title: "Record a user preference",
      description: `Save a durable preference about how the user works, so future sessions don't re-ask. Use this when the user states a lasting preference — "I prefer X", "always Y", "never Z", "I'm on macOS", "we use Postgres". (For saving a *discussion*, use mindmap_capture instead — this is for standing preferences.)

Args:
  - text (string): the preference, e.g. "Prefers concise, code-first answers"
  - category: identity | stack | style | communication | constraints | workflow | goals
  - polarity ('prefer'|'avoid'|'fact'): default 'prefer'
  - project (string, optional): scope to one project instead of global
Returns: the saved fact.`,
      inputSchema: {
        text: z.string().min(2).describe("The preference statement"),
        category: personaCategory.describe("Which dimension this preference is about"),
        polarity: z.enum(["prefer", "avoid", "fact"]).default("prefer").describe("prefer / avoid / fact"),
        project: z.string().optional().describe("Scope to a project (default: global)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ text, category, polarity, project }) => {
      const f = await setFact({
        text,
        category: category as PersonaCategory,
        polarity,
        scope: project ? `project:${project}` : "global",
      });
      return result(`Got it — recorded: "${f.text}" (${f.category}, ${f.scope}).`, {
        id: f.id,
        confidence: f.confidence,
      });
    },
  );

  server.registerTool(
    "mindmap_persona_forget",
    {
      title: "Forget a preference",
      description: `Remove or mute a persona fact (e.g. it's wrong or out of date). Get ids from mindmap_persona. Default mutes (recoverable); hard=true deletes.

Args: id (string), hard (boolean, default false). Returns: confirmation.`,
      inputSchema: {
        id: z.string().describe("Persona fact id"),
        hard: z.boolean().default(false).describe("Permanently delete instead of mute"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, hard }) => {
      const ok = await forgetFact(id, hard);
      return result(ok ? `${hard ? "Deleted" : "Muted"} persona fact ${id}.` : `No fact ${id}.`, {
        id,
        ok,
      });
    },
  );

  server.registerTool(
    "mindmap_persona_learn",
    {
      title: "Infer persona from memory",
      description: `Derive persona facts from your existing memories. If you've configured an LLM (mindmap_llm), it extracts richer facts — style, constraints, workflow; otherwise it runs a no-LLM keyword heuristic over your stack/tools. Either way, inferred facts get lower confidence than declared ones and never override what you've explicitly set.

Args: none. Returns: how many facts were added/updated and which path ran.`,
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async () => {
      const r = await inferWithLLM();
      const total = (await allFacts()).filter((f) => f.status === "active").length;
      return result(
        `Inferred from your memories (${r.usedLLM ? "LLM-assisted" : "no-LLM heuristic"}): +${r.added} new, ${r.updated} refreshed. ${total} active persona facts now.`,
        r,
      );
    },
  );

  // --------------------------------------------------------------- byo-key LLM
  server.registerTool(
    "mindmap_llm",
    {
      title: "Configure optional LLM (BYO key)",
      description: `Mind Map runs fully WITHOUT an LLM. This is opt-in: plug in your OWN provider to unlock smarter features (LLM-assisted persona inference, richer summaries).

Security: Mind Map stores only the provider + model name. It NEVER stores your API key — the key is read from your environment (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY; ollama needs none). Set the env var yourself.

Args (all optional — omit all to just see status):
  - provider: none | anthropic | openai | google | ollama
  - model: override the default model
  - baseUrl: for ollama / self-hosted (default http://localhost:11434)
Returns: current provider/model, whether it's ready, and a rough cost note.`,
      inputSchema: {
        provider: z.enum(["none", "anthropic", "openai", "google", "ollama"]).optional()
          .describe("LLM provider, or 'none' to disable"),
        model: z.string().optional().describe("Model name override"),
        baseUrl: z.string().optional().describe("Base URL for ollama / self-hosted"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ provider, model, baseUrl }) => {
      if (provider || model || baseUrl !== undefined) {
        await setSettings({
          ...(provider ? { provider: provider as ProviderName } : {}),
          ...(model ? { model } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        });
      }
      const st = await llmStatus();
      const est = estimateCost(st.provider, 1500, 400); // a typical persona-infer call
      const valid = PROVIDER_NAMES.join(", ");
      const body = [
        `**LLM:** ${st.provider}${st.provider === "none" ? "" : ` (${st.model})`}`,
        `**Ready:** ${st.ready ? "yes" : "no"} — ${st.note}`,
        st.provider === "none" ? "" : `**Est. per call:** ${est}`,
        `_Providers: ${valid}. Key comes from your environment; Mind Map never stores it._`,
      ].filter(Boolean).join("\n\n");
      return result(body, st);
    },
  );

  // ------------------------------------------------------------- glass-box audit
  server.registerTool(
    "mindmap_audit",
    {
      title: "Audit what's stored (glass-box)",
      description: `Show a transparent ledger of everything Mind Map knows — each memory's provenance (where it came from), trust (promote-on-reuse count), tier, last use, and when it will fade to a one-line trace. Use when the user asks "what do you know about me?", "what's stored?", or wants to review/clean their memory.

Args: limit (number, optional, default 30). Returns: the ledger rows.`,
      inputSchema: { limit: z.number().int().positive().max(500).default(30).describe("Max rows") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit }) => {
      const cfg = await getConfig();
      const rows = (await auditLedger(await allEntries(), getThread, cfg, Date.now())).slice(0, limit);
      const body = rows.length
        ? rows
            .map(
              (r) =>
                `• ${r.title}\n   ${r.provenance} · trust ${r.trust}× · ${r.tier} · ${r.fades} · used ${r.lastUsedDays}d ago`,
            )
            .join("\n")
        : "No memories stored yet.";
      return result(`Glass-box ledger (${rows.length}):\n\n${body}`, { rows });
    },
  );

  // --------------------------------------------------------------- passport
  server.registerTool(
    "mindmap_passport_export",
    {
      title: "Export memory passport",
      description: `Export all memories + persona to a single portable JSON file you own — to back up, move to another machine, or hand to a fork. This is your context, extractable.

Args: path (string, optional) — output file (default ~/mindmap-passport-<date>.json). Returns: the file path and counts.`,
      inputSchema: { path: z.string().optional().describe("Output file path") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
    },
    async ({ path: outPath }) => {
      const r = await exportPassport(outPath);
      return result(`Exported ${r.counts.memories} memories + ${r.counts.persona} persona facts to ${r.path}`, r);
    },
  );

  server.registerTool(
    "mindmap_passport_import",
    {
      title: "Import memory passport / data export",
      description: `Bring context IN. Either a Mind Map passport file (from another machine), or pull your conversations OUT of a walled garden by pointing at its exported data file:
  - kind 'passport' (default): a Mind Map passport JSON
  - kind 'chatgpt': ChatGPT's exported conversations.json
  - kind 'claude': Claude.ai's exported conversations.json
The cloud chats themselves can't be reached live, but their EXPORT FILES are yours — this imports them as distilled memories.

Args: file (string, required), kind ('passport'|'chatgpt'|'claude', default 'passport'). Returns: import counts.`,
      inputSchema: {
        file: z.string().describe("Path to the file to import"),
        kind: z.enum(["passport", "chatgpt", "claude"]).default("passport").describe("File kind"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ file, kind }) => {
      if (kind === "passport") {
        const r = await importPassport(file);
        return result(
          `Imported ${r.memories.imported} memories (${r.memories.skippedDup} dup) + persona +${r.persona.added}/${r.persona.updated}.`,
          { ...r },
        );
      }
      const r = await importExport(kind, file);
      return result(`Imported ${r.imported} of ${r.total} ${kind} conversations (${r.skippedDup} already present).`, { ...r });
    },
  );

  // ----------------------------------------------------- persona projection
  server.registerTool(
    "mindmap_persona_sync",
    {
      title: "Write persona into your tools",
      description: `Project the user's persona into the native instruction files of their AI tools (Claude CLAUDE.md, Cursor rules, Copilot instructions, Windsurf rules), so even non-MCP tools know how they work — from one source. Writes only inside a managed block; never clobbers the user's own content. By default writes the global Claude config + any detected project tools.

Args:
  - targets (string[], optional): specific target ids (claude-global, claude-project, cursor, copilot, windsurf)
  - force (boolean, optional): write even if a tool isn't detected
Returns: per-target outcomes.`,
      inputSchema: {
        targets: z.array(z.string()).optional().describe("Target ids to write"),
        force: z.boolean().default(false).describe("Write even if tool not detected"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ targets: only, force }) => {
      const detected = await detectTargets(process.cwd());
      const r = await syncPersona({ only, force });
      const wrote = r.outcomes.filter((o) => o.action === "created" || o.action === "updated");
      const body =
        `Persona synced (project: ${r.project}).\n` +
        r.outcomes.map((o) => `  ${o.action === "skipped" ? "–" : "✓"} ${o.id}: ${o.action}${o.reason ? ` (${o.reason})` : ""}`).join("\n") +
        `\n\nDetected tools: ${detected.filter((d) => d.present).map((d) => d.id).join(", ") || "none"}.`;
      return result(body, { ...r, wrote: wrote.length });
    },
  );
}

function scoreBar(pct: number): string {
  const filled = Math.round(pct / 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

/** Re-export for the background pruner in index.ts. */
export type { Tier };
