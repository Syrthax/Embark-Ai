# diagnosis#1.md — project-k Autonomy Runtime Forensic Diagnosis

**Subject:** `mc-server/bot/` runtime, post token-discipline lifecycle fix
**Date:** 2026-05-07
**Scope:** every file in `mc-server/bot/`, plus orchestrators (`tui.js`, `cli.js`)
**Posture:** diagnosis only — no patches in this document

This document is evidence-driven. Every claim is backed by either a code reference (`file.js:line`) or a log entry from `mc-server/bot/events.jsonl`. Sample log lines below come from the operational run captured 2026-05-07 06:30–06:50 UTC.

---

## SECTION 1 — System Architecture Map

### Module inventory

| File | LOC | Role |
|---|---|---|
| `bot.js` | 2336 | Single-file runtime: event listeners, task system, all watchdogs, all timers, all task functions |
| `engine.js` | 213 | Stateless: intent classifier, LLM-output validator, autonomous goal selector, insult detector, safe-default table |
| `state.js` | 93 | Stateless: builds `groundedState` snapshot from real Mineflayer reads |
| `llm.js` | 213 | Featherless API client (`queryLLM`, `checkOllama`) |
| `memory.js` | 59 | JSON-file persistence for locations / events / knowledge |
| `logger.js` | 63 | JSONL event logger with 5MB rotation |
| `env.js` | 38 | Walks parent dirs to load `.env` |
| `tui.js` (root) | ~620 | Blessed-based dashboard; spawns bot.js subprocess; tails events.jsonl |
| `cli.js` (root) | ~700 | Prompt-driven sibling of TUI; same orchestration logic |

### Concurrency surface (timers + event listeners)

`bot.js` registers **eight long-lived timers** plus **eight Mineflayer event listeners**, all sharing global state:

| Subsystem | Period | Code location | Reads | Writes |
|---|---|---|---|---|
| Agent loop | 250 ms | `startAgentLoop`, ~bot.js:1961 | state.goal, state.followTarget, taskBusy, bot.entity, bot.players | state.goal, lastValidPosition, bot.pathfinder, controls |
| State loop | 1 s | `startStateLoop`, ~bot.js:1696 | bot.health, bot.food, taskBusy | state.energy, state.hunger, state.goal, runTask side-effects |
| Damage classifier | 500 ms | `processDamageWindow`, ~bot.js:368 | damageWindow, lastReactionAt, damageState | damageWindow, damageState, lastReactionAt, replaceTask side-effects |
| Threat loop | 2.5 s | `startThreatLoop`, ~bot.js:1681 | taskBusy, state.goal, state.energy, bot.entities | runTask side-effects |
| Anger decay | 1 s | `startAngerDecay`, ~bot.js:130 | anger | anger |
| Activity watchdog | 30 s | `startActivityWatchdog`, ~bot.js:1725 | state.lastActivityAt, taskBusy, state.goal | state.idleTicks |
| Reconciliation watchdog | 5 s | `startReconciliationWatchdog`, ~bot.js:178 | state.goal, taskBusy, currentTaskContext, bot.pathfinder | bot.pathfinder, taskBusy, state.goal, recoveryAttempts |
| Freeze forensics | 1 s | `startFreezeForensics`, ~bot.js:280 | currentTaskContext, lastValidPositionAt, bot.entity, taskBusy | calls cancelCurrentTask under one condition |
| Chat queue pump | event-driven `setTimeout(1500)` | `pumpChat`, ~bot.js:117 | chatQueue | chatQueue, chatBusy |
| Promise callbacks | microtask-deferred | runTask `.then/.catch/.finally`, ~bot.js:651–704 | currentTaskToken | conditional global state mutations gated by `isOwner` |

Plus Mineflayer events: `spawn`, `entityHurt`, `health`, `death`, `respawn`, `forcedMove`, `chat`, `error`, `kicked`, `end`. Plus Node lifecycle: `uncaughtException`, `unhandledRejection`.

### Movement authority graph (writers to `bot.pathfinder` and `bot.entity` controls)

```
                                   bot.pathfinder
                                         ▲
            ┌────────────────────────────┼────────────────────────────┐
            │                            │                            │
   navNear (inside tasks)        Agent loop follow          Reconciliation watchdog
   • setMovements                • setMovements             • setMovements
   • goto(GoalNear)              • setGoal(GoalFollow)      • setGoal(GoalFollow)
                                 • stop() on stuck-reset    • (no explicit stop)
                                 • stop() on goal exit
                                                        ┌────────┘
                                                        │
                                  cancelCurrentTask     forcedMove handler
                                  • stop()              • cancelCurrentTask()
                                  • pvp.stop()
                                  • clearControlStates  +  taskExplore / taskEscape
                                                          mutate `pathfinder.thinkingTimeout`

   bot.attack (counter-punch)        bot.pvp.attack            bot.dig
   (inside reactToPlayerAttack)      (taskAttackMobs/Player)   (taskGatherWood / taskMineBlock)
```

There is **one synchronous writer at a time** to `bot.pathfinder.setGoal` only because the timers don't preempt each other (single-threaded JS), but **no explicit ownership protocol**. The token discipline added in the previous pass governs `runTask`'s deferred callbacks but **not** the agent loop or reconciliation watchdog — both of those mutate `bot.pathfinder` directly.

### State mutation graph

```
state.goal — mutated by 11 distinct sites (bot.js): runTask start, runTask finally,
             cancelCurrentTask, agent loop auto-resume, agent loop follow-lost,
             state-loop low-HP transition, state-loop rest-recovery,
             reconciliation watchdog orphan recovery, executeAction case 'follow',
             fallback command 'follow me', state-loop low-HP override after cancel.

state.followTarget — mutated by 6 sites: executeAction case 'follow', case 'stop',
                     fallback 'follow me', fallback 'stop', death handler,
                     agent loop "Lost you" path. NO single owner.

taskBusy — mutated by runTask (sets true, then false in finally),
           cancelCurrentTask (sets false), reconciliation watchdog orphan recovery
           (sets false). Defended by token discipline against stale callback writes.

damageState — mutated by processDamageWindow only. Single owner. ✓
```

