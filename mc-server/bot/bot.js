const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')

const { loadMemory, rememberLocation, rememberEvent, rememberKnowledge, recallLocation } = require('./memory')
const { buildGroundedState, chatSummary, HOSTILE_MOB_NAMES } = require('./state')
const { classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal } = require('./engine')
const { queryLLM, checkOllama } = require('./llm')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Ember',
  version: '1.21.4',
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)

// ── Internal State ─────────────────────────────────────────────────────────────
const state = {
  energy: 100,
  hunger: 100,
  goal: 'idle',   // idle | resting | following | exploring | gathering | going_to | attacking | collecting | crafting | building
  idleTicks: 0,
}

const memory   = loadMemory()
let llmEnabled = false
let llmBusy    = false
let taskBusy   = false

// ── Boot ───────────────────────────────────────────────────────────────────────

bot.once('spawn', async () => {
  console.log('[Ember] Spawned.')
  llmEnabled = await checkOllama()
  console.log(`[Ember] Ollama: ${llmEnabled ? 'connected' : 'offline — using fallback'}`)

  bot.chat(llmEnabled ? 'Ready.' : 'LLM offline — using commands.')
  rememberLocation(memory, 'spawn', bot.entity.position)
  rememberEvent(memory, 'spawned', {})

  startStateLoop()
  startAgentLoop()
})

// ── Task Runner ────────────────────────────────────────────────────────────────

function runTask(goalName, fn) {
  if (taskBusy) return false
  taskBusy = true
  state.goal = goalName
  state.idleTicks = 0

  fn().catch(err => {
    console.log(`[Ember] task ${goalName} stopped: ${err.message}`)
    bot.pathfinder.stop()
    bot.clearControlStates()
  }).finally(() => {
    taskBusy = false
    bot.clearControlStates()
    if (state.goal === goalName) state.goal = 'idle'
  })

  return true
}

// ── Helper: get log block IDs ──────────────────────────────────────────────────

const LOG_NAMES = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log']
const logIds    = () => LOG_NAMES.map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)

// ── Helper: navigate close to a position ──────────────────────────────────────

async function navNear(x, y, z, range = 3) {
  const mvmt = new Movements(bot)
  bot.pathfinder.setMovements(mvmt)
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
}

// ── Task: Explore ──────────────────────────────────────────────────────────────

async function taskExplore() {
  const angle = Math.random() * Math.PI * 2
  const dist  = 25 + Math.random() * 30
  const p     = bot.entity.position
  const tx    = Math.floor(p.x + Math.sin(angle) * dist)
  const tz    = Math.floor(p.z + Math.cos(angle) * dist)
  console.log(`[Ember] Exploring → (${tx}, _, ${tz})`)
  await navNear(tx, p.y, tz)
  rememberLocation(memory, 'last_explored', bot.entity.position)
}

// ── Task: Gather Wood ──────────────────────────────────────────────────────────

async function taskGatherWood() {
  const ids = logIds()
  const log = bot.findBlock({ matching: ids, maxDistance: 32 })
  if (!log) { bot.chat('No trees in range.'); return }
  console.log(`[Ember] Chopping log at ${log.position}`)
  await navNear(log.position.x, log.position.y, log.position.z, 2)
  const fresh = bot.blockAt(log.position)
  if (fresh && ids.includes(fresh.type) && bot.canDigBlock(fresh)) {
    await bot.dig(fresh)
    bot.chat('Got some wood.')
    rememberEvent(memory, 'gathered_wood', {})
  }
}

// ── Task: Go To Location ───────────────────────────────────────────────────────

async function taskGoTo(name) {
  const loc = recallLocation(memory, name)
  if (!loc) { bot.chat(`Don't know where ${name} is.`); return }
  console.log(`[Ember] Going to ${name}`)
  await navNear(loc.pos.x, loc.pos.y, loc.pos.z)
  bot.chat(`Reached ${name}.`)
  rememberEvent(memory, 'visited', { name })
}

// ── Task: Attack Hostile Mobs ──────────────────────────────────────────────────

