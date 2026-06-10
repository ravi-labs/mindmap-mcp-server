/**
 * The Persona layer — a distilled, evolving profile of the user that any tool
 * can read to make aligned decisions and ask fewer questions.
 *
 * Distinct from memories (which record discussions): persona facts record *how
 * the user works* — stack, style, communication, constraints. Built two ways,
 * both local/no-LLM in v1:
 *   - DECLARED  : the user states a preference ("I prefer TypeScript").
 *   - INFERRED  : a heuristic pass over existing memories (keyword frequency).
 * (LLM-assisted inference is the next, opt-in/BYO-key step.)
 *
 * Confidence + scope (global / project) let tools gate what they apply
 * silently vs. ask about. Stored locally in ~/.mindmap/persona.json.
 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./constants.js";
import { complete, isReady } from "./llm.js";
import { allEntries } from "./store.js";

const PERSONA_FILE = path.join(DATA_DIR, "persona.json");

export type PersonaCategory =
  | "identity"
  | "stack"
  | "style"
  | "communication"
  | "constraints"
  | "workflow"
  | "goals";

export interface PersonaFact {
  id: string;
  category: PersonaCategory;
  text: string;
  polarity: "prefer" | "avoid" | "fact";
  source: "declared" | "inferred" | "confirmed";
  confidence: number; // 0..1
  scope: string; // "global" or "project:<name>"
  evidence: string[]; // thread ids / notes that justify it
  observations: number;
  createdAt: string;
  lastObservedAt: string;
  status: "active" | "muted";
}

const CATEGORY_ORDER: PersonaCategory[] = [
  "identity",
  "stack",
  "constraints",
  "style",
  "communication",
  "workflow",
  "goals",
];

function nowIso(): string {
  return new Date().toISOString();
}

async function load(): Promise<PersonaFact[]> {
  try {
    return JSON.parse(await fs.readFile(PERSONA_FILE, "utf8")) as PersonaFact[];
  } catch {
    return [];
  }
}

async function save(facts: PersonaFact[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${PERSONA_FILE}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(facts, null, 2), "utf8");
  await fs.rename(tmp, PERSONA_FILE);
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Declare (or reinforce) a fact. Re-declaring an existing one bumps confidence. */
export async function setFact(input: {
  text: string;
  category: PersonaCategory;
  polarity?: PersonaFact["polarity"];
  scope?: string;
}): Promise<PersonaFact> {
  const facts = await load();
  const scope = input.scope || "global";
  const existing = facts.find(
    (f) => f.scope === scope && norm(f.text) === norm(input.text),
  );
  const now = nowIso();
  if (existing) {
    existing.observations += 1;
    existing.confidence = Math.min(1, existing.confidence + 0.05);
    existing.source = "declared";
    existing.status = "active";
    existing.lastObservedAt = now;
    await save(facts);
    return existing;
  }
  const fact: PersonaFact = {
    id: randomUUID().slice(0, 8),
    category: input.category,
    text: input.text.trim(),
    polarity: input.polarity || "prefer",
    source: "declared",
    confidence: 0.9,
    scope,
    evidence: [],
    observations: 1,
    createdAt: now,
    lastObservedAt: now,
    status: "active",
  };
  facts.push(fact);
  await save(facts);
  return fact;
}

export async function forgetFact(id: string, hard: boolean): Promise<boolean> {
  const facts = await load();
  const i = facts.findIndex((f) => f.id === id);
  if (i < 0) return false;
  if (hard) facts.splice(i, 1);
  else facts[i].status = "muted";
  await save(facts);
  return true;
}

export async function allFacts(): Promise<PersonaFact[]> {
  return load();
}

/**
 * Merge in facts from elsewhere (a passport import). Dedup by scope + text;
 * an incoming fact bumps confidence on a match, otherwise it's added with a
 * fresh id so it can't collide with a local one.
 */
