import { BOARD_SIZE, FLEET } from "./types.js";
import { DEFAULT_POLICY, type Policy } from "./policy.js";

export type Outcome = "HIT" | "MISS" | "SUNK";

type Cell = [number, number];

const enum Status {
  Unknown = 0,
  Miss = 1,
  Hit = 2,
}

const DEFAULT_FLEET = FLEET.map((f) => f.length); // [5,4,3,3,2]

/**
 * Probability-density firing engine for one game.
 *
 * Every shot, we superimpose EVERY legal placement of every still-floating
 * ship over the board (both orientations, all positions that don't collide
 * with a known miss or a sunk ship). Each placement adds weight to the cells
 * it covers; we then fire the highest-weighted un-shot cell. This unifies
 * "hunt" and "target" into one model:
 *
 *  - With no outstanding hits it naturally produces a parity-optimal hunt,
 *    concentrated where the largest remaining ship is most likely to sit.
 *  - With outstanding hits it only counts placements that explain those hits
 *    and weights them by how many they cover, so a 2-in-a-row line's open
 *    ends dominate — sinking ships in far fewer shots than fixed parity.
 *
 * A learned per-cell `prior` (from past games, see memory.ts) multiplies the
 * weights, so the engine improves the more it plays. Invariants preserved:
 * never repeats a shot, never fires off-board.
 */
export class Brain {
  private readonly size: number;
  private readonly status: Status[];
  private readonly shotMask: boolean[];
  private readonly prior: number[];
  private readonly policy: Policy;
  /** Per-cell static multiplier from the policy (edge aversion). */
  private readonly cellWeight: number[];
  private remaining: number[]; // lengths of ships not yet sunk
  private openHits: Cell[] = []; // hits belonging to ships not yet sunk

  constructor(
    size: number = BOARD_SIZE,
    prior?: number[],
    fleetLengths: number[] = DEFAULT_FLEET,
    policy: Policy = DEFAULT_POLICY,
  ) {
    this.size = size;
    this.policy = policy;
    this.status = new Array<Status>(size * size).fill(Status.Unknown);
    this.shotMask = new Array<boolean>(size * size).fill(false);
    this.prior =
      prior && prior.length === size * size
        ? prior
        : new Array<number>(size * size).fill(1);
    this.remaining = [...fleetLengths];

    // Precompute the static per-cell weight: down-weight the outer ring by
    // `edgeAversion` (opponents often keep ships off the edges).
    this.cellWeight = new Array<number>(size * size).fill(1);
    if (policy.edgeAversion > 0) {
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          const onRing = r === 0 || r === size - 1 || c === 0 || c === size - 1;
          if (onRing) this.cellWeight[r * size + c] = 1 - policy.edgeAversion;
        }
      }
    }
  }

  private idx(r: number, c: number): number {
    return r * this.size + c;
  }

  private inBounds(r: number, c: number): boolean {
    return r >= 0 && r < this.size && c >= 0 && c < this.size;
  }

  hasShot(r: number, c: number): boolean {
    return this.shotMask[this.idx(r, c)] === true;
  }

  /** Pick the next legal, never-repeated shot via the density map. */
  nextShot(): Cell {
    const density = this.densityMap();

    let best: Cell | null = null;
    let bestScore = -Infinity;
    let ties = 0;
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.shotMask[this.idx(r, c)]) continue;
        const d = density[this.idx(r, c)] ?? 0;
        if (d > bestScore) {
          bestScore = d;
          best = [r, c];
          ties = 1;
        } else if (d === bestScore) {
          // Reservoir tie-break so equal-density cells are chosen uniformly.
          ties += 1;
          if (Math.random() < 1 / ties) best = [r, c];
        }
      }
    }

    if (!best) throw new Error("No cells left to shoot");
    return this.take(best[0], best[1]);
  }

  private take(r: number, c: number): Cell {
    this.shotMask[this.idx(r, c)] = true; // reserve so we never repeat
    return [r, c];
  }

  /**
   * Feed back the outcome of a shot. `sunkLength` is the length of the ship
   * that just sank, when the server reports it; otherwise we infer it from
   * the contiguous run of outstanding hits.
   */
  record(r: number, c: number, outcome: Outcome, sunkLength?: number): void {
    this.shotMask[this.idx(r, c)] = true;
    if (outcome === "MISS") {
      this.status[this.idx(r, c)] = Status.Miss;
      return;
    }

    // HIT or SUNK — this cell holds part of a ship either way.
    this.status[this.idx(r, c)] = Status.Hit;
    this.openHits.push([r, c]);

    if (outcome === "SUNK") this.resolveSunk([r, c], sunkLength);
  }

  /** Every cell we've confirmed holds a ship (for learning a placement prior). */
  discoveredShipCells(): Cell[] {
    const cells: Cell[] = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.status[this.idx(r, c)] === Status.Hit) cells.push([r, c]);
      }
    }
    return cells;
  }

  /**
   * A ship sank at `last`. Remove its cells from the outstanding-hit set and
   * drop one matching length from the remaining fleet, so the density model
   * stops trying to place that ship.
   */
  private resolveSunk(last: Cell, sunkLength?: number): void {
    const run = this.contiguousRun(last);
    const length = sunkLength && sunkLength > 0 ? sunkLength : run.length;

    // Take the `length` cells of the run nearest `last` as the sunk ship.
    const sunkCells = run.slice(0, length);
    const sunkKeys = new Set(sunkCells.map(([r, c]) => `${r},${c}`));
    this.openHits = this.openHits.filter(
      ([r, c]) => !sunkKeys.has(`${r},${c}`),
    );

    // Remove one ship of this length from the remaining fleet (closest match
    // if the exact length isn't present, to stay robust to mis-inference).
    this.removeRemaining(length);
  }

  private removeRemaining(length: number): void {
    let pick = this.remaining.indexOf(length);
    if (pick === -1 && this.remaining.length > 0) {
      let bestDiff = Infinity;
      this.remaining.forEach((l, i) => {
        const diff = Math.abs(l - length);
        if (diff < bestDiff) {
          bestDiff = diff;
          pick = i;
        }
      });
    }
    if (pick >= 0) this.remaining.splice(pick, 1);
  }

  /** Outstanding hits forming a straight contiguous line through `cell`. */
  private contiguousRun([r, c]: Cell): Cell[] {
    const isOpenHit = (rr: number, cc: number): boolean =>
      this.openHits.some(([hr, hc]) => hr === rr && hc === cc);

    const horizontal: Cell[] = [[r, c]];
    for (let cc = c - 1; isOpenHit(r, cc); cc--) horizontal.unshift([r, cc]);
    for (let cc = c + 1; isOpenHit(r, cc); cc++) horizontal.push([r, cc]);

    const vertical: Cell[] = [[r, c]];
    for (let rr = r - 1; isOpenHit(rr, c); rr--) vertical.unshift([rr, c]);
    for (let rr = r + 1; isOpenHit(rr, c); rr++) vertical.push([rr, c]);

    const line = horizontal.length >= vertical.length ? horizontal : vertical;
    // Order the run so the cells nearest `last` come first.
    return line.sort(
      (a, b) =>
        Math.abs(a[0] - r) + Math.abs(a[1] - c) -
        (Math.abs(b[0] - r) + Math.abs(b[1] - c)),
    );
  }

  /** Build the per-cell placement-density map (weighted by the prior). */
  private densityMap(): number[] {
    const density = new Array<number>(this.size * this.size).fill(0);
    const targeting = this.openHits.length > 0;
    const openSet = new Set(this.openHits.map(([r, c]) => `${r},${c}`));

    for (const length of this.remaining) {
      for (const [dr, dc] of [
        [0, 1], // horizontal
        [1, 0], // vertical
      ] as const) {
        const maxR = this.size - dr * (length - 1);
        const maxC = this.size - dc * (length - 1);
        for (let r = 0; r < maxR; r++) {
          for (let c = 0; c < maxC; c++) {
            this.scorePlacement(density, r, c, dr, dc, length, targeting, openSet);
          }
        }
      }
    }

    // Fallback: if targeting found nothing consistent (shouldn't happen),
    // hunt instead so we never stall.
    if (targeting && density.every((d) => d === 0)) {
      const saved = this.openHits;
      this.openHits = [];
      const fallback = this.densityMap();
      this.openHits = saved;
      return fallback;
    }
    return density;
  }

  private scorePlacement(
    density: number[],
    r0: number,
    c0: number,
    dr: number,
    dc: number,
    length: number,
    targeting: boolean,
    openSet: Set<string>,
  ): void {
    const cells: Cell[] = [];
    let covered = 0;
    for (let k = 0; k < length; k++) {
      const r = r0 + dr * k;
      const c = c0 + dc * k;
      const s = this.status[this.idx(r, c)];
      if (s === Status.Miss) return; // can't cover a known miss
      const open = openSet.has(`${r},${c}`);
      if (s === Status.Hit && !open) return; // can't overlap a sunk ship
      if (open) covered += 1;
      cells.push([r, c]);
    }

    if (targeting && covered === 0) return; // must explain an outstanding hit

    const weight = targeting ? 1 + covered * this.policy.targetBonus : 1;
    for (const [r, c] of cells) {
      const i = this.idx(r, c);
      if (this.shotMask[i]) continue; // only score un-shot cells
      let mult = (this.prior[i] ?? 1) * (this.cellWeight[i] ?? 1);
      // Parity bias only applies while hunting (it would distort a hit line).
      if (!targeting && this.policy.huntParityBias > 0 && (r + c) % 2 === 0) {
        mult *= 1 + this.policy.huntParityBias;
      }
      density[i] = (density[i] ?? 0) + weight * mult;
    }
  }
}
