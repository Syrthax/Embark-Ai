# roadmap#1.md — project-k Runtime Stabilization Roadmap

**Subject:** project-k autonomous Minecraft runtime  
**Phase:** Post-diagnosis stabilization roadmap  
**Based on:** diagnosis#1.md  
**Goal:** Transform the runtime from “safe but stall-prone” into “safe, live, and self-recovering”

---

# Executive Summary

The runtime has successfully evolved past the original catastrophic lifecycle corruption layer.

The token-discipline repair eliminated:
- stale cleanup corruption
- recursive task destruction
- watchdog corruption
- taskBusy desynchronization
- uncontrolled interrupt races

The runtime now fails differently:
- safe stalls
- validator dead-ends
- entity desync freezes
- liveness loss
- prolonged degraded states
- silent recovery failure

This is a major architectural improvement.

The current system is no longer unsafe.  
It is now insufficiently resilient.

The next milestone is not “more fixes.”  
The next milestone is:

> guaranteed liveness under uncertainty.

This roadmap restructures the runtime around four foundational guarantees:

1. Movement Ownership
2. Entity Liveness
3. Bounded Async Operations
4. Recovery-First Runtime Design

---

# Core Architectural Principle

The runtime must stop assuming:

```txt
world state is always valid
```

and instead assume:

```txt
world state may be:
- delayed
- partial
- corrupted
- stale
- temporarily invalid
- internally inconsistent
```

The runtime must therefore:
- degrade gracefully
- preserve liveness
- survive invalidity
- recover automatically
- never freeze permanently

---

# Stabilization Strategy

The stabilization roadmap is divided into 6 phases.

DO NOT SKIP PHASES.  
Each phase establishes invariants required by later phases.

---

# PHASE 1 — Runtime Safety Foundation

## Goal

Eliminate all remaining unbounded operations and establish strict runtime guarantees.

This phase prevents:
- permanent hangs
- infinite awaits
- unrecoverable blocked tasks

---

## 1.1 — Bound Every Mineflayer Promise

### Problem

Several Mineflayer APIs can hang indefinitely:
- bot.dig()
- bot.craft()
- bot.equip()
- bot.consume()
- bot.placeBlock()

Current architecture only relies on:
- global 90s task watchdog

This is too coarse.

A single blocked API call can stall the runtime for tens of seconds.

---

## Required Changes

Create wrappers:

```js
safeDig()
safeCraft()
safeEquip()
safeConsume()
safePlaceBlock()
```

All wrappers must:
- use Promise.race(timeout)
- emit structured logs
- preserve task token discipline
- reject on timeout
- stop pathfinder/control states on timeout

---

## Required Guarantees

No Mineflayer API call may:
- block indefinitely
- exceed its timeout budget
- survive task replacement

---

## Suggested Timeouts

| Operation | Timeout |
|---|---|
| dig | 8s |
| craft | 5s |
| equip | 3s |
| consume | 5s |
| placeBlock | 5s |

---

## Success Criteria

- no task survives indefinitely waiting on Mineflayer
- all slow-operation hangs become recoverable
- freeze snapshots no longer show >15s blocked operations

---

# PHASE 2 — Entity Liveness Layer

## Goal

Detect and recover from Mineflayer entity desync.

This phase addresses:
- NaN position freezes
- invalid velocity states
- silent desync
- idle-bot death

---

## 2.1 — Create EntityLivenessMonitor

### Problem

Current runtime assumes:

```js
bot.entity.position
```

is trustworthy.

Diagnosis proved this assumption false.

Observed:
- x/z become NaN
- velocity becomes NaN
- damage events fail
- bot dies silently

---

## Required New Runtime Layer

Create:

```txt
EntityLivenessMonitor
```

Responsibilities:
- monitor position validity
- monitor velocity validity
- monitor physics progression
- monitor movement progression
- monitor packet freshness
- classify entity health state

---

## Required States

Implement:

```txt
LIVE_VALID
LIVE_TRANSIENT_INVALID
LIVE_STALE_USING_CACHE
LIVE_RECOVERING
LIVE_FATAL
```

DO NOT use:

```txt
valid / invalid
```

That model is too primitive.

