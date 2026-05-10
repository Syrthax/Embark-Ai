# roadmap#2.md — fixes for diagnosis#2

*Derived from `diagnosis#2.md`. One entry per finding. Each entry: **Problem** → **Approach** (the design, not just a patch) → **Claude Code prompt** (copy-paste-ready, self-contained — a fresh session can run it without this conversation) → **Model** (Opus / Sonnet / Haiku, with reason).*

**Model rubric used here:** cross-cutting architectural surgery (new ownership boundaries, collapsing multiple subsystems, large extractions) → **Opus**. Localized but multi-file mechanical change with judgement (wrap an API, add a guard, reorder, NaN-proof) → **Sonnet**. Trivial single-spot edit → **Haiku**.

> Workflow note: this repo has a `runtime-planner` subagent and an `approach.md`. Each prompt below already cites the relevant `diagnosis#2.md` section; when you run one, let `runtime-planner` draft against it first if the change touches `mc-server/bot/`.

---

## Fix 1 — Collapse the desync recovery timeline; reconnect fast *(CRITICAL — diagnosis F-1, F-3; the primary freeze cause)*

**Problem.** A server-state position desync (`bot.entity.position.y === null`) is detected within ~3 s but not *acted on* for ~50–60 s, because: `FATAL_THRESHOLD_MS=30000` before liveness even says `LIVE_FATAL`; `FATAL_QUIT_THRESHOLD_MS=30000` more before `bot.quit()`; the 8 s force-recovery path is gated behind `&& taskBusy` so idle desync is uncovered by it; and the recoveryEngine `POSITION` ladder spends levels 1–2 on no-ops before level 3 reconnects, behind 5 s cooldowns.

**Approach (out-of-the-box).** Stop treating desync as "degraded, wait and see." Introduce a hard, dedicated **DESYNC fast-path** that is *separate* from the graded liveness states:
- Keep the 5-state liveness machine for *quality-of-position* decisions, but add a single source-of-truth predicate `liveness.isDesynced()` = "live position has been structurally invalid (NaN/null component) for > `DESYNC_HARD_MS`" with `DESYNC_HARD_MS ≈ 5000` (one knob).
- The moment `isDesynced()` is true, go straight to reconnect — no `cancelTask`, no `blind_survival`, no escalation ladder. A desync is binary: you're synced or you reconnect.
- Remove the `&& taskBusy` condition from the freeze-forensics force-recovery (bot.js:407) — desync doesn't care whether a task is running.
- **Unify** `fatalDesyncRecovery` and the freeze-forensics force-recovery into one place that owns the reconnect decision, so they can't race (the log showed recoveryEngine winning by ~4 s and `fatalDesyncRecovery`'s 30 s timer being pure dead time). Pick one owner; the other just reports.
- Lower the graded thresholds too, but conservatively — `FATAL_THRESHOLD_MS` from 30 s to ~8 s is reasonable now that the hard desync path exists.
- Make sure the existing `exit_reason.json` write still records `reason: "entity_desync"` so the supervisor's short backoff (`entity_desync: 3000`) applies.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, the bot freezes for ~55 s whenever a damage-triggered escape causes a server position desync (`bot.entity.position.y` arrives as `null`). Root cause is in `diagnosis#2.md` §1.1–1.2 and §3 B1/B8: `entityLiveness.js FATAL_THRESHOLD_MS=30000` + `fatalDesyncRecovery.js FATAL_QUIT_THRESHOLD_MS=30000` stack to a 60 s floor, the 8 s force-recovery in `bot.js` (`if (posInvalidMs > FORCE_RECOVERY_POS_INVALID_MS && taskBusy)` ~line 407) is gated behind `taskBusy`, and `recoveryEngine.js` POSITION levels 1–2 do nothing for a desync. Fix: (1) add `liveness.isDesynced()` to `entityLiveness.js` — true when the live position has had a NaN/null component continuously for > `DESYNC_HARD_MS` (~5000 ms); (2) make a *single* owner (fold `fatalDesyncRecovery.js` and the `bot.js` force-recovery branch together — your call which file hosts it) that, when `isDesynced()` flips true, writes `exit_reason.json` `{reason:"entity_desync",...}` and calls `bot.quit()` immediately — no `cancelTask`, no `blind_survival`, no escalation ladder for desync; (3) remove the `&& taskBusy` condition from the force-recovery check; (4) lower `FATAL_THRESHOLD_MS` to ~8000. Do NOT change the 5-state machine's other transitions, token discipline, the `safe*` wrappers, or the supervisor. Success: in `events.jsonl`, the gap between the first `pos_invalid` / structurally-invalid-position event and `disconnect.quitting` is < ~8 s, and there is no 30 s `LIVE_FATAL` dead-time band before the quit. Run `node bot.js` against the local server briefly to confirm it still connects and behaves normally when *not* desynced.

**Model: Opus** — this redraws the boundary between "graded liveness" and "binary desync," unifies two recovery heads, and touches `entityLiveness.js`, `fatalDesyncRecovery.js`, `bot.js`, and `recoveryEngine.js` coherently. Needs the whole picture in head at once.

---

## Fix 2 — Separate "physically stuck" from "desynced" as distinct recovery classes *(CRITICAL — diagnosis F-2)*

**Problem.** `recoveryEngine` `POSITION` recovery runs `blind_survival` (raw control-state bursts) — a remedy for being *wedged in terrain*. When the bot is *desynced*, that maneuver provably does nothing (log: position unchanged after a 3.1 s `blind_survival`) and can deepen the desync. The two failure modes are collapsed into one class with one (wrong) remedy.

**Approach (out-of-the-box).** Make the distinction first-class:
- `STUCK` recovery class = "live position is *valid* but not changing, pathfinder can't progress" → keep the existing escalation: jiggle / `taskEscape` / `runHazardEscape` / dig-up.
- `DESYNC` recovery class = "live position is structurally invalid (NaN/null)" → the *only* action at any level is reconnect (Fix 1's fast-path). Never run a control-state maneuver here.
- The dispatcher that currently calls `recover('POSITION')` should pick `STUCK` vs `DESYNC` by asking `liveness` whether the position is *valid-but-stale* or *structurally-invalid*.
- `healthIntegrityWatchdog`'s `onSilentDamage()` currently does `replaceTask('blind_survival', …)` — keep that only when the position is valid; if HP is draining *and* the position is structurally invalid, that's `DESYNC`, route to reconnect.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, per `diagnosis#2.md` §1.3 / §3 B2: `recoveryEngine.js` runs `taskBlindSurvival` (raw control-state bursts) for `POSITION` recovery, but that's the remedy for being *physically wedged*, not for a *server desync* — and the logs show it does nothing when the bot is desynced. Replace the single `POSITION` class with two: `STUCK` (live position valid but not progressing — keep the current jiggle/`taskEscape`/dig-up ladder) and `DESYNC` (live position structurally invalid, NaN/null component — the only action at any level is reconnect, reusing the fast-path from Fix 1 / `liveness.isDesynced()`; never run a control-state maneuver). Update every caller of `recover('POSITION', …)` to choose `STUCK` vs `DESYNC` by asking `entityLiveness` whether the position is valid-but-stale or structurally-invalid. Also: in `healthIntegrityWatchdog`'s `onSilentDamage()` path (`bot.js`), only `replaceTask('blind_survival', …)` when the position is valid; if HP is draining *and* the position is structurally inv
alid, treat it as `DESYNC` → reconnect. Don't touch token discipline, `safe*` wrappers, or the goal registry. Success: `events.jsonl` shows `recovery_attempt` with `class:"DESYNC"` going straight to `recovery_reconnect`, and `class:"STUCK"` only ever appearing when the logged position has valid finite coords. Assumes Fix 1 is already merged.

**Model: Opus** — it splits a recovery class, rewires every call site, and has to stay consistent with Fix 1's `isDesynced()`. Cross-cutting.

---

## Fix 3 — Make `bot.pvp.attack()` non-hanging *(HIGH — diagnosis F-4)*

**Problem.** `taskAttackMobs`/`taskAttackPlayer` call `bot.pvp.attack(target)` fire-and-forget and only escape via `Promise.race([once('stoppedAttacking'), setTimeout(30000)])`. If the target dies/leaves range/desyncs and `stoppedAttacking` never fires, the bot stands in goal `attacking` for 30 s. No target-validity poll.

**Approach (out-of-the-box).** Wrap pvp the same way `safeMineflayer.js` wraps `dig`/`craft`/etc — a `safeAttack(bot, target, { maxMs, label })` helper that:
- starts `bot.pvp.attack(target)`,
- resolves on `stoppedAttacking` **or** a short hard cap (~10 s, not 30 s),
- runs an internal ~500 ms poll: if `target` is no longer a valid entity, or `target.position` is gone, or distance > a reasonable engage radius, or the target's HP hit 0 → `bot.pvp.stop()` and resolve early,
- logs a structured `safe_attack_*` event (mirrors the existing `safe_dig_timeout` style) so postmortems see it.
Then both attack tasks call `safeAttack(...)` instead of the inline race. Combat goal is released the moment the fight is genuinely over, not 30 s later.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, per `diagnosis#2.md` §1.4 / §3 B5: `taskAttackMobs` and `taskAttackPlayer` in `bot.js` call `bot.pvp.attack(target)` fire-and-forget and only escape via `Promise.race([bot.once('stoppedAttacking'), setTimeout(30000)])` — so if the target dies/leaves/desyncs and `stoppedAttacking` never fires, the bot stands in goal `attacking` for 30 s. Add a `safeAttack(bot, target, { maxMs = 10000, label })` helper to `safeMineflayer.js` (match the `withTimeout`/`safeDig` pattern already there): start `bot.pvp.attack(target)`, resolve on `stoppedAttacking` OR `maxMs` OR an internal ~500 ms poll detecting target invalid / `target.position` gone / distance beyond a sane engage radius / target HP ≤ 0 — on early-out call `bot.pvp.stop()` first; emit a structured `safe_attack_done`/`safe_attack_timeout` log event. Replace the inline races in both attack tasks with `safeAttack(...)`. Don't change the threat loop, anger system, or `reactToMobAttack`/`reactToPlayerAttack` logic (those are separate fixes). Success: `events.jsonl` shows `safe_attack_*` events; after a target dies or wanders off, goal returns from `attacking` within a couple seconds, never 30 s.

**Model: Sonnet** — localized, mirrors an existing pattern in `safeMineflayer.js`, two call sites. Mechanical with light judgement on the early-out conditions.

---

## Fix 4 — Single damage-reaction authority; kill the `resting ↔ following` oscillation *(HIGH — diagnosis F-5)*

**Problem.** Two reaction authorities: `bot.on('health')` (immediate `cancelCurrentTask()` + `setGoal('resting')` on `hp ≤ 4`, no cooldown) and `processDamageWindow()` (1.5 s window, 3 s cooldown, classify → `reactToXxx` → `replaceTask`). On a sustained hazard both fire; the health path preempts; the agent loop re-resumes `following`; the classifier's intended *escape* is suppressed by its own cooldown. Bot bounces `resting → following → resting` while HP drains.

**Approach (out-of-the-box).** One reaction authority — `processDamageWindow` — and make `bot.on('health')` a *reporter* into it:
- `bot.on('health')` no longer cancels/sets goal directly. Instead, when HP drops sharply or crosses a critical floor, it pushes a synthetic high-priority entry into `damageWindow` (or sets a `criticalHpFlag`) and lets the next `processDamageWindow` tick classify it.
- `processDamageWindow` gains a *priority bypass*: a critical-HP entry reacts immediately (skips the 3 s cooldown for *this* incident only), and its reaction is an actual escape (`taskEvadeHazard` / `taskFlee`), not bare `resting`.
- The reaction cooldown now genuinely spans everything, because there's only one path.
- The agent-loop follow-resume (bot.js:2207) should additionally check "not currently in a damage-reaction goal" (`evading`/`fleeing`/`attacking`/`resting`) before resuming `following` — belt and suspenders so a half-tick race can't undo an escape.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/bot.js`, per `diagnosis#2.md` §1.5 / §3 B6: there are two damage-reaction authorities — `bot.on('health')` (~line 778, immediately `cancelCurrentTask()` + `setGoal('resting')` on `hp ≤ 4`, no cooldown) and `processDamageWindow()` (~line 626, 1.5 s window + 3 s `REACTION_COOLDOWN_MS`, then `reactToIncident`) — and on a sustained hazard they fight: health preempts, the agent loop (~line 2207) re-resumes `following`, the classifier's escape is suppressed by its own cooldown, so the bot oscillates `resting ↔ following` while HP drains. Make `processDamageWindow` the single authority: `bot.on('health')` should, on a sharp HP drop / critical floor, push a synthetic high-priority entry into `damageWindow` (or set a `criticalHpFlag`) instead of acting; `processDamageWindow` gets a priority bypass that reacts to such an entry immediately (skipping the 3 s cooldown for that incident only) with a real escape (`taskEvadeHazard`/`taskFlee`), not bare `setGoal('resting')`; and the agent-loop follow-resume must not resume `following` while `state.goal` is one of `evading`/`fleeing`/`attacking`/`resting`. Keep `bot.on('death')` and `bot.on('respawn')` as-is. Don't touch the damage *classifier* logic, the anger system, or token discipline. Success: under a sustained lava/fire hazard in a test world, `events.jsonl` shows a single `damage_incident` → escape, no `resting`/`following` flapping, and the bot actually leaves the hazard.

**Model: Sonnet** — single file, well-bounded behavior change, but needs care around the window/cooldown interaction and the agent-loop guard. Sonnet is enough.

---

## Fix 5 — A recovery arbiter: watchdogs *report*, one module *decides* *(HIGH — diagnosis F-6)*

**Problem.** ≥8 independent observers (`startFreezeForensics`, `fatalDesyncRecovery`, `recoveryEngine` callers, `healthIntegrityWatchdog`, `startReconciliationWatchdog`, `startActivityWatchdog`, `processDamageWindow`, `bot.on('health')`) each *observe* overlapping symptoms and each *act*. They race (logged: recoveryEngine reconnect ~4 s before `fatalDesyncRecovery`'s timer; redundant). No module owns "symptom → action at level."

**Approach (out-of-the-box).** Promote `recoveryEngine` to a true **arbiter** and demote everyone else to *reporters*:
- A single API: `recoveryEngine.report(symptom, context)` where `symptom ∈ {DESYNC, STUCK, TASK_HUNG, IDLE, ENTITY_ORPHAN, COMBAT_STALL, CRITICAL_HP, MOVEMENT_TIMEOUT_STREAK}`.
- The arbiter holds a small state: current "worst active symptom," its level, last action time. It dedups (two reporters, same symptom in the same window → one action), it orders (DESYNC outranks STUCK outranks IDLE), and it owns the escalation ladder and cooldowns (already there).
- All the watchdogs keep their *detection* loops but their *only* output is `report(...)`. `fatalDesyncRecovery` becomes "detect desync → `report('DESYNC')`" and stops calling `bot.quit()` itself. `bot.on('health')` becomes "detect critical HP → `report('CRITICAL_HP')`" (this dovetails with Fix 4 if the damage window forwards to the arbiter instead).
- One reconnect path, one place to read "why did it recover," one place to tune.
- This is the structural fix that makes Fixes 1, 2, and 4 *stay* fixed instead of drifting back into competing paths — sequence it after them so it consolidates a known-good behavior rather than chasing a moving target.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, per `diagnosis#2.md` §2.1 / §3 B8: recovery is multi-headed — `startFreezeForensics`, `fatalDesyncRecovery.js`, `recoveryEngine.js` callers, `healthIntegrityWatchdog.js`, `startReconciliationWatchdog`, `startActivityWatchdog`, `processDamageWindow`, and `bot.on('health')` all independently detect overlapping symptoms AND independently act, and they race. Refactor `recoveryEngine.js` into the single arbiter: expose `report(symptom, context)` where `symptom ∈ {DESYNC, STUCK, TASK_HUNG, IDLE, ENTITY_ORPHAN, COMBAT_STALL, CRITICAL_HP, MOVEMENT_TIMEOUT_STREAK}`; the arbiter dedups same-symptom reports within a window, orders symptoms (DESYNC > STUCK > MOVEMENT_TIMEOUT_STREAK > TASK_HUNG > ENTITY_ORPHAN > COMBAT_STALL > CRITICAL_HP > IDLE), owns the existing per-class escalation ladder + cooldowns, and is the only thing that ever calls `bot.quit()`. Convert every other watchdog to call `report(...)` and nothing else — in particular `fatalDesyncRecovery.js` becomes "detect desync → report('DESYNC')" with no `bot.quit()` of its own. Keep all the *detection* loops and their cadences. Preserve token discipline, `safe*` wrappers, goal registry, movement controller. Success: `events.jsonl` shows recovery actions only ever originating from `recoveryEngine` (one `recovery_*` source), no two watchdogs acting on the same incident, exactly one reconnect per desync incident. Sequence: do this AFTER Fixes 1, 2, 4 are merged.

**Model: Opus** — this is the big consolidation: new API, every watchdog touched, ordering/dedup semantics, must not regress Fixes 1/2/4. Definitely Opus.

---

## Fix 6 — Give `reactToPlayerAttack` the guard `reactToMobAttack` has *(MEDIUM — diagnosis F-7)*

**Problem.** `reactToMobAttack` opens with `if (taskBusy && state.goal === 'attacking') return`. `reactToPlayerAttack` has no such guard — at anger ≥ `ANGER_ATTACK_LEVEL` it unconditionally `replaceTask('attacking', () => taskAttackPlayer(...))`, restarting the attack task on every hit and clobbering whatever the bot was doing.

**Approach.** Add the symmetric guard. If already attacking *this* player, do nothing (the existing attack task will keep going). If attacking someone/something else, decide deliberately (switch target only if the new attacker is closer / has hit more) rather than blind restart. Also extend the `already-engaged` short-circuit to the counter-punch branch so a flurry of hits doesn't queue a counter-punch per hit beyond the existing `COUNTER_PUNCH_COOLDOWN_MS`.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/bot.js`, per `diagnosis#2.md` §2.3 / §3 B4: `reactToMobAttack` (~line 729) starts with `if (taskBusy && state.goal === 'attacking') return // already engaged`, but `reactToPlayerAttack` (~line 706) has no equivalent — so a player hitting the bot mid-task unconditionally `replaceTask('attacking', () => taskAttackPlayer(...))` every hit, restarting the attack and clobbering the current task. Add the symmetric guard to `reactToPlayerAttack`: if already in goal `attacking` against this same player, return; if attacking a different target, only switch if the new attacker is closer or has dealt more recent hits, otherwise return. Leave the anger/chat logic and `COUNTER_PUNCH_COOLDOWN_MS` as-is. Success: `events.jsonl` shows at most one `task_start attacking` per sustained player attack, not one per hit.

**Model: Haiku** — a few lines in one function, mirroring an adjacent function. Trivial.

---

## Fix 7 — Fix the `taskBusy` clear-before-stop window (and optionally de-overload the flag) *(MEDIUM — diagnosis F-8, F-9)*

**Problem (small).** `cancelCurrentTask` sets `taskBusy = false` *before* `movement.forceStop('cancel')` / `bot.pvp.stop()` / `bot.clearControlStates()`. A `runTask` slipping in during that window passes the `if (taskBusy) return false` re-entrancy gate and mints a new token while the old task's pathfinder/pvp is still unwinding.

**Problem (broader, optional).** `taskBusy` doubles as the re-entrancy lock *and* the public "is the bot doing something deliberate?" flag consulted by ~15 sites; when the two meanings diverge (exactly during cancel), those sites read a stale answer.

**Approach.** *Small:* move `taskBusy = false` to the *end* of `cancelCurrentTask`, after movement/pvp/control-states are stopped. *Broader (only if the small fix proves insufficient):* split into `taskLock` (private, the re-entrancy guard, set false last) and `botEngaged` (public, what the loops read), and have the ~15 readers consult `botEngaged`. Recommend doing the small fix now and noting the broader one in `approach.md` rather than bundling.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/bot.js`, per `diagnosis#2.md` §2.2 / §3 B3: in `cancelCurrentTask` (~line 830), `taskBusy = false` (~line 837) executes *before* `movement.forceStop('cancel')` (~line 842), `bot.pvp.stop()`, and `bot.clearControlStates()` — so a `runTask` call landing in that window passes the `if (taskBusy) return false` guard and starts a new task while the old one's pathfinder/pvp is still unwinding. Move the `taskBusy = false` assignment to the very end of `cancelCurrentTask`, after movement/pvp/control-states are all stopped. Keep the rest of the function (token nulling, watchdog clear, goal→idle via `setGoal`) in its current order; just relocate the `taskBusy = false` line to last. Don't change `runTask`/`replaceTask`. Success: `cancelCurrentTask` returns with `taskBusy === false` only after `forceStop` has run; no behavior change observable in normal operation, but the re-entrancy window is closed. (Optional follow-up, note in `approach.md` only: split `taskBusy` into a private `taskLock` and a public `botEngaged` flag — do NOT do this in the same change.)

**Model: Haiku** — relocating one line, with a clear note about the optional bigger refactor. Trivial.

---

## Fix 8 — Make `environmentPerception.scan()` honest under a `NaN`/null position *(MEDIUM — diagnosis F-10)*

**Problem.** `scan()` floors `bot.entity.position`; `Math.floor(NaN) === NaN`; `blockAt({x:NaN,…})` → null (swallowed); every block reads "clear"; `locomotionRisk = 0`; escape vector defaults North. The `_empty()` guard only fires when `bot.entity?.position` is *absent*, not when a component is `NaN`/`null`. So during `LIVE_FATAL` the perception layer reports a safe empty world, and `runHazardEscape` yaw can be mis-aimed from the junk vector.

**Approach.** Tighten the guard: `scan()` should return a clearly-flagged `{ valid: false, reason: 'position_invalid' }` (or set `lastEnvScan.positionInvalid = true`) whenever any of `position.x/y/z` is non-finite — *before* doing any block probing. Callers (`startPerceptionLoop`, `runHazardEscape`, anything reading `lastEnvScan`) must check that flag and not treat an invalid scan as "all clear." `runHazardEscape` should refuse to compute a yaw from an invalid scan (and, given Fix 2, a desync shouldn't be running `runHazardEscape` at all). This is mostly an observability/correctness fix — the pathfinder already can't run with `NaN` coords.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/environmentPerception.js`, per `diagnosis#2.md` §2.5 / §3 B7: `scan()` floors `bot.entity.position` without checking finiteness, so a `NaN`/null component (which happens during `LIVE_FATAL`) makes every probed block read as "clear", `locomotionRisk` come out 0, and the escape vector default to North — the `_empty()` guard only catches an *absent* position object, not a `NaN` component. Fix: at the top of `scan()`, if any of `bot.entity?.position?.x/y/z` is not `Number.isFinite`, return a result explicitly flagged invalid (e.g. `{ valid: false, reason: 'position_invalid', ...minimal fields }`) without probing any blocks. Update `startPerceptionLoop` in `bot.js` and `locomotionRecovery.js`'s `runHazardEscape` (and any other reader of `lastEnvScan`) to check that flag and NOT treat an invalid scan as safe — `runHazardEscape` must not derive a yaw from an invalid scan. Don't change the hazard taxonomy, traversability scoring, or hazard-memory logic for the valid case. Success: when the position is `NaN`, `events.jsonl` shows perception reporting invalid (not `locomotionRisk:0`), and no `runHazardEscape` runs off a junk vector.

**Model: Sonnet** — small but touches three files (perception, bot.js loop, locomotionRecovery) and needs every reader updated consistently. Sonnet.

---

## Fix 9 — Actually carve `bot.js` down (modularization the roadmap promised) *(MEDIUM — diagnosis F-11)*

**Problem.** `bot.js` is 2580 lines — it *grew* past roadmap#1's 2336 instead of shrinking toward the ~600-line orchestrator target. The new modules wrap *pieces* (pathfinder, goal mutation, mineflayer calls) but the *behavior* — the damage pipeline, every `taskXxx` body, all six+ loops — was never extracted.

**Approach (out-of-the-box).** Stop "extracting helpers." Extract **whole subsystems**, in this order (smallest blast radius first):
1. `damagePipeline.js` — `captureDamageEvent`, `processDamageWindow`, `classifyIncident`, `reactToIncident`, `reactToXxx`, `rememberHazard`, hazard memory. Takes `{bot, log, state, liveness, envPerception, replaceTask, recoveryEngine, safeChat, anger}` as deps. (~200 LOC out of bot.js.)
2. `tasks/` directory — one file per `taskXxx` (or grouped: `tasks/combat.js`, `tasks/gather.js`, `tasks/build.js`, `tasks/survival.js`). Each task is a factory `({bot, deps}) => async function task...`. (~850 LOC out.)
3. `loops.js` — `startStateLoop`, `startAgentLoop`, `startThreatLoop`, `startPerceptionLoop`, `startActivityWatchdog`, `startAngerDecay`, `startHealthBeacon`, `startReconciliationWatchdog`, `startFreezeForensics`. (~400 LOC out.)
After: `bot.js` = create bot, wire deps, register listeners, kick the loops. Target < ~700 LOC. **Do not change behavior** — pure mechanical move + dependency-injection plumbing, verified by `events.jsonl` looking identical before/after on a smoke run. Sequence this *last* (after Fixes 1–8), because doing it earlier means re-doing the moves every time a behavior fix lands; doing it after locks in the good behavior. Have the `code-quality` subagent check LOC budgets afterward.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, per `diagnosis#2.md` §2.4: `bot.js` is 2580 lines — modularization in roadmap#1 *added* modules alongside the monolith instead of carving it down. Do a behavior-preserving extraction in three steps, each its own commit, smoke-tested with `node bot.js` against the local server (the `events.jsonl` stream must look unchanged): (1) `damagePipeline.js` — move `captureDamageEvent`, `processDamageWindow`, `classifyIncident`, `reactToIncident`, the `reactToXxx` reaction functions, `rememberHazard`, and the hazard-memory arrays; export a factory taking the deps it needs (`bot, log, state, liveness, envPerception, replaceTask, recoveryEngine, safeChat`, anger helpers); `bot.js` just calls it and registers the `entityHurt` listener. (2) A `tasks/` directory — move each `taskXxx` body into `tasks/combat.js`/`gather.js`/`build.js`/`survival.js` as factory functions `({bot, ...deps}) => async function`; `bot.js` imports the bound tasks. (3) `loops.js` — move all the `startXxxLoop`/`startXxxWatchdog`/`startFreezeForensics`/`startHealthBeacon` functions; `bot.js` calls a single `startLoops(deps)`. Absolutely no behavior changes — pure moves + DI plumbing. Preserve token discipline, `isOwner` guards, `safe*` wrappers, goal registry, movement controller exactly. After all three: `bot.js` should be under ~700 lines. Success: `wc -l bot.js` < 700; a smoke run produces the same kinds/sequence of `events.jsonl` entries as before; `git diff` shows code *moved*, not rewritten. Sequence: do this LAST, after all the behavior fixes (Fixes 1–8) are merged.

**Model: Opus** — large multi-file extraction with dependency-injection plumbing across the whole module; high risk of accidental behavior change if done carelessly. Opus, and do it in the three separate commits the prompt specifies.

---

## Fix 10 — Remove dead state (`taskFailureCounts`, `recoveryAttempts`) *(LOW — diagnosis F-12)*

**Problem.** `taskFailureCounts` and `recoveryAttempts` are declared/populated/incremented in `bot.js` but never consulted for any decision. Noise; implies a mechanism that isn't wired.

**Approach.** Confirm with `grep` that each is only ever written, never read in a conditional/branch; then delete the declaration and all write sites. If a read *is* found, leave it and report instead.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/bot.js`, per `diagnosis#2.md` §3 B9: `taskFailureCounts` and `recoveryAttempts` are declared and written but (believed) never read for any decision. For each: `grep -n` every occurrence; if it's only ever assigned/incremented and never read in a condition or passed somewhere that reads it, delete the declaration and all write sites; if any genuine read exists, leave it untouched and report what reads it. Don't touch anything else. Success: `grep` finds zero references to the removed names; `node bot.js` still starts and runs normally.

**Model: Haiku** — grep + delete, with a guard clause. Trivial.

---

## Fix 11 — Add slash-command navigation (`/locate`, `/tp`-aware pathing) *(MEDIUM for autonomy — diagnosis F-13)*

**Problem.** No server-command path at all. Navigation is memory-of-last-~5-locations or random 10–30-block vectors. The bot can't go *to* a biome/structure/coordinate on request.

**Approach (out-of-the-box).** A small `serverCommands.js` that issues chat commands and parses their responses (mineflayer surfaces `/locate` output as a chat message with a coordinate and a "click to teleport" component): `locateStructure(name)` and `locateBiome(name)` → resolve a target `{x,z}`; then route that through `movementController.navigate(...)` as a NORMAL-priority goal (long-distance: chunk by chunk, with the existing timeout/retry). Add an `executeAction` action label `go_to_structure` / `go_to_biome` and an LLM schema entry. Permission-aware: if `/locate` comes back "Unknown or incomplete command" / "you do not have permission," fall back to the existing exploration and say so in chat. Optionally support `/tp` only when the bot has op (detect via the same permission-denied signal) — but treating `/locate` as "find the coordinate, then walk there" is the robust default that needs no op.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, per `diagnosis#2.md` §5 (carryover) and `final_validation_report.md`: the bot has no slash-command navigation — all movement is memory-based or random vectors. Add `serverCommands.js`: `locateStructure(bot, name)` and `locateBiome(bot, name)` that send `/locate structure <name>` / `/locate biome <name>` and parse the chat response for the coordinate (mineflayer delivers `/locate` results as a chat message with a position + a click-to-teleport component — extract `{x, z}` from it; reject/fallback on "Unknown or incomplete command" or permission-denied text). Wire a new `executeAction` branch + LLM action label (`go_to_structure`, `go_to_biome` with a `target` arg) in `bot.js`/`engine.js`/`llm.js` that resolves the coordinate via `serverCommands.js` then drives there with `movementController.navigate(...)` at NORMAL priority using the existing long-distance/timeout/retry plumbing; if location fails or permission is denied, fall back to `taskExplore` and `safeChat` an explanation. Don't add `/tp` unless op is detected via a permission-denied signal — "locate then walk" is the default and needs no op. Don't change the threat/anger/survival paths. Success: in a test world, `@Ember go to the nearest village` results in a `/locate` chat, a parsed coordinate, and the bot pathing toward it; with no permission, it says it can't and explores instead.

**Model: Sonnet** — new small module + a few wiring points across `bot.js`/`engine.js`/`llm.js`, with parsing/permission-handling judgement. Sonnet.

---

## Fix 12 — Inventory-overflow handling in gather/mine/craft tasks *(MEDIUM-HIGH — diagnosis F-14)*

**Problem.** `taskMineBlock`, `taskGatherWood`, `taskCraftPlanks`, `taskBuildHouseSmart` don't check free inventory slots before/while running; no auto-drop. After extended gathering the bot wedges with a full inventory and keeps trying.

**Approach (out-of-the-box).** A shared `inventory.js` helper: `freeSlots(bot)`, `isFull(bot)`, and `makeRoom(bot, { keep: [...priorityItemNames], log })` that tosses the lowest-value junk (cobblestone, dirt, gravel, rotten flesh, etc. — a configurable junk list) until there are ≥ N free slots. Gather/mine/craft tasks call `makeRoom(...)` as a pre-flight (and re-check periodically inside long loops); if `makeRoom` can't free enough (everything is "keep"), the task ends gracefully with a chat message instead of spinning. Optionally: when full and near a known chest location in memory, deposit instead of dropping — but auto-drop-junk is the minimum viable fix.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/`, per `diagnosis#2.md` §5 (carryover) and `final_validation_report.md`: `taskMineBlock`, `taskGatherWood`, `taskCraftPlanks`, `taskBuildHouseSmart` (in `bot.js`) never check free inventory slots and there's no auto-drop, so after extended gathering the bot wedges with a full inventory. Add `inventory.js`: `freeSlots(bot)`, `isFull(bot)`, and `makeRoom(bot, { minFree = 4, keep = [...priorityNames], log })` that `bot.toss`es the lowest-value junk (configurable list: cobblestone, dirt, gravel, andesite/diorite/granite, rotten_flesh, etc.) until `freeSlots >= minFree`, never tossing anything in `keep`; emit a structured `inventory_makeroom` log event. In each of those tasks, call `makeRoom(...)` before starting and re-check inside any long loop; if it can't free enough, end the task cleanly with a `safeChat` ("My inventory's full of stuff I need — stopping.") instead of spinning. Use the `safe*` wrappers / token discipline as the surrounding tasks already do. Success: run a long `gather_wood` in a test world to fill the inventory — `events.jsonl` shows `inventory_makeroom` events and the task continues, or ends cleanly with the chat message; no infinite retry against a full inventory.

**Model: Sonnet** — new helper + four call-site integrations, with a junk-list/keep-list judgement call. Sonnet.

---

## Fix 13 — Water/drowning escape that works mid-task *(MEDIUM — diagnosis F-15)*

**Problem.** The only water-survival mechanism is `bot.entity?.isInWater && !taskBusy → jump = true` in the agent loop (bot.js:2220). A task that walks the bot into water blocks the only escape; if the task also doesn't surface, the bot drowns.

**Approach.** Two parts: (1) make the agent-loop water-jump *not* gated behind `!taskBusy` — surfacing is reflexive, like the threat reaction; set `jump = true` whenever submerged, regardless of task (it doesn't conflict with most tasks, and a task that genuinely needs the bot underwater is not a thing this bot does). (2) Add a `breath` check to the damage/health path: when `bot.oxygenLevel` (air) drops below a threshold, `report('CRITICAL_HP'-style 'DROWNING')` to the recovery arbiter (or, pre-Fix-5, `replaceTask('evading', () => taskEvadeHazard({name:'water'}))`) so an active task is interrupted to surface. `taskEvadeHazard` should know how to handle `water` (swim up + toward the nearest non-water column).

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/bot.js`, per `diagnosis#2.md` §5 (carryover): the only drowning protection is the agent-loop line `if (bot.entity?.isInWater && !taskBusy) jump = true` (~line 2220), so a task that walks the bot into water blocks the only escape. (1) Remove the `!taskBusy` condition — set `jump = true` whenever `bot.entity?.isInWater`, regardless of task; surfacing is reflexive. (2) Add a breath check: when `bot.oxygenLevel` drops below ~6 (air ticks), interrupt whatever's running to surface — `replaceTask('evading', () => taskEvadeHazard({ name: 'water' }))` (or, if Fix 5's arbiter exists, `recoveryEngine.report('DROWNING', ...)`). (3) Make `taskEvadeHazard` handle `name === 'water'`: swim up (`jump`) and head toward the nearest non-water column / dry land. Don't change other survival paths. Success: in a test world, send the bot mining/exploring into deep water — it surfaces and leaves, `events.jsonl` shows the water-evade, and `bot.oxygenLevel` never reaches 0.

**Model: Sonnet** — one-line gate removal is trivial, but the breath check + `taskEvadeHazard` water handling needs real logic. Sonnet.

---

## Fix 14 — Fall-damage awareness *(LOW-MEDIUM — diagnosis F-16)*

**Problem.** `findNearbyHazard(2)` can't perceive "I'm falling," so fall damage classifies as `unknown`, and `reactToUnknownDamage` only reacts if `bot.health < 12`. The bot takes repeated fall damage off ledges without recognizing the cause.

**Approach.** Add a `fall` hazard signal to `classifyIncident`: if at damage time `bot.entity.velocity.y` was strongly negative *and* `!onGround` in the captured event (these are already in `captureDamageEvent`), classify as `environmental` with `hazard: { name: 'fall' }`. `reactToEnvironmental`'s response for `fall` = stop horizontal movement, don't path further off the edge, and (if mid-task) cancel a task that's walking the bot toward a drop. Cheap, uses data already captured.

**Claude Code prompt:**
> In `/Users/sarthakghosh/projects/project-k/mc-server/bot/bot.js`, per `diagnosis#2.md` §5 (carryover): fall damage classifies as `unknown` because `findNearbyHazard` can't see falling, and `reactToUnknownDamage` only reacts under `hp < 12`. In `classifyIncident` (~line 667), before the `unknown` fallback, add a `fall` check: if the captured damage events show `velocity.y` strongly negative (e.g. < -0.5) and `onGround === false` (both already captured in `captureDamageEvent`), return `{ type: 'environmental', hazard: { name: 'fall' }, summary: { hazard: 'fall' } }`. In `reactToEnvironmental`, handle `name === 'fall'`: clear horizontal control states, do not path further in the current direction, and if a task is running that's heading toward the drop, `cancelCurrentTask()` + `setGoal('idle', ...)`. Don't change the player/mob classification or the other environmental cases. Success: stepping the bot off a ledge in a test world produces a `damage_incident` with `hazard:"fall"` and the bot stops at the edge instead of repeatedly walking off.

**Model: Haiku** — a small branch in `classifyIncident` + a small case in `reactToEnvironmental`, using already-captured fields. Trivial.

---

## Recommended execution order

1. **Fix 1** (desync fast-path) — the headline; everything else is secondary.
2. **Fix 2** (STUCK vs DESYNC classes) — depends on Fix 1's `isDesynced()`.
3. **Fix 3** (`safeAttack`) — independent; kills the secondary 30 s freeze.
4. **Fix 4** (single damage authority) — independent of 1–3; kills the `resting↔following` oscillation.
5. **Fix 6** (player-attack guard) — independent, tiny, do it whenever.
6. **Fix 7** (taskBusy clear-last) — independent, tiny.
7. **Fix 8** (perception NaN honesty) — best after Fix 2 (so a desync isn't running `runHazardEscape` anyway), but standalone-safe.
8. **Fix 5** (recovery arbiter) — *after* 1, 2, 4 — it consolidates their good behavior into one owner; doing it earlier means redoing it.
9. **Fix 10** (dead-state removal) — anytime; do it as part of the Fix 9 cleanup pass if convenient.
10. **Fixes 11–14** (slash commands, inventory overflow, drowning, fall damage) — the diagnosis#1 carryovers; independent of the freeze work, prioritize Fix 12 (inventory) and Fix 13 (drowning) as the next real survival risks.
11. **Fix 9** (modularize `bot.js`) — **last**. Pure mechanical extraction once behavior is settled; re-doing it after each behavior fix would be wasteful.

## Do not regress (mirror of diagnosis §4)

- Token discipline: `Symbol` ownership tokens, `isOwner(myToken)` on every deferred callback, atomic `cancelCurrentTask`/`replaceTask`.
- `safe*` Mineflayer wrappers (`safeDig`/`safeCraft`/`safeEquip`/`safeConsume`/`safePlaceBlock`, and the new `safeAttack`) — no raw `await bot.<op>()` in hot paths.
- `goalRegistry.setGoal()` as the sole `state.goal` mutator.
- `movementController` as the sole `bot.pathfinder` writer; priority model intact.
- Recovery → exactly one path to `bot.quit()` (after Fix 5, that's the arbiter; before it, don't add new ones).
- `exit_reason.json` always written on quit with a real `reason`, so the supervisor's per-class backoff applies.
- Correlation IDs threaded through tasks/goto/recovery/damage; structured JSONL logging with rotation.
- After Fix 9: `bot.js` stays under ~700 LOC (have `code-quality` enforce it).
