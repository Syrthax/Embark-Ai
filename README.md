# project-k — Autonomous Minecraft Agent

A Minecraft bot that thinks, defends itself, and gets things done.
Built with **Mineflayer** + **local LLM via Ollama**. No cloud, no TypeScript, no databases.

---

## What Ember does

- **Talks naturally** — local LLM interprets intent ("build me a house" → plans wood gathering + plank crafting + construction)
- **Has a real personality** — stubborn, refuses dumb requests, holds grudges
- **Defends itself** — attacks back when hit, gets angry at insults, escalates to combat
- **Multi-step planning** — chains gather → craft → build automatically
- **Survives autonomously** — energy, hunger, exhaustion, rest, threat reaction
- **Real perception** — sees inventory, blocks, mobs, drops via Mineflayer APIs (no hallucination)
- **Pathfinds anywhere** — handles obstacles, water, terrain
- **Reports errors in chat** — if something fails, you see why in-game

```
<Dormanor> build me a house
<Ember> Starting house. Will gather and craft if needed.
<Ember> Have 0 planks, need 30 more. Gathering wood (try 1/12).
<Ember> Got wood.    [...repeats...]
<Ember> Made 32 planks.
<Ember> Have 32 planks. Building now.
<Ember> House done!

<Dormanor> hey asshole
<Ember> Watch your mouth, Dormanor.
<Dormanor> fuck you
<Ember> That's it, Dormanor. I warned you.
<Ember> Coming for you, Dormanor.
```

---

## Architecture

```
chat message
     │
     ├─► detectInsult()        ← anger++ / attack at threshold
     │
     ▼
classifyIntent()                ← regex pattern (follow/build/attack/...)
     │
     ▼
evaluateSurvival()              ← short-circuit if exhausted
     │
     ▼
buildGroundedState()            ← real inventory + blocks + mobs + drops + anger
     │                            (no hallucination — only verified Mineflayer data)
     ▼
queryLLM(qwen2.5-coder:14b)     ← grounded prompt → strict JSON output
     │
     ▼
validateLLMOutput()             ← schema check → safeDefault() on failure
     │
     ▼
executeAction()                 ← LLM never controls movement directly
     │                            calls runTask() → pathfinder / pvp / craft
     ▼
errors → bot.chat()             ← every failure visible in-game
```

**Background loops (always running):**
- `entityHurt` listener → identify attacker → fight back
- Threat loop (every 2.5s) → auto-engage hostile mobs within 10 blocks
- Anger decay (every 1s) → grudges fade over time
- State loop (every 1s) → energy/hunger drain, autonomous goal selection
- Agent loop (every 250ms) → look at player, follow, water survival

---

## CLI

A control panel for the project. Manages the Minecraft server and one or more bots, each with its own Ollama model.

```bash
node cli.js
```

```
╔══════════════════════════════════════════════╗
║          project-k Control Panel             ║
╚══════════════════════════════════════════════╝
Server: ● Running (PID 5977)
Bots:
  ● Ember (qwen2.5-coder:14b, PID 15940, up 142s)

Actions:
  [1] Start server         [5] Restart bot
  [2] Stop server          [6] View logs
  [3] Spawn bot            [7] List Ollama models
  [4] Stop bot             [q] Quit (kills everything)
```

**Features:**
- Start/stop the Minecraft server
- Spawn multiple bots with different names + Ollama models
- Hot-restart a bot without losing state
- Tail bot/server logs interactively
- Lists Ollama models from `/api/tags`
- All errors caught and displayed; SIGINT/SIGTERM cleanly kill children

CLI tracks only processes it spawned. If you start the server externally, the CLI won't see it.

---

## File Structure

```
project-k/
├── cli.js                    Control panel — server + bot management
├── README.md                 This file
├── status.md                 Phase-by-phase build log
├── .cli-logs/                Server + bot logs (auto-created)
└── mc-server/
    ├── server.jar            (gitignored)
    ├── server.properties     difficulty=easy (mobs spawn)
    └── bot/
        ├── bot.js            Main loop, tasks, action execution, defense
        ├── engine.js         Intent classifier, validation, anger/insult
        ├── state.js          Grounded state — real sensor data only
        ├── llm.js            Ollama integration (model via env)
        ├── memory.js         Persistent memory (locations, events)
        └── package.json      mineflayer + pathfinder + pvp
```

