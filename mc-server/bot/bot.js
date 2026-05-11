// Load .env from project root before anything else (Featherless API key, model)
require('./env').loadEnv()

const fs   = require('fs')
const path = require('path')

const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')

const { loadMemory, rememberLocation, rememberEvent, rememberKnowledge, recallLocation } = require('./memory')
const { buildGroundedState, chatSummary, HOSTILE_MOB_NAMES } = require('./state')
const { classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal, detectInsult } = require('./engine')
const { queryLLM, checkOllama, getModelName } = require('./llm')
const log = require('./logger')
const { safeDig, safeCraft, safeEquip, safeConsume, safePlaceBlock, safeAttack } = require('./safeMineflayer')
const createEntityLivenessMonitor    = require('./entityLiveness')
const createHealthIntegrityWatchdog  = require('./healthIntegrityWatchdog')
const createFatalDesyncRecovery      = require('./fatalDesyncRecovery')
const createMovementController       = require('./movementController')
const createGoalRegistry             = require('./goalRegistry')
const createRecoveryEngine           = require('./recoveryEngine')
const createEnvironmentPerception    = require('./environmentPerception')
const createLocomotionRecovery       = require('./locomotionRecovery')
const createDamagePipeline           = require('./damagePipeline')
const createTasks                    = require('./tasks')
const createPositionGuard            = require('./positionGuard')

// ── Configuration via env ─────────────────────────────────────────────────────
const BOT_NAME    = process.env.BOT_NAME    || 'Ember'
const SERVER_HOST = process.env.SERVER_HOST || 'localhost'
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '25565', 10)
const MC_VERSION  = process.env.MC_VERSION  || '1.21.4'

const bot = mineflayer.createBot({
  host:     SERVER_HOST,
  port:     SERVER_PORT,
  username: BOT_NAME,
  version:  MC_VERSION,
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)

const liveness  = createEntityLivenessMonitor(bot, log)
const movement  = createMovementController(bot, goals, makeMovements, log)

// ── Internal State ─────────────────────────────────────────────────────────────
const state = {
  energy: 100,
  hunger: 100,
  goal: 'idle',
  idleTicks: 0,
  followTarget: null,    // username being followed (specific, not "nearest")
  lastActivityAt: Date.now(),  // for global activity watchdog
}

const memory   = loadMemory()
const anger    = new Map()  // username → { level, count, lastAt }
let llmEnabled    = false
let llmBusy       = false
let taskBusy      = false

// ─────────────────────────────────────────────────────────────────────────────
// TASK OWNERSHIP — token-discipline lifecycle
// ─────────────────────────────────────────────────────────────────────────────
//
// Each runTask() invocation mints a Symbol — its ownership token — stored in
// `currentTaskToken`. Per-task state (watchdog handle, goal name, start time)
// lives in `currentTaskContext`. Every deferred callback (catch, finally,
// watchdog, retry timer) verifies via `isOwner(myToken)` that it is still the
// active task before mutating any global state, pathfinder, pvp, or controls.
//
// When a task is replaced via `replaceTask()`, the old token is superseded
// atomically (single synchronous block — JS is single-threaded, no race).
// The old task's pending Promise will resolve later, but its callbacks see
// they are no longer the owner and become observational-only — they cannot
// corrupt the new task's globals, watchdog, or movement state.
//
// This is the architectural fix for the canonical livelock where an old
// task's deferred cleanup would clear the new task's watchdog and taskBusy.
//
// Invariant: if currentTaskToken === T, then currentTaskContext.token === T
//            and taskBusy === true. If currentTaskToken === null, taskBusy
//            should be false. Both are restored in cancelCurrentTask().
//
let currentTaskToken   = null
let currentTaskContext = null   // { token, goalName, startedAt, silent, watchdog }

const { setGoal } = createGoalRegistry(
  state,
  () => ({ taskBusy, currentTaskToken }),
  log
)

const isOwner = (token) => currentTaskToken === token

// ─────────────────────────────────────────────────────────────────────────────
// VECTOR SAFETY LAYER
// Every coordinate that flows into the pathfinder must pass through these.
// The pathfinder rejects NaN, but only AFTER it has been called — by that
// point the task has already started, the watchdog is running, and the
// failure mode is a 15-second timeout. These helpers make NaN impossible
// to construct in the first place.
// ─────────────────────────────────────────────────────────────────────────────

const VEC_EPSILON = 1e-6

const isFiniteNum = (n) => typeof n === 'number' && Number.isFinite(n)

// True iff v has finite x, y, z. Works on Vec3, plain objects, or null/undefined.
function isValidVec(v) {
  return v != null && isFiniteNum(v.x) && isFiniteNum(v.y) && isFiniteNum(v.z)
}

// Returns { x, y, z } with floored coords, or null if any coord is invalid.
function safeFloor(v) {
  if (!isValidVec(v)) return null
  return { x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) }
}

// Normalise a 2D direction. Returns { dx, dz } with magnitude 1.
// Falls back to a random unit direction if input is invalid or zero-length.
function safeNormalize2D(dx, dz) {
  if (!isFiniteNum(dx) || !isFiniteNum(dz)) {
    const a = Math.random() * Math.PI * 2
    return { dx: Math.sin(a), dz: Math.cos(a), fallback: 'invalid_input' }
  }
  const len = Math.sqrt(dx * dx + dz * dz)
  if (len < VEC_EPSILON) {
    const a = Math.random() * Math.PI * 2
    return { dx: Math.sin(a), dz: Math.cos(a), fallback: 'zero_length' }
  }
  return { dx: dx / len, dz: dz / len, fallback: null }
}

// Wait until bot.entity.position has finite x,y,z. Resolves with the position,
// or rejects on timeout. Used by every task that reads the bot's current position.
async function awaitValidPosition(timeoutMs = 2000) {
  const start = Date.now()
  // Fast path: position is already valid
  if (isValidVec(bot.entity?.position)) return bot.entity.position
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 80))
    if (isValidVec(bot.entity?.position)) return bot.entity.position
  }
  throw new Error(`bot position invalid for ${timeoutMs}ms (post-teleport / pre-spawn race)`)
}

// ── Utility: rate-limited chat queue (Spigot kicks on >4 msgs in 0.5s) ────────
const chatQueue = []
let   chatBusy  = false

function safeChat(msg) {
  const str = String(msg).slice(0, 200)
  if (chatQueue.length >= 5) {
    console.log(`[${BOT_NAME}] [chat-dropped] ${str}`)
    return
  }
  if (chatQueue.length > 0 && chatQueue[chatQueue.length - 1] === str) return  // dedup
  chatQueue.push(str)
  pumpChat()
}

function pumpChat() {
  if (chatBusy || chatQueue.length === 0) return
  chatBusy = true
  const msg = chatQueue.shift()
  try { bot.chat(msg) } catch (e) { console.error('[chat error]', e.message) }
  setTimeout(() => { chatBusy = false; pumpChat() }, 1500)  // 1 msg per 1.5s
}

