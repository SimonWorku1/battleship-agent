import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BOARD_SIZE } from "./types.js";

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
export interface Memory {
  version: number;
  size: number;
  /** Accumulated count of times each cell held a ship. */
  heat: number[];
  /** Total ship cells observed (for reference). */
  cellsObserved: number;
  gamesObserved: number;
  attempts: { score: number; ts: string }[];
  bestScore: number | null;
}

const VERSION = 1;

export function loadMemory(file: string, size: number = BOARD_SIZE): Memory {
  if (existsSync(file)) {
    try {
      const m = JSON.parse(readFileSync(file, "utf8")) as Memory;
      if (m && Array.isArray(m.heat) && m.heat.length === size * size) {
        return {
          version: m.version ?? VERSION,
          size,
          heat: m.heat,
          cellsObserved: m.cellsObserved ?? 0,
          gamesObserved: m.gamesObserved ?? 0,
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
    attempts: [],
    bestScore: null,
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
 * Turn the heatmap into per-cell multipliers centred on 1. `lambda` controls
 * how strongly past data tilts the search; additive smoothing (alpha) keeps
 * early, noisy data from dominating.
 */
export function priorFromMemory(mem: Memory, lambda = 0.6): number[] {
  const n = mem.heat.length;
  const total = mem.heat.reduce((a, b) => a + b, 0);
  if (total <= 0) return new Array<number>(n).fill(1);
  const mean = total / n;
  const alpha = mean; // smoothing toward the mean
  return mem.heat.map((h) =>
    Math.max(0.05, 1 + lambda * ((h + alpha) / (mean + alpha) - 1)),
  );
}

/** Record an attempt's final score and update the best-so-far. */
export function recordAttempt(mem: Memory, score: number | null): void {
  if (score === null || Number.isNaN(score)) return;
  mem.attempts.push({ score, ts: new Date().toISOString() });
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
  if (isBest && scores.length > 1) lines.push("New best score — the agent is improving.");
  return lines.join("\n");
}