---

## SECTION 2 — Global State Analysis

### Catalog

| Variable | File:line | Type | Mutations | Risk |
|---|---|---|---|---|
| `state` (object) | bot.js:31 | mutable singleton | 11+ sites | **Catastrophic** |
| `taskBusy` | bot.js:44 | boolean | runTask, cancel, reconcile | Risky (token-defended) |
| `currentTaskToken` | bot.js:64 | Symbol or null | runTask + cancelCurrentTask | Safe (discipline-gated) |
| `currentTaskContext` | bot.js:65 | object or null | runTask + cancelCurrentTask | Safe |
| `damageWindow` | bot.js:296 | array | entityHurt push, classifier shift, respawn/forcedMove clear | Safe |
| `damageState` | bot.js:298 | enum string | classifier only | Safe |
| `lastReactionAt` | bot.js:299 | number | classifier only | Safe |
| `hazardZones` | bot.js:297 | array | rememberHazard, classifier trim | Safe |
| `anger` | bot.js:41 | Map | bumpAnger, decay loop, attack reduction | Safe (single mutator per username) |
| `chatQueue` / `chatBusy` | bot.js:101–102 | array + bool | safeChat, pumpChat | Safe (FIFO discipline) |
| `lastValidPosition` / `lastValidPositionAt` | bot.js:323–324 | object + number | agent loop tick, captureDamageEvent reads | **Risky** — only updated by 250ms agent loop, can be stale |
| `nextGotoId` / `activeGotos` | bot.js:911–912 | counter + Map | navNear adds, navNear deletes | Safe |
| `recoveryAttempts` | bot.js:176 | counter | reconciliation watchdog | Safe |
| `taskFailureCounts` | bot.js:594 | Map | runTask success/error | Safe |
| `phantomCraftBlocklist` | bot.js:1129 | Map | taskCraftItem only | Safe |
| `lastHitChatAt` / `lastCounterPunchAt` | bot.js:303–304 | numbers | reactToPlayerAttack only | Safe |
| `unknownHitCount` / `unknownHitFirstAt` | bot.js:294–295 | numbers | **VESTIGIAL** — declared but no write site after damage-pipeline rewrite | Smell |
| `_tickCounter` / `_lastValidPos` | function-attached on `startStateLoop` | counter + cache | state loop only | Safe |
| `lastFreezeSnapshotAt` | bot.js:288 | number | freeze forensics only | Safe |
| `llmEnabled` / `llmBusy` | bot.js:42–43 | booleans | spawn handler / handleMessage | Safe |
| `prevGoal` / `prevFollowTarget` / `lostTicks` / `followRefreshTicks` / `stuckCheckTicks` / `lastBotPos` / `stuckTicks` | inside `startAgentLoop` closure, ~bot.js:1962–1968 | various | agent loop only | Safe (closure-scoped) |

### Catastrophic-risk classification: `state` object

`state` (bot.js:31) is a single mutable plain object with **no encapsulation**. Eleven distinct code paths assign to `state.goal`, six assign to `state.followTarget`, and the agent loop's auto-resume reads-then-writes `state.goal` non-atomically. Whilst this is currently hardened by the token discipline (writes happen only when no task is active *or* by the owning task), there is no mechanical enforcement — a future code path that mutates `state.goal` while `taskBusy === true` would silently break the model.

Concretely, the agent loop (`bot.js:1982`) does:
```js
if (state.followTarget && state.goal === 'idle' && !taskBusy) {
  state.goal = 'following'
}
```
This is correct *iff* `taskBusy` is reliable. Token discipline ensures it is — but there is **no assertion** anywhere that catches a violation.

### Vestigial state — confidence-erosion signal

`unknownHitCount` and `unknownHitFirstAt` (bot.js:294–295) were used by the pre-pipeline damage handler. After the capture/classify/react rewrite they are declared but never written. They survive only as evidence that the codebase has accumulated dead state without explicit removal — a code-smell that increases the risk of misreading the architecture during future work.

---

## SECTION 3 — Async Lifecycle Analysis

### Promise chains in scope

1. **`runTask`'s `fn().then().catch().finally()`** — main task lifecycle.
2. **`navNear`'s `Promise.race([pathPromise, timeoutPromise])`** — pathfinder timeout.
3. **`taskAttackMobs` / `taskAttackPlayer`'s `Promise.race([stoppedAttacking, 30s timeout])`** — combat completion.
4. **`bot.pathfinder.goto()` Promise** (mineflayer-pathfinder).
5. **`bot.dig()` Promise** (mineflayer).
6. **`bot.craft()` Promise** (mineflayer).
7. **`bot.placeBlock()` Promise** (mineflayer).
8. **`bot.equip()` Promise** (mineflayer).
9. **`bot.consume()` Promise** (mineflayer).
10. **`fetch` to Featherless** (`queryLLM`, `checkOllama`).

### Token-discipline coverage

`runTask`'s three deferred callbacks (`.then`, `.catch`, `.finally`) and the watchdog `setTimeout` all gate on `isOwner(myToken)` (bot.js:677, 686, 717, 666). This was verified to fire correctly in production: the log contains `task_complete_stale` and `task_finally_stale` events (bot.js:679, 720), proof that the stale-callback path is being exercised and is benign:

```
06:34:06.324 task_complete_stale
06:34:06.324 task_finally_stale
```

These appeared after `position_invalid_extended_force_cancel` superseded the active task at 06:34:04.300 — confirming that the token check correctly inhibits state corruption.

### Race windows — **identified residual risks**

