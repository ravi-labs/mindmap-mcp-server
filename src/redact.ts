/**
 * Secret redaction — keep credentials out of stored memory.
 *
 * Memories live as plain files in ~/.mindmap, and IMPORTS can drag in API keys
 * or tokens that were pasted into past sessions. Before anything is persisted we
 * scan for common secret shapes and mask them, so a captured/imported memory
 * never quietly becomes a plaintext credential on disk (which other tools, or
 * persona projection, could then read). Local, regex-based, no LLM, no network.
 *
 * This is best-effort, not a vault: it catches well-known token formats, not
 * every possible secret. It deliberately errs toward masking.
 */

import { type Thread } from "./types.js";

interface SecretRule {
  label: string;
  re: RegExp;
}

// Order matters a little (more specific first). All are global+multiline.
const RULES: SecretRule[] = [
  { label: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { label: "github-token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}/g },
  { label: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g },
  { label: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}/g },
  { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { label: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { label: "private-key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Generic "Authorization: Bearer <token>" — mask the token, keep the header.
  { label: "bearer-token", re: /\b([Bb]earer\s+)[A-Za-z0-9._~+/=-]{20,}/g },
];

function maskRule(input: string, rule: SecretRule): { out: string; n: number } {
  let n = 0;
  const out = input.replace(rule.re, (m, ...args) => {
    n += 1;
    // bearer-token has a capture group (the "Bearer " prefix) to preserve.
    const prefix = typeof args[0] === "string" ? args[0] : "";
    return `${prefix}[REDACTED:${rule.label}]`;
  });
  return { out, n };
}

/** Mask any detected secrets in a string. Returns the redacted text + count. */
export function redactText(input: string): { text: string; count: number } {
  if (!input) return { text: input, count: 0 };
  let text = input;
  let count = 0;
  for (const rule of RULES) {
    const { out, n } = maskRule(text, rule);
    text = out;
    count += n;
  }
  return { text, count };
}

/** True if the string contains anything that looks like a secret. */
export function hasSecret(input: string): boolean {
  return redactText(input).count > 0;
}

/**
 * Redact a thread's user-content fields in place (title, summary, key points,
 * trace). Returns how many secrets were masked; sets `thread.redacted` when > 0.
 */
export function redactThread(thread: Thread): number {
  let count = 0;
  const t = redactText(thread.title);
  thread.title = t.text;
  count += t.count;

  const s = redactText(thread.summary);
  thread.summary = s.text;
  count += s.count;

  const tr = redactText(thread.trace);
  thread.trace = tr.text;
  count += tr.count;

  if (Array.isArray(thread.keyPoints)) {
    thread.keyPoints = thread.keyPoints.map((p) => {
      const r = redactText(p);
      count += r.count;
      return r.text;
    });
  }

  if (count > 0) thread.redacted = true;
  return count;
}
