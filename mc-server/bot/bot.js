const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: pvp } = require('mineflayer-pvp')

const { loadMemory, rememberLocation, rememberEvent, rememberKnowledge, recallLocation } = require('./memory')
const { buildGroundedState, chatSummary, HOSTILE_MOB_NAMES } = require('./state')
const { classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal, detectInsult } = require('./engine')
const { queryLLM, checkOllama, getModelName } = require('./llm')

// ── Configuration via env ─────────────────────────────────────────────────────
const BOT_NAME    = process.env.BOT_NAME    || 'Ember'
const SERVER_HOST = process.env.SERVER_HOST || 'localhost'
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '25565', 10)
const MC_VERSION  = process.env.MC_VERSION  || '1.21.4'

const bot = mineflayer.createBot({
  host:     SERVER_HOST,
  port:     SERVER_PORT,
  username: BOT_NAME,
  version:  MC_VERSION,
})

bot.loadPlugin(pathfinder)
bot.loadPlugin(pvp)

// ── Internal State ─────────────────────────────────────────────────────────────
const state = {
  energy: 100,
  hunger: 100,
  goal: 'idle',
  idleTicks: 0,
}

const memory   = loadMemory()
const anger    = new Map()  // username → { level, count, lastAt }
let llmEnabled = false
let llmBusy    = false
let taskBusy   = false

// ── Utility: safe chat (errors must always be visible in-game) ────────────────
function safeChat(msg) {
  try { bot.chat(String(msg).slice(0, 200)) } catch (e) { console.error('chat error:', e.message) }
}

// ── Boot ───────────────────────────────────────────────────────────────────────
bot.once('spawn', async () => {
  console.log(`[${BOT_NAME}] Spawned at ${bot.entity.position}`)
  llmEnabled = await checkOllama()
  console.log(`[${BOT_NAME}] Model: ${getModelName()} | Ollama: ${llmEnabled ? 'connected ✓' : 'OFFLINE ✗'}`)

  safeChat(llmEnabled ? `${BOT_NAME} online (${getModelName()}).` : 'LLM offline — using fallback commands.')
  rememberLocation(memory, 'spawn', bot.entity.position)
  rememberEvent(memory, 'spawned', { model: getModelName() })

  startStateLoop()
  startAgentLoop()
  startThreatLoop()
  startAngerDecay()
})

// ── Anger / Defense System ────────────────────────────────────────────────────

const ANGER_INSULT       = 1
const ANGER_HIT          = 4
const ANGER_THRESHOLD    = 3   // warn at this level
const ANGER_ATTACK_LEVEL = 5   // attack at this level
const ANGER_DECAY_PER_S  = 0.05

function bumpAnger(username, amount, reason) {
  const rec = anger.get(username) || { level: 0, count: 0, lastAt: 0 }
  rec.level   += amount
  rec.count   += 1
  rec.lastAt   = Date.now()
  rec.reason   = reason
  anger.set(username, rec)
  console.log(`[${BOT_NAME}] anger ${username} → ${rec.level.toFixed(1)} (${reason})`)
  return rec
}

function startAngerDecay() {
  setInterval(() => {
    for (const [name, rec] of anger.entries()) {
      rec.level = Math.max(0, rec.level - ANGER_DECAY_PER_S)
      if (rec.level <= 0.1) anger.delete(name)
    }
  }, 1000)
}

function maybeAttackForAnger(username) {
  const rec = anger.get(username)
  if (!rec) return false
  if (rec.level < ANGER_ATTACK_LEVEL) return false
  if (state.energy < 20) return false
  if (taskBusy && state.goal !== 'attacking') return false

  const player = bot.players[username]
  if (!player?.entity) return false

  safeChat(`That's it, ${username}. I warned you.`)
  runTask('attacking', () => taskAttackPlayer(player.entity, username))
  return true
}