| Race | Severity | Status |
|---|---|---|
| `runTask` deferred cleanup vs replacement task | **Closed** by token discipline |
| `forcedMove`'s `cancelCurrentTask` vs in-flight task | **Closed** — `cancelCurrentTask` is atomic; old goto rejection sees stale token |
| Agent loop `setGoal(GoalFollow)` vs task's `goto(GoalNear)` | **Open** (low severity) — both writers exist, but agent loop only writes when `state.goal === 'following'`, which is a non-task state. No code currently violates this, but no assertion either. |
| Reconciliation watchdog `setGoal(GoalFollow)` vs same-tick task start | **Open** — reconciliation runs every 5 s on its own setInterval; on a 5 s mark it could fire microseconds before a damage classifier replaceTask. JS single-threadedness means they don't actually interleave in execution, but the order they enter the macrotask queue is not deterministic. |
| `bot.dig()` / `bot.craft()` / `bot.equip()` Promises with no timeout | **Open** — see below |
| `bot.pvp.attack()` ‖ `taskAttackMobs` 30 s timeout | Mitigated — `Promise.race` with 30 s cap |
| `bot.pathfinder.goto()` ‖ `navNear` 15 s timeout | Mitigated — `Promise.race` with 15 s cap |

### Unbounded await: **`bot.dig()`** — confirmed evidence

`bot.dig(fresh)` is called in `taskGatherWood` (bot.js:1007) and `taskMineBlock` (bot.js:1175 area) **without a timeout**. mineflayer's `bot.dig` returns a Promise that resolves only after the block break animation completes and the block is removed; if the block is moved/replaced/unreachable mid-dig, the Promise can wait an undefined amount of time before rejecting.

**Log evidence (06:48:34–06:49:14):**
```
06:48:34.901  task_start goal=mining
06:48:34.901  mine_start
06:48:34.910  goto_start id=N
06:48:36.088  goto_resolve durationMs=1178   ← reached the block
                                              [29.8s of silence — bot.dig() in flight]
06:49:05.866  freeze_snapshot taskAge=30965 pathActive=false isMoving=false   ← dig still in flight
06:49:11.866  freeze_snapshot taskAge=36965  ← dig STILL in flight
06:49:14.607  mined                         ← finally completed after ~38 s total
06:49:14.609  task_complete goal=mining
```

The 90 s task watchdog (bot.js:666) eventually saves us here, but a single dig taking 38 seconds for a sand block is operational dysfunction. The bot is alive but contributes nothing for half a minute. If this happens during follow-with-magma-nearby, it's catastrophic.

### Microtask ordering — verified safe under token discipline

```
T+0   replaceTask called (synchronous):
        cancelCurrentTask: token=null, pathfinder.stop()  (synchronous side-effects)
        runTask: token=B, taskBusy=true, B's goto() begins
T+0   (same tick, microtask queue empty)

T+ε   microtask: A's goto() rejects with "Path was stopped"
T+ε   A's catch fires: isOwner(A)? false → log only, return
T+ε   A's finally fires: isOwner(A)? false → log only, return
```

JavaScript's single-threaded macrotask model and the fact that `cancelCurrentTask + runTask` runs synchronously within one macrotask means the old microtasks always execute *after* the replacement is fully installed. **Race window mathematically zero.**

---

## SECTION 4 — Movement Architecture Analysis

### All `bot.pathfinder` writers

```
1. navNear (bot.js:925-928)             setMovements + goto(GoalNear)
2. agent loop follow re-issue (1825)    setMovements + setGoal(GoalFollow, dynamic=true)
3. agent loop stuck reset (1751)        stop() + setMovements + setGoal
4. agent loop follow-lost (1850)        stop() + clearControlStates
5. agent loop goal-exit (1899)          stop() + clearControlStates
6. reconciliation watchdog (190)        setMovements + setGoal(GoalFollow)
7. cancelCurrentTask (606)              stop()
8. runTask catch on error (697)         stop()
9. forcedMove handler (568)             cancelCurrentTask() (delegates)
10. taskExplore thinkingTimeout (989)   mutates global pathfinder.thinkingTimeout
11. taskEscape thinkingTimeout (1276)   mutates global pathfinder.thinkingTimeout
12. position_invalid_extended_force_cancel (322)  cancelCurrentTask()
```

### Movement ownership conflicts

- **Writers 2, 3, 6** are independent of the task system. They write `bot.pathfinder` based on their own logic. The ONLY thing preventing them from racing each other is that the agent loop (writers 2-5) and reconciliation watchdog (writer 6) both *only* fire when `state.goal === 'following'`, which by convention is a non-task state. There is no enforcement — only convention.
- **Writers 10 and 11** mutate `bot.pathfinder.thinkingTimeout` (a global per-bot setting). Each task captures the previous value, sets its own, and restores in `finally`. If two such tasks ran concurrently (which token discipline prevents), the saved/restore would be wrong. Today this is OK because only one task runs at a time. **Architectural smell** — the saved value isn't per-task; it's a global temporal state.

### Hidden bypass: `bot.attack()` and `bot.pvp.attack()`

- `bot.attack(entity)` (bot.js:467 in counter-punch) is just an arm-swing packet, no movement.
- `bot.pvp.attack(entity)` (bot.js:1061, 1077) **takes over the pathfinder** internally. It is called from inside tasks, so it is bounded by the task lifecycle — but during combat, `bot.pathfinder.goal` is being written by the pvp plugin while the agent loop's `pathActive` check reads it. The reconciliation watchdog (bot.js:184) does:
  ```js
  if (state.goal === 'following' && state.followTarget) {
    const pathActive = bot.pathfinder?.isMoving() || bot.pathfinder?.goal != null
    if (!pathActive) { /* re-issue follow goal */ }
  }
  ```
  During a combat task, `state.goal === 'attacking'`, so this block is gated off. **Safe today** — but again, only by convention.

### Desync vector: `bot.lookAt`

The agent loop calls `bot.lookAt` (bot.js:1992) every 250 ms, even when a task is actively pathfinding. mineflayer-pathfinder also internally controls `bot.entity.yaw/pitch` to point in the movement direction. Calling `bot.lookAt` during pathfinding fights pathfinder's own look-control. This has been observed in earlier sessions to cause subtle "bot turns around mid-path" behaviour.

**Severity:** low — pathfinder's look update wins on the next tick. But this is unnecessary work.

---

## SECTION 5 — Entity / Physics Validity Analysis

### Assumptions about `bot.entity.position`

The codebase makes three different assumptions in three different places:

| Site | Assumption | Defense |
|---|---|---|
| `taskExplore`, `taskFlee`, `taskEvadeHazard`, `taskEscape` | Position is valid before computing target | `awaitValidPosition(2000)` prefix (bot.js:973, 1499, 1340, 1257) |
| `captureDamageEvent` | Position must be valid OR cache fresh | Cached-position fallback (bot.js:331) |
| `getNearestPlayer`, `getPlayer`, `state.js:buildGroundedState` | Position is always valid | **No defense** — direct access to `bot.entity.position.distanceTo(...)` |
| Agent loop look | Position validity unchecked at call site | `try { bot.lookAt(...) } catch {}` swallows any error |

### Critical evidence — extended NaN window

Log series (bot.js writes `null` in JSON for NaN due to `JSON.stringify(NaN)`):

```
06:34:00.115  damage_capture_skipped rawX=null rawY=73 rawZ=null typeofX=number cachedAgeMs=14000+
06:34:00.614  damage_capture_skipped rawX=null rawY=73 rawZ=null cachedAgeMs=14500
06:34:01.111  damage_capture_skipped (every 500ms — damage classifier ticking)
… (continuous for 47 seconds) …
06:34:47.124  damage_capture_skipped rawX=null rawY=73 rawZ=null cachedAgeMs=58582
06:34:47.126  died lastGoal=idle
```

**Observations:**
- `typeofX=number` while value serialises as `null` ⇒ value is **`NaN`** (since `typeof NaN === 'number'` and `JSON.stringify(NaN) === 'null'`).
- `rawY=73` stayed valid the whole time — the y-coordinate never went bad. **Only x and z became NaN.**
- The bot was **idle** (`goal: idle`, `taskBusy: false`, `followTarget: null`) for the entire dying sequence (verified in the `freeze_snapshot` at 06:34:42 below).
- HP went from full to 1.66 to 0 over 47 seconds.

**Freeze snapshot at 06:34:42:**
```json
{"event":"freeze_snapshot","reason":"pos_invalid_long",
 "currentTaskGoal":null, "taskBusy":false, "watchdogActive":false,
 "goal":"idle", "followTarget":null, "damageState":"safe",
 "damageWindowSize":0, "msSinceLastReaction":50243,
 "pathActive":false, "isMoving":false,
 "livePosValid":false, "livePosRaw":{"x":null,"y":73,"z":null},
 "cachedPos":{"x":-317.58,"y":73,"z":741.49},
 "posInvalidMs":53781,
 "onGround":false, "inWater":false, "inLava":false,
 "velocity":null, "dimension":"overworld", "hp":1.67, "food":20}
```

This is a **terminal state**:
- Position invalid for 53.7 s
- Bot idle, no follow target, no task
- `damageWindowSize=0` because all events were dropped at capture
- `pathActive=false`, `isMoving=false`
- `velocity=null` (also NaN somewhere)
- HP at 1.67, dying

The bot died standing still in this state.

### Why position becomes NaN

`bot.entity.position` is a `Vec3` whose `x/y/z` are populated from server `Position` packets. The repeated pattern `x=NaN, y=73, z=NaN` strongly suggests:
- Server is sending a packet with horizontal NaN data, OR
- mineflayer is computing position via interpolation and dividing by zero on a velocity update

The fact that `velocity=null` in the snapshot (so `bot.entity.velocity.x` is also NaN) supports the second theory: a velocity update with bad delta-time or bad packet data is propagating into both velocity and position.

### Validator dead-end — confirmed architecturally

The damage pipeline's `captureDamageEvent` requires either a live valid position OR a cache <5 s old (bot.js:328–333). When the NaN window exceeds 5 s, **every** damage event becomes a no-op:
- `damageWindow` stays empty
- Classifier sees `damageWindow.length === 0` → transitions damageState to 'safe'
- No reaction is ever issued
- HP drains to 0

The only watchdog with the authority to break out is `position_invalid_extended_force_cancel` (bot.js:319):
```js
if (posInvalidMs > FORCE_RECOVERY_POS_INVALID_MS && taskBusy) {
  cancelCurrentTask()
}
```
**Note the `&& taskBusy` clause.** When the bot is idle (no task), this watchdog does nothing. **The recovery never fires.** This is the root cause of death-while-idle.

### Cached position becomes a liability

The agent loop only updates `lastValidPosition` (bot.js:1974) when `isValidVec(livePos)` returns true. If position remains invalid for the entire 250 ms tick, the cache ages without refresh. After 5 seconds (`STALE_POSITION_MAX_MS`), the cache is rejected and damage capture starts dropping. **The cache window is too narrow** for prolonged Mineflayer entity desync.

---

## SECTION 6 — Watchdog & Recovery Analysis

### Watchdog inventory

| Watchdog | Period | Trigger condition | Action | Idle-coverage? |
|---|---|---|---|---|
| Per-task watchdog | once-shot 90 s | task running >90 s | `cancelCurrentTask` + chat | No (per-task only) |
| `navNear` timeout | once-shot 15 s | path not resolved | `pathfinder.stop` + reject promise | No (per-call only) |
| Combat timeout | once-shot 30 s | `stoppedAttacking` not received | resolves race, task returns | No |
| Reconciliation watchdog | 5 s | following without active path; orphaned `taskBusy` | re-issue `setGoal` | Partial |
| Activity watchdog | 30 s | no activity for 5 min | force `state.idleTicks = 999` (next autonomous decision) | Yes, but slow |
| Stuck-detection (in agent loop) | 1 s sample / 4 s threshold | following but not moving | `pathfinder.stop` + re-issue | Only during follow |
| Freeze forensics | 1 s | task >30 s old OR pos invalid >3 s | log snapshot | Yes (logging only) |
| `position_invalid_extended_force_cancel` | 1 s (within freeze forensics) | pos invalid >8 s **AND `taskBusy`** | `cancelCurrentTask` | **No — gated by taskBusy** |

### Recovery path coverage matrix

