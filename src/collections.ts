/**
 * Collections — the user-organization layer on top of the automatic one.
 *
 * Mind Map organizes memory automatically (tiers, source, topic graph,
 * workspace). Collections let a user *also* group memories however they like —
 * Goals, Parking Lot, anything — as named, ordered, many-to-many groups. This is
 * optional sugar: the tool works fully without it.
 *
 * Key tie-in with the forgetting model: a memory filed into a **pinned**
 * collection resists decay (never drops below warm). Otherwise a "parking lot"
 * that quietly empties itself would be useless — deliberate organization is a
 * signal of importance, just like promote-on-reuse.
 *
 * Source of truth: ~/.mindmap/collections.json. Membership is stored here (not on
 * the threads), so ordering + collection metadata live in one place.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./constants.js";

const COLLECTIONS_FILE = path.join(DATA_DIR, "collections.json");

export interface Collection {
  id: string; // slug of the name
  name: string;
  emoji?: string;
  /** Members resist decay (never fall below warm). */
  pinned: boolean;
  createdAt: string;
  /** Ordered thread ids. */
  items: string[];
}

interface Store {
  collections: Collection[];
}

const DEFAULTS: Collection[] = [
  { id: "goals", name: "Goals", emoji: "🎯", pinned: true, createdAt: "", items: [] },
  { id: "parking-lot", name: "Parking Lot", emoji: "🅿️", pinned: true, createdAt: "", items: [] },
  { id: "decisions", name: "Decisions", emoji: "✅", pinned: true, createdAt: "", items: [] },
];

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "collection";
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Load collections; seed sensible starters on first ever run (file absent). */
async function load(): Promise<Store> {
  try {
    return JSON.parse(await fs.readFile(COLLECTIONS_FILE, "utf8")) as Store;
  } catch {
    // First run — seed starters (deletable/renameable by the user).
    const seeded: Store = { collections: DEFAULTS.map((c) => ({ ...c, createdAt: nowIso() })) };
    await save(seeded);
    return seeded;
  }
}

async function save(s: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${COLLECTIONS_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2), "utf8");
  await fs.rename(tmp, COLLECTIONS_FILE);
}

export async function listCollections(): Promise<Collection[]> {
  return (await load()).collections;
}

export async function createCollection(
  name: string,
  opts: { emoji?: string; pinned?: boolean } = {},
): Promise<Collection> {
  const s = await load();
  const id = slug(name);
  const existing = s.collections.find((c) => c.id === id);
  if (existing) return existing;
  const c: Collection = {
    id,
    name: name.trim(),
    ...(opts.emoji ? { emoji: opts.emoji } : {}),
    pinned: opts.pinned ?? true,
    createdAt: nowIso(),
    items: [],
  };
  s.collections.push(c);
  await save(s);
  return c;
}

export async function addToCollection(name: string, ids: string[]): Promise<Collection> {
  const s = await load();
  const id = slug(name);
  let c = s.collections.find((x) => x.id === id);
  if (!c) {
    c = { id, name: name.trim(), pinned: true, createdAt: nowIso(), items: [] };
    s.collections.push(c);
  }
  for (const memId of ids) if (!c.items.includes(memId)) c.items.push(memId);
  await save(s);
  return c;
}

export async function removeFromCollection(name: string, ids: string[]): Promise<Collection | null> {
  const s = await load();
  const c = s.collections.find((x) => x.id === slug(name));
  if (!c) return null;
  const drop = new Set(ids);
  c.items = c.items.filter((i) => !drop.has(i));
  await save(s);
  return c;
}

export async function deleteCollection(name: string): Promise<boolean> {
  const s = await load();
  const before = s.collections.length;
  s.collections = s.collections.filter((c) => c.id !== slug(name));
  if (s.collections.length === before) return false;
  await save(s);
  return true;
}

/** Names of collections a thread belongs to (reverse lookup, for badges). */
export async function collectionsForThread(threadId: string): Promise<{ id: string; name: string; emoji?: string }[]> {
  const s = await load();
  return s.collections
    .filter((c) => c.items.includes(threadId))
    .map((c) => ({ id: c.id, name: c.name, ...(c.emoji ? { emoji: c.emoji } : {}) }));
}

/** Thread ids that resist decay because they're in a pinned collection. */
export async function pinnedMemberIds(): Promise<Set<string>> {
  const s = await load();
  const set = new Set<string>();
  for (const c of s.collections) if (c.pinned) for (const i of c.items) set.add(i);
  return set;
}

/** Reverse map id -> collection names, for bulk badging in the dashboard. */
export async function membershipMap(): Promise<Map<string, { id: string; name: string; emoji?: string }[]>> {
  const s = await load();
  const m = new Map<string, { id: string; name: string; emoji?: string }[]>();
  for (const c of s.collections) {
    for (const i of c.items) {
      const arr = m.get(i) ?? [];
      arr.push({ id: c.id, name: c.name, ...(c.emoji ? { emoji: c.emoji } : {}) });
      m.set(i, arr);
    }
  }
  return m;
}