bot.on('entityHurt', (entity) => {
  if (entity !== bot.entity) return

  const pos = bot.entity.position
  // 1. Player attacker?
  let attacker = null, minDist = 5
  for (const name in bot.players) {
    if (name === BOT_NAME) continue
    const p = bot.players[name]
    if (!p.entity) continue
    const d = p.entity.position.distanceTo(pos)
    if (d < minDist) { minDist = d; attacker = { name, entity: p.entity } }
  }

  if (attacker) {
    bumpAnger(attacker.name, ANGER_HIT, 'attacked me')
    safeChat(`Stop hitting me, ${attacker.name}!`)
    maybeAttackForAnger(attacker.name)
    return
  }

  // 2. Mob attacker?
  const mob = bot.nearestEntity(e =>
    e.name && HOSTILE_MOB_NAMES.has(e.name) && e.position.distanceTo(pos) < 6
  )
  if (mob && !taskBusy) {
    safeChat(`A ${mob.name} attacked me. Fighting back.`)
    runTask('attacking', () => taskAttackMobs())
  }
})

bot.on('death', () => {
  safeChat('I died. Respawning...')
  state.energy = 100
  state.hunger = 100
  state.goal = 'idle'
  taskBusy = false
})

bot.on('respawn', () => {
  console.log(`[${BOT_NAME}] respawned at ${bot.entity.position}`)
  safeChat("I'm back. That hurt.")
})

// ── Task Runner (errors to chat) ──────────────────────────────────────────────

function runTask(goalName, fn) {
  if (taskBusy) return false
  taskBusy = true
  state.goal = goalName
  state.idleTicks = 0

  fn().catch(err => {
    console.error(`[${BOT_NAME}] task ${goalName} error:`, err.message)
    safeChat(`Error in ${goalName}: ${err.message.slice(0, 80)}`)
    try { bot.pathfinder.stop() } catch {}
    try { bot.pvp.stop() } catch {}
    bot.clearControlStates()
  }).finally(() => {
    taskBusy = false
    bot.clearControlStates()
    if (state.goal === goalName) state.goal = 'idle'
  })

  return true
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const LOG_NAMES   = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log']
const PLANK_NAMES = ['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks']

const logIds   = () => LOG_NAMES.map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
const plankIds = () => PLANK_NAMES.map(n => bot.registry.itemsByName[n]?.id).filter(Boolean)

function countInInv(names) {
  return bot.inventory.items()
    .filter(i => names.includes(i.name))
    .reduce((s, i) => s + i.count, 0)
}

async function navNear(x, y, z, range = 3) {
  const mvmt = new Movements(bot)
  bot.pathfinder.setMovements(mvmt)
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, range))
}

async function equipBestWeapon() {
  const weapons = [
    'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
    'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe',
  ]
  for (const w of weapons) {
    const id = bot.registry.itemsByName[w]?.id
    const item = id ? bot.inventory.findInventoryItem(id, null, false) : null
    if (item) { await bot.equip(item, 'hand'); return w }
  }
  return null
}

// ── TASKS ─────────────────────────────────────────────────────────────────────

async function taskExplore() {
  const angle = Math.random() * Math.PI * 2
  const dist  = 25 + Math.random() * 30
  const p     = bot.entity.position
  const tx    = Math.floor(p.x + Math.sin(angle) * dist)
  const tz    = Math.floor(p.z + Math.cos(angle) * dist)
  console.log(`[${BOT_NAME}] Exploring → (${tx}, _, ${tz})`)
  await navNear(tx, p.y, tz)
  rememberLocation(memory, 'last_explored', bot.entity.position)
}

async function taskGatherWood() {
  const ids = logIds()
  const log = bot.findBlock({ matching: ids, maxDistance: 50 })
  if (!log) { safeChat('No trees in range.'); return }
  console.log(`[${BOT_NAME}] Chopping log at ${log.position}`)
  await navNear(log.position.x, log.position.y, log.position.z, 2)
  const fresh = bot.blockAt(log.position)
  if (fresh && ids.includes(fresh.type) && bot.canDigBlock(fresh)) {
    await bot.dig(fresh)
    safeChat('Got wood.')
    rememberEvent(memory, 'gathered_wood', {})
  }
}

