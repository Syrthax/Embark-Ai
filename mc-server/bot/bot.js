const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const { loadMemory, rememberLocation, rememberEvent, rememberKnowledge, recallLocation } = require('./memory')
const { buildGroundedState, chatSummary } = require('./state')
const { classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal } = require('./engine')
const { queryLLM, checkOllama } = require('./llm')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 25565,
  username: 'Ember',
  version: '1.21.4',
})

bot.loadPlugin(pathfinder)

// ── Internal State ─────────────────────────────────────────────────────────────
const state = {
  energy: 100,
  hunger: 100,
  goal: 'idle',    // idle | resting | following | exploring | gathering | going_to
  idleTicks: 0,
}

const memory  = loadMemory()
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

// ── Pathfinder Task Runner ─────────────────────────────────────────────────────
// Guards against overlapping async tasks. LLM never calls these directly.

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

// ── Tasks (pathfinder-based, not called by LLM directly) ──────────────────────

const logNames = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log']
const logIds   = () => logNames.map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)

async function taskExplore() {
  const angle = Math.random() * Math.PI * 2
  const dist  = 25 + Math.random() * 30
  const p     = bot.entity.position
  const tx    = Math.floor(p.x + Math.sin(angle) * dist)
  const tz    = Math.floor(p.z + Math.cos(angle) * dist)

  console.log(`[Ember] Exploring → (${tx}, _, ${tz})`)
  const mvmt = new Movements(bot)
  bot.pathfinder.setMovements(mvmt)
  await bot.pathfinder.goto(new goals.GoalNear(tx, p.y, tz, 3))
  rememberLocation(memory, 'last_explored', bot.entity.position)
  rememberEvent(memory, 'explored', {})
}

async function taskGatherWood() {
  const ids = logIds()
  const log = bot.findBlock({ matching: ids, maxDistance: 32 })
  if (!log) { bot.chat('No trees in range.'); return }

  console.log(`[Ember] Chopping log at ${log.position}`)
  const mvmt = new Movements(bot)
  bot.pathfinder.setMovements(mvmt)
  await bot.pathfinder.goto(new goals.GoalNear(log.position.x, log.position.y, log.position.z, 2))

  const fresh = bot.blockAt(log.position)
  if (fresh && ids.includes(fresh.type) && bot.canDigBlock(fresh)) {
    await bot.dig(fresh)
    bot.chat('Got some wood.')
    rememberEvent(memory, 'gathered_wood', {})
  }
}

async function taskGoTo(name) {
  const loc = recallLocation(memory, name)
  if (!loc) { bot.chat(`Don't know where ${name} is.`); return }

  console.log(`[Ember] Going to ${name} at (${loc.pos.x}, ${loc.pos.y}, ${loc.pos.z})`)
  const mvmt = new Movements(bot)
  bot.pathfinder.setMovements(mvmt)
  await bot.pathfinder.goto(new goals.GoalNear(loc.pos.x, loc.pos.y, loc.pos.z, 3))
  bot.chat(`Reached ${name}.`)
  rememberEvent(memory, 'visited', { name })
}

// ── Autonomous Behavior ────────────────────────────────────────────────────────

const IDLE_THRESHOLD = 20  // seconds of idle before self-initiating

function tryAutonomous() {
  if (taskBusy || state.goal !== 'idle' || state.energy < 40) return

  state.idleTicks++
  if (state.idleTicks < IDLE_THRESHOLD) return
  state.idleTicks = 0

  const gs     = buildGroundedState(bot, state, memory)
  const choice = selectAutonomousGoal(gs)

  if (choice) {
    bot.chat(choice.say)
    if      (choice.action === 'explore')     runTask('exploring', taskExplore)
    else if (choice.action === 'gather_wood') runTask('gathering', taskGatherWood)
  } else {
    const summary = chatSummary(gs)
    bot.chat(summary ? `I see: ${summary}` : 'All quiet here.')
  }
}

// ── State Loop (1 s) ───────────────────────────────────────────────────────────

function startStateLoop() {
  setInterval(() => {
    state.hunger = Math.max(0, state.hunger - 0.2)

    const active = ['following','exploring','gathering','going_to'].includes(state.goal)
    state.energy = active
      ? Math.max(0, state.energy - 1.2)
      : Math.min(100, state.energy + 2)

    if (state.energy <= 15 && active) {
      taskBusy = false
      bot.pathfinder.stop()
      bot.clearControlStates()
      state.goal = 'resting'
      bot.chat('Need to rest...')
      rememberEvent(memory, 'exhausted', {})
      console.log('[Ember] Exhausted → resting')
    }

    if (state.goal === 'resting' && state.energy >= 80) {
      state.goal = 'idle'
      bot.chat('Rested. Ready.')
      console.log('[Ember] Recovered → idle')
    }

    if (state.hunger < 20 && state.hunger > 19.8) {
      bot.chat('Getting hungry...')
    }

    tryAutonomous()
    console.log(`[Ember] goal=${state.goal} E=${state.energy.toFixed(0)} H=${state.hunger.toFixed(0)} idle=${state.idleTicks} busy=${taskBusy}`)
  }, 1000)
}

// ── Agent Loop (250 ms) — survival + look + pathfinder follow ─────────────────

function startAgentLoop() {
  let prevGoal = 'idle'

  setInterval(() => {
    const player = getNearestPlayer()
    if (player) {
      bot.lookAt(player.entity.position.offset(0, player.entity.height, 0))
    }

    // Water survival — overrides everything
    if (bot.entity.isInWater) {
      bot.pathfinder.stop()
      bot.clearControlStates()
      bot.setControlState('jump', true)
      prevGoal = state.goal
      return
    }

    // Follow: GoalFollow (dynamic — tracks moving player through obstacles)
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

    // Leaving follow — stop pathfinder
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
// sense → classify_intent → survival_check → build_grounded_state → LLM → validate → act → remember

async function handleMessage(username, message) {
  if (llmBusy) { bot.chat('Hold on...'); return }
  llmBusy = true

  try {
    // 1. Classify intent (pre-LLM, pattern-based)
    const intent = classifyIntent(message)
    console.log(`[Engine] intent=${intent} message="${message}"`)

    // 2. Survival check — short-circuit for critical states (no LLM wasted)
    const survivalBlock = evaluateSurvival(state)
    if (survivalBlock && ['follow','gather','explore'].includes(intent)) {
      bot.chat(survivalBlock.say)
      rememberEvent(memory, 'survival_block', { intent, reason: survivalBlock.reason })
      return
    }

    // 3. Build grounded state — only real sensor data, no inference
    const groundedState = buildGroundedState(bot, state, memory)

    // 4. Query LLM with grounded context
    let result
    try {
      const raw = await queryLLM(groundedState, intent, message)
      result = validateLLMOutput(raw)
      if (!result) {
        console.warn('[Engine] LLM output invalid, using safe default:', JSON.stringify(raw))
        result = safeDefault(intent)
      }
    } catch (err) {
      console.error('[Engine] LLM error:', err.message)
      result = safeDefault(intent)
    }

    console.log(`[Engine] decision=${result.decision} action=${result.action} | "${result.reason}"`)

    // 5. Execute via safe action map (LLM never directly controls movement)
    executeAction(result, username, groundedState)

    // 6. Respond
    bot.chat(result.say)

    // 7. Remember important events only (no noise)
    if (result.action !== 'none') {
      rememberEvent(memory, 'acted', { intent, action: result.action, decision: result.decision })
    }
  } finally {
    llmBusy = false
  }
}

// ── Safe Action Map ────────────────────────────────────────────────────────────
// Maps LLM output → actual functions. Unknown or unaccepted → safe ignore.

function executeAction(result, username, groundedState) {
  // Only execute accepted decisions
  if (result.decision !== 'accept') return

  // Hard energy guard (LLM told to refuse, but code enforces regardless)
  if (result.action === 'follow' && state.energy < 25) {
    result.say = 'Too tired to follow right now.'
    return
  }

  // Task busy guard for movement actions
  const movementActions = ['explore','gather_wood','go_to']
  if (movementActions.includes(result.action) && taskBusy) {
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
      bot.clearControlStates()
      state.goal = 'idle'
      break

    case 'explore':
      runTask('exploring', taskExplore)
      break

    case 'gather_wood': {
      // Extra grounding check: only execute if logs actually visible
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

    case 'none':
    default:
      break
  }
}

// ── Fallback Commands (LLM offline) ───────────────────────────────────────────

function fallbackCommand(username, message) {
  const cmd = message.trim().toLowerCase()

  if (cmd === 'follow me') {
    if (state.energy < 25) { bot.chat('Too tired.'); return }
    state.goal = 'following'
    bot.chat('Following you.')
  } else if (cmd === 'stop') {
    taskBusy = false
    bot.pathfinder.stop()
    bot.clearControlStates()
    state.goal = 'idle'
    bot.chat('Stopped.')
  } else if (cmd === 'status') {
    bot.chat(`Goal: ${state.goal} | E:${state.energy.toFixed(0)} H:${state.hunger.toFixed(0)}`)
  } else if (cmd === 'explore') {
    if (!runTask('exploring', taskExplore)) bot.chat("I'm busy.")
    else bot.chat('Exploring.')
  } else if (cmd === 'get wood' || cmd === 'chop tree') {
    if (!runTask('gathering', taskGatherWood)) bot.chat("I'm busy.")
    else bot.chat('Getting wood.')
  } else if (cmd === 'look around' || cmd === 'what do you see') {
    const gs = buildGroundedState(bot, state, memory)
    bot.chat(`I see: ${chatSummary(gs) || 'nothing notable'}`)
  } else if (cmd === 'inventory' || cmd === 'what do you have') {
    const items = bot.inventory.items()
    bot.chat(items.length ? `I have: ${items.map(i => `${i.name}x${i.count}`).join(', ')}` : 'Inventory is empty.')
  } else {
    const whereMatch = cmd.match(/^where is (.+)$/)
    if (whereMatch) {
      const loc = recallLocation(memory, whereMatch[1].trim())
      bot.chat(loc ? `${whereMatch[1]}: ${loc.pos.x}, ${loc.pos.y}, ${loc.pos.z}` : `Don't know where "${whereMatch[1]}" is.`)
      return
    }
    const goMatch = cmd.match(/^go to (.+)$/)
    if (goMatch) {
      if (!runTask('going_to', () => taskGoTo(goMatch[1].trim()))) bot.chat("I'm busy.")
      else bot.chat(`Going to ${goMatch[1]}.`)
    }
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