export async function mergeFacts(incoming: PersonaFact[]): Promise<{ added: number; updated: number }> {
  const facts = await load();
  let added = 0;
  let updated = 0;
  const now = nowIso();
  for (const inc of incoming) {
    if (!inc || typeof inc.text !== "string" || !inc.category) continue;
    const scope = inc.scope || "global";
    const match = facts.find((f) => f.scope === scope && norm(f.text) === norm(inc.text));
    if (match) {
      match.confidence = Math.max(match.confidence, inc.confidence ?? match.confidence);
      match.lastObservedAt = now;
      updated += 1;
    } else {
      facts.push({
        ...inc,
        id: randomUUID().slice(0, 8),
        scope,
        status: inc.status === "muted" ? "muted" : "active",
        lastObservedAt: inc.lastObservedAt || now,
        createdAt: inc.createdAt || now,
      });
      added += 1;
    }
  }
  await save(facts);
  return { added, updated };
}

// --- Heuristic inference (no LLM) ------------------------------------------

/** Stack/tool terms worth surfacing as inferred facts when they recur. */
const STACK_TERMS = [
  "typescript", "javascript", "python", "go", "golang", "rust", "java", "kotlin",
  "react", "angular", "vue", "svelte", "next", "nextjs", "express", "fastapi",
  "django", "flask", "spring", "node", "nodejs", "deno", "bun",
  "postgres", "postgresql", "mysql", "mongodb", "sqlite", "redis", "dynamodb",
  "docker", "kubernetes", "k8s", "terraform", "aws", "gcp", "azure", "vercel",
  "tailwind", "graphql", "rest", "grpc", "pnpm", "npm", "yarn", "vite", "webpack",
  "claude", "openai", "anthropic", "mcp", "llm", "agent",
];

/** Build inferred 'stack' facts from terms that recur across memories. */
export async function inferFromMemories(): Promise<{ added: number; updated: number }> {
  const entries = await allEntries();
  const counts = new Map<string, number>();
  const ev = new Map<string, string[]>();
  const set = new Set(STACK_TERMS);
  for (const e of entries) {
    if (e.status === "archived") continue;
    const seen = new Set<string>();
    for (const tok of (e.title + " " + (e.trace || "") + " " + e.tags.join(" "))
      .toLowerCase()
      .split(/[^a-z0-9]+/)) {
      if (set.has(tok) && !seen.has(tok)) {
        seen.add(tok);
        counts.set(tok, (counts.get(tok) ?? 0) + 1);
        const arr = ev.get(tok) ?? [];
        if (arr.length < 5) arr.push(e.id);
        ev.set(tok, arr);
      }
    }
  }

  const facts = await load();
  let added = 0;
  let updated = 0;
  const now = nowIso();
  for (const [term, count] of counts) {
    if (count < 3) continue; // needs to recur to be a real signal
    const text = `Works with ${term}`;
    const confidence = Math.min(0.7, 0.3 + count * 0.04);
    const existing = facts.find((f) => f.scope === "global" && norm(f.text) === norm(text));
    if (existing) {
      // don't override a declared fact; just refresh inferred ones
      if (existing.source !== "declared") {
        existing.observations = count;
        existing.confidence = Math.max(existing.confidence, confidence);
        existing.evidence = ev.get(term) ?? existing.evidence;
        existing.lastObservedAt = now;
        updated += 1;
      }
    } else {
      facts.push({
        id: randomUUID().slice(0, 8),
        category: "stack",
        text,
        polarity: "fact",
        source: "inferred",
        confidence,
        scope: "global",
        evidence: ev.get(term) ?? [],
        observations: count,
        createdAt: now,
        lastObservedAt: now,
        status: "active",
      });
      added += 1;
    }
  }
  await save(facts);
  return { added, updated };
}

/**
 * LLM-assisted inference (opt-in, BYO key). Extracts richer persona facts —
 * style, constraints, workflow — that keyword counting can't see. Falls back
 * to the heuristic pass if no LLM is configured or the call fails.
 */