async function taskCraftPlanks() {
  const logs = bot.inventory.items().filter(i => LOG_NAMES.includes(i.name))
  if (!logs.length) { safeChat('No logs to convert.'); return }

  let totalCrafted = 0
  for (const log of logs) {
    const plankName = log.name.replace('_log', '_planks')
    const plankId = bot.registry.itemsByName[plankName]?.id
    if (!plankId) continue

    const recipes = bot.recipesFor(plankId, null, 1, null)
    if (!recipes.length) continue

    try {
      const count = log.count
      await bot.craft(recipes[0], count, null)
      totalCrafted += count * 4
    } catch (err) {
      console.error(`[${BOT_NAME}] Plank craft failed:`, err.message)
    }
  }

  if (totalCrafted > 0) {
    safeChat(`Made ${totalCrafted} planks.`)
    rememberEvent(memory, 'crafted_planks', { count: totalCrafted })
  } else {
    safeChat('Could not make planks.')
  }
}

async function taskGoTo(name) {
  const loc = recallLocation(memory, name)
  if (!loc) { safeChat(`Don't know where "${name}" is.`); return }
  console.log(`[${BOT_NAME}] Going to ${name}`)
  await navNear(loc.pos.x, loc.pos.y, loc.pos.z)
  safeChat(`Reached ${name}.`)
  rememberEvent(memory, 'visited', { name })
}

async function taskAttackMobs() {
  const mob = bot.nearestEntity(e =>
    e.name && HOSTILE_MOB_NAMES.has(e.name) && e.position.distanceTo(bot.entity.position) < 20
  )
  if (!mob) { safeChat('No hostile mobs nearby.'); return }

  const weapon = await equipBestWeapon()
  console.log(`[${BOT_NAME}] Attacking ${mob.name} with ${weapon || 'fists'}`)
  safeChat(`Fighting ${mob.name}.`)
  bot.pvp.attack(mob)
  await new Promise(r => bot.once('stoppedAttacking', r))

  if (mob.isValid) safeChat('Got away.')
  else            { safeChat(`${mob.name} down.`); rememberEvent(memory, 'killed_mob', { name: mob.name }) }
}

async function taskAttackPlayer(entity, username) {
  if (!entity || !entity.isValid) { safeChat(`${username} is gone.`); return }

  const weapon = await equipBestWeapon()
  console.log(`[${BOT_NAME}] Attacking player ${username} with ${weapon || 'fists'}`)
  safeChat(`Coming for you, ${username}.`)
  bot.pvp.attack(entity)
  await new Promise(r => bot.once('stoppedAttacking', r))

  // Reduce anger after fighting
  const rec = anger.get(username)
  if (rec) rec.level = Math.max(0, rec.level - 3)
  safeChat('We even now.')
  rememberEvent(memory, 'fought_player', { username })
}

async function taskCollectNearby() {
  const pos = bot.entity.position
  const drops = Object.values(bot.entities)
    .filter(e => e.type === 'object' && e.objectType === 'Item' && e.position.distanceTo(pos) < 25)
    .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))
    .slice(0, 10)

  if (!drops.length) { safeChat('No items nearby.'); return }

  safeChat(`Collecting ${drops.length} item(s).`)
  for (const e of drops) {
    if (!e.isValid) continue
    try { await navNear(e.position.x, e.position.y, e.position.z, 1) } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  rememberEvent(memory, 'collected_items', {})
}

async function taskCraftItem(itemName) {
  const normalized = itemName.replace(/ /g, '_').toLowerCase()
  const itemData   = bot.registry.itemsByName[normalized]

  if (!itemData) { safeChat(`Don't know what "${itemName}" is.`); return }

  let recipes = bot.recipesFor(itemData.id, null, 1, null)
  let table   = null

  if (!recipes.length) {
    const tableId = bot.registry.blocksByName['crafting_table']?.id
    table = tableId ? bot.findBlock({ matching: [tableId], maxDistance: 20 }) : null
    if (table) {
      await navNear(table.position.x, table.position.y, table.position.z, 2)
      recipes = bot.recipesFor(itemData.id, null, 1, table)
    }
    if (!recipes.length) { safeChat(`Can't craft "${itemName}" — missing materials or table.`); return }
  }

  await bot.craft(recipes[0], 1, table)
  safeChat(`Crafted ${itemName}.`)
  rememberEvent(memory, 'crafted', { item: itemName })
}

