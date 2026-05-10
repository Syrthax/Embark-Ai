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
  llmEnabled = await checkOllama()
  log.info('llm_check', { model: getModelName(), connected: llmEnabled })

  safeChat(llmEnabled ? `${BOT_NAME} online (${getModelName()}).` : 'LLM offline — using fallback commands.')
  rememberLocation(memory, 'spawn', bot.entity.position)
  rememberEvent(memory, 'spawned', { model: getModelName() })

  recoveryEngine = createRecoveryEngine({
    bot, movement, state, log,
    getTaskContext: () => ({ taskBusy, currentTaskToken }),
    cancelTask:     cancelCurrentTask,
    replaceTask,
    runTask,
    taskBlindSurvival,
    taskEscape,
    taskExplore,
    writeExitReason,
  })

  envPerception      = createEnvironmentPerception(bot, log)
  locomotionRecovery = createLocomotionRecovery(bot, log)

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
    damageState,
    damageWindowSize: damageWindow.length,
    msSinceLastReaction: now - lastReactionAt,

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
// Used by entityHurt's unknown-damage branch and by Movements.blocksToAvoid.
const HAZARD_BLOCKS = new Set([
  'cactus', 'fire', 'soul_fire', 'lava', 'magma_block',
  'sweet_berry_bush', 'wither_rose', 'powder_snow',
  'campfire', 'soul_campfire',
])

// Scan a 7×4×7 box around the bot for hazardous blocks. Returns the closest one or null.
function findNearbyHazard(radius = 3) {
  if (!bot.entity) return null
  const pos = bot.entity.position
  let nearest = null, minDist = Infinity
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 2; dy++) {  // feet, body, head
      for (let dz = -radius; dz <= radius; dz++) {
        const block = bot.blockAt(pos.offset(dx, dy, dz))
        if (!block || !HAZARD_BLOCKS.has(block.name)) continue
        const d = block.position.distanceTo(pos)
        if (d < minDist) { minDist = d; nearest = { block, dist: d, name: block.name } }
      }
    }
  }
  return nearest
}

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
  replaceTask('attacking', () => taskAttackPlayer(player.entity, username))
  return true
}

// ─────────────────────────────────────────────────────────────────────────────
// DAMAGE PIPELINE — capture / classify / react (decoupled, cooldown-gated)
//
// Architecture (replaces the old in-line entityHurt reaction):
//
//   raw entityHurt event ──► captureDamageEvent() ──► damageWindow[]
//                                                         │
//                                              every 500ms, processDamageWindow():
//                                                         │
//                                                  trim window to last 1.5s
//                                                  enter REACTING / HURT / SAFE
//                                                  classifyIncident(window)
//                                                  if reactionCooldown elapsed:
//                                                     react ONCE per incident
//
// The reaction cooldown (3s) makes the cactus-loop / lava-loop impossible:
// we react once, take 3s to step out, then re-evaluate. No spam, no recursion.
// ─────────────────────────────────────────────────────────────────────────────

const DAMAGE_WINDOW_MS    = 1500   // damage events within this window are one incident
const REACTION_COOLDOWN_MS = 3000  // never react more often than this
const HAZARD_MEMORY_MS    = 60000  // hazard zones remembered for 1 min

// Cooldowns for chat / arm-swing (separate from reaction cooldown)
let lastHitChatAt      = 0
let lastCounterPunchAt = 0
let currentPlayerAttackTarget = null  // username of the player we're currently in goal=attacking against
const HIT_CHAT_COOLDOWN_MS      = 4000
const COUNTER_PUNCH_COOLDOWN_MS = 1500

// Damage state machine
const damageWindow = []       // recent raw damage event captures
const hazardZones  = []       // { x, y, z, type, ts } — places we took env damage
let damageState     = 'safe'  // safe | hurt | reacting
let lastReactionAt  = 0
let damageCorrelationCounter = 0
// Single damage-reaction authority (Fix 4): health event sets this flag instead of
// acting directly. processDamageWindow reads it to bypass the cooldown and react
// with a real escape. Prevents the health handler racing processDamageWindow.
let criticalHpFlag  = null    // { at: number, hp: number } | null
let prevHp          = null    // tracks last seen HP for sharp-drop detection

// === Helpers for context capture ===

function getNearestNonBotPlayerWithin(maxDist) {
  if (!bot.entity) return null
  let nearest = null, minDist = maxDist
  for (const name in bot.players) {
    if (name === BOT_NAME) continue
    const p = bot.players[name]
    if (!p?.entity) continue
    const d = p.entity.position.distanceTo(bot.entity.position)
    if (d < minDist) { minDist = d; nearest = { name, entity: p.entity, dist: d } }
  }
  return nearest
}

function getNearestHostileMobWithin(maxDist) {
  if (!bot.entity) return null
  return bot.nearestEntity(e =>
    e !== bot.entity && e.name && HOSTILE_MOB_NAMES.has(e.name) &&
    e.position.distanceTo(bot.entity.position) < maxDist
  )
}

function captureDamageEvent() {
  const rawPos = bot.entity?.position
  let usingCached = false
  let pos = rawPos

  if (!isValidVec(rawPos)) {
    // Degraded mode (diagnosis §13E): instead of silently dropping the event,
    // use liveness.getBestPosition() which returns the best available position
    // with a quality tag. Callers that see posSource='unknown_blind' route to
    // reactToBlind() instead of the normal reaction pipeline.
    const best = liveness.getBestPosition()
    if (!best) {
      log.warn('damage_capture_skipped', {
        reason: 'no_position_available',
        livenessState: liveness.getState(),
        invalidMs: liveness.getInvalidMs(),
      })
      return null
    }
    pos = best.pos
    usingCached = best.source !== 'live'
    if (best.source === 'unknown') {
      // Mark as blind — classifier will fall through to reactToBlind()
      usingCached = true
      pos = best.pos || { x: 0, y: 0, z: 0 }
      log.debug('damage_capture_blind', { livenessState: liveness.getState(), cacheAgeMs: liveness.getCachedAge() })
    }
  }

  const event = {
    at: Date.now(),
    hp: Number(bot.health.toFixed(1)),
    hurtTime: bot.entity?.hurtTime ?? null,
    pos: safeFloor(pos),
    posSource: usingCached ? 'cached' : 'live',
    velocity: isValidVec(bot.entity?.velocity) ? {
      x: Number(bot.entity.velocity.x.toFixed(2)),
      y: Number(bot.entity.velocity.y.toFixed(2)),
      z: Number(bot.entity.velocity.z.toFixed(2)),
    } : null,
    nearestPlayer: getNearestNonBotPlayerWithin(5),
    nearestHostileMob: getNearestHostileMobWithin(6),
    hazard: findNearbyHazard(2),
    inWater: !!bot.entity?.isInWater,
    inLava: !!bot.entity?.isInLava,
  }
  if (usingCached) log.debug('damage_capture_using_cached_pos', { cachedAgeMs: liveness.getCachedAge(), livenessState: liveness.getState() })
  return event
}

// === Raw event listener — only captures, never reacts ===