async function taskAttackMobs() {
  const mob = bot.nearestEntity(e =>
    e.name && HOSTILE_MOB_NAMES.has(e.name) && e.position.distanceTo(bot.entity.position) < 20
  )

  if (!mob) { bot.chat('No hostile mobs nearby.'); return }

  // Equip best available weapon
  const weapons = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe',
  ]
  for (const w of weapons) {
    const itemId = bot.registry.itemsByName[w]?.id
    const item   = itemId ? bot.inventory.findInventoryItem(itemId, null, false) : null
    if (item) { await bot.equip(item, 'hand'); break }
  }

  console.log(`[Ember] Attacking ${mob.name}`)
  bot.chat(`Fighting ${mob.name}.`)
  bot.pvp.attack(mob)

  await new Promise(resolve => bot.once('stoppedAttacking', resolve))

  const result = mob.isValid ? 'Target got away.' : 'Target down.'
  bot.chat(result)
  rememberEvent(memory, 'combat', { mob: mob.name, result })
}

// ── Task: Collect Dropped Items ────────────────────────────────────────────────

async function taskCollectNearby() {
  const pos = bot.entity.position
  const drops = Object.values(bot.entities)
    .filter(e => e.type === 'object' && e.objectType === 'Item' && e.position.distanceTo(pos) < 25)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .slice(0, 10)

  if (!drops.length) { bot.chat('No items on the ground nearby.'); return }

  bot.chat(`Collecting ${drops.length} item(s).`)
  for (const entity of drops) {
    if (!entity.isValid) continue
    try {
      await navNear(entity.position.x, entity.position.y, entity.position.z, 1)
    } catch {}
    await new Promise(r => setTimeout(r, 300))  // wait for auto-pickup tick
  }

  const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ')
  bot.chat(inv ? `Picked up. Have: ${inv}` : 'Nothing picked up.')
  rememberEvent(memory, 'collected_items', {})
}

// ── Task: Craft Item ───────────────────────────────────────────────────────────

async function taskCraftItem(itemName) {
  const normalized = itemName.replace(/ /g, '_').toLowerCase()
  const itemData   = bot.registry.itemsByName[normalized]

  if (!itemData) {
    bot.chat(`Don't know how to make "${itemName}".`)
    return
  }

  // Try 2x2 inventory crafting first
  let recipes       = bot.recipesFor(itemData.id, null, 1, null)
  let craftingTable = null

  if (!recipes.length) {
    // Find a crafting table for 3x3 recipes
    const tableId    = bot.registry.blocksByName['crafting_table']?.id
    const tableBlock = tableId ? bot.findBlock({ matching: [tableId], maxDistance: 20 }) : null

    if (tableBlock) {
      craftingTable = tableBlock
      await navNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 2)
      recipes = bot.recipesFor(itemData.id, null, 1, tableBlock)
    }

    if (!recipes.length) {
      // Auto-craft a crafting table if we have logs
      const logsHave = bot.inventory.items().filter(i => LOG_NAMES.includes(i.name))
      if (logsHave.length > 0) {
        bot.chat('No crafting table nearby. Need to make one first.')
      } else {
        bot.chat(`Can't craft "${itemName}" — missing materials or crafting table.`)
      }
      return
    }
  }

  try {
    await bot.craft(recipes[0], 1, craftingTable)
    bot.chat(`Crafted ${itemName}.`)
    rememberEvent(memory, 'crafted', { item: itemName })
  } catch (err) {
    bot.chat(`Crafting failed: not enough materials.`)
    console.error('[Ember] Craft error:', err.message)
  }
}

// ── Task: Build House ──────────────────────────────────────────────────────────

const PLANK_NAMES = ['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks']