---

## 2.2 — Introduce Degraded Runtime Mode

### Problem

Current validator behavior:

```txt
invalid position -> reject everything
```

This destroys liveness.

---

## Required Behavior

When:
- live position invalid
- cached position still valid
- cache age acceptable

Then:
- continue degraded operation
- suspend precision movement
- preserve planner state
- preserve damage processing
- allow generic recovery behavior

---

## Required Guarantees

Invalid live position must NEVER cause:
- permanent freeze
- complete autonomy shutdown
- silent damage death

---

## 2.3 — HP-Loss Watchdog

### Problem

Damage capture currently depends on valid position.

During NaN windows:
- damage events dropped
- no reactions issued
- HP drains silently

---

## Required Watchdog

Add:

```txt
HealthIntegrityWatchdog
```

Independent from damage pipeline.

Behavior:
- track HP delta over rolling windows
- detect unexplained HP loss
- issue generic evasive recovery
- bypass validator requirements

---

## Required Guarantees

Even if:
- entity position invalid
- damage classifier broken
- damage source unknown

The bot must still:
- attempt survival behavior
- preserve liveness
- avoid standing still until death

---

## 2.4 — Fatal Desync Recovery

### Problem

Current runtime can remain invalid for 50+ seconds.

This is operationally fatal.

---

## Required Recovery Escalation

If:

```txt
LIVE_FATAL
```

persists > threshold:
- force reconnect cycle
OR
- fully recreate bot instance

The runtime must treat:

```txt
prolonged entity invalidity
```

as:

```txt
client corruption
```

NOT:

```txt
temporary inconvenience
```

---

## Success Criteria

- no more death-while-idle
- no more 50s NaN windows without escalation
- runtime recovers automatically from entity desync
- freeze snapshots show recovery progression

---

# PHASE 3 — Movement Authority Refactor

## Goal

Establish a single owner of movement.

This phase removes:
- convention-based safety
- hidden pathfinder conflicts
- implicit movement writers

---

## 3.1 — Create MovementController

### Problem

Current architecture has:
- 12 movement writers
- no ownership enforcement
- no authority hierarchy

Movement safety currently depends on:

```txt
“people remembering not to conflict”
```

This is fragile.

---

## Required Architecture

ALL movement must flow through:

```txt
MovementController
```

Only MovementController may:
- setGoal
- goto
- stop pathfinder
- mutate controls
- change movement mode

---

## Required Features

MovementController must:
- track movement owner
- track movement intent
- support priorities
- support interruption
- support degraded movement
- support emergency stop
- support movement snapshots

---

## Required Priority Model

| Priority | Source |
|---|---|
| CRITICAL | desync recovery |
| HIGH | damage evasion |
| NORMAL | tasks |
| LOW | follow behavior |
| PASSIVE | lookAt |

---

## 3.2 — Remove Direct Pathfinder Writes

Refactor:
- agent loop
- reconciliation watchdog
- forcedMove
- tasks
- combat
- follow logic

All must request movement THROUGH controller.

---

## Required Guarantees

No subsystem may:
- mutate pathfinder directly
- stop another subsystem silently
- overwrite active movement ownership

---

## Success Criteria

- all movement transitions logged centrally
- movement ownership always known
- no hidden movement conflicts remain

---

# PHASE 4 — Goal & Runtime Ownership

## Goal

Eliminate uncontrolled shared-state mutation.

---

## 4.1 — Encapsulate state.goal

### Problem

11 distinct writers mutate:

```js
state.goal
```

This is dangerous.

---

## Required Refactor

Replace:

```js
state.goal = X
```

with:

```js
setGoal(X, metadata)
```

---

## Required Metadata

Every transition must include:
- source subsystem
- task token
- previous goal
- reason
- timestamp

---

## Required Invariants

Examples:
- task goals require active ownership token
- follow goal cannot overwrite active combat
- recovery goals supersede passive goals

Violations must:
- log loudly
- emit diagnostics
- never silently mutate state

---

## 4.2 — Runtime Invariant Layer

Create invariant assertions for:
- taskBusy consistency
- movement ownership
- watchdog ownership
- task token validity
- goal consistency
- recovery-state consistency

