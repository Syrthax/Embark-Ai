# approach.md — project-k Stabilization & Modularization

**Source-of-truth executable plan.** Combines `diagnosis#1.md` (forensic findings) + `roadmap#1.md` (strategic phases) into a phase-by-phase checklist with file:line targets and concrete module destinations. The two source documents stay as historical reference; this file is what gets executed against.

---

## Status Snapshot

| Item | Value |
|---|---|
| Current bot.js LOC | 2336 |
| Token-discipline lifecycle repair | DONE (closed lifecycle corruption class) |
| Dominant active failure | F1/F18 — death-while-idle during NaN window |
| Helper modules already present | `engine.js`, `state.js`, `llm.js`, `memory.js`, `logger.js`, `env.js` |
| Phase in progress | — (all phases complete) |
| Next phase | Quick-wins parking lot + new failure modes |
| Phase 1 completed | 2026-05-08 — `safeMineflayer.js` extracted; all 16 bare Mineflayer awaits migrated |
| Phase 2 completed | 2026-05-08 — `entityLiveness.js`, `healthIntegrityWatchdog.js`, `fatalDesyncRecovery.js` extracted; 8 old globals removed; cli.js auto-respawn added |
| Phase 3 completed | 2026-05-08 — `movementController.js` extracted; all 20+ direct `bot.pathfinder` writes migrated; `navNear` gets priority param; evade uses HIGH priority; follow uses LOW priority; every transition logged centrally |
| Phase 4 completed | 2026-05-08 — `goalRegistry.js` extracted; all 11 bare `state.goal =` mutations replaced with `setGoal(name, meta)`; every transition logged with source/reason; two invariant checks (follow-overwrites-combat, task-goal-without-active-task) |
| Phase 5 completed | 2026-05-08 — `recoveryEngine.js` created; 6 classes (TASK/POSITION/MOVEMENT/IDLE/ENTITY/COMBAT) with per-class failure counters, cooldowns, decay, and L1–L4 escalation; 5 integration sites (task watchdog, stuck detection, freeze forensics, activity watchdog, task success); recovery state surfaced in freeze snapshots |
| Phase 6 completed | 2026-05-08 — health beacon (`runtime_health_snapshot` every 10s); `cid` correlation IDs threaded through task_start/complete/error/watchdog_kill, goto_start/resolve/reject, recovery_attempt, damage_incident; `classifyFreeze()` taxonomy (entity_desync/movement_deadlock/async_timeout/validator_dead_end/planner_stall/runtime_corruption/unknown) added to every freeze_snapshot |
| LOC target after all phases | ~600 (bot.js becomes thin orchestrator) |

---

## Core Principle

> The runtime must stop assuming world state is always valid, and instead assume it may be delayed, partial, corrupted, stale, temporarily invalid, or internally inconsistent.
>
> — `roadmap#1.md`

Every phase below builds toward four guarantees: **Movement Ownership · Entity Liveness · Bounded Async · Recovery-First**.

---

## Module Split Map

bot.js is currently a 2336-LOC monolith. Each phase extracts one subsystem into its own file. **Modularize as we go** — do not big-bang refactor.

