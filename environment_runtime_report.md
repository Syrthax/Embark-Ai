# Environment Runtime Report — Spatial Perception Layer

**Date:** 2026-05-08  
**Status:** Implemented

---

## What was built

### `environmentPerception.js` (NEW)

A real-time spatial awareness module. The bot now continuously reads the world through Mineflayer's `blockAt()` API and builds a structured local world model. This is symbolic spatial intelligence — no screenshots, no vision models.

**What it scans:**

- All blocks within a configurable sphere (default radius 12, ~2200 block queries per scan)
- Classified into four hazard tiers: `fatal` (lava/fire), `damage` (cactus/magma/campfire), `slow` (cobweb/soul_sand), `liquid` (water)
- Standing surface (foot-1), feet block (foot), head block (foot+1) — immediate body contact detection

**What it produces per scan:**

| Field | Description |
|---|---|
| `hazardSummary` | Human-readable: `"lava 2m E; cactus 5m S"` |
| `traversability.{N,S,E,W}` | Each direction classified: `walkable`, `blocked`, `fall_risk`, `unsafe_lava`, `unsafe_fire`, `hazardous`, `swim_risk`, `low_ceiling`, `step_down`, `hazard_memory` |
| `escapeVector` | Direction with lowest danger score, with `dx/dz` for orientation |
| `standingOn` | Block directly underfoot |
| `feetBlock` / `headBlock` | Immediate body blocks |
| `locomotionRisk` | 0–10 score (5+ means slow down, 8+ means escape) |
| `isEnclosed` | True if ≥3 directions are blocked/lethal |
| `cliffNearby` | True if any adjacent direction drops 3+ blocks |
| `stuckClass` | `lava_immobilization`, `collision_deadlock`, `terrain_deadlock`, `liquid_drag`, `suffocation_hazard`, `lava_proximity`, `movement_blocked` |
| `nearbyBlocksCompact` | Up to 12 close hazard blocks with `{type, dx, dy, dz}` for diagnostics |
| `hazardMemorySize` | Count of positions in hazard memory |

**Hazard memory:**

Every time a hazardous block is found during a scan, its coarsened coordinates are written to a TTL-evicted memory store (max 100 entries, 5-minute TTL). Traversability checks consult this memory — a direction that passes through a known hazard position gets a `hazard_memory` label and a score penalty of 5, steering pathfinding away from repeatedly lethal coordinates.

This prevents the loop of: die to lava → respawn → walk into same lava → die.

---

### `locomotionRecovery.js` (NEW)

Below-pathfinder physical escape maneuvers. When the bot is stuck (collision deadlock, lava immobilization, etc.), these functions attempt direct control-state bursts rather than asking the pathfinder for a path that may not exist.

**Maneuvers:**

| Function | Description |
|---|---|
| `tryJumpEscape` | Forward + sprint + jump burst (450ms) |
| `tryStrafeEscape(dir)` | Left or right + jump burst (500ms) |
| `tryReverseEscape` | Back + jump burst (500ms) |
| `tryPerturbEscape` | Random yaw + sprint + jump (600ms) |
| `tryClimbEscape` | 4× forward+jump+sprint bursts (pillar up one block) |
| `tryDirectedEscape(x,z)` | Face away from a specific position, sprint |
| `runEscapeSequence` | Full escalating sequence: jump→strafe-L→strafe-R→reverse→perturb |
| `runHazardEscape(stuckClass)` | Routes to optimal maneuver based on stuck classification |

**`runHazardEscape` routing:**

- `lava_immobilization` / `lava_proximity` → directed escape away from lava + climb
- `collision_deadlock` → full sequence (all directions tried)
- `terrain_deadlock` → jump + perturb
- `liquid_drag` → climb (surface)
- `suffocation_hazard` → reverse + jump

All maneuvers use the perception `escapeVector` to orient before moving.

---

### `state.js` (MODIFIED)

`buildGroundedState()` now accepts an optional `perception` module and calls `perception.scan()` if available. The scan result is attached as `groundedState.environment`. This flows into the LLM prompt and any other consumer of grounded state.

---

### `llm.js` (MODIFIED)

The LLM prompt now includes a `=== SPATIAL AWARENESS ===` section with:

```
standing_on: grass_block | hazards: lava 2m E | risk: 6/10 | N:walkable S:walkable E:unsafe_lava W:walkable | escape: west
```

Three dynamic warnings are injected when conditions are severe:
- `WARNING: standing in LAVA — escape immediately`
- `WARNING: high environmental risk — prioritize survival`
- `WARNING: enclosed space detected — escape before other tasks`