// ── Smart agentic house building ──────────────────────────────────────────────
// Auto-chains: gather wood → craft planks → place blocks

async function taskBuildHouseSmart() {
  safeChat('Starting house. Will gather and craft if needed.')

  let plankCount = countInInv(PLANK_NAMES)

  // Step 1: convert any logs to planks
  if (countInInv(LOG_NAMES) > 0) {
    await taskCraftPlanks()
    plankCount = countInInv(PLANK_NAMES)
  }

  // Step 2: while not enough, gather more wood and craft
  let attempts = 0
  while (plankCount < 30 && attempts < 12) {
    attempts++
    const stillNeed = 30 - plankCount
    const logsNeeded = Math.ceil(stillNeed / 4)

    safeChat(`Have ${plankCount} planks, need ${30 - plankCount} more. Gathering wood (try ${attempts}/12).`)

    let chopped = 0
    while (chopped < logsNeeded) {
      const ids = logIds()
      const log = bot.findBlock({ matching: ids, maxDistance: 60 })
      if (!log) { safeChat('No more trees in range. Stopping.'); return }
      try {
        await navNear(log.position.x, log.position.y, log.position.z, 2)
        const fresh = bot.blockAt(log.position)
        if (fresh && ids.includes(fresh.type)) {
          await bot.dig(fresh)
          chopped++
        } else { break }
      } catch (e) {
        console.error(`[${BOT_NAME}] gather error:`, e.message)
        break
      }
    }

    await taskCraftPlanks()
    plankCount = countInInv(PLANK_NAMES)
  }

  if (plankCount < 30) {
    safeChat(`Couldn't gather enough planks (${plankCount}). Aborting.`)
    return
  }

  safeChat(`Have ${plankCount} planks. Building now.`)
  await buildHouseStructure()
}

