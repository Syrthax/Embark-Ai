// locomotionRecovery.js — Terrain-aware physical escape maneuvers.
//
// When the bot is stuck (lava proximity, collision deadlock, terrain deadlock),
// these functions attempt active micro-escapes using direct control-state bursts.
// They do NOT use the pathfinder — they operate below the pathfinder layer.
//
// Each function returns a Promise that resolves when the maneuver completes.
// They are intentionally short-lived (300–700ms each) so they can be composed
// into escalating escape sequences without long-blocking the event loop.
//
// Typical call order: jump → strafe-L → strafe-R → reverse → perturb → climb

'use strict'

const BURST_MS = 500   // default control-state burst duration

module.exports = function createLocomotionRecovery(bot, log) {

  async function _burst(controls, ms = BURST_MS) {
    for (const [k, v] of Object.entries(controls)) {
      try { bot.setControlState(k, v) } catch {}
    }
    await new Promise(r => setTimeout(r, ms))
    try { bot.clearControlStates() } catch {}
  }

  // Orient the bot toward a heading (radians) before a burst.
  function _orient(yaw) {
    try { bot.entity.yaw = yaw } catch {}
  }

  // ── Individual maneuvers ───────────────────────────────────────────────────

  async function tryJumpEscape(label = 'unstuck') {
    log.info('escape_attempt', { method: 'jump', label })
    await _burst({ jump: true, forward: true, sprint: true }, 450)
    log.info('locomotion_escape', { method: 'jump', label })
  }

  async function tryStrafeEscape(direction = 'left', label = 'unstuck') {
    log.info('escape_attempt', { method: `strafe_${direction}`, label })
    const ctrl = direction === 'left' ? { left: true } : { right: true }
    await _burst({ ...ctrl, jump: true }, 500)
    log.info('locomotion_escape', { method: `strafe_${direction}`, label })
  }

  async function tryReverseEscape(label = 'unstuck') {
    log.info('escape_attempt', { method: 'reverse', label })
    await _burst({ back: true, jump: true }, 500)
    log.info('locomotion_escape', { method: 'reverse', label })
  }

  async function tryPerturbEscape(label = 'unstuck') {
    log.info('escape_attempt', { method: 'perturb', label })
    _orient(Math.random() * Math.PI * 2)
    await _burst({ forward: true, sprint: true, jump: true }, 600)
    log.info('locomotion_escape', { method: 'perturb', label })
  }

  async function tryClimbEscape(label = 'unstuck') {
    log.info('escape_attempt', { method: 'climb', label })
    for (let i = 0; i < 4; i++) {
      await _burst({ forward: true, jump: true, sprint: true }, 320)
      await new Promise(r => setTimeout(r, 80))
    }
    log.info('locomotion_escape', { method: 'climb', label })
  }

  // Escape away from a specific block position (lava / hazard source).
  async function tryDirectedEscape(awayFromX, awayFromZ, label = 'directed') {
    if (!bot.entity?.position) return tryPerturbEscape(label)
    const pos = bot.entity.position
    const dx = pos.x - awayFromX
    const dz = pos.z - awayFromZ
    const len = Math.sqrt(dx*dx + dz*dz)
    if (len < 0.01) return tryPerturbEscape(label)

    const yaw = Math.atan2(-(dx/len), -(dz/len))
    log.info('escape_attempt', { method: 'directed', label })
    _orient(yaw)
    await _burst({ forward: true, sprint: true, jump: true }, 600)
    log.info('locomotion_escape', { method: 'directed', label })
  }

  // ── Escalating full escape sequence ────────────────────────────────────────
  // Uses perception escape vector to orient first if available.
  // Returns after all maneuvers complete; caller decides whether to re-scan.

  async function runEscapeSequence(label = 'sequence', perception = null) {
    log.info('escape_attempt', { method: 'sequence_start', label })

    // Treat an invalid scan (NaN position window) the same as no scan — don't derive
    // a yaw from the default-North junk vector.
    const safePerception = perception?.valid !== false ? perception : null

    // Use perception escape vector to face safest direction first
    if (safePerception?.escapeVector) {
      const ev = safePerception.escapeVector
      if (ev.dx !== 0 || ev.dz !== 0) {
        const yaw = Math.atan2(-ev.dx, -ev.dz)
        _orient(yaw)
        log.debug('escape_oriented', { direction: ev.label, score: ev.score })
      }
    }

    // Escalating ladder: each step creates more displacement
    // (safePerception already consumed above for orientation)
    await tryJumpEscape(label)
    await new Promise(r => setTimeout(r, 150))
    await tryStrafeEscape('left', label)
    await new Promise(r => setTimeout(r, 150))
    await tryStrafeEscape('right', label)
    await new Promise(r => setTimeout(r, 150))
    await tryReverseEscape(label)
    await new Promise(r => setTimeout(r, 150))
    await tryPerturbEscape(label)

    log.info('escape_success', { method: 'sequence_complete', label })
  }

  // Hazard-class-specific escape selector — routes to the right maneuver
  // based on what stuck the bot.
  async function runHazardEscape(stuckClass, perception = null, label = 'hazard_escape') {
    log.info('escape_attempt', { method: 'hazard_specific', stuckClass, label })

    // Treat an invalid scan (NaN position window) the same as no scan — don't derive
    // a yaw from the default-North junk vector in the escape vector field.
    const safePerception = perception?.valid !== false ? perception : null

    switch (stuckClass) {
      case 'lava_immobilization':
      case 'lava_proximity': {
        // Lava: jump + sprint away from lava, use escape vector if known
        const ev = safePerception?.escapeVector
        if (ev) {
          await tryDirectedEscape(
            (bot.entity?.position?.x || 0) - ev.dx * 5,
            (bot.entity?.position?.z || 0) - ev.dz * 5,
            label
          )
        } else {
          await tryPerturbEscape(label)
        }
        // Follow with a climb attempt in case we're on lava's edge
        await tryClimbEscape(label)
        break
      }

      case 'collision_deadlock':
        // Trapped: try all 4 directions
        await runEscapeSequence(label, safePerception)
        break

      case 'terrain_deadlock':
        // High risk terrain: jump + perturb
        await tryJumpEscape(label)
        await new Promise(r => setTimeout(r, 200))
        await tryPerturbEscape(label)
        break

      case 'liquid_drag':
        // Water: jump repeatedly to surface
        await tryClimbEscape(label)
        break

      case 'suffocation_hazard':
        // Something above head: back up + jump
        await tryReverseEscape(label)
        await new Promise(r => setTimeout(r, 200))
        await tryJumpEscape(label)
        break

      default:
        await runEscapeSequence(label, safePerception)
    }

    log.info('escape_success', { method: 'hazard_escape_done', stuckClass, label })
  }

  return {
    tryJumpEscape,
    tryStrafeEscape,
    tryReverseEscape,
    tryPerturbEscape,
    tryClimbEscape,
    tryDirectedEscape,
    runEscapeSequence,
    runHazardEscape,
  }
}
