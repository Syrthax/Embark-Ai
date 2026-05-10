# diagnosis#2.md — Ember runtime, second pass

*Supersedes `diagnosis#1.md` for anything in scope here; `#1` stays as history.*
*Companion: `roadmap#2.md` (one fix per finding, with copy-paste Claude Code prompts + model picks).*

---

## §0 — Executive summary

**The freeze-on-damage bug is not a missing feature. It is a mis-tuned recovery *timeline*.**

When the bot takes damage, an evade/escape task churns the pathfinder and raw control states; the Minecraft server then stops sending valid position updates (`bot.entity.position.y` arrives as `null`). The runtime correctly *detects* this within ~3 s — and then **waits ~55 s before doing the only thing that fixes it (reconnect).** The 9-day `events.jsonl` ends on exactly this: 75 `freeze_snapshot` records, `LIVE_RECOVERING → LIVE_FATAL`, a `blind_survival` that accomplishes nothing because the bot is desynced (not physically stuck), and finally a reconnect at ~55 s with `exit_reason: entity_desync`. HP was 20/20 the whole time. The bot didn't die — it stood still long enough that *to an observer it froze*.

Root cause, in one line: **a server-state desync is being treated as something to "wait out" with escalating-but-useless local maneuvers, when it should be a fast, dedicated "reconnect now" path.** Four constants conspire — `FREEZE_SNAPSHOT_POS_INVALID_MS=3000`, `FORCE_RECOVERY_POS_INVALID_MS=8000` (and it's gated behind `&& taskBusy`), `FATAL_THRESHOLD_MS=30000`, `FATAL_QUIT_THRESHOLD_MS=30000` — plus a recovery engine whose POSITION ladder spends levels 1–2 on no-ops before level 3 reconnects, behind per-class cooldowns.

Other faults found this pass (detailed below): two damage-reaction paths race and leave the bot oscillating `resting ↔ following`; `reactToPlayerAttack` lacks the `taskBusy` guard its sibling `reactToMobAttack` has, so every player hit interrupts whatever the bot was doing; `bot.pvp.attack()` is fire-and-forget with only a 30 s wall-clock escape; `taskBusy` is cleared *before* movement is stopped during cancel; recovery is multi-headed with no arbiter (≥6 independent watchdogs acting on overlapping symptoms); `environmentPerception.scan()` reports "all clear" when the position is `NaN`; `bot.js` has *grown* to 2580 lines (the modularization in roadmap#1 added modules *alongside* the monolith instead of carving it down); and the diagnosis#1 carryovers (no slash commands, no inventory-overflow handling, drowning-mid-task, fall-damage blindness) are all still open.

---

## §1 — Freeze-on-damage: full root-cause analysis

### 1.1 The observed sequence (annotated, from `events.jsonl` tail, ending 2026-05-08T11:23:32Z)

| Time (Z) | Event | What it means |
|---|---|---|
| 11:22:31.836 | `damage_incident` env (lava), hp 20→17 | Lava tick. `reactToEnvironmental` → `replaceTask('evading', taskEvadeHazard)` (bot.js:742-755). |
| 11:22:31.760 | liveness → `LIVE_TRANSIENT_INVALID` then `LIVE_STALE_USING_CACHE` | Server stopped sending a valid `y`. `livePosRaw: {x:-28.84, y:null, z:42.46}`; `cachedPos: {x:-25.5, y:75, z:42.5}`. Velocity stuck at gravity (`y=-3.92`). |
| 11:23:05.784 | `freeze_snapshot` reason `pos_invalid_long`, `posInvalidMs:29005`, state `LIVE_RECOVERING`, `freezeClass:"entity_desync"` | First snapshot. Note: this is the *logging* condition (3 s), but by the time it surfaces in the tail the position has been invalid ~29 s. |
| 11:23:06.942 | liveness `LIVE_RECOVERING → LIVE_FATAL`, `invalidMs:30164` | Crossed `FATAL_THRESHOLD_MS=30000`. |
| 11:23:10.623 → .785 | `task_start` `exploring` (cid 20) → `freeze_snapshot` 162 ms later | Activity/idle path tried to do something; instantly snapshotted again (`34007 ms` invalid). |
| 11:23:10.786 | `recovery_attempt` POSITION L1→L2; `task_cancel`; `blind_survival` start | `recoveryEngine.recover('POSITION')` from freeze-forensics (bot.js:407-419). |
| 11:23:13.949 | `blind_survival` completes after 3163 ms | Raw control-state bursts. Position still `{x:-30.84, y:null, z:45.00}` — **the maneuver did nothing because the bot isn't physically stuck, it's desynced.** |
| 11:23:15.789 | `freeze_snapshot`, `posInvalidMs:39011`, state `LIVE_FATAL` | Still frozen. `envStuck:"movement_blocked"`, `envRisk:5` (perception still reporting *something*, but the position feeding it is junk). |
| 11:23:20.793 | `recovery_attempt` POSITION L2 (maxed for this round) | Cooldown (`COOLDOWN_MS.POSITION=5000`) limits how fast it can climb. |
| 11:23:31.647 → .803 | `task_start` `exploring` (cid 22) → `recovery_attempt` POSITION L2→L3 → `recovery_reconnect` | Finally level 3 → `_reconnect()` → `bot.quit()`. |
| 11:23:32.309 | `disconnect: disconnect.quitting`; `exit_reason.json: {"reason":"entity_desync","livenessState":"LIVE_FATAL","chainId":null}` | ~55 s after the desync onset. Supervisor/CLI then respawns. |

**Net dead time per occurrence: ~50–60 s of a motionless bot.** Across the 9-day log: 75 `freeze_snapshot` records, 67 `LIVE_FATAL` occurrences, 51 `entity_desync` classifications. This is not a one-off.

### 1.2 Why each layer fails to act sooner — the four guilty constants

1. **`FREEZE_SNAPSHOT_POS_INVALID_MS = 3000`** (bot.js:296) — only *logs* a snapshot. No action.
2. **`FORCE_RECOVERY_POS_INVALID_MS = 8000`** (bot.js:297) — triggers `recoveryEngine.recover('POSITION')`, **but** the call is `if (posInvalidMs > FORCE_RECOVERY_POS_INVALID_MS && taskBusy)` (bot.js:407). If the bot is *idle* when it desyncs, this never fires — the only thing covering idle desync is the slow `fatalDesyncRecovery` 30 s + 30 s path.
3. **`FATAL_THRESHOLD_MS = 30000`** (entityLiveness.js:22) — liveness won't even *say* `LIVE_FATAL` for 30 s. Until then it's `LIVE_STALE_USING_CACHE` / `LIVE_RECOVERING`, i.e. "degraded but maybe OK." For a `y:null` from the server, it is never "maybe OK."
4. **`FATAL_QUIT_THRESHOLD_MS = 30000`** (fatalDesyncRecovery.js:11) — *after* `LIVE_FATAL`, wait *another* 30 s before `bot.quit()`. So the floor on the idle-desync path is 60 s.

And the recoveryEngine POSITION ladder (recoveryEngine.js:124-133):
- **L1:** `cancelTask()` — does nothing for a desync (there may be no task; cancelling doesn't un-desync).
- **L2:** `cancelTask()` + `replaceTask('blind_survival', …)` — raw control-state escape. **Wrong tool** (see §1.3).
- **L3:** `_reconnect()` → `bot.quit()` — *the only correct action*, reached third, behind `COOLDOWN_MS.POSITION=5000` between escalations and only after `failures` has incremented to 3.

So even the "fast" 8 s path needs ~3 escalation rounds × 5 s cooldown + the work in between ≈ 20–30 s to reach reconnect — and only if `taskBusy` happened to be true.

### 1.3 Why `blind_survival` / raw control states are the wrong response to a *desync*

`taskBlindSurvival` and `locomotionRecovery.runHazardEscape` work by setting `bot.controlStates` (forward/jump/strafe) directly — bypassing the pathfinder. That is the right move when the bot is **physically stuck** (wedged in terrain, pathfinder can't find a route): brute-force jiggling can pop it free.

It is the *wrong* move when the bot is **desynced**: the client thinks it's at `(x, null, z)` while the server has it somewhere else (or nowhere coherent). Setting control states sends movement intents relative to a position the server doesn't agree with. Best case: nothing happens (the log: position unchanged after a 3.1 s `blind_survival`). Worst case: it deepens the desync. **"Physically stuck" and "desynced" are different failure classes and need different responses** — but the runtime collapses them both into `POSITION` recovery and runs the physical-stuck remedy for the server-state problem.

### 1.4 Secondary freeze path — `bot.pvp.attack()` with no real timeout

`taskAttackMobs` (bot.js:1152) and `taskAttackPlayer` (bot.js:1169) call `bot.pvp.attack(target)` **fire-and-forget**, then `await Promise.race([ once('stoppedAttacking'), setTimeout(30000) ])` (bot.js:1155-1156, 1172-1174). If the target dies, leaves range, or desyncs and `mineflayer-pvp` stops emitting `stoppedAttacking`, the task stands in goal `attacking` for the full 30 s. From outside: the bot took damage, "fought back," then froze for half a minute. No target-validity poll, no shorter cap, no escape if the entity goes invalid.

### 1.5 The damage-path race — `bot.on('health')` vs `processDamageWindow`

There are two reaction authorities:

- **`bot.on('health')`** (bot.js:778-785): on `bot.health <= 4 && taskBusy` → immediately `cancelCurrentTask()` + `setGoal('resting', …)`. **No cooldown.** Fires on every health packet.
- **`processDamageWindow()`** (bot.js:626-665, every 500 ms): 1.5 s damage window, **3 s reaction cooldown** (`REACTION_COOLDOWN_MS=3000`), then `classifyIncident` → `reactToIncident` → one of the `reactToXxx` functions which call `replaceTask(…)`.

On a sustained hazard (lava, fire, repeated hits) both fire. The `health` path wins the race, cancels the task, sets `resting`. Then the agent loop (bot.js:2207, every 250 ms) sees `state.followTarget && state.goal === 'idle' && !taskBusy` after the next cancel/finally and resumes `following`. Meanwhile `processDamageWindow` wanted to react with an *escape* but is now inside its own 3 s cooldown, so the escape never happens. Result: `resting → following → resting → …` while HP keeps dropping — not an escape. **The reaction cooldown must span both paths, and there must be a single reaction authority** (see roadmap#2 Fix 4).

---

## §2 — Architectural faults

### 2.1 Multi-headed recovery, no arbiter

Independent observers that *also independently act*:

| Watchdog | Cadence | Watches | Acts how |
|---|---|---|---|
| `startFreezeForensics` (bot.js:383) | 1 s | task age, `liveness.getInvalidMs()` | logs `freeze_snapshot`; at 8 s+ **and** `taskBusy` → `recoveryEngine.recover('POSITION')` |
| `fatalDesyncRecovery` (own module) | 2 s | `liveness.getState()===LIVE_FATAL` | at +30 s → `bot.quit()` |
| `recoveryEngine` (recoveryEngine.js) | on-demand | whatever calls `recover()` | per-class L1→L3 ladder, cooldowns 5–120 s |
| `healthIntegrityWatchdog` (own module) | 1 s (state loop) | HP delta over 2 s window | `onSilentDamage()` → `replaceTask('blind_survival', …)` |
| `startReconciliationWatchdog` (bot.js:232) | 5 s | pathfinder/pvp state desync | `recoveryEngine.recover(…)` |
| `startActivityWatchdog` (bot.js:2024) | 30 s | 5-min idle | `runTask('exploring', …)` / `recoveryEngine.recover('IDLE')` |
| damage pipeline (`processDamageWindow`) | 0.5 s | `entityHurt` events | `replaceTask('evading'|'fleeing'|'attacking', …)` |
| `bot.on('health')` (bot.js:778) | per packet | `bot.health <= 4` | `cancelCurrentTask()` + `setGoal('resting')` |

The log shows the consequence directly: `recoveryEngine` POSITION L3 reconnected ~4 s before `fatalDesyncRecovery`'s 30 s timer would have — so that timer was 30 s of pure dead time, and the two were racing to do the same thing. There is no module that owns "this symptom → this action at this level." Symptoms are observed in 8 places and acted on in 8 places.

### 2.2 `taskBusy` lifecycle hazards

`taskBusy` (bot.js:59) carries **two meanings**: (a) a re-entrancy lock for `runTask` (bot.js:861 `if (taskBusy) return false`), and (b) a "is the bot doing something deliberate right now?" flag consulted by ≥15 sites — agent loop follow-resume (2207), water-jump (2220), autonomous gate (1914), threat loop (2072), auto-eat (2121), `reactToMobAttack` (730), `bot.on('health')` (780), perception lava-escape (2002), freeze-forensics force-recovery (407), `executeAction` (2386), recoveryEngine `_execute` guards (115, 139, 147, 160), reconciliation orphan check (269). When meaning (a) and meaning (b) diverge — e.g. during the brief window inside `cancelCurrentTask` — these consult a stale answer.

Concretely: `cancelCurrentTask` (bot.js:830-844) sets `taskBusy = false` at line 837 **before** `movement.forceStop('cancel')` at line 842 and `bot.pvp.stop()` / `bot.clearControlStates()` after. In that window a fresh `runTask` can pass the `if (taskBusy) return false` gate and mint a new ownership token while the old task's pathfinder/pvp is still unwinding — a small but real "two tasks alive" gap. The fix is trivial (clear `taskBusy` *last*), but it points at the deeper issue: `taskBusy` should not be both the lock and the public state flag.

### 2.3 `reactToPlayerAttack` lacks the guard `reactToMobAttack` has

`reactToMobAttack` (bot.js:729-740) opens with `if (taskBusy && state.goal === 'attacking') return // already engaged`. `reactToPlayerAttack` (bot.js:706-714) has *no* such guard — when anger ≥ `ANGER_ATTACK_LEVEL` it unconditionally `replaceTask('attacking', () => taskAttackPlayer(...))`. So a player who hits the bot mid-mine, mid-craft, mid-pathfind interrupts it *every single hit*, restarting the attack task each time. Inconsistent policy between two sibling functions that should behave the same way.

### 2.4 `bot.js` has grown, not shrunk

roadmap#1 promised `bot.js` would become a ~600-line thin orchestrator as subsystems were carved into modules. What happened: `entityLiveness.js`, `healthIntegrityWatchdog.js`, `fatalDesyncRecovery.js`, `recoveryEngine.js`, `environmentPerception.js`, `locomotionRecovery.js`, `safeMineflayer.js`, `movementController.js`, `goalRegistry.js` were all *added*, and `bot.js` went from 2336 → **2580 lines**. The damage pipeline (~605-800), freeze forensics (~289-421), every `taskXxx` body (~1062-1910), and all six+ loops (~1955-2316) still live in `bot.js`. The new modules wrap *pieces* (pathfinder, goal mutation, mineflayer calls) but the *behavior* — damage reactions, task implementations, the loops — was never extracted. The monolith got bigger.

### 2.5 Perception reports "safe" under a `NaN` position

`environmentPerception.scan()` floors `bot.entity.position` to integer block coords; `Math.floor(NaN) === NaN`; `bot.blockAt({x:NaN,…})` throws or returns null; the try/catch swallows it; every probed block reads as "clear"; `locomotionRisk` comes out `0`; the escape vector defaults to North. The `_empty()` guard only fires if `!bot.entity?.position` (the object is absent), not if `position.x`/`.y` is `NaN`. During `LIVE_FATAL` — exactly when you most want honest perception — the perception layer cheerfully reports a safe, empty world. (Mitigating note: the pathfinder can't run with `NaN` coords anyway, so this is mostly a *postmortem/observability* lie rather than a steering hazard — but `runHazardEscape`'s yaw is oriented from the escape vector, so a junk vector can mis-aim the one maneuver that does run.)

---

## §3 — Bugs (concrete, file:line)

| # | Bug | Location | Effect |
|---|---|---|---|
| B1 | Idle desync invisible to fast recovery | `bot.js:407` — `if (posInvalidMs > FORCE_RECOVERY_POS_INVALID_MS && taskBusy)` | If the bot is idle when it desyncs, the 8 s force-recovery never fires; only the 60 s `fatalDesyncRecovery` path covers it. |
| B2 | `blind_survival` run for desync | `recoveryEngine.js:127-129` (POSITION L2) | ~3 s wasted maneuver that cannot un-desync; log shows position unchanged after. |
| B3 | `taskBusy` cleared before movement stopped | `bot.js:837` (`taskBusy=false`) precedes `bot.js:842` (`movement.forceStop`) | Re-entrancy window where a new task starts while the old one's pathfinder/pvp is unwinding. |
| B4 | `reactToPlayerAttack` missing `taskBusy`/`already-attacking` guard | `bot.js:706-714` vs `bot.js:730` | Every player hit interrupts and restarts the current task. |
| B5 | `bot.pvp.attack()` fire-and-forget, 30 s wall-clock only | `bot.js:1152,1169` + `:1155-1156,1172-1174` | If `stoppedAttacking` never fires, bot stands in `attacking` for 30 s. No target-validity poll. |
| B6 | Damage-reaction race / split authority | `bot.on('health')` `bot.js:778-785` vs `processDamageWindow` `bot.js:626-665` | Bot oscillates `resting ↔ following` on a sustained hazard instead of escaping; reaction cooldown only covers one path. |
| B7 | Perception "all clear" under `NaN` position | `environmentPerception.js` `scan()` / `_empty()` guard | Misleading postmortems; can mis-aim `runHazardEscape` yaw. |
| B8 | Recovery has no arbiter; watchdogs race | §2.1 table | Redundant/competing actions; `fatalDesyncRecovery`'s 30 s timer was dead time in the logged incident. |
| B9 | Dead/vestigial state | `taskFailureCounts`, `recoveryAttempts` in `bot.js` (declared/incremented, never consulted for a decision) | Noise; misleads readers into thinking there's a mechanism that isn't wired. *(Confirm exact lines before removing.)* |

---

## §4 — What's actually right (do **not** regress these)

- **Token discipline.** `currentTaskToken` as a `Symbol`, `isOwner(myToken)` checks on deferred callbacks, `cancelCurrentTask`/`replaceTask` as an atomic supersede. This closed the stale-callback/orphan-watchdog class and must survive any refactor.
- **`safe*` Mineflayer wrappers** (`safeDig` 8 s, `safeCraft` 5 s, `safeEquip` 3 s, `safeConsume` 5 s, `safePlaceBlock` 5 s) and the fact that the task bodies actually use them — no raw `await bot.dig(...)` etc. in the hot paths.
- **`goalRegistry.setGoal()` as the sole `state.goal` mutator** — zero raw `state.goal =` assignments; transitions are logged and invariant-checked.
- **`movementController` as the sole `bot.pathfinder` writer** — no direct `bot.pathfinder.setGoal/goto` in `bot.js`; priorities (CRITICAL/HIGH/NORMAL/LOW/PASSIVE).
- **`fatalDesyncRecovery` being independent of `taskBusy`** — its 2 s poll keys on `liveness.getState()` only. (The *threshold* is wrong, not the independence.)
- **Correlation IDs** threaded across tasks/goto/recovery/damage; structured JSONL logging with rotation. This is why the freeze was diagnosable at all.
- **`captureDamageEvent` falling back to `liveness.getBestPosition()`** when `bot.entity.position` is invalid — the right instinct (don't drop the event just because the position is junk).

---

## §5 — Carried-over open gaps from diagnosis#1 (still unaddressed)

- **No slash commands.** No `/locate`, `/tp`, or any server-command path. All navigation is memory-based (last ~5 locations) or random 10–30-block vectors. Limits real autonomy; not a freeze cause.
- **No inventory-overflow handling.** `taskMineBlock`, `taskGatherWood`, `taskCraftPlanks`, `taskBuildHouseSmart` — none check free slots before starting; no auto-drop. After extended gathering the bot wedges.
- **Drowning mid-task.** The only water-survival mechanism is `bot.entity?.isInWater && !taskBusy → jump=true` (bot.js:2220). A task that walks the bot into water blocks the only escape.
- **Fall-damage blindness.** `findNearbyHazard(2)` can't see "I'm falling" — fall damage classifies as `unknown`, and `reactToUnknownDamage` only reacts if `bot.health < 12` (bot.js:757-765).

---

## §6 — Severity table (→ roadmap#2 fix IDs)

| ID | Finding | Severity | Freeze cause? | roadmap#2 |
|---|---|---|---|---|
| F-1 | Desync recovery timeline is ~10× too slow; reconnect reached last not first | **CRITICAL** | **Yes — primary** | Fix 1 |
| F-2 | `blind_survival` / raw control states run for desync (wrong failure class) | **CRITICAL** | Yes — compounds F-1 | Fix 2 |
| F-3 | Idle desync invisible to fast force-recovery (`&& taskBusy` gate, B1) | **HIGH** | Yes (idle case) | Fix 1 (folded in) |
| F-4 | `bot.pvp.attack()` fire-and-forget, 30 s hang, no target-validity poll (B5) | **HIGH** | Yes — secondary | Fix 3 |
| F-5 | Damage-reaction race / split authority; `resting ↔ following` oscillation (B6) | **HIGH** | Yes — adjacent | Fix 4 |
| F-6 | Recovery is multi-headed with no arbiter (B8) | **HIGH** | Indirect (enables F-1) | Fix 5 |
| F-7 | `reactToPlayerAttack` missing the guard `reactToMobAttack` has (B4) | **MEDIUM** | No — but interrupts work | Fix 6 |
| F-8 | `taskBusy` cleared before movement stopped (B3) | **MEDIUM** | No — re-entrancy gap | Fix 7 |
| F-9 | `taskBusy` overloaded as lock + public state flag (§2.2) | **MEDIUM** | No — fragility | Fix 7 (broader option) |
| F-10 | Perception "all clear" under `NaN` position (B7) | **MEDIUM** | No — observability lie | Fix 8 |
| F-11 | `bot.js` 2580 LOC — modularization never happened (§2.4) | **MEDIUM** | No — maintainability | Fix 9 |
| F-12 | Dead state `taskFailureCounts` / `recoveryAttempts` (B9) | **LOW** | No | Fix 10 |
| F-13 | No slash commands (`/locate`, `/tp`) | **MEDIUM** (for autonomy) | No | Fix 11 |
| F-14 | No inventory-overflow handling | **MEDIUM-HIGH** | No (different stall) | Fix 12 |
| F-15 | Drowning mid-task (`!taskBusy` gate on water-jump) | **MEDIUM** | No (different death) | Fix 13 |
| F-16 | Fall-damage blindness | **LOW-MEDIUM** | No | Fix 14 |