async function placeBlockAt(targetPos, blockName) {
  const current = bot.blockAt(targetPos)
  if (current && current.name !== 'air' && current.name !== 'cave_air') return true

  const itemId = bot.registry.itemsByName[blockName]?.id
  const item   = itemId ? bot.inventory.findInventoryItem(itemId, null, false) : null
  if (!item) return false

  await bot.equip(item, 'hand')

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

async function buildHouseStructure() {
  const planks = bot.inventory.items().filter(i => PLANK_NAMES.includes(i.name))
  if (!planks.length) { safeChat('No planks to build with.'); return }
  const plankName = planks[0].name

  const origin = bot.entity.position.floored().offset(0, 0, -5)
  console.log(`[${BOT_NAME}] Building house at ${origin}`)

  let outOfBlocks = false

  // Walls: 5x5 perimeter, 3 high, door gap at (0, 1-2, -2)
  for (let y = 1; y <= 3 && !outOfBlocks; y++) {
    for (let x = -2; x <= 2 && !outOfBlocks; x++) {
      for (let z = -2; z <= 2 && !outOfBlocks; z++) {
        if (Math.abs(x) !== 2 && Math.abs(z) !== 2) continue
        if (z === -2 && x === 0 && y <= 2) continue  // door

        const ok = await placeBlockAt(origin.offset(x, y, z), plankName)
        if (!ok && countInInv([plankName]) === 0) { safeChat('Out of planks.'); outOfBlocks = true }
      }
    }
  }

  // Roof
  for (let x = -2; x <= 2 && !outOfBlocks; x++) {
    for (let z = -2; z <= 2 && !outOfBlocks; z++) {
      const ok = await placeBlockAt(origin.offset(x, 4, z), plankName)
      if (!ok && countInInv([plankName]) === 0) { safeChat('Out of planks on roof.'); outOfBlocks = true }
    }
  }

  if (!outOfBlocks) {
    safeChat('House done!')
    rememberLocation(memory, 'house', origin)
    rememberEvent(memory, 'built_house', {})
  }
}

// ── Autonomous Idle Behavior ───────────────────────────────────────────────────

const IDLE_THRESHOLD = 18

function tryAutonomous() {
  if (taskBusy || state.goal !== 'idle' || state.energy < 35) return

  state.idleTicks++
  if (state.idleTicks < IDLE_THRESHOLD) return
  state.idleTicks = 0

  const gs     = buildGroundedState(bot, state, memory, anger)
  const choice = selectAutonomousGoal(gs)

  if (choice) {
    safeChat(choice.say)
    if      (choice.action === 'explore')       runTask('exploring',  taskExplore)
    else if (choice.action === 'gather_wood')   runTask('gathering',  taskGatherWood)
    else if (choice.action === 'craft_planks')  runTask('crafting',   taskCraftPlanks)
    else if (choice.action === 'attack_mobs')   runTask('attacking',  taskAttackMobs)
    else if (choice.action === 'collect_items') runTask('collecting', taskCollectNearby)
  } else {
    const summary = chatSummary(gs)
    safeChat(summary ? `I see: ${summary}` : 'All quiet.')
  }
}

// ── Threat Reaction Loop (auto-attack hostile mobs in range) ─────────────────

function startThreatLoop() {
  setInterval(() => {
    if (taskBusy || state.energy < 25) return
    if (!['idle','exploring'].includes(state.goal)) return

    const mob = bot.nearestEntity(e =>
      e.name && HOSTILE_MOB_NAMES.has(e.name) &&
      e.position.distanceTo(bot.entity.position) < 10
    )
    if (mob) {
      safeChat(`${mob.name} is close. Engaging.`)
      runTask('attacking', () => taskAttackMobs())
    }
  }, 2500)
}

// ── State Loop (1s) ───────────────────────────────────────────────────────────

function startStateLoop() {
  setInterval(() => {
    state.hunger = Math.max(0, state.hunger - 0.15)

    const active = ['following','exploring','gathering','going_to','attacking','collecting','crafting','building'].includes(state.goal)
    state.energy = active
      ? Math.max(0, state.energy - 1.0)
      : Math.min(100, state.energy + 2)

    if (state.energy <= 15 && active) {
      taskBusy = false
      try { bot.pathfinder.stop() } catch {}
      try { bot.pvp.stop() } catch {}
      bot.clearControlStates()
      state.goal = 'resting'
      safeChat('Need to rest...')
      rememberEvent(memory, 'exhausted', {})
    }

    if (state.goal === 'resting' && state.energy >= 80) {
      state.goal = 'idle'
      safeChat('Rested. Ready.')
    }

    tryAutonomous()
    console.log(`[${BOT_NAME}] goal=${state.goal} E=${state.energy.toFixed(0)} H=${state.hunger.toFixed(0)} idle=${state.idleTicks} busy=${taskBusy} anger=${anger.size}`)
  }, 1000)
}

// ── Agent Loop (250 ms) ────────────────────────────────────────────────────────

function startAgentLoop() {
  let prevGoal = 'idle'

  setInterval(() => {
    const player = getNearestPlayer()
    if (player) bot.lookAt(player.entity.position.offset(0, player.entity.height, 0))

    if (bot.entity.isInWater) {
      try { bot.pathfinder.stop() } catch {}
      bot.clearControlStates()
      bot.setControlState('jump', true)
      prevGoal = state.goal
      return
    }

    if (state.goal === 'following') {
      if (!player) {
        try { bot.pathfinder.stop() } catch {}
        bot.clearControlStates()
        state.goal = 'idle'
        safeChat('Lost you.')
      } else if (prevGoal !== 'following') {
        const mvmt = new Movements(bot)
        bot.pathfinder.setMovements(mvmt)
        bot.pathfinder.setGoal(new goals.GoalFollow(player.entity, 2), true)
      }
    }

    if (prevGoal === 'following' && state.goal !== 'following') {
      try { bot.pathfinder.stop() } catch {}
      bot.clearControlStates()
    }

    prevGoal = state.goal
  }, 250)
}

function getNearestPlayer() {
  let nearest = null, minDist = Infinity
  for (const name in bot.players) {
    if (name === BOT_NAME) continue
    const p = bot.players[name]
    if (!p.entity) continue
    const d = bot.entity.position.distanceTo(p.entity.position)
    if (d < minDist) { minDist = d; nearest = { name, entity: p.entity, dist: d } }
  }
  return nearest
}

// ── Decision Pipeline ──────────────────────────────────────────────────────────

async function handleMessage(username, message) {
  // INSULT CHECK — runs BEFORE LLM, always
  if (detectInsult(message)) {
    bumpAnger(username, 1, 'insulted me')
    const rec = anger.get(username)
    if (rec.level >= 3) safeChat(`Watch your mouth, ${username}.`)
    else                safeChat(`Don't talk to me like that.`)
    if (maybeAttackForAnger(username)) return
  }

  if (llmBusy) { safeChat('Hold on...'); return }
  llmBusy = true

  try {
    const intent = classifyIntent(message)
    console.log(`[${BOT_NAME}] intent=${intent} from=${username} msg="${message}"`)

    const survivalBlock = evaluateSurvival(state)
    if (survivalBlock && ['follow','gather','explore','attack','collect','build','craft'].includes(intent)) {
      safeChat(survivalBlock.say)
      return
    }

    const groundedState = buildGroundedState(bot, state, memory, anger)

    let result
    try {
      const raw = await queryLLM(groundedState, intent, message, BOT_NAME)
      result = validateLLMOutput(raw)
      if (!result) {
        console.warn(`[${BOT_NAME}] LLM output invalid:`, JSON.stringify(raw))
        result = safeDefault(intent)
      }
    } catch (err) {
      console.error(`[${BOT_NAME}] LLM error:`, err.message)
      safeChat(`LLM error: ${err.message.slice(0, 60)}`)
      result = safeDefault(intent)
    }

    console.log(`[${BOT_NAME}] decision=${result.decision} action=${result.action} reason="${result.reason}"`)

    executeAction(result, username, groundedState)
    safeChat(result.say)

    if (result.action !== 'none') {
      rememberEvent(memory, 'acted', { intent, action: result.action, decision: result.decision })
    }
  } catch (err) {
    console.error(`[${BOT_NAME}] handleMessage fatal:`, err.message)
    safeChat(`Internal error: ${err.message.slice(0, 80)}`)
  } finally {
    llmBusy = false
  }
}

// ── Safe Action Map ────────────────────────────────────────────────────────────

function executeAction(result, username, groundedState) {
  if (result.decision !== 'accept') return

  const movementActions = ['follow','explore','gather_wood','craft_planks','attack_mobs','attack_player','collect_items','build_house_smart']
  if (movementActions.includes(result.action) && state.energy < 25) {
    result.say = 'Too tired right now.'
    return
  }

  const taskActions = ['explore','gather_wood','craft_planks','go_to','attack_mobs','attack_player','collect_items','craft','build_house_smart']
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
      try { bot.pathfinder.stop() } catch {}
      try { bot.pvp.stop() } catch {}
      bot.clearControlStates()
      state.goal = 'idle'
      break

    case 'explore':       runTask('exploring', taskExplore); break
    case 'craft_planks':  runTask('crafting',  taskCraftPlanks); break

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

    case 'attack_mobs':
      if (!groundedState.hostileMobs.length) { result.say = 'No hostile mobs visible.'; return }
      runTask('attacking', taskAttackMobs)
      break

    case 'attack_player': {
      const tgt = result.target
      const player = tgt ? bot.players[tgt] : null
      if (!player?.entity) { result.say = `Can't see ${tgt || 'them'}.`; return }
      runTask('attacking', () => taskAttackPlayer(player.entity, tgt))
      break
    }

    case 'collect_items':
      if (groundedState.droppedCount === 0) { result.say = 'No items on the ground.'; return }
      runTask('collecting', taskCollectNearby)
      break

    case 'craft': {
      const itemName = result.target || 'crafting_table'
      runTask('crafting', () => taskCraftItem(itemName))
      break
    }

    case 'build_house_smart':
      runTask('building', taskBuildHouseSmart)
      break

    case 'none':
    default: break
  }
}

