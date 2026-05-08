// fatalDesyncRecovery.js — Force clean disconnect when entity desync is fatal.
//
// If bot.entity.position remains NaN for > FATAL_QUIT_THRESHOLD_MS, the Mineflayer
// client is in an unrecoverable state (velocity/position packet corruption — see
// diagnosis §5 "Why position becomes NaN"). The correct response is to disconnect
// and reconnect, not to wait passively until the bot dies.
//
// bot.quit() triggers bot.on('end') in bot.js → process.exit(0).
// cli.js / tui.js detect the clean exit (code 0) and auto-respawn the bot.

const FATAL_QUIT_THRESHOLD_MS = 30000  // 30s at LIVE_FATAL before quitting
const CHECK_INTERVAL_MS       = 2000

module.exports = function createFatalDesyncRecovery(bot, liveness, log) {
  let fatalSince  = null  // ms when state first became LIVE_FATAL
  let quitPending = false

  const interval = setInterval(() => {
    if (quitPending) return

    const state = liveness.getState()
    const STATES = liveness.STATES

    if (state !== STATES.LIVE_FATAL) {
      fatalSince = null
      return
    }

    const now = Date.now()
    if (!fatalSince) { fatalSince = now; return }

    const fatalMs = now - fatalSince
    if (fatalMs < FATAL_QUIT_THRESHOLD_MS) return

    // LIVE_FATAL has persisted long enough — this is client corruption, not a glitch.
    quitPending = true
    clearInterval(interval)
    log.fatal('fatal_desync_quit', {
      fatalMs,
      invalidMs: liveness.getInvalidMs(),
      cachedPos: liveness.getCachedPos(),
    })
    try {
      bot.chat('Entity desync — reconnecting.')
    } catch {}
    setTimeout(() => {
      try { bot.quit() } catch (e) {
        log.error('fatal_desync_quit_error', { message: e.message })
        process.exit(0)
      }
    }, 300)
  }, CHECK_INTERVAL_MS)

  return { interval }
}