| Failure | What recovers it? |
|---|---|
| Task hangs >90 s | Per-task watchdog ✓ |
| `navNear` hangs >15 s | navNear timeout ✓ |
| Combat stuck | 30 s `stoppedAttacking` race ✓ |
| `bot.dig()` hangs | **Only the per-task 90 s watchdog** — task can hang for up to 90 s |
| `bot.craft()` hangs | Same — 90 s only |
| Position NaN brief (<5 s) | Cached-position fallback in damage capture ✓ |
| Position NaN extended + task active | `position_invalid_extended_force_cancel` ✓ |
| **Position NaN extended + idle (no task)** | **NOTHING — bot dies standing still** ✗ |
| Pathfinder hangs `goto` | navNear timeout ✓ |
| Pathfinder thinking-timeout exhaustion | Pathfinder's own reject ✓ |
| Live entity desync (server-side) | None — bot waits forever for valid packets |
| Server kicks bot | `bot.on('kicked')` handler exits process ✓ |

### Dead recovery paths — confirmed

#### Death-while-idle (severity: catastrophic)
Demonstrated above. `position_invalid_extended_force_cancel` requires `taskBusy=true`. When the bot becomes idle during prolonged NaN, no watchdog ever fires.

#### Autonomous-livelock during NaN window
**Log evidence (06:34:04):**
```
06:34:04.298  autonomous_choice action=explore
06:34:04.299  task_start goal=exploring
06:34:04.299  state goal=exploring busy=true
06:34:04.300  position_invalid_extended_force_cancel    ← fired 1 ms after task started!
06:34:06.324  explore_skip_invalid_position             ← awaitValidPosition timed out
06:34:06.324  task_complete_stale
06:34:06.324  task_finally_stale
```

When the autonomous loop attempts to start a task (because IDLE_THRESHOLD ticks elapsed and `state.idleTicks` hit 18), the task starts → `taskBusy=true` → in the next 1 s tick, `position_invalid_extended_force_cancel` fires and immediately kills it. After 2 s, `awaitValidPosition` times out → task body returns → catch/finally fire as stale (because `position_invalid_extended_force_cancel` already superseded the token).

This is a **livelock** between the autonomous loop and the recovery watchdog. The bot oscillates between "starting a task" and "having that task force-cancelled" with no progress. The token discipline prevents *corruption*, but the loop itself wastes cycles and doesn't help with the actual crisis (silent damage).

#### Missing fallback: hazard-positioned-source-unknown
When the damage classifier returns `type: 'unknown'` (no consistent player, no consistent mob, no detectable hazard block, not in lava), `reactToUnknownDamage` (bot.js:519) only acts if `bot.health < 12`. Above HP 12, it logs `unknown_damage_ignored_hp_ok` and does nothing. **If the unknown source persists**, HP drops below 12 and a recovery fires — but if the underlying cause is the position-NaN window, the recovery itself silently fails (see above).

---

## SECTION 7 — Task / Planner Analysis

### Task lifecycle (post token-discipline)

```
runTask(name, fn, opts)
├── guard:       if taskBusy return false
├── mint:        myToken = Symbol(name); myCtx = { token, name, watchdog, ... }
├── publish:     taskBusy=true; state.goal=name; currentTaskToken=myToken
├── log:         task_start
├── arm:         myCtx.watchdog = setTimeout(90s)
└── attach:      fn().then(success).catch(error).finally(release)

success path
├── isOwner check → if false, task_complete_stale, return
├── log task_complete; reset failure count

error path
├── isOwner check → if false, task_error_stale, return
├── log task_error; safeChat (if !silent)
├── pathfinder.stop / pvp.stop / clearControlStates
├── timeout streak tracking → maybe schedule escape

release path (always runs)
├── isOwner check → if false, task_finally_stale, return
├── clearTimeout(myCtx.watchdog)
├── currentTaskToken = null; currentTaskContext = null
├── taskBusy = false
├── clearControlStates
└── if state.goal === name: state.goal = 'idle'
```

### Planner behaviour

The "planner" is `engine.js:selectAutonomousGoal`, called from `tryAutonomous` in the state loop (bot.js area 1660). It is **stateless** — every call evaluates the current `groundedState` from scratch. There is no "remember what I was trying to do."

### Task replacement semantics

`replaceTask(name, fn, opts)` (bot.js:617) is the **only** atomic interruption primitive:
```js
function replaceTask(goalName, fn, opts) {
  cancelCurrentTask()
  return runTask(goalName, fn, opts)
}
```
Used by all 4 damage reactions (player, mob, environmental, unknown) and `maybeAttackForAnger`. Direct `if (taskBusy) { cancelCurrentTask(); taskBusy = false }; runTask(...)` patterns are gone (verified by grep).

### Goal authority: not centralised

`state.goal` is mutated by:
1. `runTask` start → `goalName`
2. `runTask` finally → `'idle'` (if still matched)
3. `cancelCurrentTask` → `'idle'` (if matched)
4. Agent loop auto-resume → `'following'`
5. Agent loop "Lost you" → `'idle'`
6. State loop low-HP → `'resting'`
7. State loop rest-recovery → `'following'` or `'idle'`
8. Reconciliation watchdog orphan recovery → `'following'` or `'idle'`
9. `executeAction` case 'follow' → `'following'`
10. Death handler (via cancelCurrentTask)
11. Various fallback commands

There is **no single owner**. The token discipline only governs paths 1, 2, 3 (the task lifecycle). Paths 4–11 are orthogonal mutators. This works today, but it's fragile.

### Confirmed task-orphan possibility

In the 06:34:00–06:34:47 sequence, the autonomous loop tried to start a task, which was force-cancelled in the next tick, leaving (briefly) `taskBusy=false, currentTaskContext=null, state.goal='idle'`. The reconciliation watchdog has a defensive check (bot.js:201):
```js
if (taskBusy && !currentTaskContext) {
  findings.push('orphaned_taskBusy')
  ...
}
```
This check has **never fired** in the production log (verified — `orphaned_taskBusy` is absent from `events.jsonl`). The token discipline keeps `taskBusy` and `currentTaskContext` synchronised. The check is theoretical paranoia.

### Planner can stall safely forever — confirmed

