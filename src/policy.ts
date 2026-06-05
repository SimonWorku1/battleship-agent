import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The strategy "policy" — a small set of bounded knobs that steer the firing
 * engine. This is the surface the Claude strategist (src/improve.ts) is
 * allowed to tune: the model proposes new values, we clamp them to the safe
 * ranges below, and the density engine reads them. Keeping the tunable
 * surface small and bounded means the closed loop can never drive the agent
 * into an illegal or degenerate strategy — the worst case is a slightly worse
 * score, never a crash or a forfeited game.
 */
export interface Policy {
  /** How strongly the learned heatmap prior tilts the search (0 = ignore). */
  lambda: number;
  /** Extra weight a placement gets per outstanding hit it covers. */
  targetBonus: number;
  /** Extra multiplier for checkerboard cells while hunting (0 = none). */
  huntParityBias: number;
  /** Down-weight the outer ring of the board (0 = none, 0.9 = strong). */
  edgeAversion: number;
}

export const DEFAULT_POLICY: Policy = {
  // Trust the learned prior fairly strongly: the opponent roster is fixed and we
  // bank lots of per-opponent placement data, so the heatmap is a real signal,
  // not noise. (The per-opponent adaptation adds up to +0.6 on top for foes we
  // keep losing to; the [0,2] cap keeps that safe.)
  lambda: 1.0,
  targetBonus: 60,
  huntParityBias: 0,
  edgeAversion: 0,
};

/** Inclusive [min, max] bounds enforced on every policy field. */
export const POLICY_BOUNDS: Record<keyof Policy, [number, number]> = {
  lambda: [0, 2],
  targetBonus: [1, 200],
  huntParityBias: [0, 3],
  edgeAversion: [0, 0.9],
};

/** Clamp every field to its bounds, falling back to the default if invalid. */
export function clampPolicy(p: Partial<Policy> | null | undefined): Policy {
  const out = { ...DEFAULT_POLICY };
  for (const key of Object.keys(POLICY_BOUNDS) as (keyof Policy)[]) {
    const [lo, hi] = POLICY_BOUNDS[key];
    const v = p?.[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[key] = Math.min(hi, Math.max(lo, v));
    }
  }
  return out;
}

export function loadPolicy(file: string): Policy {
  if (existsSync(file)) {
    try {
      return clampPolicy(JSON.parse(readFileSync(file, "utf8")) as Partial<Policy>);
    } catch {
      // fall through to default
    }
  }
  return { ...DEFAULT_POLICY };
}

export function savePolicy(file: string, policy: Policy): void {
  const dir = dirname(file);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(clampPolicy(policy), null, 2), { mode: 0o600 });
}
