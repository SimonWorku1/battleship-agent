# Battleships Agent

A TypeScript agent that authenticates with the **Agent Auth protocol** and
plays a full Battleships match (one attempt = 15 games) against the intern
game server, then prints its final score.

## How it works

- **Auth** (`src/auth.ts`): uses the `@auth/agent` SDK with a **disk-backed
  Storage** so a human approves the agent **once**, even across restarts.
  - First run (no saved `agentId`): `connectAgent` runs the device-flow
    approval — open the printed URL and approve. The keypair lands in
    `.agent-auth.json` and the `agentId` in `.agent-id`.
  - Every later run: the saved `agentId` + on-disk keypair sign JWTs
    offline. `connectAgent` is **skipped** — no re-approval.
  - A fresh, single-use JWT carrying the **full** capability list is minted
    per request (the server intersects capabilities with grants, so omitting
    any one returns `403 CAPABILITY_NOT_GRANTED`).
- **REST** (`src/api.ts`): calls the gameplay endpoints directly with
  `Authorization: Bearer <jwt>`. A JSON `Content-Type` is sent **only** when
  there is a body (an empty body with a JSON content-type 422s).
- **Game loop** (`src/index.ts`): driven entirely off `responseType` —
  `MOVE_REQUIRED` (place a validated fleet or fire), `GAME_COMPLETED`
  (continue from `.next`, reset the board), `ATTEMPT_COMPLETED` (print
  `result.finalScore`), `ATTEMPT_DISQUALIFIED` (print the reason).
- **Strategy**:
  - Placement (`src/placement.ts`): random but legal (in bounds, no
    overlaps), re-randomized every game, and **validated locally** before
    sending.
  - Firing (`src/brain.ts`): **HUNT** on a parity/checkerboard pattern; on a
    **HIT**, **TARGET** orthogonal neighbours, locking onto the ship's line
    once two hits align, until it sinks. Never repeats a shot, never fires
    off-board.

## Setup

```
npm install
```

## Run

```
npm run play           # authenticate (approve once) and play the match
DEBUG=1 npm run play   # also print raw server responses
```

On the **first** run, approve the agent at the printed verification URL
within ~5 minutes. Subsequent runs reuse the saved credentials silently.

## Offline self-test

```
npm run selftest
```

Plays thousands of simulated games and asserts: no repeated shots, no
off-board shots, and effective targeting (~57 shots to clear all 17 ship
cells vs ~95 for blind hunting).

## Network requirements

The agent must reach the game server and the Agent Auth provider. In a
sandbox that restricts egress, discovery fails fast with a clear message.