bot.on('entityHurt', (entity) => {
  if (entity !== bot.entity) return
  const evt = captureDamageEvent()
  if (!evt) return
  damageWindow.push(evt)
  // Use trace level — these events are high-frequency; not useful as user-visible info
  log.trace('damage_raw', {
    hp: evt.hp,
    player: evt.nearestPlayer?.name || null,
    mob: evt.nearestHostileMob?.name || null,
    hazard: evt.hazard?.name || null,
    inLava: evt.inLava,
  })
})

// === Periodic classifier — runs every 500 ms ===

setInterval(processDamageWindow, 500)

function processDamageWindow() {
  // Trim window to last DAMAGE_WINDOW_MS
  const cutoff = Date.now() - DAMAGE_WINDOW_MS
  while (damageWindow.length > 0 && damageWindow[0].at < cutoff) damageWindow.shift()

  // Trim hazard memory
  const hzCutoff = Date.now() - HAZARD_MEMORY_MS
  while (hazardZones.length > 0 && hazardZones[0].ts < hzCutoff) hazardZones.shift()

  if (damageWindow.length === 0) {
    if (damageState !== 'safe') {
      log.info('damage_state_change', { from: damageState, to: 'safe' })
      damageState = 'safe'
    }
    return
  }

  if (damageState === 'safe') {
    log.info('damage_state_change', { from: 'safe', to: 'hurt' })
    damageState = 'hurt'
  }

  // Reaction cooldown: don't act on every tick.
  // Priority bypass: if the health handler flagged a critical HP event that is newer
  // than our last reaction, skip the cooldown for this one incident only.
  const sinceReaction = Date.now() - lastReactionAt
  if (sinceReaction < REACTION_COOLDOWN_MS) {
    if (!criticalHpFlag || criticalHpFlag.at <= lastReactionAt) return
    log.warn('critical_hp_bypass', { hp: criticalHpFlag.hp, sinceReaction })
    criticalHpFlag = null
  }

  // Classify and react
  const incident = classifyIncident(damageWindow)
  const incidentCid = ++damageCorrelationCounter
  log.info('damage_incident', {
    type: incident.type,
    hits: damageWindow.length,
    hp: bot.health,
    detail: incident.summary,
    cid: incidentCid,
  })
  lastReactionAt = Date.now()
  damageState = 'reacting'
  reactToIncident(incident)
}

function classifyIncident(events) {
  // Check player consistency: same player nearby in all events
  const playerNames = events.map(e => e.nearestPlayer?.name).filter(Boolean)
  if (playerNames.length === events.length && new Set(playerNames).size === 1) {
    const attacker = events[events.length - 1].nearestPlayer
    return { type: 'player', attacker, summary: { player: attacker.name } }
  }

  // Mob consistency
  const mobNames = events.map(e => e.nearestHostileMob?.name).filter(Boolean)
  if (mobNames.length === events.length && new Set(mobNames).size === 1) {
    const mob = events[events.length - 1].nearestHostileMob
    return { type: 'mob', attacker: mob, summary: { mob: mob.name } }
  }

  // Lava / fire detection from entity flags
  if (events.some(e => e.inLava)) {
    return { type: 'environmental', hazard: { name: 'lava', block: bot.entity }, summary: { hazard: 'lava' } }
  }

  // Hazard block detection
  const hazards = events.map(e => e.hazard).filter(Boolean)
  if (hazards.length > 0) {
    const hz = hazards[hazards.length - 1]
    return { type: 'environmental', hazard: hz, summary: { hazard: hz.name } }
  }

  return { type: 'unknown', summary: {} }
}

function reactToIncident(incident) {
  switch (incident.type) {
    case 'player':        return reactToPlayerAttack(incident.attacker)
    case 'mob':           return reactToMobAttack(incident.attacker)
    case 'environmental': return reactToEnvironmental(incident.hazard)
    case 'unknown':       return reactToUnknownDamage()
  }
}

function reactToPlayerAttack(attacker) {
  const rec = bumpAnger(attacker.name, ANGER_HIT, 'attacked me')
  const now = Date.now()
  if (rec.level >= ANGER_ATTACK_LEVEL) {
    // Symmetric guard matching reactToMobAttack: don't restart the attack task on every hit.
    if (taskBusy && state.goal === 'attacking') {
      if (currentPlayerAttackTarget === attacker.name) return  // already engaged with this player

      // Different player is hitting us mid-attack. Switch only if the new attacker is
      // closer than our current target (they're the more immediate threat).
      const botPos = bot.entity?.position
      if (botPos) {
        const currentTarget = getPlayer(currentPlayerAttackTarget)
        const newDist = attacker.entity?.position?.distanceTo(botPos) ?? Infinity
        const curDist = currentTarget?.entity?.position?.distanceTo(botPos) ?? Infinity
        if (newDist >= curDist) {
          log.debug('player_attack_suppressed', {
            incoming: attacker.name, current: currentPlayerAttackTarget,
            newDist: Math.round(newDist), curDist: Math.round(curDist),
          })
          return  // stay on the closer current target
        }
      } else {
        return  // no position data, don't switch
      }
    }

    if (now - lastHitChatAt >= HIT_CHAT_COOLDOWN_MS) {
      safeChat(`That's it, ${attacker.name}.`)
      lastHitChatAt = now
    }
    currentPlayerAttackTarget = attacker.name
    replaceTask('attacking', () => taskAttackPlayer(attacker.entity, attacker.name))
  } else {
    if (now - lastHitChatAt >= HIT_CHAT_COOLDOWN_MS) {
      safeChat(`Stop hitting me, ${attacker.name}!`)
      lastHitChatAt = now
    }
    if (now - lastCounterPunchAt >= COUNTER_PUNCH_COOLDOWN_MS) {
      try { bot.attack(attacker.entity) } catch (e) {
        log.warn('counter_attack_failed', { message: e.message })
      }
      lastCounterPunchAt = now
    }
  }
}

function reactToMobAttack(mob) {
  if (taskBusy && state.goal === 'attacking') return  // already engaged
  if (state.energy < 30) {
    safeChat(`A ${mob.name}! Backing off.`)
    log.info('mob_hit_decision', { mob: mob.name, choice: 'flee', energy: state.energy })
    replaceTask('fleeing', taskFlee)
  } else {
    safeChat(`A ${mob.name}. Fighting back.`)
    log.info('mob_hit_decision', { mob: mob.name, choice: 'fight', energy: state.energy })
    replaceTask('attacking', () => taskAttackMobs())
  }
}

function reactToEnvironmental(hazard) {
  rememberHazard(hazard)
  // Also record in the environmental perception hazard memory for path avoidance
  if (hazard?.block?.position && envPerception) {
    const hp = hazard.block.position
    envPerception.recordHazardPosition(hp.x, hp.y, hp.z, 'damage')
  }
  log.info('hazard_detected', {
    name: hazard?.name || 'unknown',
    knownZones: hazardZones.length,
    envRisk: lastEnvScan?.locomotionRisk ?? null,
  })
  replaceTask('evading', () => taskEvadeHazard(hazard))
}

function reactToUnknownDamage() {
  // No identifiable source. If HP is dropping fast, retreat.
  if (bot.health < 12) {
    log.warn('unknown_damage_critical_retreat', { hp: bot.health })
    replaceTask('evading', () => taskEvadeHazard(null))
  } else {
    log.warn('unknown_damage_ignored_hp_ok', { hp: bot.health })
  }
}