async function placeBlockAt(targetPos, blockName) {
  const current = bot.blockAt(targetPos)
  if (current && current.name !== 'air' && current.name !== 'cave_air') return true

  const itemId = bot.registry.itemsByName[blockName]?.id
  const item   = itemId ? bot.inventory.findInventoryItem(itemId, null, false) : null
  if (!item) return false

  await bot.equip(item, 'hand')

  // Try each adjacent direction — find an existing solid block to place against
  const adj = [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
  for (const [dx, dy, dz] of adj) {
    const refBlock = bot.blockAt(targetPos.offset(dx, dy, dz))
    if (!refBlock || refBlock.boundingBox !== 'block') continue
    try {
      await navNear(targetPos.x, targetPos.y, targetPos.z, 4)
      const faceVec = targetPos.minus(refBlock.position)
      await bot.placeBlock(refBlock, faceVec)
      return true
    } catch {}
  }
  return false
}

async function taskBuildHouse() {
  // Count available planks
  const planks      = bot.inventory.items().filter(i => PLANK_NAMES.includes(i.name))
  const plankCount  = planks.reduce((s, i) => s + i.count, 0)

  if (plankCount < 30) {
    bot.chat(`Need ~30 planks. Have ${plankCount}. Gather more wood and craft planks first.`)
    return
  }

  const plankName = planks[0].name
  // Build 5 blocks north of current position (so bot starts outside)
  const origin = bot.entity.position.floored().offset(0, 0, -5)
  bot.chat('Building a house...')
  console.log(`[Ember] Building house centered at ${origin}`)

  let outOfBlocks = false

  // Walls: 5x5 perimeter, y+1 to y+3, with door gap at front (z-2, x=0, y<=2)
  for (let y = 1; y <= 3 && !outOfBlocks; y++) {
    for (let x = -2; x <= 2 && !outOfBlocks; x++) {
      for (let z = -2; z <= 2 && !outOfBlocks; z++) {
        if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue   // skip interior
        if (z === -2 && x === 0 && y <= 2) continue             // door gap

        const ok = await placeBlockAt(origin.offset(x, y, z), plankName)
        if (!ok) {
          const left = bot.inventory.items().filter(i => i.name === plankName).reduce((s, i) => s + i.count, 0)
          if (left === 0) { bot.chat('Ran out of planks.'); outOfBlocks = true }
        }
      }
    }
  }

  // Roof: full 5x5 at y+4
  for (let x = -2; x <= 2 && !outOfBlocks; x++) {
    for (let z = -2; z <= 2 && !outOfBlocks; z++) {
      const ok = await placeBlockAt(origin.offset(x, 4, z), plankName)
      if (!ok) {
        const left = bot.inventory.items().filter(i => i.name === plankName).reduce((s, i) => s + i.count, 0)
        if (left === 0) { bot.chat('Ran out of planks on the roof.'); outOfBlocks = true }
      }
    }
  }

  if (!outOfBlocks) {
    bot.chat('House done!')
    rememberLocation(memory, 'house', origin)
    rememberEvent(memory, 'built_house', {})
  }
}

// ── Autonomous Idle Behavior ───────────────────────────────────────────────────

const IDLE_THRESHOLD = 20

function tryAutonomous() {
  if (taskBusy || state.goal !== 'idle' || state.energy < 40) return

  state.idleTicks++
  if (state.idleTicks < IDLE_THRESHOLD) return
  state.idleTicks = 0

  const gs     = buildGroundedState(bot, state, memory)
  const choice = selectAutonomousGoal(gs)

  if (choice) {
    bot.chat(choice.say)
    if      (choice.action === 'explore')       runTask('exploring',  taskExplore)
    else if (choice.action === 'gather_wood')   runTask('gathering',  taskGatherWood)
    else if (choice.action === 'attack_mobs')   runTask('attacking',  taskAttackMobs)
    else if (choice.action === 'collect_items') runTask('collecting', taskCollectNearby)
  } else {
    const summary = chatSummary(gs)
    bot.chat(summary ? `I see: ${summary}` : 'All quiet.')
  }
}

// ── State Loop (1 s) ───────────────────────────────────────────────────────────

function startStateLoop() {
  setInterval(() => {
    state.hunger = Math.max(0, state.hunger - 0.2)

    const active = ['following','exploring','gathering','going_to','attacking','collecting','crafting','building'].includes(state.goal)
    state.energy = active
      ? Math.max(0, state.energy - 1.2)
      : Math.min(100, state.energy + 2)

    if (state.energy <= 15 && active) {
      taskBusy = false
      bot.pathfinder.stop()
      if (bot.pvp) bot.pvp.stop()
      bot.clearControlStates()
      state.goal = 'resting'
      bot.chat('Need to rest...')
      rememberEvent(memory, 'exhausted', {})
    }

    if (state.goal === 'resting' && state.energy >= 80) {
      state.goal = 'idle'
      bot.chat('Rested. Ready.')
    }

    if (state.hunger < 20 && state.hunger > 19.8) {
      bot.chat('Getting hungry...')
    }

    tryAutonomous()
    console.log(`[Ember] goal=${state.goal} E=${state.energy.toFixed(0)} H=${state.hunger.toFixed(0)} idle=${state.idleTicks} busy=${taskBusy}`)
  }, 1000)
}

// ── Agent Loop (250 ms) ────────────────────────────────────────────────────────

function startAgentLoop() {
  let prevGoal = 'idle'

  setInterval(() => {
    const player = getNearestPlayer()
    if (player) bot.lookAt(player.entity.position.offset(0, player.entity.height, 0))

    // Water survival
    if (bot.entity.isInWater) {
      bot.pathfinder.stop()
      bot.clearControlStates()
      bot.setControlState('jump', true)
      prevGoal = state.goal
      return
    }

    // Follow with dynamic pathfinder goal
    if (state.goal === 'following') {
      if (!player) {
        bot.pathfinder.stop()
        bot.clearControlStates()
        state.goal = 'idle'
        bot.chat('Lost you.')
      } else if (prevGoal !== 'following') {
        const mvmt = new Movements(bot)
        bot.pathfinder.setMovements(mvmt)
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true)
      }
    }

    if (prevGoal === 'following' && state.goal !== 'following') {
      bot.pathfinder.stop()
      bot.clearControlStates()
    }

    prevGoal = state.goal
  }, 250)
}

