// healthIntegrityWatchdog.js — HP-loss watchdog independent of damage pipeline.
//
// The damage pipeline (captureDamageEvent → classifyIncident → react) relies on
// bot.entity.position being valid to capture events. During NaN windows, every
// entityHurt event is dropped, leaving the bot dying silently with no reaction
// (diagnosis F1 / "validator dead-end" F18 — confirmed in events.jsonl 06:34:00–47).
//
// This watchdog bypasses the validator entirely: it just watches bot.health drop.
// If HP falls by more than HP_DROP_THRESHOLD in HP_WINDOW_MS without a recent
// damage_incident being issued by the normal pipeline, it calls onSilentDamage().
//
// onSilentDamage() in bot.js reports to recoveryEngine (the single arbiter) — which
// routes to DESYNC (reconnect) if the position is structurally invalid, or CRITICAL_HP
// (blind-survival sprint, raw control states) if it's valid. This watchdog detects and
// reports; it never acts directly.

const HP_DROP_THRESHOLD  = 2    // more than 2 HP lost in the window
const HP_WINDOW_MS       = 2000 // rolling window size
const TRIGGER_COOLDOWN_MS = 8000 // don't trigger more than once per 8s

module.exports = function createHealthIntegrityWatchdog(bot, log, onSilentDamage, getLastReactionAt) {
  const history = []  // [{ hp, at }]
  let lastTriggerAt = 0

  function tick() {
    const now = Date.now()
    const hp  = bot.health

    // Push current reading, prune window
    history.push({ hp, at: now })
    while (history.length > 0 && (now - history[0].at) > HP_WINDOW_MS) history.shift()

    if (history.length < 2) return

    const oldest  = history[0].hp
    const current = history[history.length - 1].hp
    const dropped = oldest - current  // positive = HP loss

    if (dropped <= HP_DROP_THRESHOLD) return

    // Skip if normal damage pipeline already reacted recently
    const lastReaction = getLastReactionAt()
    if ((now - lastReaction) < HP_WINDOW_MS) return

    // Skip if we triggered recently
    if ((now - lastTriggerAt) < TRIGGER_COOLDOWN_MS) return

    lastTriggerAt = now
    log.warn('silent_damage_detected', {
      hpDropped: Number(dropped.toFixed(1)),
      hpNow: Number(current.toFixed(1)),
      windowMs: HP_WINDOW_MS,
      lastReactionMsAgo: now - lastReaction,
    })
    onSilentDamage()
  }

  return { tick }
}