// ── Fallback Commands (LLM offline) ───────────────────────────────────────────

function fallbackCommand(username, message) {
  const cmd = message.trim().toLowerCase()

  if (cmd === 'follow me')                           { if (state.energy < 25) { safeChat('Too tired.'); return }; state.goal = 'following'; safeChat('Following.') }
  else if (cmd === 'stop')                           { taskBusy = false; try{bot.pathfinder.stop()}catch{}; try{bot.pvp.stop()}catch{}; bot.clearControlStates(); state.goal = 'idle'; safeChat('Stopped.') }
  else if (cmd === 'status')                         { safeChat(`Goal: ${state.goal} | E:${state.energy.toFixed(0)} H:${state.hunger.toFixed(0)} | anger:${anger.size}`) }
  else if (cmd === 'explore')                        { if (!runTask('exploring', taskExplore)) safeChat("Busy.") }
  else if (cmd === 'get wood' || cmd === 'chop tree'){ if (!runTask('gathering', taskGatherWood)) safeChat("Busy.") }
  else if (cmd === 'make planks')                    { if (!runTask('crafting', taskCraftPlanks)) safeChat("Busy.") }
  else if (cmd === 'attack' || cmd === 'fight')      { if (!runTask('attacking', taskAttackMobs)) safeChat("Busy.") }
  else if (cmd === 'collect' || cmd === 'pick up')   { if (!runTask('collecting', taskCollectNearby)) safeChat("Busy.") }
  else if (cmd === 'build house')                    { if (!runTask('building', taskBuildHouseSmart)) safeChat("Busy.") }
  else if (cmd === 'inventory')                      { const it = bot.inventory.items(); safeChat(it.length ? it.map(i=>`${i.name}x${i.count}`).join(', ') : 'Empty.') }
  else if (cmd === 'look around')                    { const gs = buildGroundedState(bot, state, memory, anger); safeChat(`I see: ${chatSummary(gs) || 'nothing'}`) }
  else {
    const m = cmd.match(/^craft (.+)$/);    if (m) { if (!runTask('crafting', () => taskCraftItem(m[1]))) safeChat("Busy."); return }
    const w = cmd.match(/^where is (.+)$/); if (w) { const loc = recallLocation(memory, w[1].trim()); safeChat(loc ? `${w[1]}: ${loc.pos.x}, ${loc.pos.y}, ${loc.pos.z}` : `Don't know.`); return }
    const g = cmd.match(/^go to (.+)$/);    if (g) { if (!runTask('going_to', () => taskGoTo(g[1].trim()))) safeChat("Busy."); else safeChat(`Going to ${g[1]}.`) }
  }
}

