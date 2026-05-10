// entityLiveness.js — Entity desync detection and degraded-position provider.
//
// Diagnosis §5 confirmed bot.entity.position x/z becomes NaN during Mineflayer
// entity desync (velocity update with bad delta-time), and that this NaN window
// can persist for 50+ seconds. A binary valid/invalid model is too coarse:
// a briefly-invalid position shouldn't drop damage events, but a 30s NaN window
// means the client is corrupted and the bot should quit and reconnect.
//
// Five liveness states (diagnosis §13B):
//   LIVE_VALID              — position is live and finite
//   LIVE_TRANSIENT_INVALID  — invalid for < 500ms (post-teleport glitch, safe to ignore)
//   LIVE_STALE_USING_CACHE  — invalid but cached pos is < CACHE_MAX_MS old (degraded ok)
//   LIVE_RECOVERING         — invalid > 500ms, cache too stale (degrade + emit events)
//   LIVE_FATAL              — invalid > FATAL_THRESHOLD_MS (quit + reconnect)
//
// getBestPosition() implements degraded runtime mode (diagnosis §13E):
//   instead of silently dropping operations, return the best available position
//   with a source tag so callers can degrade gracefully instead of aborting.

const TRANSIENT_MS       = 500
const CACHE_MAX_MS       = 5000
const FATAL_THRESHOLD_MS = 8000   // was 30000 — the desync owner reconnects at DESYNC_HARD_MS,
                                  // so LIVE_FATAL should never be reached in a pure desync now.
const DESYNC_HARD_MS     = 5000   // structurally-invalid position for this long ⇒ reconnect now

const STATES = Object.freeze({
  LIVE_VALID:             'LIVE_VALID',
  LIVE_TRANSIENT_INVALID: 'LIVE_TRANSIENT_INVALID',
  LIVE_STALE_USING_CACHE: 'LIVE_STALE_USING_CACHE',
  LIVE_RECOVERING:        'LIVE_RECOVERING',
  LIVE_FATAL:             'LIVE_FATAL',
})

function isValidVec(v) {
  return v != null &&
    typeof v.x === 'number' && Number.isFinite(v.x) &&
    typeof v.y === 'number' && Number.isFinite(v.y) &&
    typeof v.z === 'number' && Number.isFinite(v.z)
}

module.exports = function createEntityLivenessMonitor(bot, log) {
  let currentState  = STATES.LIVE_VALID
  let lastValidPos  = null   // { x, y, z } snapshot when last valid
  let lastValidAt   = 0      // ms timestamp
  let invalidSince  = null   // ms timestamp when invalidity began

  function tick() {
    const livePos = bot.entity?.position
    const now = Date.now()

    if (isValidVec(livePos)) {
      const wasInvalid = currentState !== STATES.LIVE_VALID
      lastValidPos  = { x: livePos.x, y: livePos.y, z: livePos.z }
      lastValidAt   = now
      invalidSince  = null
      if (wasInvalid) {
        log.info('liveness_state_change', {
          from: currentState, to: STATES.LIVE_VALID,
          recoveredAfterMs: invalidSince ? now - invalidSince : null,
        })
      }
      currentState = STATES.LIVE_VALID
      return
    }

    // Position is invalid — classify severity
    if (!invalidSince) invalidSince = now
    const invalidMs  = now - invalidSince
    const cacheAgeMs = lastValidAt ? now - lastValidAt : Infinity

    let next
    if (invalidMs < TRANSIENT_MS) {
      next = STATES.LIVE_TRANSIENT_INVALID
    } else if (cacheAgeMs < CACHE_MAX_MS) {
      next = STATES.LIVE_STALE_USING_CACHE
    } else if (invalidMs < FATAL_THRESHOLD_MS) {
      next = STATES.LIVE_RECOVERING
    } else {
      next = STATES.LIVE_FATAL
    }

    if (next !== currentState) {
      log.warn('liveness_state_change', { from: currentState, to: next, invalidMs, cacheAgeMs })
      currentState = next
    }
  }

  // Returns the best available position with a quality tag, or null if nothing usable.
  // source === 'live'    — fresh, fully trust it
  // source === 'cached'  — recent cache, safe for most operations
  // source === 'unknown' — stale/absent; caller should degrade or use blind behaviour
  function getBestPosition() {
    const livePos = bot.entity?.position
    if (isValidVec(livePos)) {
      return { pos: { x: livePos.x, y: livePos.y, z: livePos.z }, source: 'live' }
    }
    if (lastValidPos) {
      const cacheAgeMs = lastValidAt ? Date.now() - lastValidAt : Infinity
      if (cacheAgeMs < CACHE_MAX_MS) {
        return { pos: lastValidPos, source: 'cached' }
      }
      // Cache is stale but it's all we have — return it as 'unknown' so callers
      // can still attempt degraded reactions rather than doing nothing at all.
      return { pos: lastValidPos, source: 'unknown' }
    }
    return null
  }

  function getState()      { return currentState }
  function getCachedPos()  { return lastValidPos }
  function getCachedAge()  { return lastValidAt ? Date.now() - lastValidAt : Infinity }
  function getInvalidMs()  { return invalidSince ? Date.now() - invalidSince : 0 }

  // True when the live position has been structurally invalid (NaN/null component,
  // or entity absent) continuously for longer than DESYNC_HARD_MS. This is the single
  // trigger for the fast reconnect path — a desync is binary, not graded: no local
  // maneuver can fix it, so the only correct response is to quit and reconnect.
  function isDesynced()    { return invalidSince != null && (Date.now() - invalidSince) > DESYNC_HARD_MS }

  return { tick, getState, getBestPosition, getCachedPos, getCachedAge, getInvalidMs, isDesynced, STATES }
}