function getNearestPlayer() {
  let nearest = null, minDist = Infinity
  for (const name in bot.players) {
    if (name === bot.username) continue
    const p = bot.players[name]
    if (!p.entity) continue
    const d = bot.entity.position.distanceTo(p.entity.position)
    if (d < minDist) { minDist = d; nearest = { name, entity: p.entity, dist: d } }
  }
  return nearest
}

// ── Decision Pipeline ──────────────────────────────────────────────────────────

async function handleMessage(username, message) {
  if (llmBusy) { bot.chat('Hold on...'); return }
  llmBusy = true

  try {
    const intent = classifyIntent(message)
    console.log(`[Engine] intent=${intent} message="${message}"`)

    // Survival short-circuit
    const survivalBlock = evaluateSurvival(state)
    if (survivalBlock && ['follow','gather','explore','attack','collect','build'].includes(intent)) {
      bot.chat(survivalBlock.say)
      return
    }

    const groundedState = buildGroundedState(bot, state, memory)

    let result
    try {
      const raw = await queryLLM(groundedState, intent, message)
      result = validateLLMOutput(raw)
      if (!result) {
        console.warn('[Engine] LLM invalid, fallback:', JSON.stringify(raw))
        result = safeDefault(intent)
      }
    } catch (err) {
      console.error('[Engine] LLM error:', err.message)
      result = safeDefault(intent)
    }

    console.log(`[Engine] decision=${result.decision} action=${result.action} | "${result.reason}"`)

    executeAction(result, username, groundedState)
    bot.chat(result.say)

    if (result.action !== 'none') {
      rememberEvent(memory, 'acted', { intent, action: result.action, decision: result.decision })
    }
  } finally {
    llmBusy = false
  }
}

// ── Safe Action Map ────────────────────────────────────────────────────────────

