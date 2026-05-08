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

module.exports = { safeDig, safeCraft, safeEquip, safeConsume, safePlaceBlock }