If `selectAutonomousGoal` returns null repeatedly (e.g. every condition false), the bot stays idle forever. There is no liveness probe demanding progress. The activity watchdog only forces a fresh planner call after **5 minutes** of idle (bot.js:1740: `ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000`). For 5 minutes the bot can sit doing nothing.

---

## SECTION 8 — Pathfinder Forensics

### `goto()` lifecycle

In production, `navNear` wraps `bot.pathfinder.goto` with id-tracking and a 15 s timeout (bot.js:914-955). Captured logs show this works:

**Healthy goto:**
```
06:48:18.005  goto_start id=39 taskGoal=exploring target={x,y,z,range}
06:48:22.833  goto_resolve id=39 durationMs=4828 stale=false
```

**Stale goto (replaced mid-flight):**
```
goto_resolve id=N stale=true   ← logged but takes no action
```
This is expected: a stale resolve happens after token replacement; the surrounding task's `await navNear` re-throws or returns, but the calling context is the old task whose finally/catch is also stale. The chain dies silently.

### Pathfinder hang risk

The 15 s timeout in `navNear` is the only hard upper bound on `goto` duration. If the pathfinder's internal Promise NEVER resolves AND NEVER rejects (e.g. mineflayer-pathfinder hits an internal exception inside its event loop), `Promise.race` will resolve via the timeout — **but the original promise stays pending forever**. This causes a memory leak (the unresolved Promise keeps its closure alive), and if it ever does resolve later, the resolve flows into the `await` site of `navNear` which has already finalised — **harmless but wasteful**.

### Impossible-goal handling

`goals.GoalNear(x, y, z, range)` does not pre-validate reachability. If the target is inside an unloaded chunk, inside bedrock, or outside world bounds, the pathfinder will think for `thinkingTimeout` ms (default 5000, set to 2000 for explore, 5000 for escape) then reject. The reject path is reached normally → 15 s timeout never needed.

### Pathfinder mutation across concurrent tasks: NOT SUPPORTED

`bot.pathfinder.thinkingTimeout` is a global per-bot setting. `taskExplore` and `taskEscape` both save/set/restore it. If they ran concurrently (which token discipline prevents), the first to save would observe a polluted value from the second. **Confirmed safe under current discipline; brittle if discipline is ever bypassed.**

### Unloaded chunk behaviour

The bot has no chunk-loading awareness. `bot.world.getColumn(...)` is never read; `bot.entity.position` is the only spatial signal. If the player teleports the bot far outside the loaded region, position can become NaN (chunk unload races) and damage events flow without context.

---

## SECTION 9 — Event Storm Analysis

### `entityHurt` — primary event source

Production damage_raw frequency: ~50 events captured in 5000 log lines ≈ 1% of total events. Plus 128 `damage_capture_skipped` (mostly during the death sequence). Plus 11 `damage_state_change`.

The classifier's 500 ms tick rate plus 3 s reaction cooldown means at most **~120 reactions per minute** is theoretically possible. Production rate is ~1 reaction per minute under normal play. **No event storm risk** in current architecture.

### Recursive reaction risk

`reactToPlayerAttack` calls `bumpAnger`, `safeChat`, optionally `bot.attack()`, optionally `replaceTask('attacking', ...)`. None of these synchronously emit `entityHurt`. **No recursion.**

`bot.attack` (counter-punch) sends a use_entity packet. The server may respond by hurting the player, who may hit back, generating a new `entityHurt`. **This is sequential, not recursive** — separated by a network round-trip ≥ 50 ms.

### Duplicate event risk

mineflayer fires `entityHurt` once per server `EntityStatus` packet of type "hurt." If the server emits multiple `EntityStatus` packets for one logical hit (rare but possible), we'd capture them as separate events in `damageWindow`. The classifier's 1.5 s window groups them as one incident. **Safe.**

### Event backlog risk

`damageWindow` (bot.js:296) is unbounded:
```js
damageWindow.push(evt)
```
The classifier trims to a 1.5 s window every 500 ms. In the worst case, between trims, ~8 hits could accumulate (1.5 s ÷ ~200 ms per cactus tick × 3). **Bounded in practice, unbounded in code.**

### `bot.on('chat')` self-feedback risk

The bot's own messages are filtered:
```js
if (username === BOT_NAME) return
if (/online \(.+\)\.?$/.test(message)) return
if (message === 'Hold on...' || ...) return
```
Tested in earlier sessions — works. **Safe.**

### `entityHurt` for non-self entities

```js
if (entity !== bot.entity) return
```
Returns early. **Safe.**

---

## SECTION 10 — Failure Mode Catalog