function rememberHazard(hazard) {
  if (!hazard?.block?.position) return
  const p = hazard.block.position
  hazardZones.push({
    x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
    type: hazard.name,
    ts: Date.now(),
  })
  while (hazardZones.length > 50) hazardZones.shift()
}

bot.on('health', () => {
  const hp   = bot.health
  const prev = prevHp ?? hp
  prevHp = hp

  const sharpDrop = (prev - hp) >= 2
  const critical  = hp <= 4

  // Stage a high-priority flag for processDamageWindow instead of acting directly.
  // Direct action (cancelCurrentTask + setGoal) here races processDamageWindow's
  // escape reaction, cancelling it on every lava tick and causing goal oscillation.
  // processDamageWindow will bypass its cooldown for this flag and launch a real escape.
  if ((sharpDrop || critical) && (!criticalHpFlag || criticalHpFlag.at < Date.now() - 500)) {
    criticalHpFlag = { at: Date.now(), hp }
    log.warn('critical_hp_queued', { hp, prev, sharpDrop, critical })
  }
})

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
  damageWindow.length = 0
  damageState = 'safe'
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
  damageWindow.length = 0
  damageState = 'safe'
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

const LOG_NAMES   = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log']
const PLANK_NAMES = ['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks']

const logIds   = () => LOG_NAMES.map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
const plankIds = () => PLANK_NAMES.map(n => bot.registry.itemsByName[n]?.id).filter(Boolean)

function countInInv(names) {
  return bot.inventory.items()
    .filter(i => names.includes(i.name))
    .reduce((s, i) => s + i.count, 0)
}

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

async function equipBestWeapon() {
  const weapons = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe',
  ]
  for (const w of weapons) {
    const id = bot.registry.itemsByName[w]?.id
    const item = id ? bot.inventory.findInventoryItem(id, null, false) : null
    if (item) { await safeEquip(bot, item, 'hand'); return w }
  }
  return null
}

// ── TASKS ─────────────────────────────────────────────────────────────────────

async function taskExplore() {
  let p
  try { p = await awaitValidPosition(2000) }
  catch (e) { log.warn('explore_skip_invalid_position', { reason: e.message }); return }

  const angle = Math.random() * Math.PI * 2
  const dist  = 10 + Math.random() * 20  // 10-30 blocks — short enough to reliably reach
  const tx    = Math.floor(p.x + Math.sin(angle) * dist)
  const ty    = Math.floor(p.y)
  const tz    = Math.floor(p.z + Math.cos(angle) * dist)
  if (!isFiniteNum(tx) || !isFiniteNum(ty) || !isFiniteNum(tz)) {
    log.error('explore_target_invalid', { tx, ty, tz })
    return
  }
  log.debug('explore_target', { from: safeFloor(p), to: { x: tx, y: ty, z: tz } })

  // Fail fast on complex terrain — try another direction next idle cycle
  movement.setThinkingTimeout(2000)
  try {
    await navNear(tx, ty, tz, 5)
    rememberLocation(memory, 'last_explored', bot.entity.position)
  } finally {
    movement.restoreThinkingTimeout()
  }
}

async function taskGatherWood() {
  const ids = logIds()
  const log = bot.findBlock({ matching: ids, maxDistance: 50 })
  if (!log) { safeChat('No trees in range.'); return }
  console.log(`[${BOT_NAME}] Chopping log at ${log.position}`)
  await navNear(log.position.x, log.position.y, log.position.z, 2)
  const fresh = bot.blockAt(log.position)
  if (fresh && ids.includes(fresh.type) && bot.canDigBlock(fresh)) {
    await safeDig(bot, fresh)
    safeChat('Got wood.')
    rememberEvent(memory, 'gathered_wood', {})
  }
}

async function taskCraftPlanks() {
  const logs = bot.inventory.items().filter(i => LOG_NAMES.includes(i.name))
  if (!logs.length) { safeChat('No logs to convert.'); return }

  let totalCrafted = 0
  for (const log of logs) {
    const plankName = log.name.replace('_log', '_planks')
    const plankId = bot.registry.itemsByName[plankName]?.id
    if (!plankId) continue

    const recipes = bot.recipesFor(plankId, null, 1, null)
    if (!recipes.length) continue

    try {
      const count = log.count
      await safeCraft(bot, recipes[0], count, null)
      totalCrafted += count * 4
    } catch (err) {
      console.error(`[${BOT_NAME}] Plank craft failed:`, err.message)
    }
  }

  if (totalCrafted > 0) {
    safeChat(`Made ${totalCrafted} planks.`)
    rememberEvent(memory, 'crafted_planks', { count: totalCrafted })
  } else {
    safeChat('Could not make planks.')
  }
}

async function taskGoTo(name) {
  const loc = recallLocation(memory, name)
  if (!loc) { safeChat(`Don't know where "${name}" is.`); return }
  console.log(`[${BOT_NAME}] Going to ${name}`)
  await navNear(loc.pos.x, loc.pos.y, loc.pos.z)
  safeChat(`Reached ${name}.`)
  rememberEvent(memory, 'visited', { name })
}

async function taskAttackMobs() {
  const mob = bot.nearestEntity(e =>
    e.name && HOSTILE_MOB_NAMES.has(e.name) && e.position.distanceTo(bot.entity.position) < 20
  )
  if (!mob) { safeChat('No hostile mobs nearby.'); return }

  const weapon = await equipBestWeapon()
  console.log(`[${BOT_NAME}] Attacking ${mob.name} with ${weapon || 'fists'}`)
  safeChat(`Fighting ${mob.name}.`)
  await safeAttack(bot, mob, { maxMs: 10_000, label: mob.name })

  if (mob.isValid) safeChat('Got away.')
  else            { safeChat(`${mob.name} down.`); rememberEvent(memory, 'killed_mob', { name: mob.name }) }
}

async function taskAttackPlayer(entity, username) {
  if (!entity || !entity.isValid) { safeChat(`${username} is gone.`); return }

  const weapon = await equipBestWeapon()
  console.log(`[${BOT_NAME}] Attacking player ${username} with ${weapon || 'fists'}`)
  safeChat(`Coming for you, ${username}.`)
  await safeAttack(bot, entity, { maxMs: 10_000, label: username })

  // Reduce anger after fighting
  const rec = anger.get(username)
  if (rec) rec.level = Math.max(0, rec.level - 3)
  safeChat('We even now.')
  rememberEvent(memory, 'fought_player', { username })
}

async function taskCollectNearby() {
  const pos = bot.entity.position
  const drops = Object.values(bot.entities)
    .filter(e => e.type === 'object' && e.objectType === 'Item' && e.position.distanceTo(pos) < 25)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .slice(0, 10)

  if (!drops.length) { safeChat('No items nearby.'); return }

  safeChat(`Collecting ${drops.length} item(s).`)
  for (const e of drops) {
    if (!e.isValid) continue
    try { await navNear(e.position.x, e.position.y, e.position.z, 1) } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  rememberEvent(memory, 'collected_items', {})
}

// Items whose recipes always require sticks (vanilla wooden/stone/iron/gold/diamond/netherite tools)
const STICK_TOOL_RE = /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|sword|axe|shovel|hoe)$/

function countItemsByName(name) {
  // Match by name string — more robust across protocol/registry version drift
  return bot.inventory.items()
    .filter(i => i.name === name)
    .reduce((s, i) => s + i.count, 0)
}

