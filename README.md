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
  - Firing (`src/brain.ts`): a **probability-density engine**. Every shot it
    superimposes every legal placement of the still-floating fleet over the
    board and fires the highest-density un-shot cell. This unifies hunting
    (a parity-optimal search concentrated where the largest remaining ship
    likely sits) and targeting (placements that explain outstanding hits are
    weighted by how many they cover, so a line's open ends dominate). Never
    repeats a shot, never fires off-board.
- **Self-improvement** (`src/memory.ts`): after every game the agent records
  where the opponent's ships actually were into a per-cell heatmap, persisted
  to `.agent-memory.json`. That heatmap becomes a **prior** that biases the
  density engine toward historically ship-dense cells, so it tends to find
  ships faster the more it plays. The prior starts uniform and is gentle by
  design: with no data (or a uniformly-random opponent) it stays ~1 and can't
  hurt; any real placement bias only helps. Per-attempt scores are also kept
  so improvement is visible run over run (`best`, `avg(last 5)`, "new best").

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
off-board shots, and effective targeting (~45 shots to clear all 17 ship
cells vs ~95 for blind hunting). It also runs a **self-improvement check**:
against a biased opponent it shows that learning a prior from past games
measurably reduces the shots needed in later games.

## Network requirements

The agent must reach the game server and the Agent Auth provider. In a
sandbox that restricts egress, discovery fails fast with a clear message.
