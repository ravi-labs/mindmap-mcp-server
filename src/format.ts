/** Human-readable (markdown) formatting helpers shared across tools. */

import { CHARACTER_LIMIT } from "./constants.js";
import { type IndexEntry, type Thread } from "./types.js";

const TIER_ICON: Record<string, string> = { hot: "🔥", warm: "🌤️", cold: "❄️" };
const STATUS_ICON: Record<string, string> = {
  captured: "•",
  promoted: "★",
  archived: "🗄️",
};

export function truncate(text: string): string {
  if (text.length <= CHARACTER_LIMIT) return text;
  return (
    text.slice(0, CHARACTER_LIMIT) +
    `\n\n…[truncated ${text.length - CHARACTER_LIMIT} chars — narrow your query or use filters]`
  );
}

export function formatThread(t: Thread): string {
  const lines: string[] = [];
  lines.push(`# ${TIER_ICON[t.tier] ?? ""} ${t.title}  (${t.id})`);
  lines.push(
    `${STATUS_ICON[t.status]} ${t.status} · tier: ${t.tier} · source: ${t.source} · used ${t.accessCount}×`,
  );
  if (t.tags.length) lines.push(`tags: ${t.tags.map((x) => `#${x}`).join(" ")}`);
  lines.push("");
  if (t.status === "archived" || t.tier === "cold") {
    lines.push(`> ${t.trace}`);
    lines.push("");
    lines.push("_(cold — full summary retained below)_");
    lines.push("");
  }
  lines.push("## Summary");
  lines.push(t.summary.trim() || "_(empty)_");
  if (t.keyPoints.length) {
    lines.push("");
    lines.push("## Key points");
    for (const p of t.keyPoints) lines.push(`- ${p}`);
  }
  if (t.links.length) {
    lines.push("");
    lines.push(`## Linked threads`);
    for (const id of t.links) lines.push(`- ${id}`);
  }
  lines.push("");
  lines.push(
    `_created ${short(t.createdAt)} · updated ${short(t.updatedAt)} · last used ${short(t.lastAccessedAt)}_`,
  );
  return lines.join("\n");
}

export function formatList(entries: IndexEntry[], heading: string): string {
  if (entries.length === 0) return `${heading}\n\n_No matching memories._`;
  const lines = [heading, ""];
  for (const e of entries) {
    const icon = TIER_ICON[e.tier] ?? "";
    const star = e.status === "promoted" ? "★ " : "";
    lines.push(`- ${icon} **${star}${e.title}** (${e.id}) — ${e.trace || "…"}`);
    const meta = [`${e.source}`, `${e.tier}`, `used ${e.accessCount}×`];
    if (e.tags.length) meta.push(e.tags.map((t) => `#${t}`).join(" "));
    lines.push(`  _${meta.join(" · ")}_`);
  }
  return lines.join("\n");
}

function short(iso: string): string {
  return iso.slice(0, 10);
}
