// positionGuard.js — Repair bot.entity.position in place when a hit corrupts it to NaN.
//
// A single knockback can make prismarine-physics integrate a bad velocity into a
// NaN/null position (a long-standing Mineflayer quirk). The server's view of the bot
// is fine, but the *client* is then stuck with a corrupt position for several seconds:
// the bot can't pathfind or react, so it stands still until either a server position
// packet arrives or fatalDesyncRecovery reconnects (~6s of "freeze when you hit her").
//
// This guard runs every physics tick (~50ms): if the live position has any non-finite
// component, it overwrites it with the last cached valid position (from entityLiveness)
// and zeroes any non-finite velocity component. Physics then continues from there with
// finite values; the next server position packet corrects any small drift. Net effect:
// the ~6s freeze becomes a ~50ms invisible blip.
//
// Because the restore makes entityLiveness see a valid position again, isDesynced()
// never fires and fatalDesyncRecovery never reconnects in the common case. As a backstop
// for the rare scenario where the corruption keeps reappearing despite restores, after
// RECONNECT_AFTER_TICKS of continuous restoring we ask the recovery arbiter to reconnect.

const RECONNECT_AFTER_TICKS = 100  // ~5s of nonstop restoring ⇒ something deeper is wrong

function finite(n) { return typeof n === 'number' && Number.isFinite(n) }

module.exports = function createPositionGuard(bot, liveness, log, recoveryEngine) {
  let restoreCount       = 0
  let consecutiveBad     = 0
  let reconnectRequested = false

  bot.on('physicsTick', () => {
    const e = bot.entity
    if (!e) return
    const p = e.position
    const v = e.velocity

    const pBad = !p || !finite(p.x) || !finite(p.y) || !finite(p.z)
    const vBad = !!v && (!finite(v.x) || !finite(v.y) || !finite(v.z))

    if (!pBad && !vBad) {
      consecutiveBad     = 0
      reconnectRequested = false
      return
    }

    consecutiveBad++

    if (pBad) {
      const cached = liveness.getCachedPos()
      if (!cached) return  // nothing valid recorded yet (pre-spawn) — leave it; desync path will handle
      if (!finite(p.x)) p.x = cached.x
      if (!finite(p.y)) p.y = cached.y
      if (!finite(p.z)) p.z = cached.z
    }
    if (vBad && v) {
      if (!finite(v.x)) v.x = 0
      if (!finite(v.y)) v.y = 0
      if (!finite(v.z)) v.z = 0
    }

    restoreCount++
    if (restoreCount === 1 || restoreCount % 20 === 0) {
      log.warn('position_guard_restored', {
        restoreCount, consecutiveBad, pBad, vBad,
        restoredTo: pBad ? liveness.getCachedPos() : null,
      })
    }

    if (consecutiveBad > RECONNECT_AFTER_TICKS && !reconnectRequested) {
      reconnectRequested = true
      log.error('position_guard_giving_up', { consecutiveBad, restoreCount })
      try { recoveryEngine?.report('DESYNC', { source: 'position_guard_unrecoverable', consecutiveBad }) } catch {}
    }
  })

  return { getRestoreCount: () => restoreCount }
}
