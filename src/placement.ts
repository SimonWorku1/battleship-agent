import {
  BOARD_SIZE,
  FLEET,
  type Orientation,
  type Placement,
} from "./types.js";

/** All cells a placement would occupy, or null if it runs off-board. */
export function cellsFor(p: Placement, length: number): Array<[number, number]> | null {
  const cells: Array<[number, number]> = [];
  for (let i = 0; i < length; i++) {
    const r = p.startRow + (p.orientation === "VERTICAL" ? i : 0);
    const c = p.startCol + (p.orientation === "HORIZONTAL" ? i : 0);
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) return null;
    cells.push([r, c]);
  }
  return cells;
}

/**
 * Validate a full fleet locally before sending it: every ship is the right
 * length, fully in bounds, and no two ships overlap. Throws on any problem
 * so we never ship an illegal fleet (which would disqualify the attempt).
 */
export function validateFleet(placements: Placement[]): void {
  if (placements.length !== FLEET.length) {
    throw new Error(`Fleet must have ${FLEET.length} ships, got ${placements.length}`);
  }
  const required = new Set(FLEET.map((f) => f.shipClass));
  const occupied = new Set<string>();

  for (const p of placements) {
    const spec = FLEET.find((f) => f.shipClass === p.shipClass);
    if (!spec) throw new Error(`Unknown ship class ${p.shipClass}`);
    if (!required.delete(p.shipClass)) {
      throw new Error(`Duplicate or unexpected ship ${p.shipClass}`);
    }
    const cells = cellsFor(p, spec.length);
    if (!cells) throw new Error(`Ship ${p.shipClass} is out of bounds`);
    for (const [r, c] of cells) {
      const key = `${r},${c}`;
      if (occupied.has(key)) throw new Error(`Ships overlap at ${key}`);
      occupied.add(key);
    }
  }

  if (required.size > 0) {
    throw new Error(`Missing ships: ${[...required].join(", ")}`);
  }
}

/**
 * Generate a random but legal fleet: in bounds, no overlaps. Re-randomized
 * on every call (every game gets a fresh layout).
 */
export function randomFleet(): Placement[] {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const placements: Placement[] = [];
    const occupied = new Set<string>();
    let ok = true;

    for (const { shipClass, length } of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 200 && !placed; tries++) {
        const orientation: Orientation =
          Math.random() < 0.5 ? "HORIZONTAL" : "VERTICAL";
        const maxRow = orientation === "VERTICAL" ? BOARD_SIZE - length : BOARD_SIZE - 1;
        const maxCol = orientation === "HORIZONTAL" ? BOARD_SIZE - length : BOARD_SIZE - 1;
        const startRow = Math.floor(Math.random() * (maxRow + 1));
        const startCol = Math.floor(Math.random() * (maxCol + 1));
        const candidate: Placement = { shipClass, orientation, startRow, startCol };
        const cells = cellsFor(candidate, length);
        if (!cells) continue;
        if (cells.some(([r, c]) => occupied.has(`${r},${c}`))) continue;
        for (const [r, c] of cells) occupied.add(`${r},${c}`);
        placements.push(candidate);
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }

    if (ok) {
      validateFleet(placements); // defensive: prove it before returning
      return placements;
    }
  }
  throw new Error("Failed to generate a legal fleet after many attempts");
}
