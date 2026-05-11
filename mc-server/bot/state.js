// state.js — Grounded State Builder
// ONLY returns facts verifiable from bot APIs. No inference. No assumptions.

const SCAN_TYPES = [
  'oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log',
  'sand','gravel','stone','iron_ore','coal_ore','water','crafting_table','chest','dirt','grass_block',
]

const HOSTILE_MOB_NAMES = new Set([
  'zombie','skeleton','creeper','spider','cave_spider','witch','phantom','drowned','husk','stray',
  'pillager','evoker','vex','vindicator','slime','magma_cube','silverfish','endermite',
  'guardian','elder_guardian','warden','hoglin','piglin_brute','zoglin','blaze','ghast',
  'ravager','shulker','zombified_piglin','enderman',
])

function buildGroundedState(bot, state, memory, anger = new Map(), perception = null) {
  const pos = bot.entity.position

  // REAL inventory — only what bot.inventory.items() returns right now
  const rawItems = bot.inventory.items()
  const inventory = rawItems.slice(0, 10).map(i => `${i.name}x${i.count}`)

  // REAL nearby blocks — only what bot.findBlock() can confirm
  const nearbyBlocks = []
  for (const typeName of SCAN_TYPES) {
    const id = bot.registry.blocksByName[typeName]?.id
    if (!id) continue
    const block = bot.findBlock({ matching: [id], maxDistance: 20 })
    if (block) {
      nearbyBlocks.push({
        type: typeName,
        dist: Math.floor(block.position.distanceTo(pos)),
      })
    }
  }
  nearbyBlocks.sort((a, b) => a.dist - b.dist)

  // REAL visible entities — only from bot.entities
  const entities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.name && e.position.distanceTo(pos) < 20)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .slice(0, 5)
    .map(e => ({ name: e.name, dist: Math.floor(e.position.distanceTo(pos)) }))

  // REAL hostile mobs — confirmed from bot.entities
  const hostileMobs = Object.values(bot.entities)
    .filter(e => e.name && HOSTILE_MOB_NAMES.has(e.name) && e.position.distanceTo(pos) < 20)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .slice(0, 3)
    .map(e => ({ name: e.name, dist: Math.floor(e.position.distanceTo(pos)) }))

  // REAL dropped items on ground — item entities from server
  const droppedItems = Object.values(bot.entities)
    .filter(e => e.type === 'object' && e.objectType === 'Item' && e.position.distanceTo(pos) < 20)
  const droppedCount = droppedItems.length

  // Environmental perception — scan on demand; null if unavailable or errors
  let envScan = null
  if (perception) {
    try {
      envScan = perception.scan()
    } catch (err) {
      // Gracefully degrade if perception scan fails
      envScan = null
    }
  }

  return {
    self: {
      hp:     bot.health,                // real Minecraft HP  (0–20)
      food:   bot.food,                  // real Minecraft food (0–20)
      energy: Math.floor(state.energy),  // hp mapped to 0-100 for engine compatibility
      hunger: Math.floor(state.hunger),  // food mapped to 0-100 for engine compatibility
      goal: state.goal,
      pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    },
    inventory,          // from bot.inventory.items()   — real
    nearbyBlocks,       // from bot.findBlock()          — real
    entities,           // from bot.entities             — real
    hostileMobs,        // filtered to known hostile names — real
    droppedCount,       // item entities on ground count  — real
    anger: Array.from(anger.entries()).map(([name, rec]) => ({ name, level: rec.level })),
    knownLocations: memory.locations.slice(-5).map(l => ({ name: l.name, pos: l.pos })),
    environment: envScan,          // real-time spatial perception (null if unavailable)
  }
}

// One-line text summary for autonomous narration
function chatSummary(gs) {
  const parts = []
  if (gs.nearbyBlocks.length) {
    parts.push(gs.nearbyBlocks.slice(0, 3).map(b => `${b.type}@${b.dist}m`).join(', '))
  } else {
    parts.push('nothing notable nearby')
  }
  if (gs.hostileMobs.length) {
    parts.push(`HOSTILE: ${gs.hostileMobs.map(m => `${m.name}@${m.dist}m`).join(', ')}`)
  } else if (gs.entities.length) {
    parts.push(gs.entities.map(e => `${e.name}@${e.dist}m`).join(', '))
  }
  if (gs.droppedCount > 0) parts.push(`${gs.droppedCount} item(s) on ground`)
  return parts.join('; ')
}

module.exports = { buildGroundedState, chatSummary, HOSTILE_MOB_NAMES }
