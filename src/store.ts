/**
 * File-based storage layer.
 *
 * Layout under DATA_DIR (~/.mindmap by default):
 *   threads/<id>.json   one file per memory thread (full content)
 *   index.json          lightweight index for fast list/search
 *   config.json         tunable thresholds + feature flags
 *
 * The index is the source of truth for listing/search; thread files hold the
 * full body. Writes update both, atomically per file (write tmp -> rename).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import {
  CONFIG_FILE,
  DATA_DIR,
  DEFAULTS,
  INDEX_FILE,
  THREADS_DIR,
  type Config,
} from "./constants.js";
import { redactThread } from "./redact.js";
import { type IndexEntry, type Thread, toIndexEntry } from "./types.js";

let indexCache: Map<string, IndexEntry> | null = null;
let configCache: Config | null = null;

async function ensureDirs(): Promise<void> {
  await fs.mkdir(THREADS_DIR, { recursive: true });
}

async function atomicWrite(file: string, data: string): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function getConfig(): Promise<Config> {
  if (configCache) return configCache;
  await ensureDirs();
  const stored = await readJson<Partial<Config>>(CONFIG_FILE);
  configCache = { ...DEFAULTS, ...(stored ?? {}) };
  if (!stored) await atomicWrite(CONFIG_FILE, JSON.stringify(configCache, null, 2));
  return configCache;
}

export async function setConfig(patch: Partial<Config>): Promise<Config> {
  const current = await getConfig();
  configCache = { ...current, ...patch };
  await atomicWrite(CONFIG_FILE, JSON.stringify(configCache, null, 2));
  return configCache;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

async function loadIndex(): Promise<Map<string, IndexEntry>> {
  if (indexCache) return indexCache;
  await ensureDirs();
  const entries = (await readJson<IndexEntry[]>(INDEX_FILE)) ?? [];
  indexCache = new Map(entries.map((e) => [e.id, e]));
  return indexCache;
}

async function persistIndex(): Promise<void> {
  const idx = await loadIndex();
  await atomicWrite(INDEX_FILE, JSON.stringify([...idx.values()], null, 2));
}

export async function allEntries(): Promise<IndexEntry[]> {
  return [...(await loadIndex()).values()];
}

/** Rebuild index.json from the thread files — picks up any new index fields. */
export async function reindex(): Promise<number> {
  await ensureDirs();
  let files: string[];
  try {
    files = await fs.readdir(THREADS_DIR);
  } catch {
    return 0;
  }
  const map = new Map<string, IndexEntry>();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const t = await readJson<Thread>(path.join(THREADS_DIR, f));
    if (t && t.id) map.set(t.id, toIndexEntry(t));
  }
  indexCache = map;
  await persistIndex();
  return map.size;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

function threadPath(id: string): string {
  return path.join(THREADS_DIR, `${id}.json`);
}

export async function getThread(id: string): Promise<Thread | null> {
  return readJson<Thread>(threadPath(id));
}

export async function saveThread(thread: Thread): Promise<void> {
  await ensureDirs();
  // Central choke point: mask secrets before anything is persisted, so no
  // capture/import/hook/passport path can write a plaintext credential to disk.
  const cfg = await getConfig();
  if (cfg.redactSecrets !== false) redactThread(thread);
  await atomicWrite(threadPath(thread.id), JSON.stringify(thread, null, 2));
  const idx = await loadIndex();
  idx.set(thread.id, toIndexEntry(thread));
  await persistIndex();
}

export async function deleteThread(id: string): Promise<boolean> {
  const idx = await loadIndex();
  if (!idx.has(id)) return false;
  idx.delete(id);
  await persistIndex();
  try {
    await fs.unlink(threadPath(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return true;
}

export function newId(): string {
  return randomUUID().slice(0, 8);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export { DATA_DIR };