function countMaterialFamily(suffix) {
  // e.g., "_planks" → counts all plank types together
  return bot.inventory.items()
    .filter(i => i.name.endsWith(suffix))
    .reduce((s, i) => s + i.count, 0)
}

// Track items that "successfully" crafted but didn't actually consume materials —
// likely a mineflayer/server protocol mismatch. Don't keep retrying these.
const phantomCraftBlocklist = new Map()  // itemName -> blockedUntilTimestamp
const PHANTOM_BLOCK_MS = 5 * 60 * 1000  // block re-attempts for 5 minutes

function inventoryHas(predicate) {
  return bot.inventory.items().some(predicate)
}

// Auto-craft sticks if needed. Returns true if sticks are now available.
async function ensureSticks() {
  const stickId = bot.registry.itemsByName['stick']?.id
  if (!stickId) return false
  if (bot.inventory.findInventoryItem(stickId, null, false)) return true

  // Need at least 2 planks (any kind). If we don't have planks but have logs, craft planks first.
  const totalPlanks = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
  if (totalPlanks < 2) {
    if (bot.inventory.items().some(i => i.name.endsWith('_log'))) {
      log.info('auto_craft_planks_for_sticks')
      await taskCraftPlanks()
    } else {
      log.warn('cannot_make_sticks', { reason: 'no planks or logs' })
      return false
    }
  }

  // Sticks: 2 planks → 4 sticks. Inventory crafting (no table required).
  const recipes = bot.recipesFor(stickId, null, 1, null)
  if (!recipes.length) {
    log.warn('no_stick_recipe_available', { invPlanks: totalPlanks })
    return false
  }
  try {
    await safeCraft(bot, recipes[0], 1, null)
    log.info('crafted_sticks_auto', { sticksNow: countItemsByName('stick') })
    return true
  } catch (e) {
    log.error('stick_craft_exception', { message: e.message })
    return false
  }
}

// Determine which ingredients are missing for a recipe (best-effort diagnostic).
function describeRecipe(itemId) {
  // Search the registry for any recipe producing this item
  try {
    const recipes = bot.registry.recipes?.[itemId]
    if (!recipes || !recipes.length) return null
    return recipes[0]  // raw shape varies by mineflayer version, used for logging only
  } catch { return null }
}

async function taskCraftItem(itemName) {
  const normalized = (itemName || '').replace(/ /g, '_').toLowerCase()
  if (!normalized) { safeChat('Craft what?'); return }

  const itemData = bot.registry.itemsByName[normalized]
  if (!itemData) { safeChat(`Don't know what "${itemName}" is.`); return }

  // Skip items that previously phantom-crafted (succeeded silently without consuming materials)
  const blockedUntil = phantomCraftBlocklist.get(normalized)
  if (blockedUntil && Date.now() < blockedUntil) {
    const secsLeft = Math.ceil((blockedUntil - Date.now()) / 1000)
    log.warn('craft_skip_phantom_blocked', { item: normalized, secsLeft })
    safeChat(`Skipping ${itemName} — recipe seems broken.`)
    return
  }

  const beforeCount = countItemsByName(normalized)
  const invSnapshot = bot.inventory.items().map(i => `${i.name}x${i.count}`)
  log.info('craft_start', { item: normalized, before: beforeCount, inventory: invSnapshot })

  // ── 1. Try inventory crafting (recipes that don't need a table) ────────────
  let recipes = bot.recipesFor(itemData.id, null, 1, null)
  if (recipes.length > 0) {
    try {
      const stickBefore = countItemsByName('stick')
      const planksBefore = countMaterialFamily('_planks')
      await safeCraft(bot, recipes[0], 1, null)
      const after = countItemsByName(normalized)
      const stickAfter = countItemsByName('stick')
      const planksAfter = countMaterialFamily('_planks')
      const consumed = (stickAfter < stickBefore) || (planksAfter < planksBefore)
      if (after > beforeCount && consumed) {
        safeChat(`Crafted ${itemName}.`)
        log.info('craft_success', { item: normalized, table: false, before: beforeCount, after })
        rememberEvent(memory, 'crafted', { item: itemName })
        return
      }
      if (after > beforeCount && !consumed) {
        log.error('craft_phantom', { item: normalized, table: false, beforeCount, after, stickBefore, stickAfter, planksBefore, planksAfter })
        phantomCraftBlocklist.set(normalized, Date.now() + PHANTOM_BLOCK_MS)
        safeChat(`Recipe broken for ${itemName}.`)
        return
      }
      log.warn('craft_no_count_change', { item: normalized, table: false })
    } catch (e) {
      log.error('craft_inventory_exception', { item: normalized, message: e.message })
    }
  }

  // ── 2. Need a crafting table — find or auto-place one ──────────────────────
  const tableId = bot.registry.blocksByName['crafting_table']?.id
  let table = tableId ? bot.findBlock({ matching: [tableId], maxDistance: 20 }) : null

  if (!table) {
    const tableItemId = bot.registry.itemsByName['crafting_table']?.id
    if (tableItemId && bot.inventory.findInventoryItem(tableItemId, null, false)) {
      log.info('auto_place_table', { reason: `crafting ${normalized}` })
      const placed = await placeFromInventory('crafting_table')
      if (placed) {
        await new Promise(r => setTimeout(r, 300))
        table = tableId ? bot.findBlock({ matching: [tableId], maxDistance: 5 }) : null
      }
    }
  }

  if (!table) {
    safeChat('No crafting table.')
    log.warn('craft_no_table', { item: normalized, hasTableInInv: inventoryHas(i => i.name === 'crafting_table') })
    return
  }
  await navNear(table.position.x, table.position.y, table.position.z, 2)

  // ── 3. Try with the table ──────────────────────────────────────────────────
  recipes = bot.recipesFor(itemData.id, null, 1, table)

  // ── 4. If no recipe is currently makeable and this is a tool, auto-make sticks ──
  if (recipes.length === 0 && STICK_TOOL_RE.test(normalized) && !inventoryHas(i => i.name === 'stick')) {
    log.info('auto_resolve_sticks', { reason: `tool prerequisite for ${normalized}` })
    safeChat('Need sticks first.')
    const ok = await ensureSticks()
    if (ok) {
      recipes = bot.recipesFor(itemData.id, null, 1, table)
    }
  }

  // ── 5. Final sanity check ──────────────────────────────────────────────────
  if (recipes.length === 0) {
    const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'empty'
    log.warn('craft_failed_no_recipe', { item: normalized, inventory: inv })
    safeChat(`Can't craft ${itemName}. Have: ${inv.length > 80 ? inv.slice(0, 77) + '...' : inv}`)
    return
  }

  // ── 6. Craft and verify (also detect phantom: success but materials not consumed) ──
  try {
    const stickBefore = countItemsByName('stick')
    const planksBefore = countMaterialFamily('_planks')
    await safeCraft(bot, recipes[0], 1, table)
    const after = countItemsByName(normalized)
    const stickAfter = countItemsByName('stick')
    const planksAfter = countMaterialFamily('_planks')
    const consumed = (stickAfter < stickBefore) || (planksAfter < planksBefore)

    if (after > beforeCount && consumed) {
      safeChat(`Crafted ${itemName}.`)
      log.info('craft_success', { item: normalized, table: true, before: beforeCount, after, consumed: { stick: stickBefore - stickAfter, planks: planksBefore - planksAfter } })
      rememberEvent(memory, 'crafted', { item: itemName })
    } else if (after > beforeCount && !consumed) {
      // Phantom craft: server didn't actually accept the recipe (likely protocol/data version drift)
      // Don't keep retrying the same item — block for 5 minutes.
      log.error('craft_phantom', { item: normalized, table: true, beforeCount, after, stickBefore, stickAfter, planksBefore, planksAfter })
      phantomCraftBlocklist.set(normalized, Date.now() + PHANTOM_BLOCK_MS)
      safeChat(`Recipe broken for ${itemName}. Skipping.`)
    } else {
      log.warn('craft_silent_failure', { item: normalized, before: beforeCount, after })
      safeChat(`Crafted ${itemName} but inventory unchanged?`)
    }
  } catch (e) {
    log.error('craft_table_exception', { item: normalized, message: e.message, stack: e.stack?.split('\n')[1]?.trim() })
    safeChat(`Craft error: ${e.message.slice(0, 50)}`)
  }
}

