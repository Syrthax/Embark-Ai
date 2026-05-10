// environmentPerception.js — Real-time environmental perception layer.
//
// Continuously scans nearby world state and builds:
//   - local hazard map  (fatal/damage/slow/liquid blocks in configurable radius)
//   - traversability analysis (N/S/E/W classified as walkable/blocked/fall_risk/unsafe_*)
//   - escape vector     (direction with lowest danger score)
//   - hazard memory     (dangerous coordinates, TTL-evicted, max 100)
//   - stuck classifier  (lava_immobilization/collision_deadlock/terrain_deadlock/…)
//   - locomotion risk   (0–10 score)
//
// scan()         → full perception report
// getLLMContext  → compact string for LLM prompt (no raw chunk data)
// getHazardMemory→ read hazard memory entries

'use strict'

// ── Hazard taxonomy ────────────────────────────────────────────────────────────

const SEVERITY = Object.freeze({ FATAL: 3, DAMAGE: 2, SLOW: 1, LIQUID: 1 })

const HAZARD_FATAL  = new Set(['lava', 'fire', 'soul_fire'])
const HAZARD_DAMAGE = new Set(['cactus', 'sweet_berry_bush', 'wither_rose', 'magma_block',
                                'campfire', 'soul_campfire'])
const HAZARD_SLOW   = new Set(['cobweb', 'soul_sand', 'mud', 'honey_block', 'powder_snow'])
const HAZARD_LIQUID = new Set(['water'])
const AIR_BLOCKS    = new Set(['air', 'cave_air', 'void_air'])

const SCAN_RADIUS_DEFAULT = 12
const HAZARD_TTL_MS       = 5 * 60 * 1000  // 5 minutes
const HAZARD_MEMORY_MAX   = 100

const DIRECTIONS = Object.freeze({
  N: { dx: 0,  dz: -1, label: 'north' },
  S: { dx: 0,  dz:  1, label: 'south' },
  E: { dx: 1,  dz:  0, label: 'east'  },
  W: { dx: -1, dz:  0, label: 'west'  },
})

// ── Module factory ─────────────────────────────────────────────────────────────

