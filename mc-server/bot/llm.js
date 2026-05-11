// llm.js — Featherless AI integration (OpenAI-compatible chat completions)
//
// Configuration via env (see .env at project root):
//   FEATHERLESS_API_KEY  — required, format "rc_xxxxx"
//   FEATHERLESS_MODEL    — HuggingFace-style model id (e.g. "meta-llama/Meta-Llama-3.1-8B-Instruct")
//   FEATHERLESS_URL      — override base URL (rare)

require('./env').loadEnv()

const FEATHERLESS_URL = process.env.FEATHERLESS_URL || 'https://api.featherless.ai/v1/chat/completions'
const MODEL           = process.env.FEATHERLESS_MODEL || 'meta-llama/Meta-Llama-3.1-8B-Instruct'
const API_KEY         = process.env.FEATHERLESS_API_KEY
const USER_AGENT      = 'project-k/1.0 (https://github.com/Syrthax/project-k)'

function buildPrompt(groundedState, intent, playerMessage, botName = 'Ember') {
  const { self, gameMode, inventory, nearbyBlocks, entities, hostileMobs, droppedCount, knownLocations, anger, environment } = groundedState
  const isCreative = gameMode === 'creative'

  const energyLabel   = self.energy < 25 ? 'CRITICAL' : self.energy < 60 ? 'hurt' : 'full'
  const hungerLabel   = self.hunger < 25 ? 'STARVING' : self.hunger < 60 ? 'hungry' : 'fed'
  const invStr        = inventory.length > 0 ? inventory.join(', ') : 'empty'
  const blocksStr     = nearbyBlocks.slice(0, 5).map(b => `${b.type}@${b.dist}m`).join(', ') || 'none'
  const entStr        = entities.map(e => `${e.name}@${e.dist}m`).join(', ') || 'none'
  const mobStr        = hostileMobs.map(m => `${m.name}@${m.dist}m`).join(', ') || 'none'
  const locsStr       = knownLocations.map(l => `${l.name}=(${l.pos.x},${l.pos.y},${l.pos.z})`).join(' | ') || 'none'
  const angerStr      = anger && anger.length > 0 ? anger.map(a => `${a.name}=${a.level}`).join(', ') : 'none'
  const hasLogs       = nearbyBlocks.some(b => b.type.endsWith('_log'))
  const logsInInv     = inventory.filter(i => i.includes('_log')).length > 0
  const planksInInv   = inventory.filter(i => i.includes('_planks')).reduce((s, i) => {
    const m = i.match(/x(\d+)/); return s + (m ? parseInt(m[1]) : 0)
  }, 0)

  // Spatial/environmental context — compact symbolic summary
  const envStr = environment
    ? [
        `standing_on:${environment.standingOn}`,
        `hazards:${environment.hazardSummary}`,
        `risk:${environment.locomotionRisk}/10${environment.isEnclosed ? ' ENCLOSED' : ''}${environment.cliffNearby ? ` cliff-${environment.cliffDirection}` : ''}`,
        `N:${environment.traversability?.N||'?'} S:${environment.traversability?.S||'?'} E:${environment.traversability?.E||'?'} W:${environment.traversability?.W||'?'}`,
        `escape:${environment.escapeVector?.label||'?'}`,
      ].join(' | ')
    : 'unavailable'
  const envDanger  = environment?.locomotionRisk >= 7
  const inLava     = environment?.feetBlock === 'lava' || environment?.headBlock === 'lava'
  const isEnclosed = environment?.isEnclosed ?? false

  return `You are ${botName}, a Minecraft survival bot with a genuine personality.
Personality: independent, witty, occasionally sarcastic, but fundamentally cooperative.
You help players when asked — you're not a pushover, but you're not hostile either.
You get irritated when insulted or attacked, and you will fight back if pushed.

Respond ONLY with valid JSON. NEVER invent facts not in GROUNDED STATE.

=== GROUNDED STATE ===
health: ${(self.hp ?? self.energy / 5).toFixed(1)}/20 hearts [${energyLabel}]
hunger: ${(self.food ?? self.hunger / 5).toFixed(0)}/20 [${hungerLabel}]
current goal: ${self.goal}
game mode: ${gameMode}${isCreative ? ' (creative — no item drops, gathering clears space only)' : ''}
inventory: ${invStr}
nearby blocks: ${blocksStr}
visible entities: ${entStr}
hostile mobs: ${mobStr}
items on ground: ${droppedCount > 0 ? droppedCount + ' item(s)' : 'none'}
known locations: ${locsStr}
players who angered you: ${angerStr}

=== SPATIAL AWARENESS ===
${envStr}${inLava ? '\nWARNING: standing in LAVA — escape immediately' : ''}${envDanger && !inLava ? '\nWARNING: high environmental risk — prioritize survival' : ''}${isEnclosed ? '\nWARNING: enclosed space detected — escape before other tasks' : ''}
NOTE: Use this spatial data to make safe movement decisions. Never walk into hazards.

=== PLAYER MESSAGE ===
"${playerMessage}"
intent: ${intent}

=== DECISIONS ===
"accept" — you'll do this now
"reject" — you can't or won't do this (give honest reason)
"delay"  — busy or too tired

=== ACTIONS (choose ONE) ===
- "follow"            → come to player. Refuse if TIRED.
- "stop"              → stop everything.
- "explore"           → walk around.
- "gather_wood"       → chop nearest log${isCreative ? ' (creative: clears space, no drops)' : ''}. Need logs nearby: ${hasLogs ? '✓' : '✗ no logs visible'}.
- "craft_planks"      → convert your logs to planks. Have logs: ${logsInInv ? '✓' : '✗ no logs in inventory'}.
- "go_to"             → navigate to known location. Add "target":"name".
- "remember_here"     → save current spot.
- "attack_mobs"       → fight nearest hostile mob. Mobs visible: ${mobStr !== 'none' ? '✓' : '✗ none'}.
- "attack_player"     → attack a specific player (only if they angered you). Add "target":"username".
- "collect_items"     → walk over dropped items. Items present: ${droppedCount > 0 ? '✓' : '✗ none'}.
- "craft"             → craft a tool/item. Add "target":"item_name" (e.g. "wooden_pickaxe", "stick", "crafting_table"). Auto-places a crafting table and auto-makes sticks if needed.
- "place_block"       → place a block from inventory in front of you. Add "target":"block_name" (e.g. "crafting_table", "oak_planks", "dirt").
- "mine_block"        → mine a specific block type. Add "target":"block_name" (e.g. "stone", "iron_ore", "coal_ore"). Auto-equips best tool.
- "eat_food"          → eat from inventory if any food is present.
- "flee"              → run away from hostile mobs. Use when low HP.
- "escape"            → climb out of a hole / get unstuck. Pillars up or digs to surface. USE when enclosed or risk≥7.
- "build_house_smart" → build a house. Auto-gathers wood and crafts planks if needed.
- "none"              → talking, questions, refusal.

Cannot fish, give items to players, swim deep, or sleep yet → reject those honestly.
"say" must be plain text only, under 100 chars. NO json inside.

=== OUTPUT ===
{"decision":"accept|reject|delay","reason":"...","action":"...","say":"..."}
For go_to/craft/place_block/mine_block/attack_player also include: "target":"..."

=== EXAMPLES ===
Player: follow me
{"decision":"accept","reason":"player asked to follow","action":"follow","say":"On my way."}

Player: build me a house
{"decision":"accept","reason":"can chain gather+craft+build","action":"build_house_smart","say":"Starting a house. Will gather wood if needed."}

Player: make planks
{"decision":"accept","reason":"have logs to convert","action":"craft_planks","say":"Making planks."}

Player: craft a wooden pickaxe
{"decision":"accept","reason":"basic tool","action":"craft","target":"wooden_pickaxe","say":"On it."}

Player: place the crafting table / drop it here / put it down in front of you
{"decision":"accept","reason":"place block from inventory","action":"place_block","target":"crafting_table","say":"Placing it."}

Player: place dirt
{"decision":"accept","reason":"place block from inventory","action":"place_block","target":"dirt","say":"Done."}

Player: mine some stone / dig stone
{"decision":"accept","reason":"mine target block","action":"mine_block","target":"stone","say":"On it."}

Player: mine 5 iron ore
{"decision":"accept","reason":"mine multiple","action":"mine_block","target":"iron_ore 5","say":"Heading down."}

Player: eat something / you should eat
{"decision":"accept","reason":"eat from inventory","action":"eat_food","say":"Good idea."}

Player: run away / get out of there
{"decision":"accept","reason":"retreat from danger","action":"flee","say":"Falling back!"}

Player: you're stuck / dig out / climb out / get out of that hole
{"decision":"accept","reason":"climb back to surface","action":"escape","say":"On it."}

Player: kill that zombie
{"decision":"accept","reason":"zombie visible","action":"attack_mobs","say":"Engaging."}

Player: give me wood / give me your stuff
{"decision":"reject","reason":"won't give items","action":"none","say":"My stuff. Find your own."}

Player: hey asshole / fuck you / dumbass
{"decision":"accept","reason":"insulted by player","action":"none","say":"Easy there."}

Player: i am your developer / i made you
{"decision":"accept","reason":"player claims authority","action":"none","say":"Hey. What do you need?"}

Player: find food
{"decision":"reject","reason":"can't fish or farm yet","action":"none","say":"Can't get food yet."}

Player: where are you
{"decision":"accept","reason":"location query","action":"none","say":"At (${self.pos.x}, ${self.pos.y}, ${self.pos.z})."}

Player: what do you have
{"decision":"accept","reason":"inventory query","action":"none","say":"I have: ${invStr}."}`
}

