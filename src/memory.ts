import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BOARD_SIZE } from "./types.js";
import type { Policy } from "./policy.js";

/**
 * Persistent learning that lets the agent improve across runs.
 *
 * After every game we record where the opponent's ships actually were into a
 * per-cell heatmap. That heatmap is turned into a `prior` (see priorFrom
 * memory) that biases the firing engine's density map toward historically
 * ship-dense cells — so the more games the agent plays, the faster it tends
 * to find ships. We also keep a per-attempt score history so improvement is
 * visible run over run.
 *
 * The prior is deliberately gentle and starts uniform: with no data, or if
 * opponents place uniformly at random, it stays ~1 everywhere and can't hurt;
 * any real placement bias only helps.
 */
/**
 * What we've learned about one opponent (or one opponent class). Two heatmaps:
 *  - shipHeat: where THIS opponent's ships actually sat (our hits) → tells our
 *    offense where to shoot first to clear them faster.
 *  - fireHeat: where THIS opponent fired at US (incomingShots) → tells our
 *    defense where NOT to place ships, so they take longer to find us.
 */
export interface OpponentRecord {
  class: string | null;
  games: number;
  shipHeat: number[];
  fireHeat: number[];
}

export interface Memory {
  version: number;
  size: number;
  /** Accumulated count of times each cell held a ship (global, all opponents). */
  heat: number[];
  /** Total ship cells observed (for reference). */
  cellsObserved: number;
  gamesObserved: number;
  /** Per-opponent models, keyed by opponentId. */
  opponents: Record<string, OpponentRecord>;
  /** Per-class aggregates (e.g. "SCOUT", "WARSHIP"), keyed by opponentClass. */
  classes: Record<string, OpponentRecord>;
  /** One entry per attempt, recording the score and the policy that produced it. */
  attempts: { score: number; ts: string; policy?: Policy }[];
  bestScore: number | null;
}

/** Identity of the opponent in the current game. */
export interface Opponent {
  id: string | null;
  class: string | null;
}

const VERSION = 2;

export function loadMemory(file: string, size: number = BOARD_SIZE): Memory {
  if (existsSync(file)) {
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Partial<Memory>;
      if (m && Array.isArray(m.heat) && m.heat.length === size * size) {
        return {
          version: VERSION,
          size,
          heat: m.heat,
          cellsObserved: m.cellsObserved ?? 0,
          gamesObserved: m.gamesObserved ?? 0,
          opponents: sanitizeRecords(m.opponents, size),
          classes: sanitizeRecords(m.classes, size),
          attempts: Array.isArray(m.attempts) ? m.attempts : [],
          bestScore: typeof m.bestScore === "number" ? m.bestScore : null,
        };
      }
    } catch {
      // fall through to a fresh memory
    }
  }
  return {
    version: VERSION,
    size,
    heat: new Array<number>(size * size).fill(0),
    cellsObserved: 0,
    gamesObserved: 0,
    opponents: {},
    classes: {},
    attempts: [],
    bestScore: null,
  };
}

/** Drop any persisted records whose heatmaps don't match the board size. */
function sanitizeRecords(
  recs: Record<string, OpponentRecord> | undefined,
  size: number,
): Record<string, OpponentRecord> {
  const out: Record<string, OpponentRecord> = {};
  if (!recs) return out;
  for (const [key, r] of Object.entries(recs)) {
    if (
      r &&
      Array.isArray(r.shipHeat) &&
      r.shipHeat.length === size * size &&
      Array.isArray(r.fireHeat) &&
      r.fireHeat.length === size * size
    ) {
      out[key] = {
        class: r.class ?? null,
        games: r.games ?? 0,
        shipHeat: r.shipHeat,
        fireHeat: r.fireHeat,
      };
    }
  }
  return out;
}

function blankRecord(size: number, cls: string | null): OpponentRecord {
  return {
    class: cls,
    games: 0,
    shipHeat: new Array<number>(size * size).fill(0),
    fireHeat: new Array<number>(size * size).fill(0),
  };
}

export function saveMemory(file: string, mem: Memory): void {
  const dir = dirname(file);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(mem), { mode: 0o600 });
}

/** Fold one game's discovered ship cells into the heatmap. */
export function learnShipCells(mem: Memory, cells: [number, number][]): void {
  if (cells.length === 0) return;
  for (const [r, c] of cells) {
    const i = r * mem.size + c;
    if (i >= 0 && i < mem.heat.length) {
      mem.heat[i] = (mem.heat[i] ?? 0) + 1;
      mem.cellsObserved += 1;
    }
  }
  mem.gamesObserved += 1;
}

/**
 * Turn a raw count heatmap into per-cell multipliers centred on 1. `lambda`
 * controls how strongly past data tilts the search; additive smoothing keeps
 * early, noisy data from dominating.
 */
function heatToPrior(heat: number[], lambda: number): number[] {
  const n = heat.length;
  const total = heat.reduce((a, b) => a + b, 0);
  if (total <= 0) return new Array<number>(n).fill(1);
  const mean = total / n;
  const alpha = mean; // smoothing toward the mean
  return heat.map((h) => Math.max(0.05, 1 + lambda * ((h + alpha) / (mean + alpha) - 1)));
}

/** Global (all-opponent) firing prior — used as a fallback. */
export function priorFromMemory(mem: Memory, lambda = 0.6): number[] {
  return heatToPrior(mem.heat, lambda);
}

/**
 * Record one finished game against `opp`: where their ships were (our hits)
 * and where they fired at us. Updates the global, per-class, and per-opponent
 * models so future games against the same opponent — or the same class — fire
 * smarter and hide better.
 */
export function learnGame(
  mem: Memory,
  opp: Opponent,
  shipCells: [number, number][],
  fireCells: [number, number][],
): void {
  // Global ship heatmap + game counter (unchanged behaviour).
  learnShipCells(mem, shipCells);

  const buckets: OpponentRecord[] = [];
  if (opp.class) {
    const rec = (mem.classes[opp.class] ??= blankRecord(mem.size, opp.class));
    buckets.push(rec);
  }
  if (opp.id) {
    const rec = (mem.opponents[opp.id] ??= blankRecord(mem.size, opp.class));
    rec.class = opp.class; // keep class label fresh
    buckets.push(rec);
  }
  for (const rec of buckets) {
    rec.games += 1;
    bump(rec.shipHeat, shipCells, mem.size);
    bump(rec.fireHeat, fireCells, mem.size);
  }
}

function bump(heat: number[], cells: [number, number][], size: number): void {
  for (const [r, c] of cells) {
    const i = r * size + c;
    if (i >= 0 && i < heat.length) heat[i] = (heat[i] ?? 0) + 1;
  }
}

/**
 * Build the firing prior for a specific opponent, blending (most specific
 * first) this opponent's own ship heatmap, its class aggregate, and the global
 * heatmap. Specific data is weighted higher but the broader pools fill in when
 * we've seen the opponent rarely or never.
 */
export function offensePrior(mem: Memory, opp: Opponent, lambda = 0.6): number[] {
  const n = mem.size * mem.size;
  const combined = new Array<number>(n).fill(0);

  const add = (heat: number[] | undefined, weight: number): void => {
    if (!heat) return;
    const total = heat.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    // Normalise each source to a probability, then weight — so a source with
    // few observations doesn't get drowned out by raw-count magnitude.
    for (let i = 0; i < n; i++) combined[i] = (combined[i] ?? 0) + (weight * (heat[i] ?? 0)) / total;
  };

  add(opp.id ? mem.opponents[opp.id]?.shipHeat : undefined, 3);
  add(opp.class ? mem.classes[opp.class]?.shipHeat : undefined, 1.5);
  add(mem.heat, 0.5);

  return heatToPrior(combined, lambda);
}

/**
 * Per-cell "danger" map for a specific opponent: where they tend to shoot.
 * Returned as raw weights (higher = more often fired on) so placement can
 * steer our ships into their cold zones. Null when we have no fire data yet.
 */
export function dangerMap(mem: Memory, opp: Opponent): number[] | null {
  const n = mem.size * mem.size;
  const combined = new Array<number>(n).fill(0);
  let any = false;

  const add = (heat: number[] | undefined, weight: number): void => {
    if (!heat) return;
    const total = heat.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    any = true;
    for (let i = 0; i < n; i++) combined[i] = (combined[i] ?? 0) + (weight * (heat[i] ?? 0)) / total;
  };

  add(opp.id ? mem.opponents[opp.id]?.fireHeat : undefined, 3);
  add(opp.class ? mem.classes[opp.class]?.fireHeat : undefined, 1.5);

  return any ? combined : null;
}

/** Record an attempt's final score (and the policy that produced it). */
export function recordAttempt(
  mem: Memory,
  score: number | null,
  policy?: Policy,
): void {
  if (score === null || Number.isNaN(score)) return;
  mem.attempts.push({ score, ts: new Date().toISOString(), ...(policy ? { policy } : {}) });
  if (mem.bestScore === null || score > mem.bestScore) mem.bestScore = score;
}

/** A short human-readable summary of how the agent is trending. */
export function progressSummary(mem: Memory): string {
  const scores = mem.attempts.map((a) => a.score);
  if (scores.length === 0) return "No attempts recorded yet.";
  const latest = scores[scores.length - 1]!;
  const recent = scores.slice(-5);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const isBest = mem.bestScore !== null && latest >= mem.bestScore;
  const lines = [
    `Attempts played: ${scores.length} | games learned from: ${mem.gamesObserved}`,
    `This attempt: ${latest} | best: ${mem.bestScore} | avg(last ${recent.length}): ${avg.toFixed(1)}`,
  ];
  const classNote = Object.entries(mem.classes)
    .map(([cls, r]) => `${cls} ×${r.games}`)
    .join(", ");
  const oppCount = Object.keys(mem.opponents).length;
  if (classNote || oppCount > 0) {
    lines.push(`Opponent models: ${oppCount} known | by class: ${classNote || "none"}`);
  }
  if (isBest && scores.length > 1) lines.push("New best score — the agent is improving.");
  return lines.join("\n");
}
