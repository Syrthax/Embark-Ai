// movementController.js — Single owner of bot.pathfinder.
// All pathfinder writes route through this module; every transition is logged.
// Priority model: CRITICAL(4) > HIGH(3) > NORMAL(2) > LOW(1) > PASSIVE(0)

const NAVIGATE_TIMEOUT_MS = 15000

const PRIORITY = Object.freeze({ CRITICAL: 4, HIGH: 3, NORMAL: 2, LOW: 1, PASSIVE: 0 })

module.exports = function createMovementController(bot, goals, makeMovements, log) {
  let owner = null              // { source, priority, type, startedAt }
  let savedThinkingTimeout = null

  function _acquire(source, priority, type) {
    if (owner && priority < owner.priority) {
      log.warn('movement_blocked', { source, priority, blockedBy: owner.source, blockedPriority: owner.priority })
      return false
    }
    if (owner) {
      log.debug('movement_preempted', { by: source, was: owner.source, heldMs: Date.now() - owner.startedAt })
    }
    owner = { source, priority, type, startedAt: Date.now() }
    log.debug('movement_acquired', { source, priority, type })
    return true
  }

  function release(source) {
    if (!owner || owner.source !== source) return
    log.debug('movement_released', { source, heldMs: Date.now() - owner.startedAt })
    owner = null
  }

  // stop: stop pathfinder and release ownership if caller is current owner.
  function stop(source) {
    try { bot.pathfinder.stop() } catch {}
    release(source)
  }

  // forceStop: stop pathfinder and clear ownership regardless of who holds it.
  // Use when a higher-level interrupt (cancel, error, evade) supersedes movement.
  function forceStop(source) {
    try { bot.pathfinder.stop() } catch {}
    if (owner) log.debug('movement_force_stopped', { by: source, was: owner.source, heldMs: Date.now() - owner.startedAt })
    owner = null
  }

  // navigate: async goto — acquires ownership, drives pathfinder.goto, releases on settle.
  // Rejects if blocked by a higher-priority owner or if pathfinding times out.
  async function navigate(x, y, z, range = 3, priority = PRIORITY.NORMAL, source = 'task') {
    if (!_acquire(source, priority, 'navigate')) {
      throw new Error(`movement_blocked: ${source} (p${priority}) blocked by ${owner?.source} (p${owner?.priority})`)
    }

    bot.pathfinder.setMovements(makeMovements())
    let timer
    const pathPromise = bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { bot.pathfinder.stop() } catch {}
        reject(new Error(`pathfinding timeout to (${x},${y},${z})`))
      }, NAVIGATE_TIMEOUT_MS)
    })

    try {
      await Promise.race([pathPromise, timeoutPromise])
    } finally {
      clearTimeout(timer)
      release(source)
    }
  }

  // follow: fire-and-forget dynamic goal — acquires ownership and sets GoalFollow.
  // Ownership persists until stop/forceStop/another follow call (no async release).
  function follow(entity, range = 2, priority = PRIORITY.LOW, source = 'follow') {
    if (!_acquire(source, priority, 'follow')) return false
    try {
      bot.pathfinder.setMovements(makeMovements())
      bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
    } catch (e) {
      log.error('movement_follow_error', { source, message: e.message })
      release(source)
      return false
    }
    return true
  }

  // setThinkingTimeout / restoreThinkingTimeout: let callers temporarily tighten
  // pathfinder planning budget (explore = 2s, escape = 5s). Saves original on first call.
  function setThinkingTimeout(ms) {
    if (savedThinkingTimeout === null) {
      savedThinkingTimeout = bot.pathfinder.thinkingTimeout ?? 1500
    }
    try { bot.pathfinder.thinkingTimeout = ms } catch {}
    log.debug('movement_thinking_timeout_set', { ms })
  }

  function restoreThinkingTimeout() {
    if (savedThinkingTimeout === null) return
    try { bot.pathfinder.thinkingTimeout = savedThinkingTimeout } catch {}
    log.debug('movement_thinking_timeout_restored', { ms: savedThinkingTimeout })
    savedThinkingTimeout = null
  }

  function isActive() {
    return !!(bot.pathfinder?.isMoving() || bot.pathfinder?.goal != null)
  }

  function getOwner() { return owner ? { ...owner } : null }

  return { PRIORITY, navigate, follow, stop, forceStop, release, setThinkingTimeout, restoreThinkingTimeout, isActive, getOwner }
}
