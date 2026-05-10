// safeMineflayer.js — Bounded wrappers for Mineflayer async API calls.
//
// Every Mineflayer API call that returns a Promise can hang indefinitely
// if the server stops responding mid-operation (confirmed: bot.dig took 38s
// on a sand block — events.jsonl 06:48:34–06:49:14). These wrappers enforce
// per-call timeouts via Promise.race, mirroring navNear (bot.js:914-955).
//
// On timeout: rejects with a clear Error and emits a structured log event
// so events.jsonl shows exactly which call stalled and for how long.
//
// Cleanup (pathfinder.stop, clearControlStates) is NOT done here — the
// calling task's existing catch/finally handlers already own that path.

const log = require('./logger')

function withTimeout(promise, timeoutMs, eventName, meta = {}) {
  let timer
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      log.warn(eventName, { timeoutMs, ...meta })
      reject(new Error(`${eventName}: timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer))
}

function safeDig(bot, block, timeoutMs = 8000) {
  return withTimeout(bot.dig(block), timeoutMs, 'safe_dig_timeout', {
    block: block?.name,
    pos: block?.position
      ? { x: block.position.x, y: block.position.y, z: block.position.z }
      : null,
  })
}

function safeCraft(bot, recipe, count, table, timeoutMs = 5000) {
  return withTimeout(bot.craft(recipe, count, table), timeoutMs, 'safe_craft_timeout', {
    count,
    hasTable: !!table,
  })
}

function safeEquip(bot, item, destination, timeoutMs = 3000) {
  return withTimeout(bot.equip(item, destination), timeoutMs, 'safe_equip_timeout', {
    item: item?.name,
    destination,
  })
}

function safeConsume(bot, timeoutMs = 5000) {
  return withTimeout(bot.consume(), timeoutMs, 'safe_consume_timeout', {})
}

function safePlaceBlock(bot, referenceBlock, faceVector, timeoutMs = 5000) {
  return withTimeout(bot.placeBlock(referenceBlock, faceVector), timeoutMs, 'safe_place_timeout', {
    ref: referenceBlock?.name,
    pos: referenceBlock?.position
      ? { x: referenceBlock.position.x, y: referenceBlock.position.y, z: referenceBlock.position.z }
      : null,
  })
}

// safeAttack — bounded bot.pvp.attack() wrapper.
//
// bot.pvp.attack() is fire-and-forget: the only escape is waiting for
// 'stoppedAttacking', which never fires if the target dies/desyncs/leaves
// range without the pvp plugin noticing. Without a bound, the calling task
// hangs for the full 30 s timeout (diagnosis#2 §1.4).
//
// Resolution order (whichever comes first):
//   1. bot event 'stoppedAttacking'
//   2. maxMs wall-clock timeout
//   3. ~500 ms poll: target invalid / position gone / out of engage range / HP ≤ 0
//
// On early-out (timeout or poll): bot.pvp.stop() is called before resolving
// so the pvp plugin doesn't keep trying to attack a gone target.
//
// Always resolves (never rejects) — attack tasks should not crash on a
// target disappearing mid-fight; the task checks target.isValid after return.
const SAFE_ATTACK_POLL_MS   = 500
const SAFE_ATTACK_ENGAGE_R  = 6  // blocks — reasonable melee + bow range

function safeAttack(bot, target, { maxMs = 10_000, label = 'target' } = {}) {
  return new Promise(resolve => {
    let done = false

    function finish(reason) {
      if (done) return
      done = true
      clearInterval(pollTimer)
      clearTimeout(wallTimer)
      bot.removeListener('stoppedAttacking', onStopped)

      const timedOut = reason !== 'stopped'
      if (timedOut) {
        log.warn('safe_attack_timeout', { label, reason, maxMs })
        try { bot.pvp.stop() } catch {}
      } else {
        log.debug('safe_attack_done', { label, reason })
      }
      resolve()
    }

    function onStopped() { finish('stopped') }

    function poll() {
      if (!target || !target.isValid)           return finish('target_invalid')
      if (!target.position)                     return finish('target_no_position')
      if ((target.health ?? 1) <= 0)            return finish('target_dead')
      const botPos = bot.entity?.position
      if (botPos && target.position.distanceTo(botPos) > SAFE_ATTACK_ENGAGE_R * 3) {
        return finish('target_out_of_range')
      }
    }

    bot.on('stoppedAttacking', onStopped)
    const pollTimer = setInterval(poll, SAFE_ATTACK_POLL_MS)
    const wallTimer = setTimeout(() => finish('timeout'), maxMs)

    try {
      bot.pvp.attack(target)
    } catch (err) {
      log.warn('safe_attack_start_error', { label, message: err.message })
      finish('start_error')
    }
  })
}

module.exports = { safeDig, safeCraft, safeEquip, safeConsume, safePlaceBlock, safeAttack }
