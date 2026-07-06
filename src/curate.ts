/**
 * Curation — read across ALL your memories and propose collections for you.
 *
 * Filing memory by hand is work. This does the first pass: it scans every
 * captured session and suggests groups — "apps you started and never finished",
 * goals, decisions, parked ideas — so you accept a ready-made organization
 * instead of building it click by click.
 *
 * Two engines, same shape (mirrors persona inference):
 *   - LLM  : if you've plugged in your own key, it reads the corpus digest and
 *            buckets memories into meaningful, named collections. Honors a free
 *            `focus` ("the apps I abandoned", "everything about billing").
 *   - HEURISTIC : no key needed. Keyword + lifecycle detectors for the common
 *            buckets. Lower precision, so everything is a *suggestion* you review
 *            before it's filed — the detectors err toward recall on purpose.
 */

import { addToCollection, createCollection, listCollections, slug } from "./collections.js";
import { complete, isReady } from "./llm.js";
import { allEntries } from "./store.js";
import { type IndexEntry } from "./types.js";

export interface CuratedCollection {
  name: string;
  emoji: string;
  /** One line on why these belong together — shown before the user accepts. */
  rationale: string;
  items: { id: string; title: string }[];
}

export interface CurateResult {
  suggestions: CuratedCollection[];
  usedLlm: boolean;
  scanned: number;
}

const DAY = 24 * 60 * 60 * 1000;

function hay(e: IndexEntry): string {
  return `${e.title} ${e.trace} ${(e.tags || []).join(" ")}`.toLowerCase();
}
function has(text: string, words: string[]): boolean {
  return words.some((w) => text.includes(w));
}

// Signals that a memory is about *building something*.
const BUILD_WORDS = [
  "app", "application", "web app", "webapp", "website", " site", "project",
  "prototype", "poc", "mvp", "service", " api", "bot", "extension", "plugin",
  "game", "dashboard", "platform", "clone", "saas", "tool", "cli", "library",
  "scaffold", "boilerplate", "starter",
];
const START_WORDS = [
  "build", "building", "built", "start", "started", "create", "creating",
  "new ", "implement", "bootstrap", "spin up", "set up", "setup", "kick off",
];
// Signals the *project* actually shipped — disqualifies "unfinished". Kept
// project-level on purpose: a finished subtask ("popup done") must NOT count.
const DONE_WORDS = [
  "shipped", "launched", "released", "deployed", "in production", "went live",
  "now live", "go-live", "published to", "released to", "shipped to",
  "finished the", "completed the", "wrapped up", "fully working", "in prod",
];
const DECISION_WORDS = [
  "decided", "decision", "we'll use", "we will use", "going with", "chose ",
  "choose ", "settled on", "agreed to", "picked ", "trade-off", "tradeoff",
];
const GOAL_WORDS = [
  "goal", "want to build", "plan to", "planning to", "roadmap", "aspire",
  "someday", "would like to", "next quarter", "objective", "milestone",
];
const PARK_WORDS = [
  "later", "someday", "backlog", "revisit", "on hold", "parked", "defer",
  "deferred", "icebox", "maybe", "nice to have", "future", "todo", "to-do",
];

function stale(e: IndexEntry, now: number): boolean {
  if (e.tier === "cold") return true;
  return now - new Date(e.lastAccessedAt).getTime() > 30 * DAY;
}

/** The centerpiece: things you started building and appear to have dropped. */
function detectUnfinished(entries: IndexEntry[], now: number): CuratedCollection | null {
  const items = entries
    .filter((e) => e.status !== "archived")
    .filter((e) => {
      const t = hay(e);
      const aboutBuilding = has(t, BUILD_WORDS) && (has(t, START_WORDS) || has(t, BUILD_WORDS));
      if (!aboutBuilding) return false;
      if (has(t, DONE_WORDS)) return false; // looks finished
      if (!stale(e, now)) return false; // still active — not abandoned
      if (e.accessCount > 4) return false; // kept coming back → probably ongoing
      return true;
    })
    .map((e) => ({ id: e.id, title: e.title }));
  if (items.length < 2) return null;
  return {
    name: "Unfinished projects",
    emoji: "🚧",
    rationale: `${items.length} things you started building but haven't touched or shipped in a while.`,
    items,
  };
}

function detectByWords(
  entries: IndexEntry[],
  words: string[],
  name: string,
  emoji: string,
  rationale: string,
  cap = 40,
): CuratedCollection | null {
  const items = entries
    .filter((e) => e.status !== "archived" && has(hay(e), words))
    .slice(0, cap)
    .map((e) => ({ id: e.id, title: e.title }));
  if (items.length < 2) return null;
  return { name, emoji, rationale, items };
}