// Place a block from inventory in front of the bot (or adjacent if blocked).
// Returns true on success, false if no spot found or no item.
async function placeFromInventory(blockName) {
  const normalized = blockName.replace(/ /g, '_').toLowerCase()
  const itemId = bot.registry.itemsByName[normalized]?.id
  if (!itemId) return false
  const item = bot.inventory.findInventoryItem(itemId, null, false)
  if (!item) return false

  await safeEquip(bot, item, 'hand')

  // Compute "in front of bot" target — uses yaw to find facing direction
  const yaw = bot.entity.yaw
  const dx = -Math.round(Math.sin(yaw))
  const dz = -Math.round(Math.cos(yaw))
  const here = bot.entity.position.floored()

  // Try positions in priority order: directly in front (ground level), then sides, then behind
  const offsets = [
    [dx, 0, dz], [dx, -1, dz],          // in front, ground or one below
    [dz, 0, -dx], [-dz, 0, dx],         // left, right
    [-dx, 0, -dz],                      // behind (last resort)
  ]

  for (const [ox, oy, oz] of offsets) {
    const targetPos = here.offset(ox, oy, oz)
    const current = bot.blockAt(targetPos)
    if (!current || (current.name !== 'air' && current.name !== 'cave_air' && current.name !== 'grass')) continue

    // Find a solid reference block adjacent to the target to "click on"
    const adj = [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]
    for (const [adx, ady, adz] of adj) {
      const refBlock = bot.blockAt(targetPos.offset(adx, ady, adz))
      if (!refBlock || refBlock.boundingBox !== 'block') continue
      try {
        const faceVec = targetPos.minus(refBlock.position)
        await safePlaceBlock(bot, refBlock, faceVec)
        log.info('placed_block', { block: normalized, pos: { x: targetPos.x, y: targetPos.y, z: targetPos.z } })
        return true
      } catch (e) {
        // Try next reference block
      }
    }
  }
  return false
}

async function taskPlaceBlock(blockName) {
  const normalized = (blockName || '').replace(/ /g, '_').toLowerCase()
  if (!normalized) { safeChat("Place what?"); return }
  if (!bot.registry.itemsByName[normalized]) {
    safeChat(`Don't know what "${blockName}" is.`); return
  }
  const itemId = bot.registry.itemsByName[normalized].id
  if (!bot.inventory.findInventoryItem(itemId, null, false)) {
    safeChat(`No ${blockName} in inventory.`); return
  }
  const ok = await placeFromInventory(normalized)
  if (ok) {
    safeChat(`Placed ${blockName}.`)
    rememberEvent(memory, 'placed', { block: normalized })
  } else {
    safeChat(`No good spot to place ${blockName}.`)
  }
}

// Generic mining — works for stone, ores, sand, etc.
// Resolves singular → plural (e.g. "stone" finds stone block).
async function taskMineBlock(blockName, count = 1) {
  const normalized = (blockName || '').replace(/ /g, '_').toLowerCase()
  if (!normalized) { safeChat('Mine what?'); return }

  // Resolve a few common aliases
  const aliasMap = {
    wood: 'oak_log', tree: 'oak_log', log: 'oak_log',
    stone_block: 'stone',
    iron: 'iron_ore', coal: 'coal_ore', gold: 'gold_ore', diamond: 'diamond_ore',
  }
  const target = aliasMap[normalized] || normalized
  const blockId = bot.registry.blocksByName[target]?.id
  if (!blockId) {
    safeChat(`Don't know how to find "${blockName}".`)
    log.warn('mine_unknown_block', { block: normalized })
    return
  }

  log.info('mine_start', { block: target, count })
  let mined = 0
  let consecutiveFailures = 0
  while (mined < count && consecutiveFailures < 3) {
    const block = bot.findBlock({ matching: [blockId], maxDistance: 32 })
    if (!block) {
      log.warn('mine_no_block_found', { block: target, mined, requested: count })
      safeChat(mined > 0 ? `Got ${mined}. No more nearby.` : `No ${blockName} nearby.`)
      return
    }

    if (!bot.canDigBlock(block)) {
      log.warn('mine_cant_dig', { block: target, hasPickaxe: inventoryHas(i => i.name.includes('pickaxe')) })
      safeChat(`Can't break ${blockName} — wrong tool?`)
      return
    }

    try {
      await navNear(block.position.x, block.position.y, block.position.z, 2)
      const fresh = bot.blockAt(block.position)
      if (!fresh || fresh.type !== blockId) {
        consecutiveFailures++
        continue  // someone else broke it, or it changed
      }
      // Equip the best tool we have
      await equipBestTool(target)
      await safeDig(bot, fresh)
      mined++
      consecutiveFailures = 0
      log.info('mined', { block: target, count: mined })
    } catch (e) {
      consecutiveFailures++
      log.error('mine_exception', { block: target, message: e.message, attempt: consecutiveFailures })
    }
  }

  if (mined > 0) {
    safeChat(`Got ${mined} ${blockName}.`)
    rememberEvent(memory, 'mined', { block: target, count: mined })
  } else {
    safeChat(`Couldn't mine ${blockName}.`)
  }
}

async function equipBestTool(blockName) {
  // Map block to preferred tool tier (best first)
  const toolPrefs = {
    stone:        ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe'],
    coal_ore:     ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe'],
    iron_ore:     ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe'],
    diamond_ore:  ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe'],
    gold_ore:     ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe'],
    sand:         ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel'],
    gravel:       ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel'],
    dirt:         ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel'],
  }
  const isLog = blockName.endsWith('_log')
  const prefs = isLog
    ? ['netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe']
    : (toolPrefs[blockName] || [])
  for (const tool of prefs) {
    const id = bot.registry.itemsByName[tool]?.id
    const item = id ? bot.inventory.findInventoryItem(id, null, false) : null
    if (item) {
      try { await safeEquip(bot, item, 'hand'); return tool } catch {}
    }
  }
  return null
}

// Eat food when hungry. Picks the best available food (cooked > raw > emergency).
const FOOD_PRIORITY = [
  'cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','cooked_rabbit',
  'cooked_cod','cooked_salmon','baked_potato','bread','pumpkin_pie',
  'beef','porkchop','chicken','mutton','rabbit',
  'apple','carrot','melon_slice','sweet_berries','cookie','golden_apple',
  // Last resort — these have side effects
  'rotten_flesh','spider_eye','poisonous_potato',
]

async function taskEatFood() {
  if (bot.food >= 20) { safeChat('Already full.'); return }

  const inv = bot.inventory.items()
  let food = null
  for (const fn of FOOD_PRIORITY) {
    food = inv.find(i => i.name === fn)
    if (food) break
  }

  if (!food) {
    log.warn('eat_no_food', { hunger: bot.food })
    safeChat('No food.')
    return
  }

  log.info('eat_start', { food: food.name, hungerBefore: bot.food })
  try {
    await safeEquip(bot, food, 'hand')
    await safeConsume(bot)
    log.info('eat_success', { food: food.name, hungerBefore: bot.food, hungerAfter: bot.food })
    safeChat(`Ate ${food.name.replace(/_/g, ' ')}.`)
    rememberEvent(memory, 'ate', { food: food.name })
  } catch (e) {
    log.error('eat_exception', { food: food.name, message: e.message })
    safeChat(`Couldn't eat: ${e.message.slice(0, 50)}`)
  }
}

// Escape from being stuck (in a hole, surrounded, etc.)
// Strategy: try to navigate to a higher Y at our current X/Z (pathfinder will dig
// or pillar with our scaffolding blocks). If that fails, dig straight up as a last resort.
async function taskEscape() {
  let p
  try { p = await awaitValidPosition(2000) }
  catch (e) { log.warn('escape_skip_invalid_position', { reason: e.message }); safeChat("Can't escape yet."); return }

  // Get current perception to classify stuck state and orient escape
  const scan = lastEnvScan || (envPerception ? envPerception.scan() : null)
  const stuckClass = scan?.stuckClass || 'unknown'

  log.info('escape_start', {
    from: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    stuckClass,
    locomotionRisk: scan?.locomotionRisk ?? null,
    hazardSummary:  scan?.hazardSummary  ?? null,
  })
  safeChat('Stuck — escaping.')

  // Phase 1: locomotion micro-escape first (fast, no pathfinder)
  if (locomotionRecovery && scan?.valid !== false) {
    log.info('escape_attempt', { method: 'locomotion_phase', stuckClass })
    await locomotionRecovery.runHazardEscape(stuckClass, scan, 'task_escape')
    await new Promise(r => setTimeout(r, 300))
  }

  // Re-read position after locomotion phase
  const p2 = bot.entity?.position
  if (!isValidVec(p2)) {
    log.warn('escape_position_invalid_after_locomotion')
    return
  }

  const startY = Math.floor(p2.y)
  const targetY = Math.min(75, startY + 15)

  // Phase 2: pathfinder escape — prefer escape-vector direction if known
  const ev = scan?.escapeVector
  const cx  = Math.floor(p2.x)
  const cz  = Math.floor(p2.z)

  const attempts = [
    { x: cx, z: cz, y: targetY },  // straight up
    // Escape-vector-biased targets first
    ...(ev ? [
      { x: cx + ev.dx * 6, z: cz + ev.dz * 6, y: targetY },
      { x: cx + ev.dx * 4, z: cz + ev.dz * 4, y: startY  },
    ] : []),
    { x: cx + 6, z: cz,     y: targetY },
    { x: cx - 6, z: cz,     y: targetY },
    { x: cx,     z: cz + 6, y: targetY },
    { x: cx,     z: cz - 6, y: targetY },
  ]

  movement.setThinkingTimeout(5000)
  try {
    for (const a of attempts) {
      if (!isFiniteNum(a.x) || !isFiniteNum(a.y) || !isFiniteNum(a.z)) continue
      try {
        await navNear(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z), 3)
        const newY = Math.floor(bot.entity.position.y)
        log.info('escape_complete', { method: 'pathfinder', reached: a, newY, stuckClass })
        safeChat('Out!')
        return
      } catch (e) {
        log.warn('escape_attempt_failed', { target: a, message: e.message })
      }
    }
  } finally {
    movement.restoreThinkingTimeout()
  }

  // Phase 3: dig up as last resort
  log.warn('escape_falling_back_to_dig_up', { stuckClass })
  await digUp(12)
  log.info('escape_complete', { method: 'dig_up', endY: Math.floor(bot.entity.position.y) })
}

// Mine the block above the bot's head, jump to fill the new space, repeat.
// Used when pathfinder can't find a way out.
async function digUp(maxBlocks = 10) {
  let dug = 0
  for (let i = 0; i < maxBlocks; i++) {
    const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0))
    if (!headBlock || ['air', 'cave_air', 'void_air'].includes(headBlock.name)) {
      break  // already at open air
    }
    if (!bot.canDigBlock(headBlock)) {
      log.warn('dig_up_blocked', { block: headBlock.name })
      safeChat(`Can't dig ${headBlock.name} — wrong tool?`)
      break
    }
    try {
      await equipBestTool(headBlock.name)
      await safeDig(bot, headBlock)
      dug++
      // Jump up to occupy the new block space
      bot.setControlState('jump', true)
      await new Promise(r => setTimeout(r, 350))
      bot.setControlState('jump', false)
    } catch (e) {
      log.warn('dig_up_step_failed', { message: e.message })
      break
    }
  }
  return dug
}

// Step away from an environmental hazard (cactus, lava, fire, etc.).
// `hazard` is optional — if null, just moves 5 blocks in a random horizontal direction.
async function taskEvadeHazard(hazard) {
  // Wait for valid position — critical right after teleport / respawn,
  // when bot.entity.position briefly has NaN x/z.
  let pos
  try {
    pos = await awaitValidPosition(2000)
  } catch (e) {
    log.warn('evade_skip_invalid_position', { reason: e.message, hazard: hazard?.name })
    safeChat('Need a moment.')
    return
  }

  // Compute escape vector — always via safeNormalize2D so length-0 / NaN
  // can never produce NaN target coords.
  let rawDx, rawDz, label
  const hazardPos = hazard?.block?.position
  if (hazard && isValidVec(hazardPos)) {
    rawDx = pos.x - hazardPos.x
    rawDz = pos.z - hazardPos.z
    label = (hazard.name || 'something').replace(/_/g, ' ')
  } else {
    rawDx = NaN
    rawDz = NaN  // forces safeNormalize2D into random fallback
    label = hazard?.name?.replace(/_/g, ' ') || 'something'
  }

  const { dx, dz, fallback } = safeNormalize2D(rawDx, rawDz)
  if (fallback) log.debug('evade_normalize_fallback', { reason: fallback, hazard: hazard?.name })

  const tx = Math.floor(pos.x + dx * 5)
  const ty = Math.floor(pos.y)
  const tz = Math.floor(pos.z + dz * 5)

  // Final safety net: if for any reason we still have NaN, pick a random walkable spot
  if (!isFiniteNum(tx) || !isFiniteNum(ty) || !isFiniteNum(tz)) {
    log.error('evade_target_invalid_after_safety', { tx, ty, tz, hazard: hazard?.name })
    return
  }

  log.info('evade_start', {
    hazard: hazard?.name || null,
    from: safeFloor(pos),
    to: { x: tx, y: ty, z: tz },
  })
  safeChat(`Ow — ${label}!`)

  movement.forceStop('evade_start')
  bot.clearControlStates()
  await new Promise(r => setTimeout(r, 100))
  await navNear(tx, ty, tz, 2, movement.PRIORITY.HIGH)
  log.info('evade_complete', { newPos: safeFloor(bot.entity?.position) })
}

// Run away from any nearby threats
async function taskFlee() {
  let pos
  try { pos = await awaitValidPosition(2000) }
  catch (e) { log.warn('flee_skip_invalid_position', { reason: e.message }); return }

  const threats = Object.values(bot.entities)
    .filter(e => e.name && HOSTILE_MOB_NAMES.has(e.name) && isValidVec(e.position) && e.position.distanceTo(pos) < 24)

  if (threats.length === 0) {
    safeChat('Nothing to run from.')
    log.info('flee_no_threats')
    return
  }

  // Direction directly away from the centroid of threats — guarded against NaN.
  let avgX = 0, avgZ = 0
  for (const t of threats) { avgX += t.position.x; avgZ += t.position.z }
  avgX /= threats.length; avgZ /= threats.length
  const { dx, dz, fallback } = safeNormalize2D(pos.x - avgX, pos.z - avgZ)
  if (fallback) log.debug('flee_normalize_fallback', { reason: fallback })

  const fleeX = Math.floor(pos.x + dx * 30)
  const fleeY = Math.floor(pos.y)
  const fleeZ = Math.floor(pos.z + dz * 30)
  if (!isFiniteNum(fleeX) || !isFiniteNum(fleeY) || !isFiniteNum(fleeZ)) {
    log.error('flee_target_invalid', { fleeX, fleeY, fleeZ })
    return
  }

  log.info('flee_start', { threats: threats.map(t => t.name), to: { x: fleeX, y: fleeY, z: fleeZ } })
  safeChat('Falling back!')
  try {
    await navNear(fleeX, fleeY, fleeZ, 5)
    log.info('flee_complete', { newPos: safeFloor(bot.entity?.position) })
  } catch (e) {
    log.warn('flee_path_failed', { message: e.message })
  }
}

// ── Smart agentic house building ──────────────────────────────────────────────
// Auto-chains: gather wood → craft planks → place blocks

async function taskBuildHouseSmart() {
  safeChat('Starting house. Will gather and craft if needed.')

  let plankCount = countInInv(PLANK_NAMES)

  // Step 1: convert any logs to planks
  if (countInInv(LOG_NAMES) > 0) {
    await taskCraftPlanks()
    plankCount = countInInv(PLANK_NAMES)
  }

  // Step 2: while not enough, gather more wood and craft
  let attempts = 0
  while (plankCount < 30 && attempts < 12) {
    attempts++
    const stillNeed = 30 - plankCount
    const logsNeeded = Math.ceil(stillNeed / 4)

    safeChat(`Have ${plankCount} planks, need ${30 - plankCount} more. Gathering wood (try ${attempts}/12).`)

    let chopped = 0
    while (chopped < logsNeeded) {
      const ids = logIds()
      const log = bot.findBlock({ matching: ids, maxDistance: 60 })
      if (!log) { safeChat('No more trees in range. Stopping.'); return }
      try {
        await navNear(log.position.x, log.position.y, log.position.z, 2)
        const fresh = bot.blockAt(log.position)
        if (fresh && ids.includes(fresh.type)) {
          await safeDig(bot, fresh)
          chopped++
        } else { break }
      } catch (e) {
        console.error(`[${BOT_NAME}] gather error:`, e.message)
        break
      }
    }

    await taskCraftPlanks()
    plankCount = countInInv(PLANK_NAMES)
  }

  if (plankCount < 30) {
    safeChat(`Couldn't gather enough planks (${plankCount}). Aborting.`)
    return
  }

  safeChat(`Have ${plankCount} planks. Building now.`)
  await buildHouseStructure()
}