---

## Setup

```bash
# 1. Install Ollama and pull a capable model
ollama pull qwen2.5-coder:14b      # recommended (9 GB) — best reasoning
# or
ollama pull llama3.2               # smaller (2 GB) — works but limited

# 2. Install bot dependencies
cd mc-server/bot && npm install && cd ../..

# 3. Run the CLI
node cli.js
# Then: [1] start server, wait ~10s, [3] spawn bot, pick model

# Or run manually:
cd mc-server && java -Xmx2G -jar server.jar nogui     # terminal 1
cd mc-server/bot && npm start                          # terminal 2
```

**Environment variables (override per-bot):**
- `BOT_NAME`     default `Ember`
- `OLLAMA_MODEL` default `qwen2.5-coder:14b`
- `OLLAMA_URL`   default `http://localhost:11434/api/chat`
- `SERVER_HOST`  default `localhost`
- `SERVER_PORT`  default `25565`
- `MC_VERSION`   default `1.21.4`

```bash
BOT_NAME=Flint OLLAMA_MODEL=llama3.2 npm start
```

---

## Commands (in Minecraft chat)

Just talk naturally — the LLM interprets it. Direct commands also work:

| Say | What happens |
|-----|-------------|
| `follow me` | Pathfinds to you, follows continuously |
| `stop` | Stops everything (movement, combat, building) |
| `build me a house` | Smart agentic build: gathers wood, crafts planks, places blocks |
| `make planks` | Converts logs in inventory to planks |
| `craft a wooden_pickaxe` | Looks up recipe, crafts if materials available |
| `kill that zombie` / `attack` | Equips best weapon, engages hostile mob |
| `pick up those items` | Pathfinds to dropped items, auto-picks up |
| `get some wood` | Finds nearest log, chops it |
| `go to spawn` | Navigates to a saved location by name |
| `where are you` | Reports real coordinates |
| `what do you have` | Reports real inventory |
| `status` | Shows energy, hunger, current goal, anger count |
| **(insult Ember)** | Anger increases — at threshold, Ember attacks you |
| **(hit Ember)** | Identifies attacker — at threshold, retaliates |

---

## Design Principles

**Anti-hallucination** — `buildGroundedState()` returns only what `bot.inventory.items()`, `bot.findBlock()`, and `bot.entities` actually report. The LLM prompt explicitly forbids inventing facts.

**LLM never controls movement** — The LLM picks an action label. `executeAction()` is the only path to pathfinder / pvp. Invalid outputs fall back to `safeDefault(intent)`.

**Agentic, not just reactive** — `taskBuildHouseSmart` is a single user request that internally chains `gather_wood × N` → `craft_planks` → `placeBlock × 70`. The bot reasons about its own dependencies.

**Survival is hardcoded** — Energy, exhaustion, water survival, and threat reaction live outside the LLM. The LLM can be wrong; the code enforces physical reality.

**Errors surface to the player** — Every task wraps its body in try/catch and calls `bot.chat("Error: ...")`. `uncaughtException` and `unhandledRejection` also chat before exit.

**Anger system** — Insults add 1, hits add 4. Decays at 0.05/sec. Warns at level 3, attacks at level 5. Equips best weapon. After fighting, anger drops by 3.

---

## Build Phases

| Phase | What was built |
|-------|---------------|
| 1 | Bot joins server |
| 2 | Player detection, look-at, distance |
| 3 | Chat command system |
| 4 | Energy + hunger state machine |
| 5 | Persistent memory |
| 6 | Sense → decide → act loop |
| 7 | LLM integration (llama3.2) |
| 8 | Pathfinding, wood gathering, autonomy |
| 8.5 | Decision engine + grounded state |
| 9 | Combat, item collection, crafting, house building |
| 10 | **Self-defense, anger system, agentic chaining, qwen2.5-coder:14b, CLI** *(current)* |

---

## Stack

- **[Mineflayer](https://github.com/PrismarineJS/mineflayer)** — Minecraft bot framework
- **[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)** — A* pathfinding
- **[mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp)** — combat plugin
- **[Ollama](https://ollama.com)** — local LLM runtime
- **qwen2.5-coder:14b** — 14B parameter model, excellent at structured JSON output
- **Spigot 1.21.4** — Minecraft server (offline mode)