function executeAction(result, username, groundedState) {
  if (result.decision !== 'accept') return

  // Hard energy guard
  if (['follow','explore','gather_wood','attack_mobs','collect_items','build_house'].includes(result.action) && state.energy < 25) {
    result.say = 'Too tired right now.'
    return
  }

  // Task busy guard
  const taskActions = ['explore','gather_wood','go_to','attack_mobs','collect_items','craft','build_house']
  if (taskActions.includes(result.action) && taskBusy) {
    result.say = "Still busy — give me a sec."
    return
  }

  switch (result.action) {

    case 'follow':
      state.goal = 'following'
      state.idleTicks = 0
      rememberKnowledge(memory, 'following_player', username)
      break

    case 'stop':
      taskBusy = false
      bot.pathfinder.stop()
      bot.pvp.stop()
      bot.clearControlStates()
      state.goal = 'idle'
      break

    case 'explore':
      runTask('exploring', taskExplore)
      break

    case 'gather_wood': {
      const hasLogs = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
      if (!hasLogs) { result.say = 'No trees in range.'; return }
      runTask('gathering', taskGatherWood)
      break
    }

    case 'go_to':
      if (result.target) runTask('going_to', () => taskGoTo(result.target))
      break

    case 'remember_here':
      rememberLocation(memory, `${username}_mark`, bot.entity.position)
      break

    case 'attack_mobs': {
      if (!groundedState.hostileMobs.length) { result.say = 'No hostile mobs visible.'; return }
      runTask('attacking', taskAttackMobs)
      break
    }

    case 'collect_items': {
      if (groundedState.droppedCount === 0) { result.say = 'No items on the ground.'; return }
      runTask('collecting', taskCollectNearby)
      break
    }

    case 'craft': {
      const itemName = result.target || 'crafting_table'
      runTask('crafting', () => taskCraftItem(itemName))
      break
    }

    case 'build_house':
      runTask('building', taskBuildHouse)
      break

    case 'none':
    default:
      break
  }
}

// ── Fallback Commands (LLM offline) ───────────────────────────────────────────

function fallbackCommand(username, message) {
  const cmd = message.trim().toLowerCase()

  if (cmd === 'follow me')                            { if (state.energy < 25) { bot.chat('Too tired.'); return }; state.goal = 'following'; bot.chat('Following.') }
  else if (cmd === 'stop')                            { taskBusy = false; bot.pathfinder.stop(); bot.pvp.stop(); bot.clearControlStates(); state.goal = 'idle'; bot.chat('Stopped.') }
  else if (cmd === 'status')                          { bot.chat(`Goal: ${state.goal} | E:${state.energy.toFixed(0)} H:${state.hunger.toFixed(0)}`) }
  else if (cmd === 'explore')                         { if (!runTask('exploring', taskExplore)) bot.chat("Busy."); else bot.chat('Exploring.') }
  else if (cmd === 'get wood' || cmd === 'chop tree') { if (!runTask('gathering', taskGatherWood)) bot.chat("Busy."); else bot.chat('Getting wood.') }
  else if (cmd === 'attack' || cmd === 'fight')       { if (!runTask('attacking', taskAttackMobs)) bot.chat("Busy.") }
  else if (cmd === 'collect' || cmd === 'pick up')    { if (!runTask('collecting', taskCollectNearby)) bot.chat("Busy.") }
  else if (cmd === 'build house')                     { if (!runTask('building', taskBuildHouse)) bot.chat("Busy.") }
  else if (cmd === 'look around') { const gs = buildGroundedState(bot, state, memory); bot.chat(`I see: ${chatSummary(gs) || 'nothing notable'}`) }
  else if (cmd === 'inventory')   { const items = bot.inventory.items(); bot.chat(items.length ? items.map(i => `${i.name}x${i.count}`).join(', ') : 'Empty.') }
  else {
    const craftMatch = cmd.match(/^craft (.+)$/)
    if (craftMatch) { if (!runTask('crafting', () => taskCraftItem(craftMatch[1]))) bot.chat("Busy."); return }

    const whereMatch = cmd.match(/^where is (.+)$/)
    if (whereMatch) { const loc = recallLocation(memory, whereMatch[1].trim()); bot.chat(loc ? `${whereMatch[1]}: ${loc.pos.x}, ${loc.pos.y}, ${loc.pos.z}` : `Don't know.`); return }

    const goMatch = cmd.match(/^go to (.+)$/)
    if (goMatch) { if (!runTask('going_to', () => taskGoTo(goMatch[1].trim()))) bot.chat("Busy."); else bot.chat(`Going to ${goMatch[1]}.`) }
  }
}

// ── Chat Entry ─────────────────────────────────────────────────────────────────

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  if (llmEnabled) handleMessage(username, message)
  else fallbackCommand(username, message)
})

bot.on('error', err => console.error('[Ember] Error:', err.message))
bot.on('end', reason => { console.log('[Ember] Disconnected:', reason); process.exit(0) })
