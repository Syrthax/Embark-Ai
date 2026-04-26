// engine.js — Decision Engine

const VALID_ACTIONS   = ['follow','stop','explore','gather_wood','go_to','remember_here',
                          'attack_mobs','collect_items','craft','build_house','none']
const VALID_DECISIONS = ['accept','reject','delay']

// ── Pre-LLM: classify what the player wants ───────────────────────────────────

const INTENT_PATTERNS = [
  { intent: 'follow',   re: /\b(follow|come here|come to me|come with me)\b/i },
  { intent: 'stop',     re: /\b(stop|wait|stay|halt)\b/i },
  { intent: 'attack',   re: /\b(attack|kill|fight|hunt|slay|defeat)\b/i },
  { intent: 'collect',  re: /\b(pick up|collect|loot|grab|get the items)\b/i },
  { intent: 'build',    re: /\b(build|construct|house|shelter|home|make a house|make a shelter)\b/i },
  { intent: 'craft',    re: /\b(craft|forge|make a|create a|i need a)\b/i },
  { intent: 'gather',   re: /\b(wood|tree|chop|gather|mine|need some|get some|sand|stone|gravel|ore)\b/i },
  { intent: 'explore',  re: /\b(explore|wander|walk|roam|go to)\b/i },
  { intent: 'query',    re: /\b(where|what|who|how|status|see|have|inventory|can you|are you|bro)\b/i },
]

function classifyIntent(message) {
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(message)) return intent
  }
  return 'unknown'
}

// ── Pre-LLM: survival check ───────────────────────────────────────────────────

function evaluateSurvival(state) {
  if (state.energy <= 15) {
    return {
      decision: 'delay',
      reason: 'energy critical',
      action: 'none',
      say: `Exhausted. Need to rest. Energy: ${Math.floor(state.energy)}/100.`,
    }
  }
  if (state.goal === 'resting') {
    return {
      decision: 'delay',
      reason: 'recovering',
      action: 'none',
      say: `Resting right now. Energy: ${Math.floor(state.energy)}/100.`,
    }
  }
  return null
}

// ── Validate LLM output strictly ──────────────────────────────────────────────

function validateLLMOutput(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (!VALID_DECISIONS.includes(raw.decision)) return null
  if (!VALID_ACTIONS.includes(raw.action)) return null
  if (typeof raw.say !== 'string' || !raw.say.trim()) return null

  return {
    decision: raw.decision,
    reason:   typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '',
    action:   raw.action,
    say:      raw.say.trim().slice(0, 150),
    target:   typeof raw.target === 'string' ? raw.target : undefined,
  }
}

// ── Safe defaults when LLM fails ─────────────────────────────────────────────

const SAFE_DEFAULTS = {
  follow:   { decision: 'accept', reason: 'fallback', action: 'follow',        say: 'On my way.'          },
  stop:     { decision: 'accept', reason: 'fallback', action: 'stop',          say: 'Stopped.'            },
  attack:   { decision: 'accept', reason: 'fallback', action: 'attack_mobs',   say: 'On it.'              },
  collect:  { decision: 'accept', reason: 'fallback', action: 'collect_items', say: 'Picking up items.'   },
  craft:    { decision: 'accept', reason: 'fallback', action: 'craft',         say: 'Let me try.'         },
  build:    { decision: 'accept', reason: 'fallback', action: 'build_house',   say: 'Building.'           },
  gather:   { decision: 'accept', reason: 'fallback', action: 'gather_wood',   say: 'Getting some wood.'  },
  explore:  { decision: 'accept', reason: 'fallback', action: 'explore',       say: 'Going exploring.'    },
  query:    { decision: 'accept', reason: 'fallback', action: 'none',          say: '...'                 },
  unknown:  { decision: 'accept', reason: 'fallback', action: 'none',          say: '...'                 },
}

function safeDefault(intent) {
  return { ...(SAFE_DEFAULTS[intent] || SAFE_DEFAULTS.unknown) }
}

// ── Autonomous goal selection ──────────────────────────────────────────────────

function selectAutonomousGoal(groundedState) {
  const hasLog      = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
  const hasEnemies  = groundedState.hostileMobs.length > 0
  const hasDrops    = groundedState.droppedCount > 0
  const r = Math.random()

  if (hasEnemies && r < 0.6) return { action: 'attack_mobs',   say: pick(['Something hostile nearby. Dealing with it.', 'Got a target.', 'Fighting time.']) }
  if (hasDrops   && r < 0.5) return { action: 'collect_items', say: pick(['Items on the ground. Picking them up.', 'Gonna grab those drops.']) }
  if (r < 0.5)               return { action: 'explore',       say: pick(['Gonna walk around.', 'Going exploring.', 'Off to look around.', 'Bored. Walking.']) }
  if (hasLog)                return { action: 'gather_wood',   say: pick(['Could use some wood.', 'Gonna chop a tree.', 'Getting wood.']) }
  return null  // caller narrates surroundings
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

module.exports = { classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal }
