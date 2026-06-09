/**
 * Shared constants and tunable thresholds for the Mind Map memory engine.
 *
 * Storage tiers map to the user's mental model:
 *   hot  -> "mem"   : recently used, promoted; always surfaced first
 *   warm -> "files" : captured or aging; kept in full, surfaced on search
 *   cold -> "drive" : decayed to a one-line trace; still searchable, out of the way
 */

import os from "node:os";
import path from "node:path";

/** Root directory for all Mind Map data. Override with MINDMAP_DIR. */
export const DATA_DIR =
  process.env.MINDMAP_DIR || path.join(os.homedir(), ".mindmap");

export const THREADS_DIR = path.join(DATA_DIR, "threads");
export const INDEX_FILE = path.join(DATA_DIR, "index.json");
export const CONFIG_FILE = path.join(DATA_DIR, "config.json");

/** Max characters in a single tool response before truncation kicks in. */
export const CHARACTER_LIMIT = 25000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Decay thresholds (in milliseconds), tunable via config.json. */
export const DEFAULTS = {
  /** Within this window since last access, an active thread stays hot. */
  hotWindowMs: 7 * DAY_MS,
  /** Beyond hot but within this window, a thread is warm. Past it -> cold. */
  warmWindowMs: 30 * DAY_MS,
  /** Promoted (human-blessed) threads decay this many times slower. */
  promotedLongevityFactor: 2,
  /** A thread needs at least this many accesses to be considered "live" (hot). */
  hotMinAccessCount: 2,
  /** How often the background pruner runs, in ms. */
  prunerIntervalMs: 6 * 60 * 60 * 1000,
  /** Gamified curation surface (health score, tidy nudges). Opt-in. */
  gamification: true,
} as const;

export type Config = {
  hotWindowMs: number;
  warmWindowMs: number;
  promotedLongevityFactor: number;
  hotMinAccessCount: number;
  prunerIntervalMs: number;
  gamification: boolean;
};

export const SERVER_NAME = "mindmap-mcp-server";
export const SERVER_VERSION = "0.2.1";