export async function inferWithLLM(): Promise<{ added: number; updated: number; usedLLM: boolean }> {
  if (!(await isReady())) return { ...(await inferFromMemories()), usedLLM: false };
  try {
    const entries = (await allEntries()).filter((e) => e.status !== "archived").slice(0, 80);
    const corpus = entries
      .map((e) => `- ${e.title}${e.trace ? ` :: ${e.trace}` : ""}`)
      .join("\n");
    const sys =
      "You extract a user's DURABLE working profile from their memory titles. " +
      "Output ONLY a JSON array of objects {category, text, polarity}. " +
      "category ∈ identity|stack|style|communication|constraints|workflow|goals. " +
      "polarity ∈ prefer|avoid|fact. Be conservative: include only preferences clearly " +
      "evidenced across multiple entries. Phrase each as a short profile statement. Max 10.";
    const out = await complete(`Memories:\n${corpus}\n\nReturn the JSON array.`, {
      system: sys,
      maxTokens: 800,
    });
    const lo = out.indexOf("[");
    const hi = out.lastIndexOf("]");
    if (lo < 0 || hi < lo) throw new Error("no JSON array in response");
    const arr = JSON.parse(out.slice(lo, hi + 1)) as {
      category?: PersonaCategory;
      text?: string;
      polarity?: PersonaFact["polarity"];
    }[];
    const facts = await load();
    let added = 0;
    let updated = 0;
    const now = nowIso();
    const valid = new Set(CATEGORY_ORDER);
    for (const item of arr) {
      if (!item.text || !item.category || !valid.has(item.category)) continue;
      const existing = facts.find((f) => f.scope === "global" && norm(f.text) === norm(item.text!));
      if (existing) {
        if (existing.source !== "declared") {
          existing.confidence = Math.max(existing.confidence, 0.6);
          existing.lastObservedAt = now;
          updated += 1;
        }
      } else {
        facts.push({
          id: randomUUID().slice(0, 8),
          category: item.category,
          text: item.text.trim(),
          polarity: item.polarity ?? "fact",
          source: "inferred",
          confidence: 0.6,
          scope: "global",
          evidence: [],
          observations: 1,
          createdAt: now,
          lastObservedAt: now,
          status: "active",
        });
        added += 1;
      }
    }
    await save(facts);
    return { added, updated, usedLLM: true };
  } catch {
    return { ...(await inferFromMemories()), usedLLM: false };
  }
}

// --- Rendering (what a tool injects) ---------------------------------------

const POLARITY_PREFIX: Record<PersonaFact["polarity"], string> = {
  prefer: "Prefers",
  avoid: "Avoids",
  fact: "",
};

/**
 * Render the "About this user" block a tool injects at session start. Merges
 * global + the current project's facts, gated by confidence, grouped by category.
 */
export async function renderPersona(opts: {
  project?: string;
  minConfidence?: number;
} = {}): Promise<{ text: string; count: number }> {
  const min = opts.minConfidence ?? 0.5;
  const projScope = opts.project ? `project:${opts.project}` : null;
  const facts = (await load()).filter(
    (f) =>
      f.status === "active" &&
      f.confidence >= min &&
      (f.scope === "global" || (projScope && f.scope === projScope)),
  );
  if (facts.length === 0) {
    return { text: "No persona facts yet. Tell me a preference and I'll remember it.", count: 0 };
  }

  const lines = ["# About this user"];
  for (const cat of CATEGORY_ORDER) {
    const inCat = facts
      .filter((f) => f.category === cat)
      .sort((a, b) => b.confidence - a.confidence);
    if (inCat.length === 0) continue;
    lines.push("", `## ${cat[0].toUpperCase()}${cat.slice(1)}`);
    for (const f of inCat) {
      const prefix = POLARITY_PREFIX[f.polarity];
      const body = prefix ? `${prefix} ${f.text.replace(/^(prefers?|avoids?)\s+/i, "")}` : f.text;
      const tag = f.source === "inferred" ? ` _(inferred, ${f.observations}×)_` : "";
      const scope = f.scope.startsWith("project:") ? ` _[${f.scope.slice(8)}]_` : "";
      lines.push(`- ${body}${tag}${scope}`);
    }
  }
  lines.push("", "_If a preference you need isn't here, ask once — it'll be remembered._");
  return { text: lines.join("\n"), count: facts.length };
}