| # | Failure | Severity | Reproducibility | Trigger | Root cause | Evidence |
|---|---|---|---|---|---|---|
| F1 | Death-while-idle during NaN window | **Catastrophic** | Reliable when entity desyncs while bot idle | Mineflayer entity position NaN >5 s while bot has no task | `position_invalid_extended_force_cancel` requires `taskBusy=true`; idle bot has no recovery path | events.jsonl 06:34:00–06:34:47 (47 s of skipped damage → death) |
| F2 | Autonomous-livelock during NaN window | High | Same trigger as F1 | Autonomous loop starts task → force-cancelled in 1 ms | Recovery watchdog and autonomous planner are not coordinated | events.jsonl 06:34:04 |
| F3 | `bot.dig()` unbounded await | Medium | Occasional | Block becomes unreachable mid-dig | mineflayer `dig` Promise has no per-call timeout | events.jsonl 06:48:34→06:49:14 (38 s dig) |
| F4 | `bot.craft()` unbounded await | Medium | Theoretical | Server-side craft slot interaction stalls | mineflayer `craft` Promise has no timeout | not directly observed; symmetric risk |
| F5 | `bot.equip()` unbounded await | Medium | Theoretical | Inventory window mid-update | mineflayer `equip` Promise has no timeout | not observed |
| F6 | Phantom craft (mineflayer ↔ 1.21.4 protocol drift) | Medium | Reproducible with wooden_pickaxe | Recipe lookup matches client side, server rejects | Was observed and mitigated by phantomCraftBlocklist (bot.js:1129) | earlier session logs |
| F7 | Stale `lookAt` during pathfinder movement | Low | Always | Agent loop calls lookAt every 250ms while pathfinder controls yaw | No coordination between agent loop look and pathfinder look | architectural smell, not failure-causing |
| F8 | Vestigial `unknownHitCount` state | Low (smell) | Always | Code accretion | dead state | bot.js:294 |
| F9 | Recipe data version drift (mineflayer 4.37 vs Minecraft 1.21.4) | Medium | Variable | Specific recipe data file mismatch | mineflayer prismarine-data version | F6 is one manifestation |
| F10 | Memory.json blocking writes | Low | Never observed | Every `rememberLocation/Event/Knowledge` call does `fs.writeFileSync` | Synchronous I/O on hot path | memory.js:22 |
| F11 | `bot.lookAt` failure swallowed | Low | Theoretical | bot.entity.position NaN during lookAt | try/catch swallows error silently | bot.js:1992 |
| F12 | Reconciliation watchdog re-issues `setGoal` while task in flight | Low | Theoretical | Same-tick race | Convention not enforcement | bot.js:184 |
| F13 | Activity watchdog 5-minute threshold | Low | Always | After 5 min idle, force task | Slow if user wants faster | bot.js:1740 |
| F14 | `damageWindow` array unbounded between trims | Low | Always | High-frequency damage with tight 500 ms classifier tick | trim runs only on classifier interval | bot.js:355 |
| F15 | `lastValidPosition` cache 5 s window | High | Reproducible | Position invalid >5 s | Cache window narrower than realistic NaN windows observed (50 s+) | F1 root cause |
| F16 | `cancelCurrentTask` from `bot.on('health')` does not preserve follow target | Low | Reproducible | HP drops to ≤4 during follow | `state.goal='resting'` set after cancel, follow lost until rest-recovery branch fires | bot.js:550 |
| F17 | No physics liveness probe | High | Always | We never verify packets are flowing | Currently inferred only from position validity | systemic |
| F18 | Damage event silently dropped during NaN window with no resort | High | Same as F1 | Cache aged out + NaN persists | No fallback to "react generically when in doubt" | F1 manifestation |
| F19 | Pathfinder hangs that emit no resolve/reject | Theoretical | Unobserved | mineflayer-pathfinder internal exception | navNear timeout fires, but inner Promise leaks | not observed |
| F20 | `forcedMove` flushes damageWindow but does not reset autonomous-loop state | Low | Always | Teleport during in-flight reaction | damageWindow cleared, but reaction's task may have just started | bot.js:566 |

---

## SECTION 11 — Freeze Classification Matrix

The user's diagnosis taxonomy — applied to the recorded freezes:

| Freeze category | Symptoms | Logs | Trigger | Confidence |
|---|---|---|---|---|
| **Async ownership corruption** | tasks corrupt each other's globals; watchdog cleared by stale finally | `task_complete_stale`, `task_finally_stale` (now safe) | rapid replaceTask | RESOLVED — token discipline closed this |
| **Movement deadlock** | pathfinder writers fight each other | follow_setgoal_error | concurrent setGoal | LOW — convention prevents but no enforcement |
| **Invalid position recovery stall** (F1) | live position NaN >5 s, idle bot, damage drops, death | `damage_capture_skipped`+`freeze_snapshot pos_invalid_long`+`died lastGoal=idle` | mineflayer entity desync | **PRIMARY ACTIVE FAILURE** — high confidence |
| **Pathfinder hang** | goto Promise never resolves | `goto_start` without matching `goto_resolve`/`goto_reject` for >15 s | unloaded chunk / impossible goal | LOW — 15 s navNear timeout always fires |
| **Watchdog failure** | watchdog never triggers despite stuck task | task_age >90 s with no force-cancel | invariant violation | NOT OBSERVED |
| **Recovery livelock** (F2) | start task → force-cancel → start task → ... | `task_start` followed by `position_invalid_extended_force_cancel` | F1 + autonomous loop | **OBSERVED** as side-effect of F1 |
| **Entity desync freeze** | bot.entity position/velocity NaN; server packets stalled | `livePosValid:false` for extended periods | server-side or network desync | OBSERVED as F1 root |
| **Validator dead-end** (F18) | every damage event rejected; HP drains silently | `damage_capture_skipped` repeating with no other events | F1 + cache stale | **OBSERVED — primary failure mode** |
| **Planner idle stall** | `selectAutonomousGoal` returns null, bot sits | no `task_start` for extended period | low energy + no nearby resources | NOT TRIGGERED in current logs |
| **Slow-action hang** (F3) | bot.dig() takes 30+ s | `goto_resolve` followed by long silence then `mined` | impossible-to-reach block, unequipped tool | OBSERVED |

### The single dominant freeze right now

**Validator dead-end (F18) caused by extended Mineflayer entity desync (F17 / F15) with idle-bot recovery gap (F1).**

Everything in the `06:34:00–06:34:47` window traces to this triad. Solving it requires:
- Either narrowing the NaN window (server-side / mineflayer-side fix — not in our control)
- Or widening the recovery surface so idle bots also recover
- Or replacing the validator's "drop the event" behaviour with "react generically"

---

## SECTION 12 — Architectural Risk Ranking

### Most fragile subsystems (descending risk)

1. **`captureDamageEvent` validator path** — silent drop of damage events when no fresh cache. Drives F1/F18.
2. **`position_invalid_extended_force_cancel` watchdog** — gated by `taskBusy`, blind to idle bot dying.
3. **`bot.dig` / `bot.craft` / `bot.equip` await sites** — no per-call timeout; 90 s is too coarse.
4. **`state.goal` mutation surface** — 11 writers, no encapsulation, only convention.
5. **Movement authority graph** — 12 writers, no enforcement.
6. **`bot.entity.position` direct access (state.js, getPlayer, getNearestPlayer)** — un-validated.
7. **mineflayer 4.37 ↔ Minecraft 1.21.4 protocol drift** — phantom crafts, possible position desync.
8. **`memory.json` synchronous writes** — blocking I/O on hot path.

### Most dangerous shared state

