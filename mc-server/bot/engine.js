// engine.js — Decision Engine

const VALID_ACTIONS = [
  'follow','stop','explore','gather_wood','craft_planks','go_to','remember_here',
  'attack_mobs','attack_player','collect_items','craft','build_house_smart','none',
]
const VALID_DECISIONS = ['accept','reject','delay']

// Curse words trigger anger toward the speaker.
// Matched as whole words (case-insensitive).
const CURSE_WORDS = [
  'fuck','shit','asshole','bitch','dumbass','idiot','moron','cunt','bastard',
  'damn','retard','stupid','fag','dick','prick','whore','slut','crap',
]
const CURSE_RE = new RegExp(`\\b(${CURSE_WORDS.join('|')})\\b`, 'i')

function detectInsult(message) {
  return CURSE_RE.test(message)
}

// ── Pre-LLM intent classifier ─────────────────────────────────────────────────

const INTENT_PATTERNS = [
  { intent: 'follow',   re: /\b(follow|come here|come to me|come with me)\b/i },
  { intent: 'stop',     re: /\b(stop|wait|stay|halt|cease)\b/i },
  { intent: 'attack',   re: /\b(attack|kill|fight|hunt|slay|defeat)\b/i },
  { intent: 'collect',  re: /\b(pick up|collect|loot|grab|get the items)\b/i },
  { intent: 'build',    re: /\b(build|construct|house|shelter|home|make a house|make a shelter)\b/i },
  { intent: 'craft',    re: /\b(craft|forge|make a|create a|i need a|make planks|craft planks)\b/i },
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

// ── Pre-LLM survival check ────────────────────────────────────────────────────

function evaluateSurvival(state) {
  if (state.energy <= 15) {
    return {
      decision: 'delay',
      reason: 'energy critical',
      action: 'none',
      say: `Exhausted. Resting. Energy: ${Math.floor(state.energy)}/100.`,
    }
  }
  if (state.goal === 'resting') {
    return {
      decision: 'delay',
      reason: 'recovering',
      action: 'none',
      say: `Resting. Energy: ${Math.floor(state.energy)}/100.`,
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
  follow:   { decision: 'accept', reason: 'fallback', action: 'follow',            say: 'On my way.'         },
  stop:     { decision: 'accept', reason: 'fallback', action: 'stop',              say: 'Stopped.'           },
  attack:   { decision: 'accept', reason: 'fallback', action: 'attack_mobs',       say: 'On it.'             },
  collect:  { decision: 'accept', reason: 'fallback', action: 'collect_items',     say: 'Picking up.'        },
  craft:    { decision: 'accept', reason: 'fallback', action: 'craft',             say: 'Let me try.'        },
  build:    { decision: 'accept', reason: 'fallback', action: 'build_house_smart', say: 'Starting build.'    },
  gather:   { decision: 'accept', reason: 'fallback', action: 'gather_wood',       say: 'Getting wood.'      },
  explore:  { decision: 'accept', reason: 'fallback', action: 'explore',           say: 'Going exploring.'   },
  query:    { decision: 'accept', reason: 'fallback', action: 'none',              say: '...'                },
  unknown:  { decision: 'accept', reason: 'fallback', action: 'none',              say: '...'                },
}

function safeDefault(intent) {
  return { ...(SAFE_DEFAULTS[intent] || SAFE_DEFAULTS.unknown) }
}

// ── Autonomous goal selection — driven by needs ─────────────────────────────

function selectAutonomousGoal(groundedState) {
  const hasLog       = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
  const hasEnemies   = groundedState.hostileMobs.length > 0
  const hasDrops     = groundedState.droppedCount > 0
  const logsInInv    = groundedState.inventory.some(i => i.includes('_log'))
  const lowEnergy    = groundedState.self.energy < 50

  // Priority: threats > drops > productive work > exploration
  if (hasEnemies)              return { action: 'attack_mobs',   say: pick(['Hostile nearby. Engaging.', 'Got a target.', 'Time to fight.']) }
  if (hasDrops && !lowEnergy)  return { action: 'collect_items', say: pick(['Items on the ground.', 'Picking up drops.']) }

  const r = Math.random()
  if (logsInInv && r < 0.3)    return { action: 'craft_planks',  say: pick(['Turning logs into planks.', 'Time to make planks.']) }
  if (hasLog && r < 0.5)       return { action: 'gather_wood',   say: pick(['Need wood.', 'Gonna chop a tree.']) }
  if (r < 0.8)                 return { action: 'explore',       say: pick(['Walking around.', 'Going exploring.', 'Off to look.']) }
  return null  // narrate
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

module.exports = {
  classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal,
  detectInsult, CURSE_WORDS,
}
