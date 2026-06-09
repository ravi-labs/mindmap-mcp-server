/**
 * BYO-key LLM layer — optional, vendor-neutral, opt-in.
 *
 * Mind Map works fully without any LLM. This layer lets a user plug in their
 * OWN key to unlock smarter features (e.g. LLM-assisted persona inference,
 * richer summaries). Design rules:
 *   - VENDOR-NEUTRAL : anthropic | openai | google | ollama | none.
 *   - OPT-IN         : provider defaults to "none"; nothing calls out silently.
 *   - GRACEFUL       : if the provider/key is missing or a call fails, callers
 *                      fall back to the no-LLM path. Never hard-fail a feature.
 *   - NO STORED KEYS : we persist provider + model only (~/.mindmap/llm.json).
 *                      The API key is read from the ENVIRONMENT, never written
 *                      to disk by Mind Map. (Local credential hygiene.)
 *   - HONEST COST    : we show a rough, clearly-labelled "just an estimate"
 *                      figure — no metering, no real billing.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./constants.js";

const LLM_FILE = path.join(DATA_DIR, "llm.json");

export type ProviderName = "none" | "anthropic" | "openai" | "google" | "ollama";

export interface LLMSettings {
  provider: ProviderName;
  model: string;
  /** For ollama / self-hosted gateways. */
  baseUrl?: string;
}

interface ProviderMeta {
  /** Default model when the user doesn't pick one. */
  defaultModel: string;
  /** Env var that supplies the key (none for local ollama). */
  keyEnv: string | null;
  /** Rough USD per 1M tokens — for the estimate only. */
  rate: { in: number; out: number };
}

const PROVIDERS: Record<Exclude<ProviderName, "none">, ProviderMeta> = {
  anthropic: { defaultModel: "claude-sonnet-4-6", keyEnv: "ANTHROPIC_API_KEY", rate: { in: 3, out: 15 } },
  openai: { defaultModel: "gpt-4o", keyEnv: "OPENAI_API_KEY", rate: { in: 2.5, out: 10 } },
  google: { defaultModel: "gemini-1.5-pro", keyEnv: "GOOGLE_API_KEY", rate: { in: 1.25, out: 5 } },
  ollama: { defaultModel: "llama3.1", keyEnv: null, rate: { in: 0, out: 0 } },
};

const DEFAULT_SETTINGS: LLMSettings = { provider: "none", model: "" };

export async function getSettings(): Promise<LLMSettings> {
  try {
    const raw = JSON.parse(await fs.readFile(LLM_FILE, "utf8")) as Partial<LLMSettings>;
    return { ...DEFAULT_SETTINGS, ...raw, provider: (raw.provider ?? "none") as ProviderName };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Set provider/model. Does NOT touch keys — those stay in the environment. */
export async function setSettings(patch: Partial<LLMSettings>): Promise<LLMSettings> {
  const cur = await getSettings();
  const provider = (patch.provider ?? cur.provider) as ProviderName;
  const next: LLMSettings = {
    provider,
    model:
      patch.model ??
      (provider !== "none" && (!cur.model || patch.provider) ? PROVIDERS[provider].defaultModel : cur.model),
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl } : cur.baseUrl ? { baseUrl: cur.baseUrl } : {}),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LLM_FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** The key for the active provider, read from the environment (never stored). */
function keyFor(provider: ProviderName): string | undefined {
  if (provider === "none") return undefined;
  const env = PROVIDERS[provider].keyEnv;
  return env ? process.env[env] : undefined;
}

/** Is an LLM actually usable right now? (provider chosen + key present if needed) */
export async function isReady(s?: LLMSettings): Promise<boolean> {
  const cfg = s ?? (await getSettings());
  if (cfg.provider === "none") return false;
  if (cfg.provider === "ollama") return true; // local, no key
  return Boolean(keyFor(cfg.provider));
}

/** Human-readable status for `mindmap_config` / dashboard. */
export async function status(): Promise<{ provider: ProviderName; model: string; ready: boolean; note: string }> {
  const s = await getSettings();
  const ready = await isReady(s);
  let note: string;
  if (s.provider === "none") note = "LLM features off. Pick a provider to enable them.";
  else if (ready) note = `Using your ${s.provider} key from the environment.`;
  else note = `Provider is ${s.provider} but ${PROVIDERS[s.provider as Exclude<ProviderName, "none">].keyEnv} isn't set — features fall back to no-LLM.`;
  return { provider: s.provider, model: s.model || "(default)", ready, note };
}

/** Rough, clearly-labelled cost estimate. NOT billing. */
export function estimateCost(provider: ProviderName, tokensIn: number, tokensOut: number): string {
  if (provider === "none") return "no LLM — $0";
  const r = PROVIDERS[provider as Exclude<ProviderName, "none">].rate;
  const usd = (tokensIn / 1e6) * r.in + (tokensOut / 1e6) * r.out;
  if (usd === 0) return "~$0 (local model) — just an estimate";
  const shown = usd < 0.01 ? "<$0.01" : `~$${usd.toFixed(usd < 1 ? 3 : 2)}`;
  return `${shown} — just an estimate (rough public rates, not a bill)`;
}

export class LLMUnavailable extends Error {}

/**
 * Single completion. Returns text, or throws LLMUnavailable so callers can
 * gracefully fall back. Uses global fetch (Node 18+); no SDK dependencies.
 */
export async function complete(
  prompt: string,
  opts: { system?: string; maxTokens?: number } = {},
): Promise<string> {
  const s = await getSettings();
  if (!(await isReady(s))) throw new LLMUnavailable(`LLM not configured (provider: ${s.provider})`);
  const provider = s.provider as Exclude<ProviderName, "none">;
  const model = s.model || PROVIDERS[provider].defaultModel;
  const key = keyFor(provider);
  const maxTokens = opts.maxTokens ?? 1024;

  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key!, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(opts.system ? { system: opts.system } : {}),
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!res.ok) throw new LLMUnavailable(`anthropic ${res.status}`);
      const j = (await res.json()) as { content?: { text?: string }[] };
      return j.content?.map((c) => c.text ?? "").join("") ?? "";
    }
    if (provider === "openai") {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [
            ...(opts.system ? [{ role: "system", content: opts.system }] : []),
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new LLMUnavailable(`openai ${res.status}`);
      const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    }
    if (provider === "google") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}),
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      if (!res.ok) throw new LLMUnavailable(`google ${res.status}`);
      const j = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    }
    // ollama (local)
    const base = s.baseUrl || "http://localhost:11434";
    const res = await fetch(`${base}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
        stream: false,
        options: { num_predict: maxTokens },
      }),
    });
    if (!res.ok) throw new LLMUnavailable(`ollama ${res.status}`);
    const j = (await res.json()) as { response?: string };
    return j.response ?? "";
  } catch (err) {
    if (err instanceof LLMUnavailable) throw err;
    throw new LLMUnavailable(`${provider} call failed: ${(err as Error).message}`);
  }
}

export const PROVIDER_NAMES: ProviderName[] = ["none", "anthropic", "openai", "google", "ollama"];
