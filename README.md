# project-k — Minecraft Autonomous Agent

A Minecraft bot that thinks, decides, and acts on its own.
Built with **Mineflayer** + **local LLM (llama3.2 via Ollama)**. No cloud. No TypeScript. No databases.

---

## What it does

**Ember** is an autonomous agent living inside a Minecraft world. She has:

- **Natural language understanding** — talk to her normally, she figures out what you mean
- **Real perception** — sees nearby blocks, entities, and her own inventory (no hallucination)
- **Pathfinding** — navigates around obstacles, trees, water, hills
- **Autonomy** — after 20 seconds of inactivity, she picks her own goals: explore, gather wood, narrate surroundings
- **Persistent memory** — remembers locations and events across restarts
- **Internal state** — energy drains while active, recharges at rest; gets tired and refuses commands when exhausted

```
<Dormanor> bro where are you
<Ember> I'm at (-149, 64, -34).

<Dormanor> come to me
<Ember> On my way.

<Dormanor> what do you have
<Ember> I have: oak_logx3.

<Dormanor> find some fish
<Ember> Can't fish. Not something I can do.

<Dormanor> get some wood
<Ember> Chopping that tree.
```

---

## Architecture

```
Player message
      │
      ▼
classifyIntent()          ← pre-LLM regex (follow/stop/gather/explore/build/query)
      │
      ▼
evaluateSurvival()        ← short-circuit if energy critical or resting
      │
      ▼
buildGroundedState()      ← real inventory + real nearby blocks + real entities
      │                      (no inferred data, no hallucination possible)
      ▼
queryLLM()                ← llama3.2 via Ollama, grounded prompt
      │
      ▼
validateLLMOutput()       ← strict schema check → safeDefault() on failure
      │
      ▼
executeAction()           ← safe action map → pathfinder / state change
      │
      ▼
rememberEvent()           ← structured memory, important events only
```

**Decision priority:** survival > current goal > player command

**LLM output schema:**
```json
{
  "decision": "accept | reject | delay",
  "reason": "grounded, honest reason",
  "action": "follow | stop | explore | gather_wood | go_to | remember_here | none",
  "say": "plain text under 100 chars"
}
```

---

## File Structure

```
mc-server/bot/
├── bot.js        Main loop · agent pipeline · pathfinder tasks · action execution
├── engine.js     Intent classifier · survival check · LLM validation · safe defaults
├── state.js      buildGroundedState() — real sensor data, nothing inferred
├── llm.js        Ollama integration · prompt builder · output parser
├── memory.js     Persistent memory — locations, events, knowledge
└── package.json  mineflayer + mineflayer-pathfinder
```

---

## Setup

### Requirements

- Node.js 18+
- [Ollama](https://ollama.com) with llama3.2 pulled
- Java 17+ (for the Minecraft server)
- Minecraft 1.21.4 client

### Run

```bash
# 1. Pull the model (first time only)
ollama pull llama3.2

# 2. Start the Minecraft server
cd mc-server
java -Xmx1G -jar server.jar nogui

# 3. Start the bot
cd mc-server/bot
npm install
npm start
```

Connect to `localhost:25565` in Minecraft. Ember joins automatically.

---

## Commands (in Minecraft chat)

| Say | What happens |
|-----|-------------|
| `follow me` | Ember pathfinds to you, keeps 2 blocks away |
| `stop` | Stops all movement |
| `go explore` | Walks to a random location 25–55 blocks away |
| `get some wood` | Finds nearest tree, pathfinds, chops it |
| `go to spawn` | Navigates to a saved location by name |
| `remember here` | Saves your current coordinates |
| `where is spawn` | Recalls saved coordinates |
| `what do you have` | Reports real inventory |
| `where are you` | Reports real coordinates |
| `status` | Energy + hunger + current goal |

You can also talk naturally — the LLM interprets intent.

---

## Design Principles

**No hallucination** — `buildGroundedState()` only passes facts from bot APIs (`bot.inventory.items()`, `bot.findBlock()`, `bot.entities`). The LLM prompt explicitly forbids inventing data.

**LLM never controls movement** — The LLM returns a decision. `executeAction()` is the only path to pathfinder calls. Invalid or unsafe decisions are caught before execution.

**Survival is hardcoded** — Energy/exhaustion logic lives in the agent loop, not the LLM. The LLM can be wrong; the code enforces it anyway.

**Graceful degradation** — If Ollama is offline, the bot falls back to regex pattern commands and keeps working.

---

## Phases Built

| Phase | What was built |
|-------|---------------|
| 1 | Bot joins server |
| 2 | Player detection, look-at, distance sensing |
| 3 | Chat command system |
| 4 | Energy + hunger + goal state machine |
| 5 | Persistent memory (memory.json) |
| 6 | Formal sense → decide → act loop |
| 7 | LLM integration (Ollama / llama3.2) |
| 8 | Pathfinding, wood gathering, autonomous behavior |
| 8.5 | Grounded reasoning, decision engine, anti-hallucination |
| 9 | Multi-agent system *(next)* |

---

## Stack

- **[Mineflayer](https://github.com/PrismarineJS/mineflayer)** — Minecraft bot framework
- **[mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder)** — A* pathfinding
- **[Ollama](https://ollama.com)** — Local LLM runtime
- **llama3.2** — 3B parameter model, runs on CPU
- **Spigot 1.21.4** — Minecraft server (offline mode)