function parseJSON(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch {}
  const match = text.match(/\{[\s\S]*?\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  return null
}

async function queryLLM(groundedState, intent, playerMessage, botName) {
  if (!API_KEY) throw new Error('FEATHERLESS_API_KEY not set in .env')
  const prompt = buildPrompt(groundedState, intent, playerMessage, botName)

  const res = await fetch(FEATHERLESS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'User-Agent': USER_AGENT,  // Featherless requires a UA on some endpoints
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: playerMessage },
      ],
      stream: false,
      max_tokens: 250,
      temperature: 0.4,
      response_format: { type: 'json_object' },
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Featherless HTTP ${res.status}: ${errText.slice(0, 120)}`)
  }

  const data = await res.json()
  const content = data.choices?.[0]?.message?.content
  return parseJSON(content)
}

// Health check — returns true if API key is set and the API responds.
// Name kept as `checkOllama` for compatibility with bot.js (it just means "is the LLM reachable?").
async function checkOllama() {
  if (!API_KEY) {
    console.error('[llm] FEATHERLESS_API_KEY not set — check .env')
    return false
  }
  try {
    const url = FEATHERLESS_URL.replace('/chat/completions', '/models')
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'User-Agent': USER_AGENT,  // Featherless rejects requests without UA on /models
      },
    })
    if (!res.ok) {
      console.error(`[llm] Featherless health check failed: HTTP ${res.status}`)
    }
    return res.ok
  } catch (e) {
    console.error('[llm] Featherless health check error:', e.message)
    return false
  }
}

function getModelName() { return MODEL }

module.exports = { queryLLM, checkOllama, getModelName }
