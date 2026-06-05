// Domain types for the Battleships game.

export const BOARD_SIZE = 10;

export type ShipClass =
  | "CARRIER"
  | "BATTLESHIP"
  | "CRUISER"
  | "SUBMARINE"
  | "DESTROYER";

export type Orientation = "HORIZONTAL" | "VERTICAL";

/** The standard fleet: one of each, with its length. */
export const FLEET: ReadonlyArray<{ shipClass: ShipClass; length: number }> = [
  { shipClass: "CARRIER", length: 5 },
  { shipClass: "BATTLESHIP", length: 4 },
  { shipClass: "CRUISER", length: 3 },
  { shipClass: "SUBMARINE", length: 3 },
  { shipClass: "DESTROYER", length: 2 },
];

export interface Placement {
  shipClass: ShipClass;
  orientation: Orientation;
  startRow: number;
  startCol: number;
}

export type ResponseType =
  | "MOVE_REQUIRED"
  | "GAME_COMPLETED"
  | "ATTEMPT_COMPLETED"
  | "ATTEMPT_DISQUALIFIED";

export type NextRequiredMove = "PLACE_SHIPS" | "SUBMIT_SHOT";

/**
 * Loose model of the server's response envelope. The exact gameplay schema
 * is intentionally read defensively (see interpret.ts) because the
 * live OpenAPI is the source of truth and may carry extra fields.
 */
export interface ServerResponse {
  responseType?: ResponseType;
  /** Embedded follow-up response (GAME_COMPLETED carries the next game here). */
  next?: ServerResponse;
  /** Current game/attempt state when a move is required. */
  state?: GameState;
  /** Final result for ATTEMPT_COMPLETED. */
  result?: { finalScore?: unknown; [k: string]: unknown };
  /** Disqualification reason. */
  reason?: string;
  message?: string;
  error?: string;
  [k: string]: unknown;
}

export interface GameState {
  nextRequiredMove?: NextRequiredMove;
  /** Result of the most recent shot — may be an object or a plain string. */
  lastShot?: unknown;
  shotResult?: unknown;
  /** Board / shot history, shapes vary; read defensively. */
  board?: unknown;
  shots?: unknown;
  [k: string]: unknown;
}

export interface ShotResultObject {
  row?: number;
  col?: number;
  /** HIT | MISS | SUNK (server vocabulary may vary in casing). */
  result?: string;
  outcome?: string;
  status?: string;
  hit?: boolean;
  sunk?: boolean;
  shipClass?: ShipClass;
  [k: string]: unknown;
}
