// recoveryEngine.js — Unified escalating recovery dispatcher.
//
// All recovery-triggering sites call recover(class, context) instead of calling
// cancelCurrentTask / replaceTask directly. The engine tracks per-class failure
// counts, applies cooldowns to avoid recovery storms, and escalates responses
// when the same class fails repeatedly.
//
// Escalation ladder:
//   L1 — gentle reset (cancel task, stop movement)
//   L2 — harder reset (cancel + blind survival / force-stop + escape)
//   L3 — reconnect (bot.quit() → cli.js auto-respawn)
//
// Failures decay after DECAY_MS of silence so transient issues don't permanently
// poison the escalation level.

const CLASSES = Object.freeze({
  TASK:     'TASK',      // task watchdog / stuck detection
  POSITION: 'POSITION',  // position invalid extended
  MOVEMENT: 'MOVEMENT',  // timeout streak / stuck navigation
  IDLE:     'IDLE',      // activity watchdog
  ENTITY:   'ENTITY',    // orphaned task state
  COMBAT:   'COMBAT',    // combat-specific recovery
})

const COOLDOWN_MS = {
  TASK:     8_000,
  POSITION: 5_000,
  MOVEMENT: 10_000,
  IDLE:     120_000,
  ENTITY:   10_000,
  COMBAT:   5_000,
}

const DECAY_MS = {
  TASK:     120_000,
  POSITION:  60_000,
  MOVEMENT: 120_000,
  IDLE:     600_000,
  ENTITY:    60_000,
  COMBAT:    30_000,
}

const MAX_LEVEL = {
  TASK: 4, POSITION: 3, MOVEMENT: 3, IDLE: 2, ENTITY: 2, COMBAT: 2,
}

module.exports = function createRecoveryEngine(deps) {
  const { bot, movement, state, log } = deps
  const { getTaskContext, cancelTask, replaceTask, runTask } = deps
  const { taskBlindSurvival, taskEscape, taskExplore } = deps

  // Per-class state: failures, current escalation level, last attempt timestamp
  const cs = {}
  for (const cls of Object.values(CLASSES)) {
    cs[cls] = { failures: 0, level: 0, lastAttemptAt: 0 }
  }

  function recover(cls, context = {}) {
    const s = cs[cls]
    const now = Date.now()
    const elapsed = now - s.lastAttemptAt

    if (elapsed < COOLDOWN_MS[cls]) {
      log.debug('recovery_cooldown', { class: cls, remainingMs: COOLDOWN_MS[cls] - elapsed, ...context })
      return
    }

    // Decay: long silence between failures resets escalation
    if (s.failures > 0 && elapsed > DECAY_MS[cls]) {
      log.debug('recovery_decay_reset', { class: cls, hadLevel: s.level, hadFailures: s.failures })
      s.failures = 0
      s.level = 0
    }

    s.failures++
    s.lastAttemptAt = now

    const prevLevel = s.level
    s.level = Math.min(s.failures, MAX_LEVEL[cls])

    log.warn('recovery_attempt', {
      class: cls,
      level: s.level,
      failures: s.failures,
      ...(context.source   && { source: context.source }),
      ...(context.goalName && { goalName: context.goalName }),
      ...(context.reason   && { reason: context.reason }),
    })

    if (s.level > prevLevel && prevLevel > 0) {
      log.warn('recovery_escalated', { class: cls, from: prevLevel, to: s.level, ...context })
    }

    _execute(cls, s.level, context)
  }

  function reset(cls) {
    const s = cs[cls]
    if (s.failures > 0) {
      log.debug('recovery_class_reset', { class: cls, failures: s.failures, level: s.level })
    }
    s.failures = 0
    s.level = 0
  }

  function _execute(cls, level, context) {
    switch (cls) {
      case CLASSES.TASK:
        if (level <= 2) {
          cancelTask()
        } else if (level === 3) {
          cancelTask()
          movement.forceStop('recovery')
          setTimeout(() => {
            if (!getTaskContext().taskBusy && state.goal === 'idle') {
              runTask('escaping', taskEscape)
            }
          }, 300)
        } else {
          _reconnect(cls, level)
        }
        break

      case CLASSES.POSITION:
        if (level === 1) {
          cancelTask()
        } else if (level === 2) {
          cancelTask()
          replaceTask('blind_survival', taskBlindSurvival, { silent: true })
        } else {
          _reconnect(cls, level)
        }
        break

      case CLASSES.MOVEMENT:
        if (level === 1) {
          movement.forceStop('recovery_movement')
          setTimeout(() => {
            if (!getTaskContext().taskBusy && state.goal === 'idle') {
              runTask('escaping', taskEscape)
            }
          }, 300)
        } else if (level === 2) {
          cancelTask()
          movement.forceStop('recovery_movement')
          setTimeout(() => {
            if (!getTaskContext().taskBusy && state.goal === 'idle') {
              runTask('escaping', taskEscape)
            }
          }, 300)
        } else {
          _reconnect(cls, level)
        }
        break

      case CLASSES.IDLE:
        if (level === 1) {
          state.idleTicks = 999  // trigger autonomous decision on next state tick
        } else {
          if (!getTaskContext().taskBusy) runTask('exploring', taskExplore)
        }
        break

      case CLASSES.ENTITY:
        cancelTask()
        if (level > 1) movement.forceStop('recovery_entity')
        break

      case CLASSES.COMBAT:
        cancelTask()
        break
    }
  }

  function _reconnect(cls, level) {
    log.error('recovery_reconnect', { class: cls, level })
    try { bot.chat('Stuck — reconnecting.') } catch {}
    setTimeout(() => {
      try { bot.quit() } catch { process.exit(0) }
    }, 500)
  }

  function getState() {
    return Object.fromEntries(
      Object.entries(cs).map(([cls, s]) => [cls, { ...s }])
    )
  }

  return { CLASSES, recover, reset, getState }
}