The `escape` action hint now explicitly says to use it when `risk≥7` or enclosed. The LLM now makes movement and task decisions with full spatial context rather than blind goal pursuit.

---

### `bot.js` (MODIFIED)

**Initialization:**
```javascript
envPerception      = createEnvironmentPerception(bot, log)
locomotionRecovery = createLocomotionRecovery(bot, log)
```
Both initialized in the `bot.once('spawn')` handler.

**Perception loop (`startPerceptionLoop`, every 3s):**
- Refreshes `lastEnvScan` (the globally shared latest scan)
- Auto-triggers `locomotionRecovery.runHazardEscape('lava_immobilization')` if feet/head block is lava and bot is not task-busy (cooldown: 8s)
- Logs `hazard_detected` when `locomotionRisk ≥ 8`

**`taskEscape` upgrade (three-phase):**
1. **Locomotion phase** — calls `runHazardEscape(stuckClass, scan)` first (fast, no pathfinder)
2. **Pathfinder phase** — tries 7 target positions, prioritizing escape-vector-biased targets
3. **Dig-up phase** — last resort when pathfinder fails

**`taskBlindSurvival` upgrade:**
- Now calls `runHazardEscape(stuckClass, scan)` instead of random yaw + raw control states
- Falls back to original random behavior only if perception unavailable

**Telemetry additions:**
- `freeze_snapshot` now includes `envRisk`, `envStuckClass`, `envHazards`, `envIsEnclosed`
- `runtime_health_snapshot` (beacon) now includes `envRisk`, `envStuck`, `envHazards`
- `environment_scan` fired when hazards detected during scan
- `hazard_detected` fired on reactive environmental hit and high-risk perception states
- `hazard_memory_hit` fired during traversability when a memory position is consulted
- `escape_attempt` / `locomotion_escape` / `escape_success` fired per maneuver

---

## Perception architecture

```
every 3s:
  environmentPerception.scan()
    → iterate sphere radius 12
    → for each block: classify hazard tier
    → for each direction N/S/E/W: classifyDirection(2-step lookahead)
    → compute escapeVector (lowest-score direction)
    → detect cliff (3-block open air drop adjacent)
    → compute locomotionRisk (0–10 composite)
    → classify stuckClass
    → build hazardSummary text
    → update hazardMemory (TTL-evict old entries)
    → return structured scan result
  → store in lastEnvScan (global)
  → auto-trigger lava escape if feetBlock == lava
```

```
on LLM query:
  buildGroundedState(bot, state, memory, anger, envPerception)
    → calls envPerception.scan() (fresh scan per LLM call)
    → attaches result as groundedState.environment
  buildPrompt(groundedState, ...)
    → formats environment as compact SPATIAL AWARENESS section
    → injects hazard warnings if conditions are severe
```

---

## Hazard classification

Traversability score per direction:

| Condition | Label | Score |
|---|---|---|
| Lava or fire | `unsafe_lava` / `unsafe_fire` | 10 |
| Physical wall | `blocked` | 7 |
| 3+ block drop | `fall_risk` | 7 |
| Damage block | `hazardous` | 6 |
| Known hazard memory | `hazard_memory` | 5 |
| Water | `swim_risk` | 3 |
| Low ceiling | `low_ceiling` | 2 |
| 1–2 block drop | `step_down` | 1 |
| Clear | `walkable` | 0 |

Escape vector = direction with lowest score.

---

## Remaining limitations

1. **Vertical escape vector** — the escape vector is 2D (horizontal only). A bot in a lava lake on all 4 sides has nowhere horizontal to go; the system falls through to dig-up. A 3D escape vector (upward) would improve this but requires pathfinder integration.

2. **Chunk loading lag** — `blockAt()` returns null for unloaded chunks. Perception ignores null blocks, so in the instant after a fast teleport or long-distance move, the scan may show clear terrain where hazards actually exist. The liveness monitor handles the teleport case independently.

3. **Scan radius vs. CPU** — radius 12 = ~2200 block queries per 3s tick. On a slow server or large worlds, this is negligible (blockAt is an in-memory lookup). If the server is under extreme load, drop `PERCEPTION_INTERVAL_MS` to 5000 in bot.js.

4. **Entity hazards** — the current system only scans static blocks. Dynamic hazards (creeper explosions, falling sand) are not in the spatial model. The existing `entityHurt` pipeline handles these reactively.

5. **Diagonal traversability** — NE/NW/SE/SW directions are not analyzed. The 4-cardinal model misses diagonal escape paths. Extending to 8 directions is a straightforward future addition.