| New file | Owns | Created in |
|---|---|---|
| `mc-server/bot/safeMineflayer.js` | safeDig, safeCraft, safeEquip, safeConsume, safePlaceBlock — `Promise.race(call, timeout)` wrappers preserving `isOwner(token)` discipline | Phase 1 |
| `mc-server/bot/entityLiveness.js` | `EntityLivenessMonitor` — position/velocity/packet freshness; states: `LIVE_VALID` / `LIVE_TRANSIENT_INVALID` / `LIVE_STALE_USING_CACHE` / `LIVE_RECOVERING` / `LIVE_FATAL` | Phase 2.1 |
| `mc-server/bot/healthIntegrityWatchdog.js` | HP delta over rolling window; triggers blind survival when HP drops without a `damage_incident` (decoupled from validator) | Phase 2.3 |
| `mc-server/bot/fatalDesyncRecovery.js` | On prolonged `LIVE_FATAL`: `bot.quit()` → orchestrator (cli.js / tui.js) auto-respawns | Phase 2.4 |
| `mc-server/bot/movementController.js` | **Single owner of `bot.pathfinder`.** All current writers submit a desired movement; controller resolves precedence (CRITICAL > HIGH > NORMAL > LOW > PASSIVE) and is the only code calling `setGoal` / `goto` / `stop` | Phase 3 |
| `mc-server/bot/goalRegistry.js` | `setGoal(name, {source, token, prevGoal, reason})` — encapsulates `state.goal` mutations with invariant assertions | Phase 4 |
| `mc-server/bot/recoveryEngine.js` | RECOVER_MOVEMENT / ENTITY / TASK / PATHFINDER / POSITION / COMBAT / IDLE / FATAL — escalation 1–6 (retry → cancel task → reset movement → rebuild pathfinder → reconnect → restart). Owns blind-survival behaviors. | Phase 5 |
| `logger.js` (extend) | `healthBeacon()` event every 10s; correlation IDs threaded through tasks/goto/recovery/damage | Phase 6 |

**Migration discipline (every phase):** extract → port all call sites → delete from `bot.js` → run a session and verify `events.jsonl` shows expected new events.

---

## Phase 1 — Bound Mineflayer Promises

**Roadmap §1.1.** Eliminate every unbounded `await` on the bot API.

Template — copy `navNear`'s `Promise.race(pathPromise, timeoutPromise)` pattern at `mc-server/bot/bot.js:914-955`. Every wrapper:

- Uses `Promise.race(call, timeoutPromise)`.
- Preserves `isOwner(myToken)` discipline (bot.js:46–72).
- On timeout: rejects, calls `bot.pathfinder.stop()` + `bot.clearControlStates()`, emits structured log.

**Migration sites:**

| Wrapper | Timeout | Replaces |
|---|---|---|
| `safeDig(block)` | 8s | `bot.dig()` at bot.js **1007, 1415, 1561, 1702** |
| `safeCraft(recipe, count, table)` | 5s | `bot.craft()` at bot.js **1028, 1161, 1206, 1277** |
| `safeEquip(item, dest)` | 3s | `bot.equip()` at bot.js **965, 1312, 1453, 1487, 1732** |
| `safePlaceBlock(ref, vec)` | 5s | `bot.placeBlock()` at bot.js **1339, 1741** |
| `safeConsume()` | 5s | `bot.consume()` at bot.js **1488** |

**Total: 16 sites across 5 wrappers.**

**Success criteria:**
- No task awaits indefinitely on a Mineflayer call.
- `freeze_snapshot` events stop showing >15s blocked operations.
- New events: `safe_dig_timeout`, `safe_craft_timeout`, `safe_equip_timeout`, `safe_place_timeout`, `safe_consume_timeout` appear when synthetically forced.

**Closes:** F3 (38s sand dig), F4 (theoretical craft hang), F5 (theoretical equip hang).

---

## Phase 2 — Entity Liveness Layer

Catches Mineflayer entity desync (the F1/F18 root cause).

### 2.1 — EntityLivenessMonitor (`entityLiveness.js`)

- Watches `bot.entity.position`, `bot.entity.velocity`, last-move timestamp.
- Five states: `LIVE_VALID`, `LIVE_TRANSIENT_INVALID`, `LIVE_STALE_USING_CACHE`, `LIVE_RECOVERING`, `LIVE_FATAL`.
- Replaces ad-hoc validity checks at: state.js, getNearestPlayer, getPlayer, agent loop, captureDamageEvent.
- DO NOT use binary `valid/invalid` — diagnosis §13(B) calls that "too primitive."

### 2.2 — Degraded Runtime Mode