// ── Chat Entry ─────────────────────────────────────────────────────────────────

bot.on('chat', (username, message) => {
  if (username === BOT_NAME) return
  try {
    if (llmEnabled) handleMessage(username, message)
    else            fallbackCommand(username, message)
  } catch (err) {
    safeChat(`Error: ${err.message.slice(0, 80)}`)
    console.error(`[${BOT_NAME}] chat handler error:`, err)
  }
})

// ── Errors / shutdown ─────────────────────────────────────────────────────────

bot.on('error',  err    => { console.error(`[${BOT_NAME}] socket error:`, err.message); safeChat(`Socket error: ${err.message.slice(0,60)}`) })
bot.on('kicked', reason => { console.error(`[${BOT_NAME}] kicked:`, reason); process.exit(0) })
bot.on('end',    reason => { console.log(`[${BOT_NAME}] disconnected: ${reason}`); process.exit(0) })

process.on('uncaughtException',  err => { console.error(`[${BOT_NAME}] uncaught:`, err); safeChat(`Crash: ${err.message.slice(0,80)}`); setTimeout(() => process.exit(1), 500) })
process.on('unhandledRejection', err => { console.error(`[${BOT_NAME}] unhandled rejection:`, err); safeChat(`Promise error: ${String(err).slice(0,80)}`) })
