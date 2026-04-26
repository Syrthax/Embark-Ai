// llm.js — Ollama Integration
// Input:  grounded state (facts only, never inferred)
// Output: {decision, reason, action, say} — validated by engine.js before use

const OLLAMA_URL = 'http://localhost:11434/api/chat'
const MODEL = 'llama3.2'

function buildPrompt(groundedState, intent, playerMessage) {
  const { self, inventory, nearbyBlocks, entities, hostileMobs, droppedCount, knownLocations } = groundedState

  const energyLabel   = self.energy < 25 ? 'TIRED' : self.energy < 60 ? 'okay' : 'good'
  const invStr        = inventory.length > 0 ? inventory.join(', ') : 'empty'
  const blocksStr     = nearbyBlocks.slice(0, 5).map(b => `${b.type}@${b.dist}m`).join(', ') || 'none visible'
  const entStr        = entities.map(e => `${e.name}@${e.dist}m`).join(', ') || 'none'
  const mobStr        = hostileMobs.map(m => `${m.name}@${m.dist}m`).join(', ') || 'none'
  const locsStr       = knownLocations.map(l => `${l.name}=(${l.pos.x},${l.pos.y},${l.pos.z})`).join(' | ') || 'none'
  const hasLogs       = nearbyBlocks.some(b => b.type.endsWith('_log'))
  const plankCount    = inventory.filter(i => i.includes('planks')).reduce((s, i) => {
    const m = i.match(/x(\d+)/)
    return s + (m ? parseInt(m[1]) : 0)
  }, 0)

  return `You are Ember, a Minecraft bot. Personality: direct, stubborn, curious.
Respond ONLY with valid JSON. Never invent facts not in GROUNDED STATE below.

=== GROUNDED STATE (only use these facts) ===
energy: ${self.energy}/100 [${energyLabel}]
current goal: ${self.goal}
inventory: ${invStr}
nearby blocks: ${blocksStr}
visible entities: ${entStr}
hostile mobs: ${mobStr}
items on ground: ${droppedCount > 0 ? droppedCount + ' item(s)' : 'none'}
known locations: ${locsStr}

=== PLAYER MESSAGE ===
"${playerMessage}"
intent: ${intent}

=== DECISION RULES ===
"accept" — you will do this now
"reject" — you cannot do this (honest reason from grounded state only)
"delay"  — energy too low or already busy

=== ACTION RULES ===
- "follow"        → player wants you to come. Refuse if TIRED.
- "stop"          → stop everything.
- "explore"       → go walk around.
- "gather_wood"   → ONLY if nearby blocks contains a log. ${hasLogs ? 'Logs visible ✓' : 'No logs nearby ✗'}
- "go_to"         → ONLY if location in known locations. Include "target" field.
- "remember_here" → save this spot.
- "attack_mobs"   → ONLY if hostile mobs list is non-empty. ${mobStr !== 'none' ? 'Mobs visible ✓' : 'No mobs visible ✗'}
- "collect_items" → ONLY if items on ground > 0. ${droppedCount > 0 ? 'Items visible ✓' : 'No items ✗'}
- "craft"         → craft an item. Include "target" field with exact item name (e.g. "wooden_pickaxe"). Need materials.
- "build_house"   → build a house. Need ${plankCount >= 30 ? `enough planks ✓ (${plankCount})` : `more planks ✗ (have ${plankCount}, need 30+)`}
- "none"          → talking, questions, or reject.

Cannot fish or carry items to player → reject honestly.
"say" must be plain text only, under 100 chars.

=== OUTPUT FORMAT ===
{"decision":"accept|reject|delay","reason":"...","action":"...","say":"..."}
For go_to and craft also include: "target":"name"

=== EXAMPLES ===
Player: follow me
{"decision":"accept","reason":"player asked to follow","action":"follow","say":"On my way."}

Player: attack that zombie / kill the mobs
{"decision":"accept","reason":"zombie visible at 8m","action":"attack_mobs","say":"On it."}

Player: pick up those items / collect the drops
{"decision":"accept","reason":"3 items on ground","action":"collect_items","say":"Picking up."}

Player: craft a wooden pickaxe
{"decision":"accept","reason":"have logs and sticks available","action":"craft","target":"wooden_pickaxe","say":"Making a wooden pickaxe."}

Player: build me a house / make a shelter
{"decision":"accept","reason":"enough planks in inventory","action":"build_house","say":"Starting construction."}

Player: get some wood
{"decision":"accept","reason":"logs visible at 5m","action":"gather_wood","say":"Chopping that tree."}

Player: find some fish
{"decision":"reject","reason":"cannot fish","action":"none","say":"Can't fish. Not capable of that."}

Player: what do you have
{"decision":"accept","reason":"inventory query","action":"none","say":"I have: ${invStr}."}

Player: where are you
{"decision":"accept","reason":"location query","action":"none","say":"At (${self.pos.x}, ${self.pos.y}, ${self.pos.z})."}`
}

function parseJSON(text) {
  try { return JSON.parse(text) } catch {}
  const match = text.match(/\{[\s\S]*?\}/)
  if (match) {
    try { return JSON.parse(match[0]) } catch {}
  }
  return null
}

async function queryLLM(groundedState, intent, playerMessage) {
  const prompt = buildPrompt(groundedState, intent, playerMessage)

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
      options: { temperature: 0.5, num_predict: 220 },
    }),
  })

  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`)

  const data = await res.json()
  return parseJSON(data.message.content)
}

async function checkOllama() {
  try {
    const res = await fetch('http://localhost:11434/api/tags')
    return res.ok
  } catch {
    return false
  }
}

module.exports = { queryLLM, checkOllama }
