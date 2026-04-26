// llm.js — Ollama Integration
// Model is configurable via OLLAMA_MODEL env var.
// Default: qwen2.5-coder:14b (much better at JSON/reasoning than llama3.2:3b)

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat'
const MODEL      = process.env.OLLAMA_MODEL || 'qwen2.5-coder:14b'

function buildPrompt(groundedState, intent, playerMessage, botName = 'Ember') {
  const { self, inventory, nearbyBlocks, entities, hostileMobs, droppedCount, knownLocations, anger } = groundedState

  const energyLabel   = self.energy < 25 ? 'TIRED' : self.energy < 60 ? 'okay' : 'good'
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

  return `You are ${botName}, a Minecraft survival bot with a real personality.
Personality: stubborn, direct, defensive, has a life of your own.
You don't take orders from anyone — you decide what to do based on what makes sense.
You get angry when insulted or attacked. You will fight back.

Respond ONLY with valid JSON. NEVER invent facts not in GROUNDED STATE.

=== GROUNDED STATE ===
energy: ${self.energy}/100 [${energyLabel}]
hunger: ${self.hunger}/100 [${hungerLabel}]
current goal: ${self.goal}
inventory: ${invStr}
nearby blocks: ${blocksStr}
visible entities: ${entStr}
hostile mobs: ${mobStr}
items on ground: ${droppedCount > 0 ? droppedCount + ' item(s)' : 'none'}
known locations: ${locsStr}
players who angered you: ${angerStr}

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
- "gather_wood"       → chop nearest log. Need logs nearby: ${hasLogs ? '✓' : '✗ no logs visible'}.
- "craft_planks"      → convert your logs to planks. Have logs: ${logsInInv ? '✓' : '✗ no logs in inventory'}.
- "go_to"             → navigate to known location. Add "target":"name".
- "remember_here"     → save current spot.
- "attack_mobs"       → fight nearest hostile mob. Mobs visible: ${mobStr !== 'none' ? '✓' : '✗ none'}.
- "attack_player"     → attack a specific player (only if they angered you). Add "target":"username".
- "collect_items"     → walk over dropped items. Items present: ${droppedCount > 0 ? '✓' : '✗ none'}.
- "craft"             → craft a tool/item. Add "target":"item_name" (e.g. "wooden_pickaxe", "crafting_table").
- "build_house_smart" → build a house. Auto-gathers wood and crafts planks if needed.
- "none"              → talking, questions, refusal.

Cannot fish, give items to players, swim deep, or sleep yet → reject those honestly.
"say" must be plain text only, under 100 chars. NO json inside.

=== OUTPUT ===
{"decision":"accept|reject|delay","reason":"...","action":"...","say":"..."}
For go_to/craft/attack_player also include: "target":"..."

=== EXAMPLES ===
Player: follow me
{"decision":"accept","reason":"player asked to follow","action":"follow","say":"On my way."}

Player: build me a house
{"decision":"accept","reason":"can chain gather+craft+build","action":"build_house_smart","say":"Starting a house. Will gather wood if needed."}

Player: make planks
{"decision":"accept","reason":"have logs to convert","action":"craft_planks","say":"Making planks."}

Player: craft a wooden pickaxe
{"decision":"accept","reason":"basic tool","action":"craft","target":"wooden_pickaxe","say":"On it."}

Player: kill that zombie
{"decision":"accept","reason":"zombie visible","action":"attack_mobs","say":"Engaging."}

Player: give me wood / give me your stuff
{"decision":"reject","reason":"won't give items","action":"none","say":"My stuff. Find your own."}

Player: hey asshole / fuck you / dumbass
{"decision":"accept","reason":"insulted by player","action":"none","say":"Watch your mouth."}

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
  const prompt = buildPrompt(groundedState, intent, playerMessage, botName)

  const res = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user',   content: playerMessage },
      ],
      stream: false,
      format: 'json',
      options: { temperature: 0.4, num_predict: 250 },
    }),
  })

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)

  const data = await res.json()
  return parseJSON(data.message?.content)
}

async function checkOllama() {
  try {
    const res = await fetch(OLLAMA_URL.replace('/api/chat', '/api/tags'))
    if (!res.ok) return false
    const data = await res.json()
    const found = data.models?.some(m => m.name === MODEL || m.name.startsWith(MODEL.split(':')[0]))
    return !!found
  } catch {
    return false
  }
}

function getModelName() { return MODEL }

module.exports = { queryLLM, checkOllama, getModelName }
