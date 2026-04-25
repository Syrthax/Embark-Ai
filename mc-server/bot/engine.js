// engine.js — Decision Engine
// Handles: intent classification, survival rules, LLM output validation, safe defaults

const VALID_ACTIONS   = ['follow','stop','explore','gather_wood','go_to','remember_here','none']
const VALID_DECISIONS = ['accept','reject','delay']

// ── Pre-LLM: classify what the player wants ───────────────────
// Runs BEFORE the LLM. Lets us short-circuit and validate LLM output.

const INTENT_PATTERNS = [
  { intent: 'follow',  re: /\b(follow|come here|come to me|come with me)\b/i },
  { intent: 'stop',    re: /\b(stop|wait|stay|halt)\b/i },
  { intent: 'gather',  re: /\b(wood|tree|chop|gather|mine|fish|food|collect|get some|find some|need some|sand|stone|gravel|ore)\b/i },
  { intent: 'explore', re: /\b(explore|wander|walk|roam|go to)\b/i },
  { intent: 'build',   re: /\b(build|make|craft|construct|create|pickaxe|axe|sword)\b/i },
  { intent: 'query',   re: /\b(where|what|who|how|status|see|have|inventory|can you|are you|bro)\b/i },
]

function classifyIntent(message) {
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(message)) return intent
  }
  return 'unknown'
}

// ── Pre-LLM: survival check — short-circuits LLM for critical conditions ─────

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
      say: `Resting right now. Energy: ${Math.floor(state.energy)}/100.`,
    }
  }
  return null
}

// ── Validate LLM output strictly — returns null if invalid ───────────────────

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

// ── Safe defaults when LLM fails or validation fails — keyed by intent ───────

const SAFE_DEFAULTS = {
  follow:  { decision: 'accept', reason: 'fallback', action: 'follow',      say: 'On my way.'           },
  stop:    { decision: 'accept', reason: 'fallback', action: 'stop',        say: 'Stopped.'             },
  gather:  { decision: 'accept', reason: 'fallback', action: 'gather_wood', say: 'Getting some wood.'   },
  explore: { decision: 'accept', reason: 'fallback', action: 'explore',     say: 'Going exploring.'     },
  build:   { decision: 'reject', reason: 'fallback', action: 'none',        say: "Can't build yet."     },
  query:   { decision: 'accept', reason: 'fallback', action: 'none',        say: '...'                  },
  unknown: { decision: 'accept', reason: 'fallback', action: 'none',        say: '...'                  },
}

function safeDefault(intent) {
  return { ...(SAFE_DEFAULTS[intent] || SAFE_DEFAULTS.unknown) }
}

// ── Autonomous goal selection — structured, not random ────────────────────────

function selectAutonomousGoal(groundedState) {
  const hasLog = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
  const r = Math.random()

  if (r < 0.50) return { action: 'explore',      say: pick(['Gonna walk around.', 'Going exploring.', 'Off to look around.', 'Bored. Walking.']) }
  if (r < 0.80 && hasLog) return { action: 'gather_wood', say: pick(['Could use some wood.', 'Gonna chop a tree.', 'Getting wood.']) }
  return null  // caller narrates surroundings instead
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

module.exports = { classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal }
