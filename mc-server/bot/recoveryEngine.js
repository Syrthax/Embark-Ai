// recoveryEngine.js — The single recovery arbiter.
//
// Recovery used to be multi-headed (diagnosis#2 §2.1): freeze-forensics,
// fatalDesyncRecovery, the health-integrity watchdog, the task watchdog, the
// movement-timeout streak, and the activity watchdog all independently detected
// overlapping symptoms AND independently acted — and they raced (the log shows two
// of them firing on the same incident seconds apart). Now there is one arbiter:
// watchdogs DETECT and call report(symptom, context); this module DECIDES and ACTS.
// Nothing else in the codebase calls bot.quit() — reconnection is owned here.
//
// SYMPTOMS (what watchdogs observe) → CLASSES (escalation ladders):
//   DESYNC                  → DESYNC       position structurally invalid; reconnect only
//   STUCK                   → STUCK        physically wedged; jiggle / blind-survival / escape
//   MOVEMENT_TIMEOUT_STREAK → MOVEMENT     pathfinder timeout streak
//   TASK_HUNG               → TASK         task watchdog tripped
//   ENTITY_ORPHAN           → ENTITY       orphaned task state
//   COMBAT_STALL            → COMBAT       combat-specific recovery
//   CRITICAL_HP             → CRITICAL_HP  HP draining, damage pipeline blind, position VALID
//   IDLE                    → IDLE         activity watchdog
//
// PRIORITY (highest first): DESYNC > STUCK > MOVEMENT_TIMEOUT_STREAK > TASK_HUNG >
//   ENTITY_ORPHAN > COMBAT_STALL > CRITICAL_HP > IDLE. If a higher-priority class is
//   mid-recovery (acted within its own cooldown), lower-priority reports are
//   suppressed so the watchdogs can't pile on during an in-flight recovery.
//
// STUCK vs DESYNC (diagnosis#2 §1.3): being physically wedged in terrain and being
// server-state desynced are different failure modes with different remedies.
// STUCK  — live position is valid but not progressing: jiggle / blind-survival / escape.
// DESYNC — live position is structurally invalid (NaN/null component): NO local maneuver
//          can help; the only action at any level is to reconnect.
//
// Per-class failure counts decay after DECAY_MS of silence so transient issues don't
// permanently poison the escalation level.

const CLASSES = Object.freeze({
  TASK:        'TASK',
  STUCK:       'STUCK',
  DESYNC:      'DESYNC',
  MOVEMENT:    'MOVEMENT',
  CRITICAL_HP: 'CRITICAL_HP',
  IDLE:        'IDLE',
  ENTITY:      'ENTITY',
  COMBAT:      'COMBAT',
})

const SYMPTOMS = Object.freeze({
  DESYNC:                  'DESYNC',
  STUCK:                   'STUCK',
  MOVEMENT_TIMEOUT_STREAK: 'MOVEMENT_TIMEOUT_STREAK',
  TASK_HUNG:               'TASK_HUNG',
  ENTITY_ORPHAN:           'ENTITY_ORPHAN',
  COMBAT_STALL:            'COMBAT_STALL',
  CRITICAL_HP:             'CRITICAL_HP',
  IDLE:                    'IDLE',
})

const SYMPTOM_TO_CLASS = {
  DESYNC:                  CLASSES.DESYNC,
  STUCK:                   CLASSES.STUCK,
  MOVEMENT_TIMEOUT_STREAK: CLASSES.MOVEMENT,
  TASK_HUNG:               CLASSES.TASK,
  ENTITY_ORPHAN:           CLASSES.ENTITY,
  COMBAT_STALL:            CLASSES.COMBAT,
  CRITICAL_HP:             CLASSES.CRITICAL_HP,
  IDLE:                    CLASSES.IDLE,
}

// Highest priority first.
const PRIORITY = [
  'DESYNC',
  'STUCK',
  'MOVEMENT_TIMEOUT_STREAK',
  'TASK_HUNG',
  'ENTITY_ORPHAN',
  'COMBAT_STALL',
  'CRITICAL_HP',
  'IDLE',
]

const COOLDOWN_MS = {
  TASK:        8_000,
  STUCK:       5_000,
  DESYNC:      3_000,
  MOVEMENT:    10_000,
  CRITICAL_HP: 8_000,   // matches healthIntegrityWatchdog's TRIGGER_COOLDOWN_MS
  IDLE:        120_000,
  ENTITY:      10_000,
  COMBAT:      5_000,
}

const DECAY_MS = {
  TASK:        120_000,
  STUCK:        60_000,
  DESYNC:       60_000,
  MOVEMENT:    120_000,
  CRITICAL_HP:  60_000,
  IDLE:        600_000,
  ENTITY:       60_000,
  COMBAT:       30_000,
}

const MAX_LEVEL = {
  TASK: 4, STUCK: 3, DESYNC: 1, MOVEMENT: 3, CRITICAL_HP: 2, IDLE: 2, ENTITY: 2, COMBAT: 2,
}

module.exports = function createRecoveryEngine(deps) {
  const { bot, movement, state, log } = deps
  const { getTaskContext, cancelTask, replaceTask, runTask } = deps
  const { taskBlindSurvival, taskEscape, taskExplore } = deps
  const { writeExitReason } = deps

  // Per-class state: failures, current escalation level, last attempt timestamp
  const cs = {}
  for (const cls of Object.values(CLASSES)) {
    cs[cls] = { failures: 0, level: 0, lastAttemptAt: 0 }
  }

  // Once we've committed to a reconnect the client is going away — ignore all
  // further reports so nothing tries to act on a disconnecting bot.
  let quitPending = false

  // ── Public entrypoint ───────────────────────────────────────────────────────
  // Watchdogs call this and nothing else.
  function report(symptom, context = {}) {
    if (quitPending) return

    const cls = SYMPTOM_TO_CLASS[symptom]
    if (!cls) {
      log.warn('recovery_unknown_symptom', { symptom, ...context })
      return
    }

    // Cross-class priority suppression: if a higher-priority class acted within its
    // own cooldown, it owns the situation right now — drop this lower-priority report.
    const now = Date.now()
    const myIdx = PRIORITY.indexOf(symptom)
    for (let i = 0; i < myIdx; i++) {
      const higherCls = SYMPTOM_TO_CLASS[PRIORITY[i]]
      const hs = cs[higherCls]
      if (hs.failures > 0 && (now - hs.lastAttemptAt) < COOLDOWN_MS[higherCls]) {
        log.debug('recovery_suppressed', { symptom, class: cls, suppressedBy: higherCls, ...context })
        return
      }
    }

    _recover(cls, { symptom, ...context })
  }

  // ── Internal escalation ladder ──────────────────────────────────────────────
  // Same-symptom dedup falls out of the per-class cooldown below.
  function _recover(cls, context = {}) {
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
      ...(context.symptom  && { symptom: context.symptom }),
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
    if (!s) return
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
          _quitSafely(cls, level, context)
        }
        break

      case CLASSES.STUCK:
        if (level === 1) {
          cancelTask()
        } else if (level === 2) {
          cancelTask()
          replaceTask('blind_survival', taskBlindSurvival, { silent: true })
        } else {
          _quitSafely(cls, level, context)
        }
        break

      case CLASSES.DESYNC:
        // Position is structurally invalid — no control-state maneuver can fix it.
        // Reconnect immediately, at any level.
        _quitSafely(cls, level, context)
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
          _quitSafely(cls, level, context)
        }
        break

      case CLASSES.CRITICAL_HP:
        // HP draining and the normal damage pipeline can't react (NaN window) BUT the
        // position is valid — so raw-control-state survival can still help. Sprint away
        // at L1; escalate to a full escape task at L2.
        if (level === 1) {
          replaceTask('blind_survival', taskBlindSurvival, { silent: true })
        } else {
          cancelTask()
          movement.forceStop('recovery_critical_hp')
          setTimeout(() => {
            if (!getTaskContext().taskBusy && state.goal === 'idle') {
              runTask('escaping', taskEscape)
            }
          }, 300)
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

  // The single owner of bot.quit(). Writes the exit reason up front (so botSupervisor
  // applies the right backoff even if bot.on('end') doesn't run cleanly), announces
  // in-game, then quits after a short defer.
  function _quitSafely(cls, level, context) {
    if (quitPending) return
    quitPending = true
    const isDesync = cls === CLASSES.DESYNC
    log.error('recovery_reconnect', { class: cls, level, ...context })
    try { if (writeExitReason) writeExitReason(isDesync ? 'entity_desync' : 'stuck_reconnect') } catch {}
    try { bot.chat(isDesync ? 'Entity desync — reconnecting.' : 'Stuck — reconnecting.') } catch {}
    setTimeout(() => {
      try { bot.quit() } catch { process.exit(0) }
    }, 500)
  }

  function getState() {
    return Object.fromEntries(
      Object.entries(cs).map(([cls, s]) => [cls, { ...s }])
    )
  }

  return { CLASSES, SYMPTOMS, report, reset, getState }
}