- When live position invalid + cached position fresh + cache age acceptable → **continue with degraded precision** instead of dropping events.
- Suspend precision movement; preserve planner state, damage processing, and generic recovery.
- Replace `captureDamageEvent`'s "drop the event" path (bot.js:328–333) with `posSource: 'unknown'` flag → `reactToBlind()` (random horizontal move-away).

### 2.3 — HealthIntegrityWatchdog (`healthIntegrityWatchdog.js`)

- Independent of damage pipeline.
- Sample `bot.health` every 1s.
- If HP drops > N over rolling 2s window AND no `damage_incident` was issued in that window → log `silent_damage_detected` and trigger blind survival (random teleport-step / blind move-away).
- **This breaks the validator dead-end without trusting the validator.** Closes F1 directly.

### 2.4 — FatalDesyncRecovery (`fatalDesyncRecovery.js`)

- If `LIVE_FATAL` persists > 30s threshold: call `bot.quit()`.
- `cli.js` / `tui.js` already track child processes — they auto-respawn the bot.
- Treats prolonged entity invalidity as **client corruption**, not "temporary inconvenience."

**Success criteria:**
- No more death-while-idle events in `events.jsonl`.
- No more 50+ second NaN windows without escalation.
- New events: `liveness_state_change`, `silent_damage_detected`, `blind_survival_triggered`, `fatal_desync_quit`.

**Closes:** F1, F2 (autonomous-livelock), F15 (5s cache window too narrow), F17 (no physics liveness probe), F18 (validator dead-end).

---

## Phase 3 — Movement Authority Refactor

Today's `bot.pathfinder` writers (cataloged from diagnosis §4 + bot.js exploration):

| bot.js line | Writer |
|---|---|
| 191, 192 | reconciliation watchdog `setMovements` + `setGoal(GoalFollow)` |
| 739 | runTask error path `stop()` |
| 803 | `cancelCurrentTask` `stop()` |
| 836 | `clearControlStates` |
| 926, 928, 931 | `navNear` `setMovements` + `goto(GoalNear)` + `stop()` |
| 1623 | `taskFlee` `stop()` + `clearControlStates` |
| 2004, 2005 | threat loop `stop()` + `clearControlStates` |
| 2028, 2029 | agent loop follow re-issue `setMovements` + `setGoal(GoalFollow, dynamic=true)` |
| 2048, 2049 | agent loop follow-lost `stop()` + `clearControlStates` |
| 2051, 2052 | agent loop stuck reset `setMovements` + `setGoal` |
| 2071, 2072 | agent loop goal-exit `stop()` + `clearControlStates` |

Plus pvp's internal pathfinder hijack inside `bot.pvp.attack()` (bot.js:1061, 1077) — annotate as "owned by combat task" but don't refactor pvp internals.

### Required architecture (`movementController.js`)

ALL writers submit a desired movement to the controller. The controller is the only code that touches `bot.pathfinder`.

**Priority model** (Roadmap §3.1):

| Priority | Source |
|---|---|
| CRITICAL | desync recovery |
| HIGH | damage evasion |
| NORMAL | tasks |
| LOW | follow behavior |
| PASSIVE | lookAt |

**Required features:** track movement owner, track movement intent, support priorities, support interruption, support degraded movement, support emergency stop, support snapshots.

**Success criteria:**
- Every movement transition logged centrally with owner.
- No direct `bot.pathfinder.setGoal` / `goto` / `stop` outside the controller (enforced by the `code-quality` subagent).
- No hidden movement conflicts in freeze snapshots.

**Closes:** movement deadlock class, F12 (reconciliation watchdog vs task race), F7 (lookAt vs pathfinder fight).

---

## Phase 4 — Goal & Runtime Ownership

### 4.1 — Encapsulate `state.goal` (`goalRegistry.js`)

The 10 mutation sites become `setGoal(name, metadata)`:

| bot.js line | Current site | Becomes |
|---|---|---|
| 206 | reconciliation watchdog reset | `setGoal(state.followTarget ? 'following' : 'idle', { source: 'reconciliation', reason: 'orphan_reset' })` |
| 680 | low-HP transition | `setGoal('resting', { source: 'state_loop', reason: 'low_hp' })` |
| 736 | runTask finally | `setGoal('idle', { source: 'task_finally', token: myToken, prevGoal: name })` |
| 837 | runTask post-completion | `setGoal('idle', { source: 'cancel_task', token })` |
| 1878 | state loop low HP | `setGoal('resting', { source: 'state_loop', reason: 'low_hp_override' })` |
| 1885 | state loop rest-recovery | `setGoal(state.followTarget ? 'following' : 'idle', { source: 'state_loop', reason: 'rest_recovery' })` |
| 1984 | reactToPlayerAttack | `setGoal('following', { source: 'damage_react', reason: 'player_attack' })` |
| 2006 | threat loop reset | `setGoal('idle', { source: 'threat_loop' })` |
| 2177 | LLM action 'follow' | `setGoal('following', { source: 'llm', reason: 'action=follow' })` |
| 2271 | fallback 'follow me' | `setGoal('following', { source: 'fallback_chat' })` |

### Required metadata on every transition

`source` subsystem · `task token` (if task-owned) · `previous goal` · `reason` · `timestamp`.

### Required invariants (assert loudly)

- Task goals require active ownership token.
- Follow goal cannot overwrite active combat.
- Recovery goals supersede passive goals.
- Violations log loudly; never silently mutate.

### 4.2 — Runtime invariant layer

Add invariant assertions for: `taskBusy` consistency · movement ownership · watchdog ownership · task token validity · goal consistency · recovery state consistency.

**Success criteria:**
- No silent state corruption possible.
- Every transition observable in `events.jsonl`.
- Architecture violations show up as loud `invariant_violation` events.

**Closes:** the systemic risk in diagnosis §2 (catastrophic-risk classification of `state` object).

---

## Phase 5 — Recovery-Centric Runtime (`recoveryEngine.js`)

### 5.1 — Unified RecoveryEngine

Today's recovery logic is fragmented across: per-task watchdog, navNear timeout, combat timeout, reconciliation watchdog, activity watchdog, stuck detection, freeze forensics, `position_invalid_extended_force_cancel`, damage pipeline reactions, forcedMove handler.

Consolidate into one engine with:

- **Recovery classes:** `RECOVER_MOVEMENT`, `RECOVER_ENTITY`, `RECOVER_TASK`, `RECOVER_PATHFINDER`, `RECOVER_POSITION`, `RECOVER_COMBAT`, `RECOVER_IDLE`, `RECOVER_FATAL`.
- **Cooldowns** to avoid storms.
- **Failure classification** + fallback selection.

### 5.2 — Escalation model

| Level | Response |
|---|---|
| 1 | retry |
| 2 | cancel task |
| 3 | reset movement |
| 4 | rebuild pathfinder |
| 5 | reconnect bot |
| 6 | restart runtime |

No repeated failure may retry forever.

### 5.3 — Generic blind survival (low-confidence behaviors)

When runtime confidence is low: random move · jump · strafe · stop hazard damage · flee approximate direction.

> Autonomous agents must prefer imperfect survival over perfect paralysis. — `roadmap#1.md`

**Success criteria:**
- No permanent freeze states.
- Repeated failures escalate automatically.
- New events: `recovery_attempt`, `recovery_escalated`, `blind_survival`.

**Closes:** the recovery fragmentation flagged in diagnosis §6.

---

## Phase 6 — Observability & Forensics

### 6.1 — Persistent health beacon

Extend `mc-server/bot/logger.js` with `healthBeacon()` emitting `runtime_health_snapshot` every 10s. Fields:

- entity validity (LiveLiveness state)
- movement owner (current MovementController owner)
- active task (name + token age)
- watchdog state
- recovery state + escalation level
- pathfinder status
- HP / food

This promotes today's edge-only `freeze_snapshot` (one entry per stuck condition) into a continuous timeline for postmortem reconstruction.