async function placeBlockAt(targetPos, blockName) {
  const current = bot.blockAt(targetPos)
  if (current && current.name !== 'air' && current.name !== 'cave_air') return true

  const itemId = bot.registry.itemsByName[blockName]?.id
  const item   = itemId ? bot.inventory.findInventoryItem(itemId, null, false) : null
  if (!item) return false

  await safeEquip(bot, item, 'hand')

  const adj = [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
  for (const [dx, dy, dz] of adj) {
    const refBlock = bot.blockAt(targetPos.offset(dx, dy, dz))
    if (!refBlock || refBlock.boundingBox !== 'block') continue
    try {
      await navNear(targetPos.x, targetPos.y, targetPos.z, 4)
      const faceVec = targetPos.minus(refBlock.position)
      await safePlaceBlock(bot, refBlock, faceVec)
      return true
    } catch {}
  }
  return false
}

async function buildHouseStructure() {
  const planks = bot.inventory.items().filter(i => PLANK_NAMES.includes(i.name))
  if (!planks.length) { safeChat('No planks to build with.'); return }
  const plankName = planks[0].name

  const origin = bot.entity.position.floored().offset(0, 0, -5)
  console.log(`[${BOT_NAME}] Building house at ${origin}`)

  let outOfBlocks = false

  // Walls: 5x5 perimeter, 3 high, door gap at (0, 1-2, -2)
  for (let y = 1; y <= 3 && !outOfBlocks; y++) {
    for (let x = -2; x <= 2 && !outOfBlocks; x++) {
      for (let z = -2; z <= 2 && !outOfBlocks; z++) {
        if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue
        if (z === -2 && x === 0 && y <= 2) continue  // door

        const ok = await placeBlockAt(origin.offset(x, y, z), plankName)
        if (!ok && countInInv([plankName]) === 0) { safeChat('Out of planks.'); outOfBlocks = true }
      }
    }
  }

  // Roof
  for (let x = -2; x <= 2 && !outOfBlocks; x++) {
    for (let z = -2; z <= 2 && !outOfBlocks; z++) {
      const ok = await placeBlockAt(origin.offset(x, 4, z), plankName)
      if (!ok && countInInv([plankName]) === 0) { safeChat('Out of planks on roof.'); outOfBlocks = true }
    }
  }

  if (!outOfBlocks) {
    safeChat('House done!')
    rememberLocation(memory, 'house', origin)
    rememberEvent(memory, 'built_house', {})
  }
}

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
    runTask('escaping', taskEscape)
    return
  }

  const gs     = buildGroundedState(bot, state, memory, anger, envPerception)
  const choice = selectAutonomousGoal(gs)

  if (choice) {
    log.debug('autonomous_choice', { action: choice.action, target: choice.target })
    // Narrate only 1-in-4 times to avoid chat spam — actions speak louder than words
    if (Math.random() < 0.25) safeChat(choice.say)
    if      (choice.action === 'explore')       runTask('exploring',  taskExplore,     { silent: true })
    else if (choice.action === 'gather_wood')   runTask('gathering',  taskGatherWood,  { silent: true })
    else if (choice.action === 'craft_planks')  runTask('crafting',   taskCraftPlanks, { silent: true })
    else if (choice.action === 'craft')         runTask('crafting',   () => taskCraftItem(choice.target || 'crafting_table'), { silent: true })
    else if (choice.action === 'attack_mobs')   runTask('attacking',  taskAttackMobs)
    else if (choice.action === 'collect_items') runTask('collecting', taskCollectNearby, { silent: true })
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

// Blind survival: sprint away in a random direction using raw control states.
// Used when position is invalid (NaN) — does NOT use the pathfinder.
// This breaks the "validator dead-end" failure where the bot stands still dying
// because all damage events are dropped due to stale position cache (diagnosis F18).
async function taskBlindSurvival() {
  const scan  = lastEnvScan || (envPerception ? envPerception.scan() : null)
  const stuck = scan?.stuckClass || 'unknown'
  log.warn('blind_survival_start', { livenessState: liveness.getState(), stuckClass: stuck, risk: scan?.locomotionRisk ?? null })
  safeChat('Taking hits. Moving.')

  if (locomotionRecovery && scan?.valid !== false) {
    // Use perception-aware escape rather than random yaw
    await locomotionRecovery.runHazardEscape(stuck, scan, 'blind_survival')
  } else {
    // Fallback: random direction sprint
    const angle = Math.random() * Math.PI * 2
    try { bot.entity.yaw = angle } catch {}
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    bot.setControlState('jump', true)
    await new Promise(r => setTimeout(r, 400))
    bot.setControlState('jump', false)
    await new Promise(r => setTimeout(r, 1600))
    bot.clearControlStates()
  }

  log.info('blind_survival_complete', { livenessState: liveness.getState() })
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
      runTask('attacking', () => taskAttackMobs())
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
    () => lastReactionAt
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
    if (bot.food <= 14 && !taskBusy && FOOD_PRIORITY.some(f => bot.inventory.items().some(i => i.name === f))) {
      runTask('eating', taskEatFood, { silent: true })
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
        // Damage pipeline (NEW)
        damageState,                                          // safe | hurt | reacting
        recentDamageHits: damageWindow.length,                // events in current 1.5s window
        msSinceLastReaction: Date.now() - lastReactionAt,
        knownHazardZones: hazardZones.length,
        // Recovery
        recoveryAttempts,
        // Anti-spam
        cooldowns: {
          hitChat: Math.max(0, HIT_CHAT_COOLDOWN_MS - (Date.now() - lastHitChatAt)),
          counterPunch: Math.max(0, COUNTER_PUNCH_COOLDOWN_MS - (Date.now() - lastCounterPunchAt)),
          reaction: Math.max(0, REACTION_COOLDOWN_MS - (Date.now() - lastReactionAt)),
        },
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

    case 'explore':       runTask('exploring', taskExplore); break
    case 'craft_planks':  runTask('crafting',  taskCraftPlanks); break

    case 'gather_wood': {
      const hasLogs = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
      if (!hasLogs) { result.say = 'No trees in range.'; return }
      runTask('gathering', taskGatherWood)
      break
    }

    case 'go_to':
      if (result.target) runTask('going_to', () => taskGoTo(result.target))
      break

    case 'remember_here':
      rememberLocation(memory, `${username}_mark`, bot.entity.position)
      break

    case 'attack_mobs':
      if (!groundedState.hostileMobs.length) { result.say = 'No hostile mobs visible.'; return }
      runTask('attacking', taskAttackMobs)
      break

    case 'attack_player': {
      const tgt = result.target
      const player = tgt ? bot.players[tgt] : null
      if (!player?.entity) { result.say = `Can't see ${tgt || 'them'}.`; return }
      runTask('attacking', () => taskAttackPlayer(player.entity, tgt))
      break
    }

    case 'collect_items':
      if (groundedState.droppedCount === 0) { result.say = 'No items on the ground.'; return }
      runTask('collecting', taskCollectNearby)
      break

    case 'craft': {
      const itemName = result.target || 'crafting_table'
      runTask('crafting', () => taskCraftItem(itemName))
      break
    }

    case 'place_block': {
      const blockName = result.target || 'crafting_table'
      runTask('placing', () => taskPlaceBlock(blockName))
      break
    }

    case 'mine_block': {
      const blockName = result.target || 'stone'
      const m = blockName.match(/^(.+?)\s*x?\s*(\d+)$/)
      const name = m ? m[1] : blockName
      const count = m ? parseInt(m[2]) : 1
      runTask('mining', () => taskMineBlock(name, Math.min(count, 16)))
      break
    }

    case 'eat_food':
      runTask('eating', taskEatFood)
      break

    case 'flee':
      runTask('fleeing', taskFlee)
      break

    case 'escape':
      runTask('escaping', taskEscape)
      break

    case 'build_house_smart':
      runTask('building', taskBuildHouseSmart)
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
  else if (cmd === 'explore')                        { if (!runTask('exploring', taskExplore)) safeChat("Busy.") }
  else if (cmd === 'get wood' || cmd === 'chop tree'){ if (!runTask('gathering', taskGatherWood)) safeChat("Busy.") }
  else if (cmd === 'make planks')                    { if (!runTask('crafting', taskCraftPlanks)) safeChat("Busy.") }
  else if (cmd === 'attack' || cmd === 'fight')      { if (!runTask('attacking', taskAttackMobs)) safeChat("Busy.") }
  else if (cmd === 'collect' || cmd === 'pick up')   { if (!runTask('collecting', taskCollectNearby)) safeChat("Busy.") }
  else if (cmd === 'build house')                    { if (!runTask('building', taskBuildHouseSmart)) safeChat("Busy.") }
  else if (cmd === 'inventory')                      { const it = bot.inventory.items(); safeChat(it.length ? it.map(i=>`${i.name}x${i.count}`).join(', ') : 'Empty.') }
  else if (cmd === 'look around')                    { const gs = buildGroundedState(bot, state, memory, anger, envPerception); safeChat(`I see: ${chatSummary(gs) || 'nothing'}`) }
  else {
    const m = cmd.match(/^craft (.+)$/);    if (m) { if (!runTask('crafting', () => taskCraftItem(m[1]))) safeChat("Busy."); return }
    const p = cmd.match(/^place (.+)$/);    if (p) { if (!runTask('placing', () => taskPlaceBlock(p[1].trim()))) safeChat("Busy."); return }
    const mn = cmd.match(/^mine (.+)$/);    if (mn) {
      const parts = mn[1].trim().match(/^(.+?)\s+(\d+)$/)
      const name = parts ? parts[1] : mn[1].trim()
      const cnt = parts ? Math.min(parseInt(parts[2]), 16) : 1
      if (!runTask('mining', () => taskMineBlock(name, cnt))) safeChat("Busy."); return
    }
    if (cmd === 'eat')                      { if (!runTask('eating', taskEatFood)) safeChat("Busy."); return }
    if (cmd === 'flee' || cmd === 'run')    { if (!runTask('fleeing', taskFlee)) safeChat("Busy."); return }
    if (cmd === 'escape' || cmd === 'climb out' || cmd === 'get out') { if (!runTask('escaping', taskEscape)) safeChat("Busy."); return }
    const w = cmd.match(/^where is (.+)$/); if (w) { const loc = recallLocation(memory, w[1].trim()); safeChat(loc ? `${w[1]}: ${loc.pos.x}, ${loc.pos.y}, ${loc.pos.z}` : `Don't know.`); return }
    const g = cmd.match(/^go to (.+)$/);    if (g) { if (!runTask('going_to', () => taskGoTo(g[1].trim()))) safeChat("Busy."); else safeChat(`Going to ${g[1]}.`) }
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
