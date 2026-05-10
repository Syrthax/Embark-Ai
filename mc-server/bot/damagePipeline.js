// damagePipeline.js — Decoupled capture / classify / react for incoming damage.
//
// Extracted verbatim from bot.js (behaviour-preserving). Architecture:
//
//   raw entityHurt event ──► captureDamageEvent() ──► damageWindow[]
//                                                         │
//                                              every 500ms, processDamageWindow():
//                                                         │
//                                                  trim window to last 1.5s
//                                                  enter REACTING / HURT / SAFE
//                                                  classifyIncident(window)
//                                                  if reactionCooldown elapsed
//                                                    (or a critical-HP flag is set):
//                                                       react ONCE per incident
//
// The reaction cooldown (3s) makes the cactus-loop / lava-loop impossible: we react
// once, take 3s to step out, then re-evaluate. The critical-HP flag (set by bot's
// 'health' handler) bypasses the cooldown for one incident so a sharp HP drop or
// critical floor gets an immediate real escape — this is the single damage-reaction
// authority (Fix 4), so the 'health' handler stages instead of acting directly.
//
// The factory registers the 'entityHurt' and 'health' listeners and the 500ms
// classifier interval itself. bot.js keeps 'death' / 'respawn' / 'forcedMove' (mixed
// concerns) and calls flushDamageState() from respawn/forcedMove.

'use strict'

const DAMAGE_WINDOW_MS          = 1500   // damage events within this window are one incident
const REACTION_COOLDOWN_MS      = 3000   // never react more often than this
const HAZARD_MEMORY_MS          = 60000  // hazard zones remembered for 1 min
const HIT_CHAT_COOLDOWN_MS      = 4000
const COUNTER_PUNCH_COOLDOWN_MS = 1500

