# Ember — Agent Status Log
*Last updated: 2026-04-25 | Session paused at token limit*

---

## What Ember Is

Ember is a Minecraft autonomous agent built on **Mineflayer + local LLM (llama3.2 via Ollama)**.
It runs on a local Spigot 1.21.4 server (offline mode, port 25565).
No cloud, no TypeScript, no databases — pure Node.js.

---

## Phases Completed

### Phase 1 — Bot joins + random movement
- Bot connects to server as `Ember`
- Basic mineflayer setup

### Phase 2 — Perception
- Detects nearest player
- `lookAt()` player
- Distance tracking
- Block detection (`blockAt`)

### Phase 3 — Chat commands
- `follow me` → start following
- `stop` → stop
- `status` → report state
- `remember here` → save location
- `where is X` → recall location

### Phase 4 — Internal state
- `energy` (0–100) drains while active, recharges at rest
- `hunger` (0–100) drains over time
- Goal system: idle / following / resting
- Exhaustion → auto-rest at energy ≤ 15

### Phase 5 — Persistent memory
- `memory.json` written on every change
- Stores: locations, events, knowledge key-values
- Survives bot restarts
- `rememberLocation`, `rememberEvent`, `rememberKnowledge`, `recallLocation`

### Phase 6 — Sense → Decide → Act loop
- Formal agent loop at 250ms
- Priority-ordered decision rules: water > exhaustion > resting > following > idle
- Jump detection via yaw + `isBlockedAhead()`
- Swim detection via `bot.entity.isInWater`

### Phase 7 — LLM integration (Ollama / llama3.2)
- Natural language understanding via local LLM
- Few-shot examples in system prompt for 3B model reliability
- Hard code guards: LLM sets goal, code enforces physics/energy
- JSON output schema: `{action, reply}`
- Fallback to pattern commands when LLM offline

### Phase 8 — True Autonomy + Pathfinding
- **mineflayer-pathfinder** replaces manual `setControlState` for navigation
- `GoalFollow(entity, range)` with dynamic=true for player following (handles obstacles)
- `GoalNear` for explore and go_to tasks
- `taskGatherWood()` — finds nearest log via `bot.findBlock()`, pathfinds, digs
- `taskExplore()` — random direction walk with full obstacle avoidance
- `taskGoTo(name)` — navigate to any saved location by name
- Autonomous idle behavior: after 20s idle, picks explore/gather/narrate on its own
- Environment scan: reports real trees, water, mobs via `bot.findBlock()` + `bot.entities`

### Phase 8.5 — Grounded Reasoning + Decision Engine (current)
Full refactor into 5 files. Architecture:

```
message → classifyIntent() → evaluateSurvival() → buildGroundedState()
        → queryLLM() → validateLLMOutput() → executeAction() → remember
```

**New files created:**

- `state.js` — `buildGroundedState(bot, state, memory)`:
  - Real inventory from `bot.inventory.items()`
  - Real nearby blocks from `bot.findBlock()` (20 block radius, 10 block types)
  - Real visible entities from `bot.entities`
  - No inferred or assumed data

- `engine.js` — Decision engine:
  - `classifyIntent(message)` — pre-LLM regex pattern classifier (follow/stop/gather/explore/build/query)
  - `evaluateSurvival(state)` — short-circuits LLM when energy critical or resting
  - `validateLLMOutput(raw)` — strict schema validation, returns null if invalid
  - `safeDefault(intent)` — fallback decision when LLM fails
  - `selectAutonomousGoal(groundedState)` — structured autonomous goal selection

- `llm.js` — Updated Ollama integration:
  - New output schema: `{decision, reason, action, say}`
  - `decision`: accept / reject / delay
  - `reason`: honest explanation (grounded only)
  - Prompt explicitly bans hallucination: "Never invent facts not in GROUNDED STATE"
  - Temperature lowered to 0.5 for more reliable outputs

- `bot.js` — Orchestrates the pipeline:
  - Safe action map: LLM output → actual pathfinder/state functions
  - LLM never directly controls movement
  - Double-guard on `gather_wood`: LLM checks nearbyBlocks + code re-checks before runTask()
  - Survival system restored: hunger + energy
  - `taskBusy` flag prevents overlapping async pathfinder tasks

**LLM output format:**
```json
{
  "decision": "accept | reject | delay",
  "reason": "honest, grounded reason",
  "action": "follow | stop | explore | gather_wood | go_to | remember_here | none",
  "say": "plain text response under 100 chars"
}
```

---

## What Works Right Now

- Bot joins server, spawns, says "Ready."
- Talks naturally via llama3.2 (Ollama local)
- Follows player with pathfinder (navigates around trees, hills, water)
- Chops trees autonomously when found
- Navigates to named locations (spawn, marked spots)
- Answers "where are you" with real coordinates
- Answers "what do you have" with real inventory (not hallucinated)
- Rejects "find fish", "build a house", "craft a pickaxe" honestly
- After 20s idle → walks around or gathers wood on its own
- Exhausts, rests, recovers — without player involvement
- Memory persists across restarts (locations, events, knowledge)

---

## Known Remaining Issues

- Cannot genuinely pathfind long distances (>50 blocks): pathfinder may timeout on complex terrain
- Autonomous goal only picks explore or gather_wood; future: scouting, sleeping, building
- No multi-agent support yet (Phase 9 pending)
- `item` entities in vision list (dropped items) — should be filtered from entity display
- Sand/gravel gathering not implemented (can find, can't dig yet — no tool equip)

---

## Next Session — Phase 9 (Multi-Agent)

Plan:
- Launch 2–3 bots (Ember, Flint, maybe Scout)
- Shared `memory.json` or socket-based communication
- Role-based behavior: Ember = leader/communicator, Flint = gatherer, Scout = explorer
- Simple message bus: bots broadcast state to each other via in-game chat or file
- Division of labor: leader assigns tasks, others execute and report back

---

## File Map

```
mc-server/bot/
  bot.js       — main loop, agent pipeline, action execution, pathfinder tasks
  engine.js    — intent classifier, survival check, LLM validation, safe defaults
  state.js     — buildGroundedState() — real sensor data only
  llm.js       — Ollama integration, prompt builder, JSON parser
  memory.js    — loadMemory, saveMemory, rememberLocation/Event/Knowledge
  package.json — mineflayer + mineflayer-pathfinder
```

---

## How to Run

```bash
# 1. Start Minecraft server
cd mc-server && java -Xmx1G -jar server.jar nogui

# 2. Start Ollama with llama3.2
ollama run llama3.2

# 3. Start bot
cd mc-server/bot && npm start
```

Server: Spigot 1.21.4 | offline-mode=true | port=25565 | difficulty=peaceful