### 6.2 — Unified timeline tracing

Correlation IDs threaded through: tasks · `goto` calls · recovery attempts · damage incidents · movement ownership.

Every related event shares a `correlation_id` field so a single failure reconstructs end-to-end.

### 6.3 — Failure taxonomy on every freeze

Every freeze classified as one of: entity desync · validator dead-end · movement deadlock · async timeout · planner stall · runtime corruption · watchdog failure · Mineflayer failure · unknown.

Never just "something froze."

**Success criteria:**
- Every freeze reproducible from a single correlation ID.
- Every recovery traceable.
- Every escalation explainable.

---

## Quick-Wins Parking Lot (deferred, not in strict order)

These are low-risk cleanups the **`code-quality`** subagent picks up opportunistically. **Do not insert into the strict phase order.**

- Remove vestigial `taskFailureCounts` (bot.js:594) — declared, populated, never consulted.
- Remove vestigial `recoveryAttempts` (bot.js:176) — incremented, never read for decisions.
- Remove vestigial `unknownHitCount` / `unknownHitFirstAt` (bot.js:294-295) — already mentioned in diagnosis as dead.
- Re-evaluate `INTENT_PATTERNS` in `engine.js` — pre-LLM classifier may be redundant with Featherless flow.
- Split `taskBusy` into a private `taskLock` (guards `runTask` entry) and a public `botEngaged` flag (read by watchdogs / react functions to check if a task is running) — the two meanings currently collide in 15+ places. **Do not bundle with the `cancelCurrentTask` clear-last fix** (already done).
- Convert `memory.js` `fs.writeFileSync` (memory.js:22) to debounced async writes — diagnosis F10.
- Eliminate the duplicate `try { bot.pathfinder.stop() } catch {}` block (7 sites: bot.js:739, 803, 931, 1623, 2004, 2048, 2071) — superseded automatically when MovementController lands.
- Eliminate the duplicate `await awaitValidPosition()` prefix (4 sites: bot.js:974, 1503, 1582, 1633) — superseded by EntityLivenessMonitor.
- Eliminate the duplicate goal-restore ternary `state.followTarget ? 'following' : 'idle'` (2 sites: bot.js:206, 1885) — superseded by `goalRegistry.setGoal()`.

---

## Subagent Roles (auto-fired via hooks)

| Agent | Trigger | Job |
|---|---|---|
| `runtime-planner` | UserPromptSubmit reminder | Before any non-trivial change, draft a structured plan citing approach.md phase, target files (file:line), success criteria, and module destination. ≤300 words. No implementation. |
| `code-quality` | Stop reminder | Scan recent `git diff` for: duplicate patterns, dead code, missing safe* wrappers, direct `bot.pathfinder` writes outside `MovementController` (post-Phase 3), direct `state.goal =` outside `setGoal()` (post-Phase 4), files past LOC budgets. ≤200 words. No edits. |
| `future-roadmap` | SessionStart reminder | Read approach.md + recent `events.jsonl` + git log. Report current phase / what's next / new risks not anticipated by diagnosis. Three short sections. |

---

## Phase Ordering (DO NOT REORDER)

```
0   Plan + subagent infra (this file + .claude/agents/ + .claude/settings.json)
1   Bounded Mineflayer Promises          → safeMineflayer.js
2.1 EntityLivenessMonitor                → entityLiveness.js
2.2 Degraded Runtime Mode                → entityLiveness.js (in same module)
2.3 HealthIntegrityWatchdog              → healthIntegrityWatchdog.js
2.4 FatalDesyncRecovery                  → fatalDesyncRecovery.js
3   MovementController                   → movementController.js
4   Goal Encapsulation                   → goalRegistry.js
5   RecoveryEngine                       → recoveryEngine.js
6   Health Beacon + Tracing              → logger.js extension
```

The first four phases (1, 2.1–2.4) eliminate the catastrophic failures. Phases 3–6 mature the runtime into a resilient architecture.
