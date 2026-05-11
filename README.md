# embark-ai — Autonomous Minecraft Agent

A Minecraft bot that thinks, survives, defends itself, and completes multi-step tasks.
Built on **Mineflayer** + **Featherless AI** (cloud) or **Ollama** (local LLM). No TypeScript, no databases.

---

## What Ember does

- **Talks naturally** — LLM interprets intent: "build me a house" chains wood-gathering → plank-crafting → construction automatically
- **Has a real personality** — stubborn, witty, refuses nonsense, holds grudges
- **Defends itself** — attacks back when hit, escalates with insults, equips best weapon
- **Survives autonomously** — manages hunger, energy, hazard avoidance, water escape, falling
- **Multi-step planning** — single requests like `build a house` or `mine 5 iron ore` chain multiple tasks internally
- **Grounded perception** — inventory, nearby blocks, mobs, drops read directly from Mineflayer APIs (zero hallucination)
- **Resilience architecture** — position-guard, desync recovery, task watchdogs, supervised restart with backoff
- **Reports everything in chat** — if a task fails, you see the reason in-game

```
<player> build me a house
<Ember>  Starting house. Will gather and craft if needed.
<Ember>  Got wood. Making planks. Have 32 planks. Building now.
<Ember>  House done!


<player> mine 5 iron_ore
<Ember>  On it.
<Ember>  Mined 5 iron_ore.
```

---

## Architecture

### Request pipeline

```
chat message
     │
     ├─► detectInsult()           anger++ / attack at threshold
     │
     ▼
classifyIntent()                  regex pre-filter (follow / build / attack / ...)
     │
     ▼
evaluateSurvival()                short-circuit if critically exhausted
     │
     ▼
buildGroundedState()              real inventory + blocks + mobs + drops + anger
     │                            only verified Mineflayer sensor data
     ▼
queryLLM()                        grounded prompt → strict JSON output
     │                            Featherless AI or Ollama (same code path)
     ▼
validateLLMOutput()               schema check → safeDefault() on failure
     │
     ▼
executeAction()                   LLM never controls movement directly
     │                            routes to runTask() → pathfinder / pvp / craft
     ▼
errors → bot.chat()               every failure surfaced in-game
```

### Background loops (always running)

| Loop | Interval | What it does |
|------|----------|-------------|
| `entityHurt` listener | event | identifies attacker, fights back |
| Threat loop | 2.5 s | auto-engages hostile mobs within 10 blocks |
| Anger decay | 1 s | insults +1, hits +4, decays 0.05/s; attacks at level 5 |
| State loop | 1 s | energy/hunger drain, autonomous goal selection |
| Agent loop | 250 ms | look-at player, follow, water survival |
| Environment perception | 3 s | scans 6-block radius for hazards, cliff edges, enclosures |
| physicsTick guard | ~50 ms | restores NaN position from cache if a hit corrupts it |

### Resilience system

Ember has a layered resilience architecture that keeps her running under game physics edge cases, server desync, and combat:

| Component | File | Role |
|-----------|------|------|
| `positionGuard` | `positionGuard.js` | Detects NaN position caused by knockback, restores from cache on every physics tick (~50 ms). Prevents the ~6 s freeze-on-hit. |
| `entityLiveness` | `entityLiveness.js` | 5-state monitor: `LIVE_VALID → TRANSIENT_INVALID → STALE_USING_CACHE → RECOVERING → FATAL`. Declares desync in ~5–8 s. |
| `recoveryEngine` | `recoveryEngine.js` | Single arbiter for all recovery. Maps symptoms (DESYNC, STUCK, CRITICAL_HP, …) to escalation classes. Sole owner of `bot.quit()`. |
| `fatalDesyncRecovery` | `fatalDesyncRecovery.js` | Independent 2 s poller; reports `DESYNC` to `recoveryEngine` when entity is fatally stale. |
| `healthIntegrityWatchdog` | `healthIntegrityWatchdog.js` | Detects HP drops not caught by the event stream. |
| `movementController` | `movementController.js` | Sole writer to `bot.pathfinder`. Token-based ownership prevents multiple tasks from racing on movement. |
| `goalRegistry` | `goalRegistry.js` | Sole mutator of `state.goal`. All goal changes go through `setGoal()`. |
| `damagePipeline` | `damagePipeline.js` | Single damage-reaction authority. Classifies and routes player hits, mob attacks, environmental damage. Staging flag prevents health-handler / damage-window races. |
| `locomotionRecovery` | `locomotionRecovery.js` | Raw-control-state escape sequences for physically stuck situations. Separate from desync recovery (which only reconnects). |
| `environmentPerception` | `environmentPerception.js` | Scans surrounding blocks for lava, water, cliff edges, enclosed spaces, traversability. Returns `{ valid: false }` on NaN position instead of silently reporting "all clear". |
| `botSupervisor` | `botSupervisor.js` | Wraps the bot process with exit-reason classification, per-class exponential backoff, restart storm protection (≥5 restarts in 10 min → halt). |

### LLM integration

Both backends use the same `llm.js` code path. Ollama mode overrides `FEATHERLESS_URL` to point at Ollama's OpenAI-compatible endpoint.

```
Featherless AI  →  api.featherless.ai/v1/chat/completions  (cloud, 3000+ models)
Ollama          →  localhost:11434/v1/chat/completions      (local, private)
```

**LLM output schema:**
```json
{
  "decision": "accept | reject | delay",
  "reason":   "...",
  "action":   "follow | stop | explore | gather_wood | craft_planks | go_to | remember_here |
               attack_mobs | attack_player | collect_items | craft | place_block | mine_block |
               eat_food | flee | escape | build_house_smart | none",
  "say":      "...",
  "target":   "..."
}
```

Invalid or missing output falls back to `safeDefault(intent)`. The LLM picks an action label — it never touches movement or pathfinder directly.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Bot framework | [Mineflayer](https://github.com/PrismarineJS/mineflayer) |
| Pathfinding | [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) |
| Combat | [mineflayer-pvp](https://github.com/PrismarineJS/mineflayer-pvp) |
| Cloud LLM | [Featherless AI](https://featherless.ai) — OpenAI-compatible API, 3,000+ models |
| Local LLM | [Ollama](https://ollama.com) — runs models locally, no GPU required for small models |
| TUI | [blessed](https://github.com/chjj/blessed) |
| Minecraft server | Vanilla Java Edition 1.21.4 |
| Runtime | Node.js 18+ |
| Language | CommonJS JavaScript — no TypeScript, no databases |

---

## System Requirements

| Requirement | Minimum |
|-------------|---------|
| Node.js | 18+ |
| Java | 21+ (for the Minecraft server) |
| RAM | 4 GB (bot + server); 8 GB recommended |
| OS | macOS, Linux (Windows via WSL) |
| Disk | ~1 GB for server + world data |

**For Ollama (local LLM):**

| RAM available | Recommended model | Download size |
|---------------|------------------|---------------|
| < 4 GB | `llama3.2:1b` | 1.3 GB |
| 4–8 GB | `llama3.2` | 2.0 GB |
| 16 GB | `qwen2.5-coder:14b` | 9 GB |
| 32 GB+ | `qwen2.5:32b` | 20 GB |

**For Featherless AI (cloud):**
- API key from [featherless.ai](https://featherless.ai) (format: `rc_xxx`)
- No GPU, no local model download required

---

## Setup

### 1. Install dependencies

```bash
npm install                        # TUI (blessed)
cd mc-server/bot && npm install    # Bot (mineflayer, pathfinder, pvp)
cd ../..
```

### 2. Java 21+

```bash
# macOS
brew install openjdk@21

# Linux (Debian/Ubuntu)
sudo apt install openjdk-21-jdk
```

### 3. Minecraft server jar

Download the Minecraft Java Edition 1.21.4 server jar from `minecraft.net/download/server` and place it at:

```
mc-server/server.jar
```

### 4. Run

```bash
npm start
# or: node tui.js
```

On first launch the **onboarding wizard** opens automatically:

1. Choose **Ollama** (local) or **Featherless API** (cloud)
2. **Ollama path** — detects installation; if missing, shows the install command; reads your RAM and recommends a model; walks through `ollama pull <model>`
3. **Featherless path** — prompts for API key, then shows a model picker
4. **Server check** — verifies `server.jar` is present

Config is saved to `.ember-config.json` (gitignored). Press `[8]` in the TUI at any time to change backend, model, or API key.

---

## TUI

```
┌─ embark-ai ─ ● Server localhost:25565 ─ Bots: ● Ember (llama3.2, 142s) ────┐
├─ Bot Status ────────────────────┬─ Actions ──────────────────────────────────┤
│ Ember                           │ AI: Ollama (llama3.2)                      │
│                                 │                                            │
│ HP:    ████████████░░ 18.0/20  │ [1] Start server                          │
│ Food:  ████████████████ 20/20  │ [2] Stop server                           │
│ Goal:  following               │ [3] Spawn bot                             │
│ Pos:   (12, 64, -8)            │ [4] Stop bot                              │
│ Anger: none                    │ [5] Restart bot                           │
│                                 │ [6] World settings                        │
│ Inventory:                      │ [7] List models                           │
│   oak_log x3, stick x4         │ [8] Reconfigure                           │
│                                 │ [s] Switch active bot                     │
├─ Live Log ──────────────────────┤                                            │
│ 14:23:01 [info] spawn_ok       │ ↑↓   scroll log                           │
│ 14:23:05 [info] task_start     │ Tab  switch focus                         │
│   action=follow                │ r    refresh                              │
│ ...                            │ q    quit                                 │
└─────────────────────────────────┴────────────────────────────────────────────┘
```

| Key | Action |
|-----|--------|
| `1` | Start Minecraft server |
| `2` | Stop Minecraft server |
| `3` | Spawn bot (choose name + model) |
| `4` | Stop a bot |
| `5` | Restart a bot (clean chain) |
| `6` | World settings — gamemode, difficulty, pvp, seed, view distance, … |
| `7` | List models (installed Ollama models or Featherless catalog) |
| `8` | Re-run onboarding (change AI backend, model, or API key) |
| `s` | Switch which bot the status panel shows |
| `↑↓` / `PgUp/Dn` | Scroll the live log |
| `Tab` | Cycle panel focus |
| `r` | Manual refresh |
| `q` / `Ctrl+C` | Quit — stops all managed processes cleanly |

Multiple bots with different names and models can run simultaneously.

---

## In-Game Commands

Speak naturally — the LLM interprets intent. Direct commands work too:

| Say | What happens |
|-----|-------------|
| `follow me` | Pathfinds to you, follows continuously |
| `stop` | Stops all movement and tasks |
| `explore` | Walks around autonomously |
| `build me a house` | Chains gather wood → craft planks → place 70 blocks |
| `get some wood` | Finds and chops the nearest log |
| `make planks` | Converts logs in inventory to planks |
| `craft a wooden_pickaxe` | Looks up recipe, crafts it (auto-makes sticks if needed) |
| `mine 5 iron_ore` | Mines that block type N times, auto-equips best tool |
| `place a crafting_table` | Places named block from inventory |
| `eat something` | Eats food from inventory |
| `kill that zombie` | Equips best weapon, engages nearest hostile mob |
| `pick up those items` | Walks to and collects nearby dropped items |
| `go to spawn` | Navigates to a saved location by name |
| `remember this place as base` | Saves current coordinates |
| `where are you` | Reports real coordinates |
| `what do you have` | Reports real inventory |
| `flee` | Runs away from the nearest hostile mob |
| `escape` / `you're stuck` | Pillars up or digs to surface |
| **(hit Ember)** | Anger +4; retaliates at threshold |
| **(insult Ember)** | Anger +1; warns at 3, attacks at 5 |

---

## File Structure

```
embark-ai/
├── tui.js                       TUI control panel — server + bot management + onboarding
├── botSupervisor.js             Supervised bot lifecycle: backoff, storm protection
├── package.json
└── mc-server/
    ├── server.jar               (gitignored — download separately)
    ├── server.properties
    └── bot/
        ├── bot.js               Main loop, action execution, agent/state/threat loops
        ├── engine.js            Intent classifier, LLM validation, anger/insult detection
        ├── state.js             buildGroundedState() — Mineflayer sensor data only
        ├── llm.js               Featherless AI / Ollama integration (same code path)
        ├── memory.js            Persistent memory — locations, events, knowledge
        ├── logger.js            Structured JSONL logger → events.jsonl
        ├── env.js               Environment variable loader
        ├── safeMineflayer.js    Safe wrappers: safeDig, safeCraft, safeAttack, …
        ├── movementController.js  Token-owned pathfinder writes
        ├── goalRegistry.js      Sole mutator of state.goal
        ├── entityLiveness.js    5-state entity validity monitor
        ├── positionGuard.js     physicsTick NaN position repair
        ├── recoveryEngine.js    Single recovery arbiter; sole bot.quit() owner
        ├── fatalDesyncRecovery.js  Desync reporter (independent 2 s poll)
        ├── healthIntegrityWatchdog.js  HP integrity watchdog
        ├── damagePipeline.js    Unified damage classification and reaction
        ├── tasks.js             All 16 task implementations
        ├── environmentPerception.js  Spatial scan — hazards, traversability
        ├── locomotionRecovery.js     Physical escape sequences
        └── package.json
```

---

## Design Principles

**Anti-hallucination** — `buildGroundedState()` returns only what `bot.inventory.items()`, `bot.findBlock()`, and `bot.entities` actually report. The LLM is explicitly told not to invent facts.

**LLM picks labels, code executes** — The LLM output is an action label. `executeAction()` is the only path to pathfinder, pvp, or crafting. Invalid LLM output falls back to `safeDefault(intent)`.

**Single authority per concern** — One module owns each resource: `movementController` for pathfinder, `goalRegistry` for `state.goal`, `recoveryEngine` for `bot.quit()`, `damagePipeline` for damage reactions.

**Token discipline** — Long-running async tasks mint a Symbol ownership token before starting. Every deferred callback checks `isOwner(myToken)` before acting, so a preempted task's callbacks silently no-op instead of racing with the new task.

**Survival is hardcoded** — Energy drain, hunger, water survival, threat reaction, and damage recovery live entirely outside the LLM path. The LLM can be wrong; the code enforces physical reality.

**Structured logging** — All events written as JSONL to `events.jsonl` with correlation IDs. The TUI tails this file live at 500 ms intervals.

**Errors surface to the player** — Every task body is wrapped in try/catch and calls `bot.chat("Error: ...")`.

---

## Environment Variables

Config is normally handled through TUI onboarding (saved to `.ember-config.json`). These env vars override it:

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_NAME` | `Ember` | In-game bot name |
| `SERVER_HOST` | `localhost` | Minecraft server host |
| `SERVER_PORT` | `25565` | Minecraft server port |
| `MC_VERSION` | `1.21.4` | Minecraft protocol version |
| `FEATHERLESS_API_KEY` | — | Featherless key (`rc_xxx`) or `ollama` for local mode |
| `FEATHERLESS_MODEL` | — | Model ID |
| `FEATHERLESS_URL` | Featherless endpoint | Set to `http://localhost:11434/v1/chat/completions` for Ollama |

---

## License

ISC