1. **`state` (the singleton object)** — see catalog above
2. **`bot.pathfinder.thinkingTimeout`** — global setting, mutated by tasks
3. **`damageWindow`** — unbounded between trims (low-severity but worth bounding)

### Biggest concurrency hazards

1. Reconciliation watchdog `setGoal` racing with task `goto` — convention-only
2. Autonomous loop ↔ recovery watchdog livelock under F1 conditions
3. Multiple watchdog timers all reading/writing `state.goal` and `taskBusy`

### Weakest recovery layers

1. **Idle-bot recovery** — almost non-existent, only the 5-minute activity watchdog
2. **Server-side desync recovery** — none; we wait passively
3. **Slow `bot.dig` recovery** — only the 90 s task watchdog, way too coarse

---

## SECTION 13 — Recommended Architecture Direction (no implementation)

These are **directions**, not patches. Each could be discussed and prioritised individually.

### A. Establish a single Movement Authority

Introduce a `MovementController` module that owns `bot.pathfinder` exclusively. All current writers (agent loop, reconciliation, tasks, forcedMove handler, cancelCurrentTask) submit a *desired movement* to the controller; the controller resolves precedence and is the only code that calls `setGoal`/`stop`.

Benefits: enforced ownership, observable (can log every transition), eliminates convention-dependent safety.

### B. Treat Mineflayer entity desync as a first-class failure mode

Introduce a `EntityLiveness` watchdog independent of position validity:
- Tracks the timestamp of the last *change* to `bot.entity.position`
- If position hasn't moved AND the bot is supposed to be moving, classify as desync
- If position is NaN AND has stayed NaN longer than a threshold, attempt liveness probe (e.g., read `bot.world.getBlock` near the cached position to verify chunks are loaded)

Recovery actions for confirmed desync:
- Send a self-look or self-look reset to nudge mineflayer
- If desync persists >30 s, force a clean disconnect/reconnect cycle (`bot.quit()` and let the orchestrator restart)

### C. Idle-bot recovery surface

The catastrophic freeze (F1) is specifically because idle bots have no health-aware watchdog. Add an **HP-loss watchdog** independent of damage capture:
- Sample `bot.health` every 1 s
- If HP dropped > N in last 2 s and no `damage_incident` was issued in that window, force a generic recovery: random teleport-step, blind move-away, log `silent_damage_detected`

This breaks the validator dead-end without trusting the validator.

### D. Bound every Mineflayer Promise

Wrap `bot.dig`, `bot.craft`, `bot.equip`, `bot.consume`, `bot.placeBlock` in helpers with `Promise.race(promise, timeout)` patterns analogous to `navNear`. Per-call timeouts:
- `dig`: 8 s
- `craft`: 5 s
- `equip`: 3 s
- `placeBlock`: 5 s

### E. Replace "drop and silence" with "react and degrade" in damage capture

When position is invalid:
- Instead of dropping the event, capture it with a flag `posSource: 'unknown'` and a placeholder position
- The classifier handles `posSource: 'unknown'` events with a degraded reaction: `reactToBlind()` — generic move-away in a random horizontal direction
- This preserves liveness during desync windows

### F. Encapsulate `state` behind setters

Replace `state.goal = X` with `setGoal(X, reason)` that:
- Logs the transition with the calling site
- Asserts invariants (e.g., can only set `state.goal=name` if no task is active OR the caller owns the active task)

This converts conventions to enforced contracts and makes architecture violations loud.

### G. Centralise watchdog priorities

Today, watchdogs are siblings — each ticks independently. Introduce a single `WatchdogScheduler` that orders checks by priority (HP-critical > pos-invalid > stuck > activity) and ensures only one recovery action per cycle.

### H. Replace polling with event-driven progress signals

The 4 s stuck-detection samples position every 1 s and decides. Replace with `bot.on('move')` event subscription: track last-move timestamp directly, no polling needed. More accurate and lower-overhead.

### I. Async I/O for memory persistence

`memory.js` uses `fs.writeFileSync` on every event (memory.js:22). Replace with debounced async writes (`fs.promises.writeFile` triggered by a timer) to remove synchronous I/O from the event hot-path.

### J. Decouple chat queue from any single bot identity

`safeChat` queue is per-bot, but the queue logic is duplicated implicitly in messaging filters. Centralise message filtering into a small `ChatBus` that knows how to recognise other bots' messages and acts as a single ingress.

### K. Promote the LLM result type and add structured action metadata

`engine.js:validateLLMOutput` accepts a flat `{decision, action, target, say}`. The action handler in `executeAction` (bot.js:2174) is a giant switch with action-specific guard logic interleaved. A structured action descriptor with declared preconditions, costs, and timeouts would let `executeAction` and the autonomous planner share validation.

### L. Failure-mode telemetry export

Today's freeze_snapshot is one structured log entry per stuck condition. Promote this to a "health beacon" emitted every 10 s with the same shape, so postmortem reconstruction has continuous data, not just edge events.

---

## Conclusion

The previous lifecycle/ownership repair was substantively correct. The current dominant failure has shifted to a new layer: **Mineflayer entity desync producing extended NaN windows in `bot.entity.position`, combined with the validator dropping all affected damage events, combined with the recovery watchdog being gated on `taskBusy`**. When all three coincide on an idle bot, it dies standing still over ~50 seconds with no recovery action ever taken.

The architecture overall is at a decision point: either continue patching specific recovery gaps (a never-ending list given the ten possible failure modes catalogued above), or invest in the four foundational changes that eliminate whole classes of failures:

1. **Movement Authority** (eliminates convention-based safety)
2. **Entity Liveness Detector** (catches all server-side desync)
3. **HP-loss watchdog independent of damage capture** (catches all silent-damage failures)
4. **Bounded Mineflayer Promises** (caps every API call)

Without these, the bot will remain fragile against new edge cases. With them, the runtime gains the property the user originally asked for: it cannot freeze permanently, because every layer has an enforced exit path.

The next document — once approved — should be `roadmap#1.md`: a strategic stabilisation roadmap mapping each catalogued failure to one of these four foundations.