function heuristicCurate(entries: IndexEntry[], now: number): CuratedCollection[] {
  const out: CuratedCollection[] = [];
  const unfinished = detectUnfinished(entries, now);
  if (unfinished) out.push(unfinished);
  const decisions = detectByWords(entries, DECISION_WORDS, "Decisions", "✅", "Choices and trade-offs you settled on.");
  if (decisions) out.push(decisions);
  const goals = detectByWords(entries, GOAL_WORDS, "Goals", "🎯", "Things you said you want to build or reach.");
  if (goals) out.push(goals);
  const parked = detectByWords(entries, PARK_WORDS, "Parking Lot", "🅿️", "Ideas you explicitly pushed to later.");
  if (parked) out.push(parked);
  return out;
}

async function llmCurate(
  entries: IndexEntry[],
  focus: string | undefined,
): Promise<CuratedCollection[]> {
  // Index-referenced digest — the model echoes indices, we map back to ids
  // (more robust than asking it to reproduce 8-char hex ids verbatim).
  const scan = entries.filter((e) => e.status !== "archived").slice(0, 120);
  const digest = scan
    .map((e, i) => {
      const age = e.tier;
      const ws = e.workspace ? ` @${e.workspace.split("/").filter(Boolean).pop()}` : "";
      return `[${i + 1}] (${age}${ws}) ${e.title}${e.trace ? ` :: ${e.trace}` : ""}`;
    })
    .join("\n");

  const sys =
    "You organize a developer's memory of past AI-tool sessions into COLLECTIONS. " +
    "Each memory is one line: [index] (tier@workspace) title :: trace. " +
    "Return ONLY a JSON array of objects {name, emoji, rationale, items} where " +
    "items is an array of the integer indices that belong in that collection. " +
    "Aim for a few high-signal collections. Always look for: apps/projects the " +
    "user STARTED but never finished (started building, went cold, no ship/launch " +
    "signal), Goals, Decisions, and a Parking Lot of deferred ideas. A memory may " +
    "appear in more than one. Keep names short; pick a fitting emoji; rationale is " +
    "one sentence. Omit a collection if fewer than 2 memories fit.";
  const focusLine = focus
    ? `\n\nThe user especially wants: "${focus}". Make that one of the collections if the memories support it.`
    : "";

  const out = await complete(`Memories:\n${digest}${focusLine}\n\nReturn the JSON array.`, {
    system: sys,
    maxTokens: 1500,
  });
  const lo = out.indexOf("[");
  const hi = out.lastIndexOf("]");
  if (lo < 0 || hi < lo) throw new Error("no JSON array in LLM response");
  const arr = JSON.parse(out.slice(lo, hi + 1)) as {
    name?: string;
    emoji?: string;
    rationale?: string;
    items?: number[];
  }[];

  const suggestions: CuratedCollection[] = [];
  for (const c of arr) {
    if (!c.name || !Array.isArray(c.items)) continue;
    const items = c.items
      .map((idx) => scan[idx - 1])
      .filter((e): e is IndexEntry => Boolean(e))
      .map((e) => ({ id: e.id, title: e.title }));
    // dedup by id, keep order
    const seen = new Set<string>();
    const deduped = items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
    if (deduped.length < 2) continue;
    suggestions.push({
      name: c.name.trim(),
      emoji: c.emoji || "📁",
      rationale: (c.rationale || "").trim(),
      items: deduped,
    });
  }
  return suggestions;
}

/**
 * Analyze the whole corpus and propose collections. Never writes anything —
 * call {@link applyCuration} to actually file the accepted suggestions.
 */
export async function curate(
  opts: { focus?: string; now?: number } = {},
): Promise<CurateResult> {
  const entries = await allEntries();
  const now = opts.now ?? Date.now();
  if (await isReady()) {
    try {
      const suggestions = await llmCurate(entries, opts.focus);
      if (suggestions.length) return { suggestions, usedLlm: true, scanned: entries.length };
      // LLM returned nothing usable — fall through to heuristic.
    } catch {
      // graceful fallback
    }
  }
  return { suggestions: heuristicCurate(entries, now), usedLlm: false, scanned: entries.length };
}

/** File accepted suggestions into collections (create + add). Idempotent-ish. */
export async function applyCuration(
  suggestions: CuratedCollection[],
): Promise<{ created: number; filed: number }> {
  const existing = new Set((await listCollections()).map((c) => c.id));
  let created = 0;
  let filed = 0;
  for (const s of suggestions) {
    if (!existing.has(slug(s.name))) created += 1;
    const before = (await createCollection(s.name, { emoji: s.emoji })).items.length;
    const c = await addToCollection(s.name, s.items.map((i) => i.id));
    filed += Math.max(0, c.items.length - before);
  }
  return { created, filed };
}