---

## Success Criteria

- no silent state corruption possible
- architecture violations visible immediately
- runtime contracts enforced mechanically

---

# PHASE 5 — Recovery-Centric Runtime

## Goal

Guarantee forward progress.

This phase transforms the runtime from:

```txt
safe but frozen
```

into:

```txt
safe and self-recovering
```

---

## 5.1 — Unified Recovery Engine

### Problem

Current recovery logic fragmented across:
- watchdogs
- damage pipeline
- stuck detection
- reconciliation
- forcedMove
- activity watchdog

No coordination exists.

---

## Required System

Create:

```txt
RecoveryEngine
```

Responsibilities:
- recovery prioritization
- escalation tracking
- recovery cooldowns
- failure classification
- fallback selection

---

## Required Recovery Classes

```txt
RECOVER_MOVEMENT
RECOVER_ENTITY
RECOVER_TASK
RECOVER_PATHFINDER
RECOVER_POSITION
RECOVER_COMBAT
RECOVER_IDLE
RECOVER_FATAL
```

---

## 5.2 — Escalation Model

Each repeated failure increases escalation:

| Level | Response |
|---|---|
| 1 | retry |
| 2 | cancel task |
| 3 | reset movement |
| 4 | rebuild pathfinder |
| 5 | reconnect bot |
| 6 | restart runtime |

---

## Required Guarantees

No repeated failure may:
- retry forever
- loop infinitely
- remain unresolved permanently

---

## 5.3 — Generic Blind Survival Behaviors

When runtime confidence low:
- move randomly
- jump
- strafe
- stop hazard damage
- flee approximate direction
- preserve life over precision

This is critical.

Autonomous agents must:

```txt
prefer imperfect survival over perfect paralysis
```

---

## Success Criteria

- no permanent freeze states
- repeated failures escalate automatically
- bot survives uncertainty more often

---

# PHASE 6 — Observability & Runtime Forensics

## Goal

Make every runtime failure diagnosable.

---

## 6.1 — Persistent Health Beacon

Emit:

```txt
runtime_health_snapshot
```

every 10 seconds.

Must include:
- entity validity
- movement owner
- active task
- watchdog state
- recovery state
- pathfinder status
- liveness classification
- current escalation level

---

## 6.2 — Unified Timeline Tracing

Create correlation IDs for:
- tasks
- goto calls
- recovery attempts
- damage incidents
- movement ownership

Allow full timeline reconstruction.

---

## 6.3 — Failure Taxonomy

Every freeze classified as:
- entity desync
- validator dead-end
- movement deadlock
- async timeout
- planner stall
- runtime corruption
- watchdog failure
- Mineflayer failure
- unknown

Never:

```txt
“something froze”
```

---

## Success Criteria

- every freeze reproducible
- every recovery traceable
- every escalation explainable

---

# Final Architecture Goal

The final runtime should guarantee:

## Safety
- stale tasks cannot corrupt active tasks
- invalid positions cannot corrupt movement
- ownership always enforced

## Liveness
- runtime always progresses toward recovery
- no permanent freezes
- no silent death states

## Recoverability
- all failures classified
- all failures escalated
- all failures bounded

## Observability
- runtime fully diagnosable
- every failure reconstructable
- every ownership transition visible

---

# Final Strategic Direction

This runtime is no longer:

```txt
a Minecraft bot script
```

It is becoming:

```txt
an autonomous embodied realtime agent runtime
```

The engineering priorities must now reflect that reality.

The correct long-term mindset is:
- resilient systems engineering
- runtime ownership discipline
- recovery-oriented architecture
- degraded-mode operation
- probabilistic world-state handling

NOT:

```txt
patching edge cases forever
```

---

# Immediate Implementation Priority

Implement in this exact order:

1. Bounded Mineflayer Promises
2. EntityLivenessMonitor
3. HP-loss watchdog
4. Fatal desync reconnect
5. MovementController
6. Goal ownership encapsulation
7. RecoveryEngine
8. Runtime health beacon

Do NOT reorder these.

The first four eliminate the catastrophic failures.  
The remaining phases mature the runtime into a resilient architecture.