module.exports = function createEnvironmentPerception(bot, log) {
  // hazardMemory: array of { key, type, ts, pos } — oldest-first, evicted by age or length
  const hazardMemory = []

  // ── Block helpers ────────────────────────────────────────────────────────────

  function _blockAt(x, y, z) {
    try { return bot.blockAt(bot.vec3(x, y, z)) } catch { return null }
  }

  function _isAir(block) {
    return !block || AIR_BLOCKS.has(block.name)
  }

  function _isSolid(block) {
    return block != null && !AIR_BLOCKS.has(block.name) && block.boundingBox === 'block'
  }

  function _hazardSeverity(block) {
    if (!block) return 0
    if (HAZARD_FATAL.has(block.name))  return SEVERITY.FATAL
    if (HAZARD_DAMAGE.has(block.name)) return SEVERITY.DAMAGE
    if (HAZARD_SLOW.has(block.name))   return SEVERITY.SLOW
    if (HAZARD_LIQUID.has(block.name)) return SEVERITY.LIQUID
    return 0
  }

  function _hazardClass(block) {
    if (!block) return null
    if (HAZARD_FATAL.has(block.name))  return 'fatal'
    if (HAZARD_DAMAGE.has(block.name)) return 'damage'
    if (HAZARD_SLOW.has(block.name))   return 'slow'
    if (HAZARD_LIQUID.has(block.name)) return 'liquid'
    return null
  }

  function _coordKey(x, y, z) {
    return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`
  }

  // ── Hazard memory ────────────────────────────────────────────────────────────

  function _pruneMemory() {
    const cutoff = Date.now() - HAZARD_TTL_MS
    while (hazardMemory.length > 0 && hazardMemory[0].ts < cutoff) hazardMemory.shift()
  }

  function recordHazardPosition(x, y, z, type) {
    const key = _coordKey(x, y, z)
    if (!hazardMemory.find(e => e.key === key)) {
      hazardMemory.push({ key, type, ts: Date.now(), pos: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) } })
      while (hazardMemory.length > HAZARD_MEMORY_MAX) hazardMemory.shift()
    }
  }

  function isKnownHazard(x, y, z) {
    const key = _coordKey(x, y, z)
    return hazardMemory.some(e => e.key === key)
  }

  // ── Traversability classifier ────────────────────────────────────────────────
  // Returns { label, score } for one horizontal direction.
  // Score: 0=safe, 10=lethal — used to rank escape vectors.

  function _classifyDirection(bx, by, bz, dx, dz) {
    let worstLabel = 'walkable', worstScore = 0

    for (const step of [1, 2]) {
      const tx = bx + dx * step
      const tz = bz + dz * step

      const foot  = _blockAt(tx, by,     tz)
      const head  = _blockAt(tx, by + 1, tz)
      const floor = _blockAt(tx, by - 1, tz)
      const sub1  = _blockAt(tx, by - 2, tz)
      const sub2  = _blockAt(tx, by - 3, tz)

      let label = 'walkable', score = 0

      if (HAZARD_FATAL.has(foot?.name) || HAZARD_FATAL.has(head?.name)) {
        label = (foot?.name === 'lava' || head?.name === 'lava') ? 'unsafe_lava' : 'unsafe_fire'
        score = 10
      } else if (HAZARD_DAMAGE.has(foot?.name) || HAZARD_DAMAGE.has(head?.name)) {
        label = 'hazardous'; score = 6
      } else if (HAZARD_LIQUID.has(foot?.name)) {
        label = 'swim_risk'; score = 3
      } else if (_isSolid(foot) && _isSolid(head)) {
        label = 'blocked'; score = 7
      } else if (!_isSolid(foot) && _isSolid(head)) {
        label = 'low_ceiling'; score = 2
      } else if (_isAir(foot) && _isAir(floor)) {
        const depth = _isAir(sub1) ? (_isAir(sub2) ? 3 : 2) : 1
        label = depth >= 3 ? 'fall_risk' : 'step_down'
        score = depth >= 3 ? 7 : 1
      } else if (isKnownHazard(tx, by, tz)) {
        label = 'hazard_memory'; score = Math.max(score, 5)
      }

      if (HAZARD_SLOW.has(floor?.name)) score += 1

      if (score > worstScore) { worstScore = score; worstLabel = label }
      if (worstScore >= 10) break  // already worst possible
    }

    return { label: worstLabel, score: worstScore }
  }

  // ── Cliff detector ───────────────────────────────────────────────────────────

  function _detectCliff(bx, by, bz) {
    for (const [key, dir] of Object.entries(DIRECTIONS)) {
      const tx = bx + dir.dx, tz = bz + dir.dz
      if (_isAir(_blockAt(tx, by, tz)) &&
          _isAir(_blockAt(tx, by - 1, tz)) &&
          _isAir(_blockAt(tx, by - 2, tz))) {
        return { hasCliff: true, direction: key, label: dir.label }
      }
    }
    return { hasCliff: false, direction: null, label: null }
  }

  // ── Risk scorer ──────────────────────────────────────────────────────────────

  function _computeRisk(s) {
    let r = 0
    if (s.maxSeverity >= SEVERITY.FATAL)  r += 5
    if (s.maxSeverity >= SEVERITY.DAMAGE) r += 2
    if (s.isEnclosed)  r += 2
    if (s.cliff.hasCliff) r += 1
    for (const v of Object.values(s.traversability)) {
      if (['unsafe_lava','unsafe_fire','fall_risk'].includes(v)) r++
    }
    if (HAZARD_FATAL.has(s.feetBlock?.name)  || HAZARD_FATAL.has(s.headBlock?.name))  r += 4
    if (HAZARD_DAMAGE.has(s.standingOn?.name)) r += 2
    return Math.min(10, r)
  }

  // ── Stuck classifier ─────────────────────────────────────────────────────────

  function _classifyStuck({ feetBlock, headBlock, hazards, traversability, locomotionRisk }) {
    if (HAZARD_FATAL.has(feetBlock?.name))  return 'lava_immobilization'
    if (HAZARD_FATAL.has(headBlock?.name))  return 'suffocation_hazard'
    const blocked = Object.values(traversability).filter(v =>
      ['blocked','unsafe_lava','unsafe_fire'].includes(v)
    ).length
    if (blocked >= 4) return 'collision_deadlock'
    if (locomotionRisk >= 8) return 'terrain_deadlock'
    if (HAZARD_LIQUID.has(feetBlock?.name)) return 'liquid_drag'
    if (hazards.some(h => h.severity === SEVERITY.FATAL && h.dist < 3)) return 'lava_proximity'
    return 'movement_blocked'
  }

  // ── Hazard summary text ──────────────────────────────────────────────────────

  function _hazardSummary(hazards) {
    if (!hazards.length) return 'clear'
    const seen = new Set()
    const parts = []
    for (const h of hazards.slice(0, 5)) {
      if (seen.has(h.type)) continue
      seen.add(h.type)
      const dir = Math.abs(h.dx) >= Math.abs(h.dz)
        ? (h.dx > 0 ? 'E' : 'W')
        : (h.dz > 0 ? 'S' : 'N')
      parts.push(`${h.type.replace(/_/g,' ')} ${Math.round(h.dist)}m ${dir}`)
    }
    return parts.join('; ')
  }

  // ── Main scan ────────────────────────────────────────────────────────────────

  function scan(radius = SCAN_RADIUS_DEFAULT) {
    _pruneMemory()

    if (!bot.entity?.position) return _invalid('no_entity')

    const pos = bot.entity.position
    // NaN/null component = entity desync (LIVE_FATAL window). Math.floor(NaN) = NaN,
    // making every blockAt probe return null — scan would report "all clear" and
    // escapeVector would default North. Reject early so callers see valid:false,
    // not a plausible-looking zero-risk result.
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) {
      log.warn('perception_position_invalid', { x: pos.x, y: pos.y, z: pos.z })
      return _invalid('position_nan')
    }

    const bx  = Math.floor(pos.x)
    const by  = Math.floor(pos.y)
    const bz  = Math.floor(pos.z)

    // Collect hazards in sphere of radius
    const hazards = []
    const nearbyBlocksCompact = []
    let maxSeverity = 0

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -2; dy <= 3; dy++) {
        for (let dz = -radius; dz <= radius; dz++) {
          if (dx*dx + dz*dz > radius*radius) continue
          const block = _blockAt(bx+dx, by+dy, bz+dz)
          if (!block) continue
          const sev = _hazardSeverity(block)
          if (sev <= 0) continue

          const dist = Math.sqrt(dx*dx + dy*dy + dz*dz)
          hazards.push({
            type: block.name,
            hazardClass: _hazardClass(block),
            severity: sev,
            dx, dy, dz, dist,
          })
          if (sev > maxSeverity) maxSeverity = sev
          recordHazardPosition(bx+dx, by+dy, bz+dz, _hazardClass(block))

          // Compact list (close range only)
          if (Math.abs(dx) <= 4 && Math.abs(dy) <= 2 && Math.abs(dz) <= 4) {
            nearbyBlocksCompact.push({ type: block.name, dx, dy, dz })
          }
        }
      }
    }

    hazards.sort((a, b) => a.dist - b.dist)

    const standingOn = _blockAt(bx, by-1, bz)
    const feetBlock  = _blockAt(bx, by,   bz)
    const headBlock  = _blockAt(bx, by+1, bz)

    // Traversability per direction
    const traversability = {}
    const dirScores      = {}
    for (const [key, dir] of Object.entries(DIRECTIONS)) {
      const result = _classifyDirection(bx, by, bz, dir.dx, dir.dz)
      traversability[key] = result.label
      dirScores[key]      = result.score
    }

    // Escape vector: direction with lowest danger
    const [bestDir] = Object.entries(dirScores).sort((a, b) => a[1] - b[1])
    const escapeDir  = DIRECTIONS[bestDir[0]]
    const escapeVector = {
      direction: bestDir[0],
      label:     escapeDir.label,
      dx:        escapeDir.dx,
      dz:        escapeDir.dz,
      score:     bestDir[1],
    }

    // Enclosed: 3+ directions lethal/blocked
    const blockedDirs = Object.values(traversability).filter(v =>
      ['blocked','unsafe_lava','unsafe_fire','hazardous'].includes(v)
    ).length
    const isEnclosed = blockedDirs >= 3

    const cliff = _detectCliff(bx, by, bz)

    const locomotionRisk = _computeRisk({ maxSeverity, isEnclosed, cliff, traversability,
                                           feetBlock, headBlock, standingOn })
    const stuckClass     = _classifyStuck({ feetBlock, headBlock, hazards, traversability, locomotionRisk })
    const hazardSummary  = _hazardSummary(hazards)

    const result = {
      valid:               true,
      hazards:             hazards.slice(0, 8),
      hazardSummary,
      traversability,
      escapeVector,
      standingOn:          standingOn?.name || 'unknown',
      feetBlock:           feetBlock?.name  || 'air',
      headBlock:           headBlock?.name  || 'air',
      locomotionRisk,
      isEnclosed,
      cliffNearby:         cliff.hasCliff,
      cliffDirection:      cliff.label,
      stuckClass,
      nearbyBlocksCompact: nearbyBlocksCompact.slice(0, 12),
      hazardMemorySize:    hazardMemory.length,
    }

    if (hazards.length > 0 || isEnclosed || cliff.hasCliff) {
      log.info('environment_scan', {
        hazardCount:   hazards.length,
        closest:       hazards[0] ? `${hazards[0].type}@(${hazards[0].dx},${hazards[0].dy},${hazards[0].dz})` : null,
        locomotionRisk,
        isEnclosed,
        cliffNearby:   cliff.hasCliff,
        escapeDir:     escapeVector.direction,
        stuckClass,
      })
    }

    return result
  }

  // ── LLM context string ───────────────────────────────────────────────────────
  // Compact symbolic text; fits within the existing prompt without bloat.

  function getLLMContext(s) {
    if (!s?.traversability) return 'perception: unavailable'
    const travLines = Object.entries(s.traversability)
      .map(([d, v]) => `  ${d}:${v}`)
      .join('  ')
    const flags = [
      s.isEnclosed   && 'ENCLOSED',
      s.cliffNearby  && `cliff-${s.cliffDirection}`,
      s.locomotionRisk >= 7 && `HIGH-RISK(${s.locomotionRisk})`,
    ].filter(Boolean).join(' ')

    return [
      `standing_on: ${s.standingOn}`,
      `hazards: ${s.hazardSummary}`,
      `risk: ${s.locomotionRisk}/10${flags ? ' ' + flags : ''}`,
      `movement: ${travLines}`,
      `escape: ${s.escapeVector.label}`,
    ].join(' | ')
  }

  // Returns an explicitly-invalid scan result. Callers must check valid===false before
  // trusting any fields — in particular locomotionRisk and escapeVector are meaningless.
  function _invalid(reason) {
    return {
      valid:               false,
      reason,
      hazards:             [],
      hazardSummary:       'position_invalid',
      traversability:      { N:'unknown', S:'unknown', E:'unknown', W:'unknown' },
      escapeVector:        { direction:'N', label:'north', dx:0, dz:-1, score:0 },
      standingOn:          'unknown',
      feetBlock:           'unknown',
      headBlock:           'unknown',
      locomotionRisk:      null,
      isEnclosed:          false,
      cliffNearby:         false,
      cliffDirection:      null,
      stuckClass:          'unknown',
      nearbyBlocksCompact: [],
      hazardMemorySize:    hazardMemory.length,
    }
  }

  function getHazardMemory() { return [...hazardMemory] }

  return { scan, getLLMContext, recordHazardPosition, isKnownHazard, getHazardMemory }
}
