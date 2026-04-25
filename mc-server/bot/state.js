// state.js — Grounded State Builder
// ONLY returns facts verifiable from bot APIs. No inference. No assumptions.

const SCAN_TYPES = [
  'oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log',
  'sand','gravel','stone','iron_ore','coal_ore','water','crafting_table','chest','dirt','grass_block',
]

function buildGroundedState(bot, state, memory) {
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

  // REAL visible entities — only from bot.entities (what server told us exists)
  const entities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.name && e.position.distanceTo(pos) < 20)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .slice(0, 5)
    .map(e => ({ name: e.name, dist: Math.floor(e.position.distanceTo(pos)) }))

  return {
    self: {
      energy: Math.floor(state.energy),
      hunger: Math.floor(state.hunger),
      goal: state.goal,
      pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    },
    inventory,       // from bot.inventory.items()  — real
    nearbyBlocks,    // from bot.findBlock()         — real
    entities,        // from bot.entities            — real
    knownLocations: memory.locations.slice(-5).map(l => ({ name: l.name, pos: l.pos })),
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
  if (gs.entities.length) {
    parts.push(gs.entities.map(e => `${e.name}@${e.dist}m`).join(', '))
  }
  return parts.join('; ')
}

module.exports = { buildGroundedState, chatSummary }
