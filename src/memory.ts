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
  /** Games we won / lost against this opponent (or class), across all attempts. */
  wins: number;
  losses: number;
  /** Total shots we fired and hits we landed across all games (for avg efficiency). */
  totalShots: number;
  totalHits: number;
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
  attempts: { score: number; wins?: number; losses?: number; ts: string; policy?: Policy }[];
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
        wins: r.wins ?? 0,
        losses: r.losses ?? 0,
        totalShots: r.totalShots ?? 0,
        totalHits: r.totalHits ?? 0,
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
    wins: 0,
    losses: 0,
    totalShots: 0,
    totalHits: 0,
    shipHeat: new Array<number>(size * size).fill(0),
    fireHeat: new Array<number>(size * size).fill(0),
  };
}

export function saveMemory(file: string, mem: Memory): void {
  const dir = dirname(file);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(mem), { mode: 0o600 });
}

/**
 * Zero the per-opponent and per-class *record* stats (games, wins, losses,
 * shots, hits) while KEEPING the heatmaps. Use this after a win-detection bug
 * polluted the W/L history: the heatmaps (which only ever accumulate "where the
 * ship was" / "where they fired") stay valid, but the corrupted win counts and
 * the shots/games mismatch (avg-shots biased low) are reset so the scoreboard
 * rebuilds from clean data.
 */
export function resetRecords(mem: Memory): void {
  for (const rec of [...Object.values(mem.opponents), ...Object.values(mem.classes)]) {
    rec.games = 0;
    rec.wins = 0;
    rec.losses = 0;
    rec.totalShots = 0;
    rec.totalHits = 0;
  }
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
  won?: boolean | null,
  shots?: number,
  hits?: number,
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
    if (won === true) rec.wins += 1;
    else if (won === false) rec.losses += 1;
    if (typeof shots === "number") rec.totalShots += shots;
    if (typeof hits === "number") rec.totalHits += hits;
    bump(rec.shipHeat, shipCells, mem.size);
    bump(rec.fireHeat, fireCells, mem.size);
  }
}

/**
 * Human-readable per-opponent record, sorted worst-win-rate first, so the
 * opponents we keep losing to are obvious. This is the signal that was missing:
 * it tells us exactly which agents (and class) the strategy can't beat yet.
 */
export function opponentScoreboard(mem: Memory): string {
  const rows = Object.entries(mem.opponents)
    .map(([id, r]) => ({
      id,
      cls: r.class ?? "?",
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      rate: r.games > 0 ? r.wins / r.games : 0,
      avgShots: r.games > 0 && r.totalShots > 0 ? r.totalShots / r.games : null,
      hitRate: r.totalShots > 0 ? (100 * r.totalHits) / r.totalShots : null,
    }))
    .filter((r) => r.games > 0)
    .sort((a, b) => a.rate - b.rate || (b.avgShots ?? 0) - (a.avgShots ?? 0));
  if (rows.length === 0) return "No per-opponent records yet.";
  const lines = rows.map((r) => {
    const eff =
      r.avgShots !== null
        ? ` avg ${r.avgShots.toFixed(1)} shots ${r.hitRate !== null ? `(${r.hitRate.toFixed(0)}% hit)` : ""}`
        : "";
    return `  ${r.id.slice(0, 14).padEnd(14)} [${r.cls.padEnd(7)}] ${String(r.wins).padStart(2)}-${r.losses} (${(100 * r.rate).toFixed(0)}% win)${eff}`;
  });
  return ["Per-opponent record (worst win-rate first):", ...lines].join("\n");
}

function bump(heat: number[], cells: [number, number][], size: number): void {
  for (const [r, c] of cells) {
    const i = r * size + c;
    if (i >= 0 && i < heat.length) heat[i] = (heat[i] ?? 0) + 1;
  }
}

/**
 * Our win rate vs a specific opponent (and how many games it's based on),
 * preferring the opponent's own record and falling back to its class. Returns
 * null when we have no record yet (so callers use neutral defaults).
 */
export function opponentWinRate(
  mem: Memory,
  opp: Opponent,
): { rate: number; games: number } | null {
  const rec = (opp.id ? mem.opponents[opp.id] : undefined) ??
    (opp.class ? mem.classes[opp.class] : undefined);
  if (!rec || rec.games <= 0) return null;
  return { rate: rec.wins / rec.games, games: rec.games };
}

/**
 * Outcome-aware adaptation. The more we LOSE to a specific opponent, the harder
 * we try against it next time: search more candidate hiding spots, and lean
 * more strongly on that opponent's own learned heatmaps (rather than the broad
 * pools). Returns gentle multipliers, neutral (1×, +0) when we have no record
 * or are already winning, so it can only help.
 */
export function opponentAdaptation(
  mem: Memory,
  opp: Opponent,
): { placementCandidates: number; lambdaBoost: number } {
  const rec = (opp.id ? mem.opponents[opp.id] : undefined) ??
    (opp.class ? mem.classes[opp.class] : undefined);
  // Search 500 cold-zone layouts by default (≈30ms — essentially free vs the 2s
  // budget). Every ship we keep out of the opponent's hot zones is ~10 points of
  // avoided own-ship-lost penalty — the single biggest score swing in the data —
  // so even opponents we already beat benefit from a wider hiding search.
  if (!rec || rec.games < 3) return { placementCandidates: 500, lambdaBoost: 0 };
  const lossRate = 1 - rec.wins / rec.games;
  // High avg shots hurts score even when we win (more opponent turns = more our
  // ships sunk). But amplifying lambda only helps when the prior actually
  // predicts this opponent's placement — i.e. a healthy hit rate. For noisy
  // opponents (low hit rate = they randomize hard) a stronger prior over-bets on
  // historically common cells they aren't using, so we skip the shot boost there
  // and let the broader search (placementCandidates) do the work instead.
  const avgShots = rec.totalShots > 0 ? rec.totalShots / rec.games : 0;
  const hitRate = rec.totalShots > 0 ? rec.totalHits / rec.totalShots : 0;
  const priorIsPredictive = hitRate >= 0.4;
  const shotBoost = priorIsPredictive ? Math.min(0.4, Math.max(0, (avgShots - 25) / 100)) : 0;
  return {
    placementCandidates: Math.round(500 + 500 * lossRate),
    lambdaBoost: Math.min(1.0, 0.6 * lossRate + shotBoost),
  };
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
  wins?: number,
  losses?: number,
): void {
  if (score === null || Number.isNaN(score)) return;
  const entry: Memory["attempts"][number] = { score, ts: new Date().toISOString() };
  if (policy) entry.policy = policy;
  if (typeof wins === "number") entry.wins = wins;
  if (typeof losses === "number") entry.losses = losses;
  mem.attempts.push(entry);
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
  const latestAttempt = mem.attempts[mem.attempts.length - 1];
  const winNote =
    latestAttempt && typeof latestAttempt.wins === "number"
      ? ` | ${latestAttempt.wins}W-${latestAttempt.losses ?? "?"}L`
      : "";
  const lines = [
    `Attempts played: ${scores.length} | games learned from: ${mem.gamesObserved}`,
    `This attempt: ${latest}${winNote} | best: ${mem.bestScore} | avg(last ${recent.length}): ${avg.toFixed(1)}`,
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