// ── Boot ───────────────────────────────────────────────────────────────────────
bot.once('spawn', async () => {
  log.info('spawned', {
    pos: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) },
    ...(RECOVERY_CHAIN_ID && { chainId: RECOVERY_CHAIN_ID }),
  })
  if (RECOVERY_CHAIN_ID) {
    log.info('recovery_chain_active', { chainId: RECOVERY_CHAIN_ID })
  }

  // Bring up the long-lived components before the (slow) LLM connectivity check so the
  // damage pipeline's entityHurt/health listeners + classifier are live from spawn.
  recoveryEngine = createRecoveryEngine({
    bot, movement, state, log,
    getTaskContext: () => ({ taskBusy, currentTaskToken }),
    cancelTask:     cancelCurrentTask,
    replaceTask,
    runTask,
    taskBlindSurvival: tasks.taskBlindSurvival,
    taskEscape:        tasks.taskEscape,
    taskExplore:       tasks.taskExplore,
    writeExitReason,
  })

  envPerception      = createEnvironmentPerception(bot, log)
  locomotionRecovery = createLocomotionRecovery(bot, log)

  damagePipeline = createDamagePipeline({
    bot, log, state, liveness,
    getEnvPerception: () => envPerception,
    getLastEnvScan:   () => lastEnvScan,
    isTaskBusy:       () => taskBusy,
    replaceTask,
    safeChat, safeFloor, isValidVec,
    getPlayer,
    bumpAnger, ANGER_HIT, ANGER_ATTACK_LEVEL,
    HAZARD_BLOCKS, HOSTILE_MOB_NAMES, BOT_NAME,
    tasks,  // damagePipeline destructures the 4 it needs (attack player/mobs, flee, evade)
  })

  llmEnabled = await checkOllama()
  log.info('llm_check', { model: getModelName(), connected: llmEnabled })

  safeChat(llmEnabled ? `${BOT_NAME} online (${getModelName()}).` : 'LLM offline — using fallback commands.')
  rememberLocation(memory, 'spawn', bot.entity.position)
  rememberEvent(memory, 'spawned', { model: getModelName() })

  startStateLoop()
  startAgentLoop()
  startThreatLoop()
  startAngerDecay()
  startActivityWatchdog()
  startReconciliationWatchdog()
  startFreezeForensics()
  startHealthBeacon()
  startPerceptionLoop()
  createFatalDesyncRecovery(bot, liveness, log, (ctx) => recoveryEngine.report('DESYNC', ctx))
  createPositionGuard(bot, liveness, log, recoveryEngine)

  // Post-spawn integrity check: confirm entity liveness reaches LIVE_VALID within 30s.
  // A failure here means position/entity data never arrived — likely a login-phase desync.
  const integrityStart = Date.now()
  const integrityCheck = setInterval(() => {
    if (liveness.getState() === 'LIVE_VALID') {
      clearInterval(integrityCheck)
      log.info('spawn_integrity_ok', {
        checkMs: Date.now() - integrityStart,
        ...(RECOVERY_CHAIN_ID && { chainId: RECOVERY_CHAIN_ID }),
      })
    } else if (Date.now() - integrityStart > 30_000) {
      clearInterval(integrityCheck)
      log.warn('spawn_integrity_fail', {
        livenessState: liveness.getState(),
        checkMs: 30_000,
        ...(RECOVERY_CHAIN_ID && { chainId: RECOVERY_CHAIN_ID }),
      })
    }
  }, 1_000)
})

// ── Reconciliation Watchdog ──────────────────────────────────────────────────
// Every 5 seconds, verify the bot's actual state matches its declared state.
// Forcibly re-syncs if any inconsistency is found:
//   - goal === 'following' but pathfinder has no active goal
//   - goal === 'attacking' but pvp is not engaged
//   - state has a followTarget but goal is idle (handled by agent loop's auto-resume too)
//   - taskBusy stuck true with no watchdog
let recoveryAttempts    = 0
let recoveryEngine      = null  // initialized in spawn handler after task functions are available
let envPerception       = null  // initialized in spawn handler
let locomotionRecovery  = null  // initialized in spawn handler
let damagePipeline      = null  // initialized in spawn handler

// Last full environment scan — refreshed every PERCEPTION_INTERVAL_MS
let lastEnvScan         = null
const PERCEPTION_INTERVAL_MS = 3000  // scan every 3s; scanning is cheap (local blockAt calls)

function startReconciliationWatchdog() {
  setInterval(() => {
    const findings = []

    // Check 1: following goal but no active path
    if (state.goal === 'following' && state.followTarget) {
      if (!movement.isActive()) {
        findings.push('following_no_path')
        const target = getPlayer(state.followTarget)
        if (target) {
          if (!movement.follow(target.entity, 2, movement.PRIORITY.LOW, 'reconcile')) {
            log.error('reconcile_follow_blocked', { blockedBy: movement.getOwner()?.source })
          } else {
            recoveryAttempts++
          }
        }
      }
    }

    // Check 2: taskBusy true but no current task context → orphaned
    // (Should be impossible under token discipline; defensive paranoia.)
    if (taskBusy && !currentTaskContext) {
      findings.push('orphaned_taskBusy')
      taskBusy = false
      setGoal(state.followTarget ? 'following' : 'idle', { source: 'reconciliation', reason: 'orphan_reset' })
      recoveryAttempts++
    }

    // Check 3: idle with no follow target after a while → reset emotion
    // (No-op for now; future: re-run autonomous planner)

    if (findings.length > 0) {
      log.warn('reconcile_corrected', { findings, recoveryAttempts })
    }
  }, 5000)
}

// ─────────────────────────────────────────────────────────────────────────────
// FREEZE FORENSICS
// Periodic stuck-detection + freeze snapshot dumper.
// Fires `freeze_snapshot` log entry with full runtime state when:
//   - a task has been running > FREEZE_SNAPSHOT_TASK_AGE_MS, OR
//   - position has been invalid for > FREEZE_SNAPSHOT_POS_INVALID_MS
// Desync→reconnect is NOT handled here: fatalDesyncRecovery.js owns that decision
// (it reconnects as soon as liveness.isDesynced() flips true). This loop is purely
// observational.
// ─────────────────────────────────────────────────────────────────────────────

const FREEZE_SNAPSHOT_TASK_AGE_MS    = 30000  // task running >30s with no completion
const FREEZE_SNAPSHOT_POS_INVALID_MS = 3000   // position invalid >3s

// Freeze taxonomy — classify what kind of failure a freeze snapshot represents.
// Returns a string tag used to route postmortem analysis.
function classifyFreeze(s) {
  if (s.livenessState === 'LIVE_FATAL' || s.livenessState === 'LIVE_RECOVERING') return 'entity_desync'
  if (s.taskBusy && !s.currentTaskGoal) return 'runtime_corruption'
  if (s.activeGotoCount > 0 && s.oldestGotoAgeMs > 15000 && !s.isMoving) return 'movement_deadlock'
  if (s.activeGotoCount > 0 && s.oldestGotoAgeMs > 15000) return 'async_timeout'
  if (s.posInvalidMs > 3000) return 'validator_dead_end'
  if (s.taskBusy && s.taskAgeMs > FREEZE_SNAPSHOT_TASK_AGE_MS) return 'planner_stall'
  return 'unknown'
}

let lastFreezeSnapshotAt    = 0
const FREEZE_SNAPSHOT_INTERVAL_MS = 5000  // don't spam