module.exports = function createDamagePipeline(deps) {
  const {
    bot, log, state, liveness,
    getEnvPerception,                    // () => envPerception (created shortly after this)
    getLastEnvScan,                      // () => lastEnvScan (mutable in bot.js)
    isTaskBusy,                          // () => taskBusy (mutable in bot.js)
    replaceTask,
    safeChat, safeFloor, isValidVec,
    getPlayer,
    bumpAnger, ANGER_HIT, ANGER_ATTACK_LEVEL,
    HAZARD_BLOCKS, HOSTILE_MOB_NAMES, BOT_NAME,
    tasks,                               // { taskAttackPlayer, taskAttackMobs, taskFlee, taskEvadeHazard }
  } = deps

  const { taskAttackPlayer, taskAttackMobs, taskFlee, taskEvadeHazard } = tasks

  // ── State ────────────────────────────────────────────────────────────────────
  let lastHitChatAt             = 0
  let lastCounterPunchAt        = 0
  let currentPlayerAttackTarget = null   // username we're currently in goal=attacking against

  const damageWindow = []       // recent raw damage event captures
  const hazardZones  = []       // { x, y, z, type, ts } — places we took env damage
  let damageState     = 'safe'  // safe | hurt | reacting
  let lastReactionAt  = 0
  let damageCorrelationCounter = 0
  // Single damage-reaction authority (Fix 4): 'health' handler sets this flag instead
  // of acting directly. processDamageWindow reads it to bypass the cooldown and react.
  let criticalHpFlag  = null    // { at: number, hp: number } | null
  let prevHp          = null    // last seen HP for sharp-drop detection

  // ── Hazard scan ──────────────────────────────────────────────────────────────

  // Scan a 7×4×7 box around the bot for hazardous blocks. Returns the closest or null.
  function findNearbyHazard(radius = 3) {
    if (!bot.entity) return null
    const pos = bot.entity.position
    let nearest = null, minDist = Infinity
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -1; dy <= 2; dy++) {  // feet, body, head
        for (let dz = -radius; dz <= radius; dz++) {
          const block = bot.blockAt(pos.offset(dx, dy, dz))
          if (!block || !HAZARD_BLOCKS.has(block.name)) continue
          const d = block.position.distanceTo(pos)
          if (d < minDist) { minDist = d; nearest = { block, dist: d, name: block.name } }
        }
      }
    }
    return nearest
  }

  // ── Context-capture helpers ──────────────────────────────────────────────────

  function getNearestNonBotPlayerWithin(maxDist) {
    if (!bot.entity) return null
    let nearest = null, minDist = maxDist
    for (const name in bot.players) {
      if (name === BOT_NAME) continue
      const p = bot.players[name]
      if (!p?.entity) continue
      const d = p.entity.position.distanceTo(bot.entity.position)
      if (d < minDist) { minDist = d; nearest = { name, entity: p.entity, dist: d } }
    }
    return nearest
  }

  function getNearestHostileMobWithin(maxDist) {
    if (!bot.entity) return null
    return bot.nearestEntity(e =>
      e !== bot.entity && e.name && HOSTILE_MOB_NAMES.has(e.name) &&
      e.position.distanceTo(bot.entity.position) < maxDist
    )
  }

  function captureDamageEvent() {
    const rawPos = bot.entity?.position
    let usingCached = false
    let pos = rawPos

    if (!isValidVec(rawPos)) {
      // Degraded mode: instead of silently dropping the event, use the best available
      // position with a quality tag. 'unknown' source ⇒ blind reaction path.
      const best = liveness.getBestPosition()
      if (!best) {
        log.warn('damage_capture_skipped', {
          reason: 'no_position_available',
          livenessState: liveness.getState(),
          invalidMs: liveness.getInvalidMs(),
        })
        return null
      }
      pos = best.pos
      usingCached = best.source !== 'live'
      if (best.source === 'unknown') {
        usingCached = true
        pos = best.pos || { x: 0, y: 0, z: 0 }
        log.debug('damage_capture_blind', { livenessState: liveness.getState(), cacheAgeMs: liveness.getCachedAge() })
      }
    }

    const event = {
      at: Date.now(),
      hp: Number(bot.health.toFixed(1)),
      hurtTime: bot.entity?.hurtTime ?? null,
      pos: safeFloor(pos),
      posSource: usingCached ? 'cached' : 'live',
      velocity: isValidVec(bot.entity?.velocity) ? {
        x: Number(bot.entity.velocity.x.toFixed(2)),
        y: Number(bot.entity.velocity.y.toFixed(2)),
        z: Number(bot.entity.velocity.z.toFixed(2)),
      } : null,
      nearestPlayer: getNearestNonBotPlayerWithin(5),
      nearestHostileMob: getNearestHostileMobWithin(6),
      hazard: findNearbyHazard(2),
      inWater: !!bot.entity?.isInWater,
      inLava: !!bot.entity?.isInLava,
    }
    if (usingCached) log.debug('damage_capture_using_cached_pos', { cachedAgeMs: liveness.getCachedAge(), livenessState: liveness.getState() })
    return event
  }

  // ── Periodic classifier ──────────────────────────────────────────────────────

  function processDamageWindow() {
    // Trim window to last DAMAGE_WINDOW_MS
    const cutoff = Date.now() - DAMAGE_WINDOW_MS
    while (damageWindow.length > 0 && damageWindow[0].at < cutoff) damageWindow.shift()

    // Trim hazard memory
    const hzCutoff = Date.now() - HAZARD_MEMORY_MS
    while (hazardZones.length > 0 && hazardZones[0].ts < hzCutoff) hazardZones.shift()

    if (damageWindow.length === 0) {
      if (damageState !== 'safe') {
        log.info('damage_state_change', { from: damageState, to: 'safe' })
        damageState = 'safe'
      }
      return
    }

    if (damageState === 'safe') {
      log.info('damage_state_change', { from: 'safe', to: 'hurt' })
      damageState = 'hurt'
    }

    // Reaction cooldown: don't act on every tick.
    // Priority bypass: if the health handler flagged a critical HP event that is newer
    // than our last reaction, skip the cooldown for this one incident only.
    const sinceReaction = Date.now() - lastReactionAt
    if (sinceReaction < REACTION_COOLDOWN_MS) {
      if (!criticalHpFlag || criticalHpFlag.at <= lastReactionAt) return
      log.warn('critical_hp_bypass', { hp: criticalHpFlag.hp, sinceReaction })
      criticalHpFlag = null
    }

    // Classify and react
    const incident = classifyIncident(damageWindow)
    const incidentCid = ++damageCorrelationCounter
    log.info('damage_incident', {
      type: incident.type,
      hits: damageWindow.length,
      hp: bot.health,
      detail: incident.summary,
      cid: incidentCid,
    })
    lastReactionAt = Date.now()
    damageState = 'reacting'
    reactToIncident(incident)
  }

  function classifyIncident(events) {
    // Check player consistency: same player nearby in all events
    const playerNames = events.map(e => e.nearestPlayer?.name).filter(Boolean)
    if (playerNames.length === events.length && new Set(playerNames).size === 1) {
      const attacker = events[events.length - 1].nearestPlayer
      return { type: 'player', attacker, summary: { player: attacker.name } }
    }

    // Mob consistency
    const mobNames = events.map(e => e.nearestHostileMob?.name).filter(Boolean)
    if (mobNames.length === events.length && new Set(mobNames).size === 1) {
      const mob = events[events.length - 1].nearestHostileMob
      return { type: 'mob', attacker: mob, summary: { mob: mob.name } }
    }

    // Lava / fire detection from entity flags
    if (events.some(e => e.inLava)) {
      return { type: 'environmental', hazard: { name: 'lava', block: bot.entity }, summary: { hazard: 'lava' } }
    }

    // Hazard block detection
    const hazards = events.map(e => e.hazard).filter(Boolean)
    if (hazards.length > 0) {
      const hz = hazards[hazards.length - 1]
      return { type: 'environmental', hazard: hz, summary: { hazard: hz.name } }
    }

    return { type: 'unknown', summary: {} }
  }

  function reactToIncident(incident) {
    switch (incident.type) {
      case 'player':        return reactToPlayerAttack(incident.attacker)
      case 'mob':           return reactToMobAttack(incident.attacker)
      case 'environmental': return reactToEnvironmental(incident.hazard)
      case 'unknown':       return reactToUnknownDamage()
    }
  }

  function reactToPlayerAttack(attacker) {
    const rec = bumpAnger(attacker.name, ANGER_HIT, 'attacked me')
    const now = Date.now()
    if (rec.level >= ANGER_ATTACK_LEVEL) {
      // Symmetric guard matching reactToMobAttack: don't restart the attack task on every hit.
      if (isTaskBusy() && state.goal === 'attacking') {
        if (currentPlayerAttackTarget === attacker.name) return  // already engaged with this player

        // Different player is hitting us mid-attack. Switch only if the new attacker is
        // closer than our current target (they're the more immediate threat).
        const botPos = bot.entity?.position
        if (botPos) {
          const currentTarget = getPlayer(currentPlayerAttackTarget)
          const newDist = attacker.entity?.position?.distanceTo(botPos) ?? Infinity
          const curDist = currentTarget?.entity?.position?.distanceTo(botPos) ?? Infinity
          if (newDist >= curDist) {
            log.debug('player_attack_suppressed', {
              incoming: attacker.name, current: currentPlayerAttackTarget,
              newDist: Math.round(newDist), curDist: Math.round(curDist),
            })
            return  // stay on the closer current target
          }
        } else {
          return  // no position data, don't switch
        }
      }

      if (now - lastHitChatAt >= HIT_CHAT_COOLDOWN_MS) {
        safeChat(`That's it, ${attacker.name}.`)
        lastHitChatAt = now
      }
      currentPlayerAttackTarget = attacker.name
      replaceTask('attacking', () => taskAttackPlayer(attacker.entity, attacker.name))
    } else {
      if (now - lastHitChatAt >= HIT_CHAT_COOLDOWN_MS) {
        safeChat(`Stop hitting me, ${attacker.name}!`)
        lastHitChatAt = now
      }
      if (now - lastCounterPunchAt >= COUNTER_PUNCH_COOLDOWN_MS) {
        try { bot.attack(attacker.entity) } catch (e) {
          log.warn('counter_attack_failed', { message: e.message })
        }
        lastCounterPunchAt = now
      }
    }
  }

  function reactToMobAttack(mob) {
    if (isTaskBusy() && state.goal === 'attacking') return  // already engaged
    if (state.energy < 30) {
      safeChat(`A ${mob.name}! Backing off.`)
      log.info('mob_hit_decision', { mob: mob.name, choice: 'flee', energy: state.energy })
      replaceTask('fleeing', taskFlee)
    } else {
      safeChat(`A ${mob.name}. Fighting back.`)
      log.info('mob_hit_decision', { mob: mob.name, choice: 'fight', energy: state.energy })
      replaceTask('attacking', () => taskAttackMobs())
    }
  }

  function reactToEnvironmental(hazard) {
    rememberHazard(hazard)
    // Also record in the environmental perception hazard memory for path avoidance
    const envPerception = getEnvPerception()
    if (hazard?.block?.position && envPerception) {
      const hp = hazard.block.position
      envPerception.recordHazardPosition(hp.x, hp.y, hp.z, 'damage')
    }
    log.info('hazard_detected', {
      name: hazard?.name || 'unknown',
      knownZones: hazardZones.length,
      envRisk: getLastEnvScan()?.locomotionRisk ?? null,
    })
    replaceTask('evading', () => taskEvadeHazard(hazard))
  }

  function reactToUnknownDamage() {
    // No identifiable source. If HP is dropping fast, retreat.
    if (bot.health < 12) {
      log.warn('unknown_damage_critical_retreat', { hp: bot.health })
      replaceTask('evading', () => taskEvadeHazard(null))
    } else {
      log.warn('unknown_damage_ignored_hp_ok', { hp: bot.health })
    }
  }

  function rememberHazard(hazard) {
    if (!hazard?.block?.position) return
    const p = hazard.block.position
    hazardZones.push({
      x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z),
      type: hazard.name,
      ts: Date.now(),
    })
    while (hazardZones.length > 50) hazardZones.shift()
  }

  // ── Event handlers (registered below) ────────────────────────────────────────

  function onEntityHurt(entity) {
    if (entity !== bot.entity) return
    const evt = captureDamageEvent()
    if (!evt) return
    damageWindow.push(evt)
    // trace level — high-frequency; not useful as user-visible info
    log.trace('damage_raw', {
      hp: evt.hp,
      player: evt.nearestPlayer?.name || null,
      mob: evt.nearestHostileMob?.name || null,
      hazard: evt.hazard?.name || null,
      inLava: evt.inLava,
    })
  }

  function onHealthUpdate() {
    const hp   = bot.health
    const prev = prevHp ?? hp
    prevHp = hp

    const sharpDrop = (prev - hp) >= 2
    const critical  = hp <= 4

    // Stage a high-priority flag for processDamageWindow instead of acting directly.
    // Direct action here would race processDamageWindow's escape reaction, cancelling
    // it on every lava tick and causing goal oscillation.
    if ((sharpDrop || critical) && (!criticalHpFlag || criticalHpFlag.at < Date.now() - 500)) {
      criticalHpFlag = { at: Date.now(), hp }
      log.warn('critical_hp_queued', { hp, prev, sharpDrop, critical })
    }
  }

  // Discard damage events that refer to a stale world (post-respawn / post-teleport).
  function flushDamageState() {
    damageWindow.length = 0
    damageState = 'safe'
  }

  // ── Wire up ──────────────────────────────────────────────────────────────────
  bot.on('entityHurt', onEntityHurt)
  bot.on('health', onHealthUpdate)
  const interval = setInterval(processDamageWindow, 500)

  return {
    flushDamageState,
    // accessors for freeze-snapshot / health-beacon logging in bot.js
    getDamageState:      () => damageState,
    getDamageWindowSize: () => damageWindow.length,
    getLastReactionAt:   () => lastReactionAt,
    getHazardZonesCount: () => hazardZones.length,
    getCooldowns: () => ({
      hitChat:      Math.max(0, HIT_CHAT_COOLDOWN_MS      - (Date.now() - lastHitChatAt)),
      counterPunch: Math.max(0, COUNTER_PUNCH_COOLDOWN_MS - (Date.now() - lastCounterPunchAt)),
      reaction:     Math.max(0, REACTION_COOLDOWN_MS      - (Date.now() - lastReactionAt)),
    }),
    REACTION_COOLDOWN_MS,
    _interval: interval,
  }
}

module.exports.REACTION_COOLDOWN_MS = REACTION_COOLDOWN_MS
