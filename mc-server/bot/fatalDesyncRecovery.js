// fatalDesyncRecovery.js — Detect entity position desync; report it to the arbiter.
//
// When bot.entity.position has a NaN/null component (Mineflayer entity desync — a
// velocity packet with a bad delta-time corrupts the position) for longer than
// DESYNC_HARD_MS (~5s), the client is in an unrecoverable state: no local maneuver
// (cancelTask, blind survival, escape) can fix it, because the bot genuinely isn't
// where it thinks it is (diagnosis#2 §1.3). The only correct response is to reconnect.
//
// This module DETECTS and REPORTS only. recoveryEngine is the single arbiter that
// owns the reconnect — see diagnosis#2 §2.1: recovery used to be multi-headed and the
// heads raced (this module's own bot.quit() fired ~4s before / after others' would
// have). Now the flow is: detect desync → recovery.report('DESYNC') → arbiter quits.
// botSupervisor.js still gets its short reconnect backoff because the arbiter writes
// exit_reason.json {reason:"entity_desync"} before quitting.

const CHECK_INTERVAL_MS = 1000

module.exports = function createFatalDesyncRecovery(bot, liveness, log, onDesync) {
  let reported = false

  const interval = setInterval(() => {
    if (reported) return
    if (!liveness.isDesynced()) return

    reported = true
    clearInterval(interval)
    log.fatal('fatal_desync_quit', {
      invalidMs:     liveness.getInvalidMs(),
      cachedPos:     liveness.getCachedPos(),
      livenessState: liveness.getState(),
    })
    try {
      onDesync({ source: 'fatal_desync', invalidMs: liveness.getInvalidMs() })
    } catch (e) {
      log.error('fatal_desync_report_error', { message: e.message })
      // Last-resort fallback: if the arbiter is unreachable, quit anyway.
      try { bot.quit() } catch { process.exit(0) }
    }
  }, CHECK_INTERVAL_MS)

  return { interval }
}