function buildFreezeSnapshot(reason) {
  const now = Date.now()
  const ctx = currentTaskContext
  const livePos = bot.entity?.position
  const oldestGoto = activeGotos.size > 0
    ? Math.min(...[...activeGotos.values()].map(g => g.startedAt))
    : null

  const snapshot = {
    reason,
    // Task state
    currentTaskGoal:  ctx?.goalName || null,
    taskAgeMs:        ctx ? now - ctx.startedAt : null,
    taskTokenStr:     ctx?.token ? String(ctx.token).slice(0, 80) : null,
    taskBusy,
    watchdogActive:   !!ctx?.watchdog,

    // Goal state
    goal:             state.goal,
    followTarget:     state.followTarget,

    // Damage state
    damageState:         damagePipeline?.getDamageState() ?? 'safe',
    damageWindowSize:    damagePipeline?.getDamageWindowSize() ?? 0,
    msSinceLastReaction: damagePipeline ? now - damagePipeline.getLastReactionAt() : null,

    // Pathfinder
    pathActive:       !!bot.pathfinder?.goal,
    isMoving:         !!bot.pathfinder?.isMoving?.(),
    activeGotoCount:  activeGotos.size,
    oldestGotoAgeMs:  oldestGoto ? now - oldestGoto : null,

    // Position liveness
    livePosValid:     isValidVec(livePos),
    livePosRaw:       livePos ? { x: livePos.x, y: livePos.y, z: livePos.z } : null,
    cachedPos:        liveness.getCachedPos(),
    posInvalidMs:     liveness.getInvalidMs() || null,
    livenessState:    liveness.getState(),

    // Physics liveness
    onGround:         !!bot.entity?.onGround,
    inWater:          !!bot.entity?.isInWater,
    inLava:           !!bot.entity?.isInLava,
    velocity:         isValidVec(bot.entity?.velocity)
      ? { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z }
      : null,

    // World liveness
    dimension:        bot.game?.dimension || null,
    hp:               bot.health,
    food:             bot.food,

    // Recovery state
    recoveryState:    recoveryEngine?.getState() || null,
    movementOwner:    movement.getOwner(),

    // Environmental perception
    envRisk:          lastEnvScan?.locomotionRisk ?? null,
    envStuckClass:    lastEnvScan?.stuckClass     ?? null,
    envHazards:       lastEnvScan?.hazardSummary  ?? null,
    envIsEnclosed:    lastEnvScan?.isEnclosed      ?? null,

    // Tracing
    cid: ctx?.correlationId || null,
  }
  snapshot.freezeClass = classifyFreeze(snapshot)
  return snapshot
}

function startFreezeForensics() {
  setInterval(() => {
    const now = Date.now()
    const ctx = currentTaskContext

    // Condition 1: task running too long
    const taskTooOld = ctx && (now - ctx.startedAt) > FREEZE_SNAPSHOT_TASK_AGE_MS

    // Condition 2: position invalid too long — use liveness monitor as source of truth
    const posInvalidMs = liveness.getInvalidMs()
    const posInvalidLong = posInvalidMs > FREEZE_SNAPSHOT_POS_INVALID_MS

    // Snapshot (rate-limited)
    if ((taskTooOld || posInvalidLong) && (now - lastFreezeSnapshotAt) > FREEZE_SNAPSHOT_INTERVAL_MS) {
      const reason = taskTooOld && posInvalidLong ? 'task_old_and_pos_invalid'
                   : taskTooOld                   ? 'task_old'
                                                   : 'pos_invalid_long'
      log.warn('freeze_snapshot', buildFreezeSnapshot(reason))
      lastFreezeSnapshotAt = now
    }
  }, 1000)
}

// ── Environmental Hazards ────────────────────────────────────────────────────
// Blocks that damage the bot just by being adjacent / inside / on top of them.
// Used by Movements.blocksToAvoid (makeMovements) and passed to the damage pipeline
// (findNearbyHazard / unknown-damage branch live in damagePipeline.js).
const HAZARD_BLOCKS = new Set([
  'cactus', 'fire', 'soul_fire', 'lava', 'magma_block',
  'sweet_berry_bush', 'wither_rose', 'powder_snow',
  'campfire', 'soul_campfire',
])

// ── Anger / Defense System ────────────────────────────────────────────────────

// Tuned for "forgive accidents, escalate on intent":
//   1 accidental hit  → anger 2.5  (no attack, decays in ~5s)
//   2 hits in 5 sec   → anger 5    (attack threshold)
//   1 insult + 1 hit  → anger 3.5  (still no attack)
const ANGER_INSULT       = 1
const ANGER_HIT          = 2.5
const ANGER_THRESHOLD    = 3
const ANGER_ATTACK_LEVEL = 5
const ANGER_DECAY_PER_S  = 0.5  // 10× faster — accidents are forgotten in seconds

function bumpAnger(username, amount, reason) {
  const rec = anger.get(username) || { level: 0, count: 0, lastAt: 0 }
  rec.level   += amount
  rec.count   += 1
  rec.lastAt   = Date.now()
  rec.reason   = reason
  anger.set(username, rec)
  console.log(`[${BOT_NAME}] anger ${username} → ${rec.level.toFixed(1)} (${reason})`)
  return rec
}

function startAngerDecay() {
  setInterval(() => {
    for (const [name, rec] of anger.entries()) {
      rec.level = Math.max(0, rec.level - ANGER_DECAY_PER_S)
      if (rec.level <= 0.1) anger.delete(name)
    }
  }, 1000)
}

