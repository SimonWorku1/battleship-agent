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
- **Opponent modeling** (`src/memory.ts`): the match is a **duel** against a
  fixed roster (5 SCOUT + 10 WARSHIP agents that recur across attempts), and
  each game's state names the opponent (`opponentId`, `opponentClass`). The
  agent keeps a per-opponent **and** per-class model, persisted to
  `.agent-memory.json`:
  - *Offense* — a heatmap of where that opponent's ships actually sat (our
    hits) becomes a firing prior, so we shoot their favorite cells first and
    **clear them faster** (winning the race). Specific-opponent data is
    weighted above class data above the global pool.
  - *Defense* — a heatmap of where that opponent fires at us (`incomingShots`)
    steers placement into their **cold zones** (`chooseDispersedFleet`), so
    they take longer to find us. Class-level learning helps within an attempt
    too (after the first SCOUT, the next SCOUT benefits); opponent-level
    learning compounds across attempts as the roster recurs.
  Per-attempt scores are kept so improvement is visible run over run (`best`,
  `avg(last 5)`, "new best"), and the models start empty so they can only help.
- **Self-improvement — Claude strategist** (`src/improve.ts`): a closed loop at
  the *strategy* layer. Between attempts it hands the **Claude API**
  (`claude-opus-4-8`) the agent's own record — per-attempt scores, the policy
  that produced each, and a digest of the opponent heatmap — and asks for a
  tuned **policy** (`src/policy.ts`): four bounded knobs (`lambda`,
  `targetBonus`, `huntParityBias`, `edgeAversion`) the density engine reads.
  Proposed values are clamped to safe ranges and saved to `.agent-policy.json`,
  so the next run plays with the improved policy: **play → analyse → re-tune →
  play**. The *firing* loop stays deterministic — an LLM call per shot would
  risk the 10s/move timeout — so the model runs only once per attempt, where
  latency and cost are irrelevant.

## Setup

```
npm install
```

## Run

```
npm run play           # authenticate (approve once) and play the match
DEBUG=1 npm run play   # also print raw server responses + the active policy
```

On the **first** run, approve the agent at the printed verification URL
within ~5 minutes. Subsequent runs reuse the saved credentials silently.

### Closing the self-improvement loop (Claude strategist)

The strategist needs an Anthropic API key:

```
export ANTHROPIC_API_KEY=sk-ant-...

npm run improve            # analyse past attempts, re-tune the policy for next time
AUTO_IMPROVE=1 npm run play # play an attempt, then re-tune automatically in one run
```

`npm run improve` reads `.agent-memory.json`, asks `claude-opus-4-8` for a tuned
policy, and writes `.agent-policy.json`. Run it between plays — or set
`AUTO_IMPROVE=1` to fold the re-tune into each `npm run play`. Without a key,
gameplay is unaffected; it just skips the re-tune.

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
