import { BOARD_SIZE } from "./types.js";

export type Outcome = "HIT" | "MISS" | "SUNK";

type Cell = [number, number];

const enum Status {
  Unknown = 0,
  Miss = 1,
  Hit = 2,
}

/**
 * Firing strategy for one game.
 *
 *  - HUNT: fire on a checkerboard/parity pattern (every ship of length >= 2
 *    must touch a parity cell), visiting parity cells in a shuffled order.
 *  - TARGET: on a HIT, enqueue orthogonal neighbours and work them until the
 *    ship sinks. Once two hits line up, only the two ends of that line are
 *    pursued, which sinks ships far faster than poking all four sides.
 *
 * Invariants: never repeats a shot, never fires off-board.
 */
export class Brain {
  private readonly size: number;
  private readonly status: Status[];
  private readonly shot: boolean[];
  private readonly queue: Cell[] = []; // target stack (LIFO)
  private hits: Cell[] = []; // current unsunk ship's hits
  private readonly huntOrder: Cell[];

  constructor(size: number = BOARD_SIZE) {
    this.size = size;
    this.status = new Array<Status>(size * size).fill(Status.Unknown);
    this.shot = new Array<boolean>(size * size).fill(false);

    // Parity cells first (shuffled), then the rest (shuffled) as a fallback.
    const parity: Cell[] = [];
    const other: Cell[] = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        ((r + c) % 2 === 0 ? parity : other).push([r, c]);
      }
    }
    shuffle(parity);
    shuffle(other);
    this.huntOrder = [...parity, ...other];
  }

  private idx(r: number, c: number): number {
    return r * this.size + c;
  }

  private inBounds(r: number, c: number): boolean {
    return r >= 0 && r < this.size && c >= 0 && c < this.size;
  }

  hasShot(r: number, c: number): boolean {
    return this.shot[this.idx(r, c)] === true;
  }

  /** Pick the next legal, never-repeated shot. */
  nextShot(): Cell {
    // 1) Drain the target queue (skip anything already fired).
    while (this.queue.length > 0) {
      const top = this.queue.pop();
      if (!top) continue;
      const [r, c] = top;
      if (this.inBounds(r, c) && !this.hasShot(r, c)) return this.take(r, c);
    }
    // 2) Hunt: first unshot cell in the parity-first shuffled order.
    for (const [r, c] of this.huntOrder) {
      if (!this.hasShot(r, c)) return this.take(r, c);
    }
    throw new Error("No cells left to shoot");
  }

  private take(r: number, c: number): Cell {
    this.shot[this.idx(r, c)] = true; // reserve so we never repeat
    return [r, c];
  }

  /** Feed back the outcome of a shot so the strategy can adapt. */
  record(r: number, c: number, outcome: Outcome): void {
    this.shot[this.idx(r, c)] = true;
    if (outcome === "MISS") {
      this.status[this.idx(r, c)] = Status.Miss;
      return;
    }

    // HIT or SUNK
    this.status[this.idx(r, c)] = Status.Hit;
    this.hits.push([r, c]);

    if (outcome === "SUNK") {
      // Ship gone: drop its hits and abandon any leftover targets so we
      // return cleanly to hunting.
      this.hits = [];
      this.queue.length = 0;
      return;
    }

    this.enqueueTargets();
  }

  private enqueueTargets(): void {
    const ends: Cell[] = [];

    if (this.hits.length >= 2) {
      const rows = this.hits.map(([r]) => r);
      const cols = this.hits.map(([, c]) => c);
      const firstRow = rows[0];
      const firstCol = cols[0];
      const sameRow = firstRow !== undefined && rows.every((r) => r === firstRow);
      const sameCol = firstCol !== undefined && cols.every((c) => c === firstCol);

      if (sameRow && firstRow !== undefined) {
        ends.push(
          [firstRow, Math.min(...cols) - 1],
          [firstRow, Math.max(...cols) + 1],
        );
      } else if (sameCol && firstCol !== undefined) {
        ends.push(
          [Math.min(...rows) - 1, firstCol],
          [Math.max(...rows) + 1, firstCol],
        );
      } else {
        const lastHit = this.hits.at(-1);
        if (lastHit) ends.push(...this.neighbours(lastHit));
      }
    } else {
      const lastHit = this.hits.at(-1);
      if (lastHit) ends.push(...this.neighbours(lastHit));
    }

    for (const [r, c] of ends) {
      if (!this.inBounds(r, c)) continue;
      if (this.hasShot(r, c)) continue;
      if (this.queue.some(([qr, qc]) => qr === r && qc === c)) continue;
      this.queue.push([r, c]);
    }
  }

  private neighbours([r, c]: Cell): Cell[] {
    return [
      [r - 1, c],
      [r + 1, c],
      [r, c - 1],
      [r, c + 1],
    ];
  }
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a !== undefined && b !== undefined) {
      arr[i] = b;
      arr[j] = a;
    }
  }
}