function maybeAttackForAnger(username) {
  const rec = anger.get(username)
  if (!rec || rec.level < ANGER_ATTACK_LEVEL) return false
  if (state.energy < 20) return false
  if (state.goal === 'attacking') return false

  const player = bot.players[username]
  if (!player?.entity) return false

  safeChat(`That's it, ${username}. I warned you.`)
  replaceTask('attacking', () => tasks.taskAttackPlayer(player.entity, username))
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// DAMAGE PIPELINE lives in damagePipeline.js — created in the spawn handler as
// `damagePipeline`. It owns the entityHurt/health listeners and the 500ms
// classifier. bot.js keeps death/respawn/forcedMove (mixed concerns) below and
// calls damagePipeline.flushDamageState() from respawn/forcedMove.
// ─────────────────────────────────────────────────────────────────────────────

bot.on('death', () => {
  log.warn('died', { lastGoal: state.goal })
  safeChat('I died. Respawning...')
  cancelCurrentTask()  // releases ownership, stops movement, sets goal=idle
  state.followTarget = null
  // health/food will re-sync from server on next tick after respawn
})

bot.on('respawn', () => {
  log.info('respawned', { pos: safeFloor(bot.entity?.position) })
  // Discard any damage events from the pre-respawn life — they refer to a stale world.
  damagePipeline?.flushDamageState()
  safeChat("I'm back. That hurt.")
})

// Server teleported the bot (e.g. /tp, /spawn, plugin teleport). Position is briefly
// invalid (NaN x/z) until the new position packet arrives. Flush stale state so
// damage events from the pre-teleport location don't leak into post-teleport reactions.
bot.on('forcedMove', () => {
  log.info('teleported', {
    newPos: safeFloor(bot.entity?.position),
    valid: isValidVec(bot.entity?.position),
  })
  damagePipeline?.flushDamageState()
  // The current task's path was for the OLD location — invalidate it atomically.
  // cancelCurrentTask supersedes ownership; the task's microtask-deferred catch
  // will see it lost ownership and skip cleanup, leaving us in clean idle state.
  cancelCurrentTask()
})

// ─────────────────────────────────────────────────────────────────────────────
// Task Runner — token-discipline lifecycle
// ─────────────────────────────────────────────────────────────────────────────

// Stops the current task atomically and stops all movement.
// After this returns: currentTaskToken=null, taskBusy=false, state.goal='idle'
// (if it matched the cancelled task's goal). Pending callbacks of the cancelled
// task will see they are no longer the owner and skip all global mutations.
//
// Use this to stop a task without starting a replacement. To swap tasks, use
// `replaceTask` instead — it bundles cancel + start atomically.
function cancelCurrentTask() {
  const oldCtx = currentTaskContext
  // Supersede ownership BEFORE stopping movement, so that the old task's
  // microtask-deferred catch handler (which the .stop() will trigger) sees
  // it is no longer the owner.
  currentTaskToken   = null
  currentTaskContext = null
  if (oldCtx?.watchdog) clearTimeout(oldCtx.watchdog)
  if (oldCtx && state.goal === oldCtx.goalName) setGoal('idle', { source: 'cancel_task', token: oldCtx.token })
  // Stop movement before clearing taskBusy so no runTask() call can slip through the
  // `if (taskBusy) return false` guard while the old task's pathfinder/pvp is still
  // unwinding. The old task's deferred catch handlers will see ownership lost and no-op.
  movement.forceStop('cancel')
  try { bot.pvp.stop() } catch {}
  bot.clearControlStates()
  taskBusy = false  // cleared last: gate stays closed until all cleanup is done
}

// Atomic task replacement: cancel current task and start a new one.
// The cancel + start runs in a single synchronous block, so the new task is
// fully installed before any of the old task's Promise callbacks can fire.
function replaceTask(goalName, fn, opts) {
  cancelCurrentTask()
  return runTask(goalName, fn, opts)
}

// When the user assigns Ember a new task while she's following, drop the follow
// so the agent-loop auto-resume does not re-engage it after the task finishes.
function interruptFollow() {
  if (!state.followTarget) return
  movement.stop('follow')
  state.followTarget = null
  setGoal('idle', { source: 'interrupt_follow', reason: 'new_task' })
  log.info('follow_interrupted_by_task')
}

// Wrapper for fallbackCommand task dispatches: preempts follow, then runs the task.
function taskCmd(goalName, fn, opts) {
  interruptFollow()
  return runTask(goalName, fn, opts)
}

// Track recent path failures by goal — repeated explore timeouts mean we're stuck.
const taskFailureCounts = new Map()  // goalName -> consecutive failure count
const EXPLORE_FAIL_THRESHOLD = 3

// silent=true: log errors to console only, never to game chat (for autonomous tasks)
function runTask(goalName, fn, { silent = false } = {}) {
  if (taskBusy) return false

  // Per-task context — captured in closure so deferred callbacks reference
  // their OWN watchdog/goal/start time, not whatever globals look like later.
  const myToken = Symbol(goalName)
  const myCtx = {
    token: myToken,
    goalName,
    startedAt: Date.now(),
    silent,
    watchdog: null,
    correlationId: ++correlationCounter,
  }

  taskBusy           = true
  setGoal(goalName, { source: 'task_start', token: myToken })
  state.idleTicks    = 0
  state.lastActivityAt = Date.now()
  currentTaskToken   = myToken
  currentTaskContext = myCtx

  log.info('task_start', { goal: goalName, silent, cid: myCtx.correlationId })

  myCtx.watchdog = setTimeout(() => {
    if (!isOwner(myToken)) return  // superseded; observational-only
    log.warn('task_watchdog_kill', { goal: goalName, durationMs: Date.now() - myCtx.startedAt, cid: myCtx.correlationId })
    if (!silent) safeChat('Timed out. Resetting.')
    recoveryEngine.report('TASK_HUNG', { source: 'watchdog', goalName, cid: myCtx.correlationId })
  }, 90000)

  fn().then(() => {
    if (!isOwner(myToken)) {
      log.debug('task_complete_stale', { goal: goalName })
      return
    }
    log.info('task_complete', { goal: goalName, durationMs: Date.now() - myCtx.startedAt, cid: myCtx.correlationId })
    taskFailureCounts.set(goalName, 0)
    recoveryEngine.reset('TASK')
  }).catch(err => {
    if (!isOwner(myToken)) {
      log.debug('task_error_stale', { goal: goalName, message: err.message })
      return  // we were replaced; the new task owns globals now
    }
    log.error('task_error', { goal: goalName, message: err.message, durationMs: Date.now() - myCtx.startedAt, cid: myCtx.correlationId })
    if (!silent) safeChat(`Error in ${goalName}: ${err.message.slice(0, 80)}`)

    // Stop movement — we're still owner, this is our cleanup
    movement.forceStop('task_error')
    try { bot.pvp.stop() } catch {}
    bot.clearControlStates()

    // Track timeout streaks for stuck detection
    const isTimeout = /timeout|Took to long|stopped before/i.test(err.message || '')
    if (isTimeout) {
      const n = (taskFailureCounts.get(goalName) || 0) + 1
      taskFailureCounts.set(goalName, n)
      if (['exploring', 'mining', 'gathering'].includes(goalName) && n >= EXPLORE_FAIL_THRESHOLD) {
        log.warn('stuck_detected_scheduling_escape', { goal: goalName, consecutive: n })
        taskFailureCounts.set(goalName, 0)
        recoveryEngine.report('MOVEMENT_TIMEOUT_STREAK', { source: 'timeout_streak', goalName, consecutive: n, cid: myCtx.correlationId })
      }
    } else {
      taskFailureCounts.set(goalName, 0)
    }
  }).finally(() => {
    if (!isOwner(myToken)) {
      log.debug('task_finally_stale', { goal: goalName })
      return  // we were replaced; the new task owns globals now
    }
    // We're still owner — release ownership and clean up our state.
    if (myCtx.watchdog) { clearTimeout(myCtx.watchdog); myCtx.watchdog = null }
    currentTaskToken     = null
    currentTaskContext   = null
    taskBusy             = false
    state.lastActivityAt = Date.now()
    bot.clearControlStates()
    if (state.goal === goalName) setGoal('idle', { source: 'task_complete', token: myToken })
  })

  return true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// (LOG_NAMES / PLANK_NAMES / logIds / plankIds / countInInv moved to tasks.js)

// Build a fully-configured Movements instance. Allows digging through
// obstacles and placing blocks for scaffolding, while protecting our own infra
// (crafting tables, chests, doors). Used by every navigation call.
function makeMovements() {
  const m = new Movements(bot)
  m.canDig = true                  // break blocks if path requires it
  m.canOpenDoors = true            // navigate through doors instead of around
  m.allowParkour = false           // don't risk gap-jumps that frequently fail
  m.allowSprinting = true
  m.allow1by1towers = true         // pillar up when needed
  m.maxDropDown = 4                // tolerate small falls
  m.infiniteLiquidDropdownDistance = false  // don't drop into deep water

  // Don't break our own infrastructure while pathing through it
  const protect = ['crafting_table', 'chest', 'furnace', 'bed',
                   'oak_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door',
                   'oak_trapdoor', 'spruce_trapdoor']
  for (const name of protect) {
    const id = bot.registry.blocksByName[name]?.id
    if (id != null) m.blocksCantBreak.add(id)
  }

  // Route AROUND damage-dealing blocks AND don't dig them.
  // (Pathfinder's blocksToAvoid: A* refuses to step into these.
  //  blocksCantBreak: A* won't propose breaking these to clear a path.)
  for (const name of HAZARD_BLOCKS) {
    const id = bot.registry.blocksByName[name]?.id
    if (id == null) continue
    if (m.blocksToAvoid)   m.blocksToAvoid.add(id)
    if (m.blocksCantBreak) m.blocksCantBreak.add(id)
  }

  // Scaffolding blocks the bot can place to traverse gaps / climb out of holes.
  // Use any plank, dirt, cobblestone, or sand we have.
  const scaffoldNames = [
    'dirt', 'cobblestone', 'cobbled_deepslate', 'sand', 'gravel', 'netherrack',
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks',
    'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'crimson_planks', 'warped_planks',
  ]
  const scaffoldIds = scaffoldNames
    .map(n => bot.registry.itemsByName[n]?.id)
    .filter(id => id != null)
  // mineflayer-pathfinder field has a typo — set both names to be safe
  if (scaffoldIds.length > 0) {
    m.scafoldingBlocks = scaffoldIds
    m.scaffoldingBlocks = scaffoldIds
  }

  return m
}

// Goto lifecycle tracking — assigns each goto() call a unique id and logs
// start / resolve / reject / stale-resolve. Useful for forensic analysis
// of pathfinder hangs and stuck-after-cancellation behaviours.
let nextGotoId = 0
let correlationCounter = 0  // monotonic; shared across tasks, goto, recovery, damage
const activeGotos = new Map()  // id -> { id, startedAt, token, taskGoal, target }

async function navNear(x, y, z, range = 3, priority = movement.PRIORITY.NORMAL) {
  if (isNaN(x) || isNaN(y) || isNaN(z)) throw new Error(`invalid position (${x},${y},${z}) — bot not ready`)

  const gotoId = ++nextGotoId
  const startedAt = Date.now()
  const ownerToken = currentTaskToken
  const ownerGoal = currentTaskContext?.goalName || null
  const cid = currentTaskContext?.correlationId || null
  const target = { x, y, z, range }
  activeGotos.set(gotoId, { id: gotoId, startedAt, token: ownerToken, taskGoal: ownerGoal, target })
  log.debug('goto_start', { id: gotoId, taskGoal: ownerGoal, target, ...(cid != null && { cid }) })

  try {
    await movement.navigate(x, y, z, range, priority, `goto_${gotoId}`)
    log.debug('goto_resolve', {
      id: gotoId,
      durationMs: Date.now() - startedAt,
      stale: ownerToken !== currentTaskToken,
      ...(cid != null && { cid }),
    })
  } catch (e) {
    log.debug('goto_reject', {
      id: gotoId,
      durationMs: Date.now() - startedAt,
      stale: ownerToken !== currentTaskToken,
      message: e.message,
      ...(cid != null && { cid }),
    })
    throw e
  } finally {
    activeGotos.delete(gotoId)
  }
}

// All taskXxx bodies + their item/craft/build helpers live in tasks.js (Fix 9 Step 2).
// createTasks(...) binds them to deps; bot.js calls them via tasks.taskXxx. The task
// runner (runTask/replaceTask/cancelCurrentTask), navNear, makeMovements and goto
// tracking stay here — tasks receive navNear as a dependency.
const tasks = createTasks({
  bot, log, state, memory, movement, liveness,
  safeChat,
  safeDig, safeCraft, safeEquip, safeConsume, safePlaceBlock, safeAttack,
  navNear, awaitValidPosition,
  isValidVec, isFiniteNum, safeFloor, safeNormalize2D,
  rememberEvent, rememberLocation, recallLocation,
  anger,
  BOT_NAME,
  getLastEnvScan:        () => lastEnvScan,
  getEnvPerception:      () => envPerception,
  getLocomotionRecovery: () => locomotionRecovery,
})

// ── Autonomous Idle Behavior ───────────────────────────────────────────────────

const IDLE_THRESHOLD = 18

function tryAutonomous() {
  if (taskBusy || state.goal !== 'idle' || state.energy < 35) return

  state.idleTicks++
  if (state.idleTicks < IDLE_THRESHOLD) return
  state.idleTicks = 0

  // Escape pre-empts everything else: if we're way underground and not doing anything
  // intentional, get back to the surface before anything else.
  const myY = bot.entity?.position?.y
  if (myY != null && !isNaN(myY) && myY < 55) {
    log.info('autonomous_escape', { y: Math.floor(myY) })
    runTask('escaping', tasks.taskEscape)
    return
  }

  const gs     = buildGroundedState(bot, state, memory, anger, envPerception)
  const choice = selectAutonomousGoal(gs)

  if (choice) {
    log.debug('autonomous_choice', { action: choice.action, target: choice.target })
    // Narrate only 1-in-4 times to avoid chat spam — actions speak louder than words
    if (Math.random() < 0.25) safeChat(choice.say)
    if      (choice.action === 'explore')       runTask('exploring',  tasks.taskExplore,     { silent: true })
    else if (choice.action === 'gather_wood')   runTask('gathering',  tasks.taskGatherWood,  { silent: true })
    else if (choice.action === 'craft_planks')  runTask('crafting',   tasks.taskCraftPlanks, { silent: true })
    else if (choice.action === 'craft')         runTask('crafting',   () => tasks.taskCraftItem(choice.target || 'crafting_table'), { silent: true })
    else if (choice.action === 'attack_mobs')   runTask('attacking',  tasks.taskAttackMobs)
    else if (choice.action === 'collect_items') runTask('collecting', tasks.taskCollectNearby, { silent: true })
  }
  // No ambient narration — silent observation avoids chat spam
}

// ── Activity Watchdog ────────────────────────────────────────────────────────
// Detects when the bot has been silently inactive for too long and force-resets
// state so autonomous behavior can resume. Different from the per-task watchdog:
// this catches "everything completed normally but bot is now stuck doing nothing".

// ── Health Beacon (10s) ───────────────────────────────────────────────────────
// Continuous runtime health timeline for postmortem reconstruction.
// Promotes the edge-only freeze_snapshot into an always-on pulse.

function startHealthBeacon() {
  setInterval(() => {
    const ctx = currentTaskContext
    const now = Date.now()
    log.info('runtime_health_snapshot', {
      livenessState:      liveness.getState(),
      livenessInvalidMs:  liveness.getInvalidMs() || 0,
      movementOwner:      movement.getOwner(),
      taskGoal:           ctx?.goalName || null,
      taskAgeMs:          ctx ? now - ctx.startedAt : null,
      taskBusy,
      watchdogActive:     !!ctx?.watchdog,
      recoveryLevels:     recoveryEngine ? Object.fromEntries(
        Object.entries(recoveryEngine.getState()).map(([k, v]) => [k, v.level])
      ) : null,
      hp:   bot.health,
      food: bot.food,
      goal: state.goal,
      envRisk:      lastEnvScan?.locomotionRisk ?? null,
      envStuck:     lastEnvScan?.stuckClass     ?? null,
      envHazards:   lastEnvScan?.hazardSummary  ?? null,
      cid:  ctx?.correlationId || null,
    })
  }, 10_000)
}

// ── Perception Loop ───────────────────────────────────────────────────────────
// Continuously refreshes lastEnvScan so it is available to tasks, the LLM,
// freeze forensics, and recovery without blocking event loop with repeated scans.
// Also fires automatic hazard escape when in critical danger and not already busy.

const LAVA_ESCAPE_COOLDOWN_MS = 8000
let lastLavaEscapeAt = 0

function startPerceptionLoop() {
  setInterval(() => {
    if (!envPerception) return
    try {
      lastEnvScan = envPerception.scan()
    } catch (e) {
      log.debug('perception_scan_error', { message: e.message })
      return
    }

    // Don't act on an invalid scan — position is NaN/null, all block reads were junk.
    if (!lastEnvScan.valid) return

    // Auto-trigger hazard escape when standing in lava and not already reacting
    if (lastEnvScan.feetBlock === 'lava' || lastEnvScan.headBlock === 'lava') {
      const now = Date.now()
      if (!taskBusy && now - lastLavaEscapeAt > LAVA_ESCAPE_COOLDOWN_MS) {
        lastLavaEscapeAt = now
        log.warn('hazard_detected', { type: 'lava', feetBlock: lastEnvScan.feetBlock })
        locomotionRecovery.runHazardEscape('lava_immobilization', lastEnvScan, 'auto_lava').catch(() => {})
      }
    }

    // Log high-risk situations for postmortem visibility
    if (lastEnvScan.locomotionRisk >= 8) {
      log.warn('hazard_detected', {
        risk: lastEnvScan.locomotionRisk,
        stuckClass: lastEnvScan.stuckClass,
        hazardSummary: lastEnvScan.hazardSummary,
        isEnclosed: lastEnvScan.isEnclosed,
      })
    }
  }, PERCEPTION_INTERVAL_MS)
}

const ACTIVITY_TIMEOUT_MS = 5 * 60 * 1000  // 5 minutes
const ACTIVITY_CHECK_INTERVAL_MS = 30 * 1000

function startActivityWatchdog() {
  setInterval(() => {
    const elapsed = Date.now() - state.lastActivityAt
    if (elapsed < ACTIVITY_TIMEOUT_MS) return
    if (taskBusy || state.goal === 'following' || state.goal === 'resting') {
      // Active in some form — not actually idle
      state.lastActivityAt = Date.now()
      return
    }
    log.warn('activity_watchdog_reset', { idleMs: elapsed, goal: state.goal })
    recoveryEngine.report('IDLE', { source: 'activity_watchdog', idleMs: elapsed })
    state.lastActivityAt = Date.now()
  }, ACTIVITY_CHECK_INTERVAL_MS)
}


// ── Threat Reaction Loop (auto-attack hostile mobs in range) ─────────────────

function startThreatLoop() {
  setInterval(() => {
    if (taskBusy || state.energy < 25) return
    if (!['idle','exploring'].includes(state.goal)) return

    const mob = bot.nearestEntity(e =>
      e.name && HOSTILE_MOB_NAMES.has(e.name) &&
      e.position.distanceTo(bot.entity.position) < 10
    )
    if (mob) {
      safeChat(`${mob.name} is close. Engaging.`)
      runTask('attacking', () => tasks.taskAttackMobs())
    }
  }, 2500)
}

// ── State Loop (1s) ───────────────────────────────────────────────────────────

function startStateLoop() {
  const hpWatchdog = createHealthIntegrityWatchdog(
    bot, log,
    () => {
      // Silent HP drain — the normal damage pipeline couldn't react. Report it; the
      // arbiter routes: structurally-invalid position ⇒ DESYNC (reconnect, no maneuver
      // can help); valid position ⇒ CRITICAL_HP (blind-survival sprint away).
      if (!isValidVec(bot.entity?.position)) {
        recoveryEngine.report('DESYNC', { source: 'silent_damage', hp: bot.health })
      } else {
        recoveryEngine.report('CRITICAL_HP', { source: 'silent_damage', hp: bot.health })
      }
    },
    () => damagePipeline?.getLastReactionAt() ?? 0
  )

  setInterval(() => {
    // HP-loss watchdog: detects silent damage when damage pipeline is blinded by NaN position
    hpWatchdog.tick()

    // Sync from real Minecraft values — bot is a full player with actual HP and hunger
    state.energy = Math.round((bot.health / 20) * 100)  // 0-100 from 0-20 HP
    state.hunger = Math.round((bot.food   / 20) * 100)  // 0-100 from 0-20 food

    const active = ['following','exploring','gathering','going_to','attacking','collecting','crafting','building'].includes(state.goal)

    // Low HP while doing something — cancel task and rest (health regen when idle)
    if (state.energy <= 15 && active) {
      cancelCurrentTask()  // atomically supersedes ownership + stops movement
      setGoal('resting', { source: 'state_loop', reason: 'low_hp' })
      safeChat('Low health. Pulling back.')
      rememberEvent(memory, 'low_health', { hp: bot.health })
    }

    // Recovered to 80% HP — resume normal operation (and follow if we were)
    if (state.goal === 'resting' && state.energy >= 80) {
      setGoal(state.followTarget ? 'following' : 'idle', { source: 'state_loop', reason: 'rest_recovery' })
      safeChat('Health up. Ready.')
      log.info('rest_recovery', { resumedGoal: state.goal, followTarget: state.followTarget })
    }

    // Auto-eat when hungry and food is available — fires once per state tick
    if (bot.food <= 14 && !taskBusy && tasks.FOOD_PRIORITY.some(f => bot.inventory.items().some(i => i.name === f))) {
      runTask('eating', tasks.taskEatFood, { silent: true })
    }

    tryAutonomous()

    // Periodic structured state snapshot for TUI / postmortem.
    // This is the canonical record of "what was the bot doing at time T?"
    if (!startStateLoop._tickCounter) startStateLoop._tickCounter = 0
    startStateLoop._tickCounter++
    if (startStateLoop._tickCounter % 2 === 0) {  // every 2s
      const pos = bot.entity?.position
      const posValid = pos && !isNaN(pos.x) && !isNaN(pos.y) && !isNaN(pos.z)
      if (posValid) {
        startStateLoop._lastValidPos = { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) }
      }

      // Compute emotion summary from anger map
      let topAnger = null
      let totalAnger = 0
      for (const [name, rec] of anger.entries()) {
        totalAnger += rec.level
        if (!topAnger || rec.level > topAnger.level) topAnger = { name, level: rec.level }
      }
      const emotion = topAnger
        ? (topAnger.level >= ANGER_ATTACK_LEVEL ? 'hostile' : topAnger.level >= ANGER_THRESHOLD ? 'irritated' : 'wary')
        : 'calm'

      log.trace('state', {
        // Basic
        goal: state.goal,
        hp: Number(bot.health.toFixed(1)),
        food: bot.food,
        pos: startStateLoop._lastValidPos || null,
        inventory: bot.inventory.items().slice(0, 16).map(i => `${i.name}x${i.count}`),
        // Concurrency
        busy: taskBusy,
        watchdogActive: !!(currentTaskContext?.watchdog),
        currentTaskGoal: currentTaskContext?.goalName || null,
        // Emotional
        anger: anger.size,
        topAngerLevel: topAnger ? Number(topAnger.level.toFixed(1)) : 0,
        topAngerWith: topAnger?.name || null,
        emotion,
        // Behaviour
        followTarget: state.followTarget,
        combatMode: state.goal === 'attacking',
        // Pathfinder state
        pathActive: !!(bot.pathfinder?.goal),
        isMoving: !!bot.pathfinder?.isMoving?.(),
        // Damage pipeline
        damageState:         damagePipeline?.getDamageState() ?? 'safe',     // safe | hurt | reacting
        recentDamageHits:    damagePipeline?.getDamageWindowSize() ?? 0,      // events in current 1.5s window
        msSinceLastReaction: damagePipeline ? Date.now() - damagePipeline.getLastReactionAt() : null,
        knownHazardZones:    damagePipeline?.getHazardZonesCount() ?? 0,
        // Recovery
        recoveryAttempts,
        // Anti-spam
        cooldowns: damagePipeline?.getCooldowns() ?? { hitChat: 0, counterPunch: 0, reaction: 0 },
      })
    }
  }, 1000)
}

// ── Agent Loop (250 ms) ────────────────────────────────────────────────────────

// Goals that block auto-follow-resume — bot must finish evading/fighting/resting first.
const FOLLOW_BLOCK_GOALS = new Set(['evading', 'fleeing', 'attacking', 'resting'])

function startAgentLoop() {
  let prevGoal = 'idle'
  let lostTicks = 0           // grace period before "Lost you"
  let prevFollowTarget = null
  let followRefreshTicks = 0  // re-issue follow goal periodically — recovers from stuck pathfinder
  let stuckCheckTicks = 0
  let lastBotPos = null
  let stuckTicks = 0

  setInterval(() => {
    // Advance entity liveness state machine — must run every 250ms tick.
    liveness.tick()

    // Auto-resume follow if we have a follow target but no active task or goal.
    // This survives ALL interruptions — counter-attacks, auto-eat, autonomous tasks, etc.
    // Guard: never resume following while the bot is evading, fleeing, attacking, or
    // resting — these goals must run to completion before the follow loop re-engages.
    if (state.followTarget && state.goal === 'idle' && !taskBusy && !FOLLOW_BLOCK_GOALS.has(state.goal)) {
      log.info('follow_auto_resumed', { target: state.followTarget, prevGoal })
      setGoal('following', { source: 'agent_loop', reason: 'follow_auto_resume' })
    }

    // Look at the player we're following, or the nearest one if just idling
    const lookTarget = state.goal === 'following'
      ? getPlayer(state.followTarget)
      : getNearestPlayer()
    if (lookTarget) {
      try { bot.lookAt(lookTarget.entity.position.offset(0, lookTarget.entity.height, 0)) } catch {}
    }

    if (bot.entity?.isInWater && !taskBusy) {
      bot.setControlState('jump', true)
    }

    if (state.goal === 'following') {
      const target = getPlayer(state.followTarget)
      if (!target) {
        lostTicks++
        if (lostTicks >= 20) {
          movement.stop('follow')
          bot.clearControlStates()
          setGoal('idle', { source: 'agent_loop', reason: 'follow_lost' })
          state.followTarget = null
          safeChat('Lost you.')
          log.info('follow_lost', { target: prevFollowTarget })
          lostTicks = 0
        }
      } else {
        lostTicks = 0
        followRefreshTicks++

        // Re-issue follow goal:
        //   1. on transition into following
        //   2. on follow-target change
        //   3. periodically every 10s (recover from pathfinder hangs caused by knockback, NaN, etc.)
        const shouldReissue =
          prevGoal !== 'following' ||
          prevFollowTarget !== state.followTarget ||
          followRefreshTicks >= 40

        if (shouldReissue) {
          followRefreshTicks = 0
          movement.follow(target.entity, 2, movement.PRIORITY.LOW, 'follow')
        }

        // Stuck detection: tighten to ~4s of no movement.
        // Sample every 1s (4 ticks) and require 4 consecutive failed samples.
        stuckCheckTicks++
        if (stuckCheckTicks >= 4) {  // every 1s
          stuckCheckTicks = 0
          const pos = bot.entity?.position
          if (pos && lastBotPos && !isNaN(pos.x) && !isNaN(pos.z)) {
            const moved = Math.hypot(pos.x - lastBotPos.x, pos.z - lastBotPos.z)
            const targetDist = pos.distanceTo(target.entity.position)
            if (targetDist > 3 && moved < 0.3) {
              stuckTicks++
              if (stuckTicks >= 4) {  // 4 × 1s = 4s of no movement
                log.warn('follow_stuck_reset', { targetDist, moved, target: state.followTarget })
                movement.forceStop('stuck')
                bot.clearControlStates()
                movement.follow(target.entity, 2, movement.PRIORITY.LOW, 'follow')
                stuckTicks = 0
              }
            } else {
              stuckTicks = 0
            }
          }
          lastBotPos = pos && !isNaN(pos.x) ? { x: pos.x, z: pos.z } : lastBotPos
        }
      }
    } else {
      lostTicks = 0
      followRefreshTicks = 0
      stuckTicks = 0
      stuckCheckTicks = 0
    }

    if (prevGoal === 'following' && state.goal !== 'following') {
      movement.stop('follow')
      bot.clearControlStates()
    }

    prevGoal = state.goal
    prevFollowTarget = state.followTarget
  }, 250)
}

function getNearestPlayer() {
  let nearest = null, minDist = Infinity
  for (const name in bot.players) {
    if (name === BOT_NAME) continue
    const p = bot.players[name]
    if (!p.entity) continue
    const d = bot.entity.position.distanceTo(p.entity.position)
    if (d < minDist) { minDist = d; nearest = { name, entity: p.entity, dist: d } }
  }
  return nearest
}

// Look up a specific player by name (for follow target tracking)
function getPlayer(username) {
  if (!username) return null
  const p = bot.players[username]
  if (!p?.entity) return null
  return { name: username, entity: p.entity, dist: bot.entity.position.distanceTo(p.entity.position) }
}

// ── Decision Pipeline ──────────────────────────────────────────────────────────

async function handleMessage(username, message) {
  // INSULT CHECK — runs BEFORE LLM, always
  if (detectInsult(message)) {
    bumpAnger(username, 1, 'insulted me')
    const rec = anger.get(username)
    if (rec.level >= 3) safeChat(`Watch your mouth, ${username}.`)
    else                safeChat(`Don't talk to me like that.`)
    if (maybeAttackForAnger(username)) return
  }

  if (llmBusy) { safeChat('Hold on...'); return }
  llmBusy = true

  try {
    const intent = classifyIntent(message)
    console.log(`[${BOT_NAME}] intent=${intent} from=${username} msg="${message}"`)

    const survivalBlock = evaluateSurvival(state)
    if (survivalBlock && ['follow','gather','explore','attack','collect','build','craft'].includes(intent)) {
      safeChat(survivalBlock.say)
      return
    }

    const groundedState = buildGroundedState(bot, state, memory, anger, envPerception)

    let result
    try {
      const raw = await queryLLM(groundedState, intent, message, BOT_NAME)
      result = validateLLMOutput(raw)
      if (!result) {
        console.warn(`[${BOT_NAME}] LLM output invalid:`, JSON.stringify(raw))
        result = safeDefault(intent)
      }
    } catch (err) {
      console.error(`[${BOT_NAME}] LLM error:`, err.message)
      safeChat(`LLM error: ${err.message.slice(0, 60)}`)
      result = safeDefault(intent)
    }

    console.log(`[${BOT_NAME}] decision=${result.decision} action=${result.action} reason="${result.reason}"`)

    executeAction(result, username, groundedState)
    safeChat(result.say)

    if (result.action !== 'none') {
      rememberEvent(memory, 'acted', { intent, action: result.action, decision: result.decision })
    }
  } catch (err) {
    console.error(`[${BOT_NAME}] handleMessage fatal:`, err.message)
    safeChat(`Internal error: ${err.message.slice(0, 80)}`)
  } finally {
    llmBusy = false
  }
}

// ── Safe Action Map ────────────────────────────────────────────────────────────

function executeAction(result, username, groundedState) {
  if (result.decision !== 'accept') return

  const movementActions = ['follow','explore','gather_wood','craft_planks','attack_mobs','attack_player','collect_items','build_house_smart']
  if (movementActions.includes(result.action) && state.energy < 25) {
    result.say = 'Too tired right now.'
    return
  }

  const taskActions = ['explore','gather_wood','craft_planks','go_to','attack_mobs','attack_player','collect_items','craft','build_house_smart']
  if (taskActions.includes(result.action) && taskBusy) {
    result.say = "Still busy — give me a sec."
    return
  }
  if (taskActions.includes(result.action)) interruptFollow()

  switch (result.action) {

    case 'follow':
      state.followTarget = username  // track who specifically — survives other players joining
      setGoal('following', { source: 'llm', reason: 'action=follow' })
      state.idleTicks = 0
      rememberKnowledge(memory, 'following_player', username)
      break

    case 'stop':
      cancelCurrentTask()
      state.followTarget = null
      break

    case 'explore':       runTask('exploring', tasks.taskExplore); break
    case 'craft_planks':  runTask('crafting',  tasks.taskCraftPlanks); break

    case 'gather_wood': {
      const hasLogs = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
      if (!hasLogs) { result.say = 'No trees in range.'; return }
      runTask('gathering', tasks.taskGatherWood)
      break
    }

    case 'go_to':
      if (result.target) runTask('going_to', () => tasks.taskGoTo(result.target))
      break

    case 'remember_here':
      rememberLocation(memory, `${username}_mark`, bot.entity.position)
      break

    case 'attack_mobs':
      if (!groundedState.hostileMobs.length) { result.say = 'No hostile mobs visible.'; return }
      runTask('attacking', tasks.taskAttackMobs)
      break

    case 'attack_player': {
      const tgt = result.target
      const player = tgt ? bot.players[tgt] : null
      if (!player?.entity) { result.say = `Can't see ${tgt || 'them'}.`; return }
      runTask('attacking', () => tasks.taskAttackPlayer(player.entity, tgt))
      break
    }

    case 'collect_items':
      if (groundedState.droppedCount === 0) { result.say = 'No items on the ground.'; return }
      runTask('collecting', tasks.taskCollectNearby)
      break

    case 'craft': {
      const itemName = result.target || 'crafting_table'
      runTask('crafting', () => tasks.taskCraftItem(itemName))
      break
    }

    case 'place_block': {
      const blockName = result.target || 'crafting_table'
      runTask('placing', () => tasks.taskPlaceBlock(blockName))
      break
    }

    case 'mine_block': {
      const blockName = result.target || 'stone'
      const m = blockName.match(/^(.+?)\s*x?\s*(\d+)$/)
      const name = m ? m[1] : blockName
      const count = m ? parseInt(m[2]) : 1
      runTask('mining', () => tasks.taskMineBlock(name, Math.min(count, 16)))
      break
    }

    case 'eat_food':
      runTask('eating', tasks.taskEatFood)
      break

    case 'flee':
      runTask('fleeing', tasks.taskFlee)
      break

    case 'escape':
      runTask('escaping', tasks.taskEscape)
      break

    case 'build_house_smart':
      runTask('building', tasks.taskBuildHouseSmart)
      break

    case 'none':
    default: break
  }
}

// ── Fallback Commands (LLM offline) ───────────────────────────────────────────

function fallbackCommand(username, message) {
  const cmd = message.trim().toLowerCase()

  if (cmd === 'follow me')                           { if (state.energy < 25) { safeChat('Too tired.'); return }; state.followTarget = username; setGoal('following', { source: 'fallback_cmd', reason: 'follow_me' }); safeChat('Following.') }
  else if (cmd === 'stop')                           { cancelCurrentTask(); state.followTarget = null; safeChat('Stopped.') }
  else if (cmd === 'status')                         { safeChat(`Goal: ${state.goal} | E:${state.energy.toFixed(0)} H:${state.hunger.toFixed(0)} | anger:${anger.size}`) }
  else if (cmd === 'explore')                        { if (!taskCmd('exploring', tasks.taskExplore)) safeChat("Busy.") }
  else if (cmd === 'get wood' || cmd === 'chop tree'){ if (!taskCmd('gathering', tasks.taskGatherWood)) safeChat("Busy.") }
  else if (cmd === 'make planks')                    { if (!taskCmd('crafting', tasks.taskCraftPlanks)) safeChat("Busy.") }
  else if (cmd === 'attack' || cmd === 'fight')      { if (!taskCmd('attacking', tasks.taskAttackMobs)) safeChat("Busy.") }
  else if (cmd === 'collect' || cmd === 'pick up')   { if (!taskCmd('collecting', tasks.taskCollectNearby)) safeChat("Busy.") }
  else if (cmd === 'build house')                    { if (!taskCmd('building', tasks.taskBuildHouseSmart)) safeChat("Busy.") }
  else if (cmd === 'inventory')                      { const it = bot.inventory.items(); safeChat(it.length ? it.map(i=>`${i.name}x${i.count}`).join(', ') : 'Empty.') }
  else if (cmd === 'look around')                    { const gs = buildGroundedState(bot, state, memory, anger, envPerception); safeChat(`I see: ${chatSummary(gs) || 'nothing'}`) }
  else {
    const m = cmd.match(/^craft (.+)$/);    if (m) { if (!taskCmd('crafting', () => tasks.taskCraftItem(m[1]))) safeChat("Busy."); return }
    const p = cmd.match(/^place (.+)$/);    if (p) { if (!taskCmd('placing', () => tasks.taskPlaceBlock(p[1].trim()))) safeChat("Busy."); return }
    const mn = cmd.match(/^mine (.+)$/);    if (mn) {
      const parts = mn[1].trim().match(/^(.+?)\s+(\d+)$/)
      const name = parts ? parts[1] : mn[1].trim()
      const cnt = parts ? Math.min(parseInt(parts[2]), 16) : 1
      if (!taskCmd('mining', () => tasks.taskMineBlock(name, cnt))) safeChat("Busy."); return
    }
    if (cmd === 'eat')                      { if (!taskCmd('eating', tasks.taskEatFood)) safeChat("Busy."); return }
    if (cmd === 'flee' || cmd === 'run')    { if (!taskCmd('fleeing', tasks.taskFlee)) safeChat("Busy."); return }
    if (cmd === 'escape' || cmd === 'climb out' || cmd === 'get out') { if (!taskCmd('escaping', tasks.taskEscape)) safeChat("Busy."); return }
    const w = cmd.match(/^where is (.+)$/); if (w) { const loc = recallLocation(memory, w[1].trim()); safeChat(loc ? `${w[1]}: ${loc.pos.x}, ${loc.pos.y}, ${loc.pos.z}` : `Don't know.`); return }
    const g = cmd.match(/^go to (.+)$/);    if (g) { if (!taskCmd('going_to', () => tasks.taskGoTo(g[1].trim()))) safeChat("Busy."); else safeChat(`Going to ${g[1]}.`) }
  }
}

// ── Chat Entry ─────────────────────────────────────────────────────────────────

bot.on('chat', (username, message) => {
  if (username === BOT_NAME) return
  // Ignore other bot instances: their spawn announcements and busy responses
  if (/online \(.+\)\.?$/.test(message)) return
  if (message === 'Hold on...' || message === 'LLM offline — using fallback commands.') return
  try {
    if (llmEnabled) handleMessage(username, message)
    else            fallbackCommand(username, message)
  } catch (err) {
    console.error(`[${BOT_NAME}] chat handler error:`, err)
    safeChat(`Error: ${err.message.slice(0, 80)}`)
  }
})

// ── Exit reason persistence ───────────────────────────────────────────────────
// Written before each exit so botSupervisor.js can classify the restart.
// Consumed (and deleted) by the supervisor on the next launch.

const EXIT_REASON_PATH = path.join(__dirname, 'exit_reason.json')
const RECOVERY_CHAIN_ID = process.env.RECOVERY_CHAIN_ID || null

function writeExitReason(reason) {
  try {
    fs.writeFileSync(EXIT_REASON_PATH, JSON.stringify({
      reason,
      exitAt:          Date.now(),
      livenessState:   liveness?.getState() || null,
      chainId:         RECOVERY_CHAIN_ID,
    }))
  } catch {}
}

// ── Errors / shutdown ─────────────────────────────────────────────────────────

bot.on('error', err => {
  log.error('socket_error', { message: err.message })
})
bot.on('kicked', reason => {
  const r = typeof reason === 'string' ? reason : JSON.stringify(reason)
  log.fatal('kicked', { reason: r })
  writeExitReason('kicked')
  setTimeout(() => process.exit(0), 200)  // give logger time to flush
})
bot.on('end', reason => {
  const r = String(reason)
  log.warn('disconnected', { reason: r })
  const livenessState = liveness?.getState()
  const exitClass = (livenessState === 'LIVE_FATAL' || r === 'disconnect.quitting')
    ? 'entity_desync'
    : 'server_disconnect'
  writeExitReason(exitClass)
  setTimeout(() => process.exit(0), 200)
})

process.on('uncaughtException',  err => {
  log.fatal('uncaught_exception', { message: err.message, stack: err.stack })
  safeChat(`Crash: ${err.message.slice(0,80)}`)
  writeExitReason('crash')
  setTimeout(() => process.exit(1), 500)
})
process.on('unhandledRejection', err => {
  log.error('unhandled_rejection', { message: String(err) })
})
