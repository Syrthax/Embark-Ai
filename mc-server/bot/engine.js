// engine.js — Decision Engine

const VALID_ACTIONS = [
  'follow','stop','explore','gather_wood','craft_planks','go_to','remember_here',
  'attack_mobs','attack_player','collect_items','craft','place_block',
  'mine_block','eat_food','flee','escape','build_house_smart','none',
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
  { intent: 'flee',     re: /\b(flee|run away|retreat|fall back)\b/i },
  { intent: 'escape',   re: /\b(escape|climb out|get out|dig out|stuck|get unstuck)\b/i },
  { intent: 'eat',      re: /\b(eat|food|hungry|feed yourself)\b/i },
  { intent: 'collect',  re: /\b(pick up|collect|loot|grab|get the items)\b/i },
  { intent: 'build',    re: /\b(build|construct|house|shelter|home|make a house|make a shelter)\b/i },
  { intent: 'craft',    re: /\b(craft|forge|make a|create a|i need a|make planks|craft planks)\b/i },
  { intent: 'place',    re: /\b(place|put down|drop the|set down)\b/i },
  { intent: 'mine',     re: /\b(mine|dig|break the)\b/i },
  { intent: 'gather',   re: /\b(wood|tree|chop|gather|need some|get some|sand|stone|gravel|ore)\b/i },
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
  flee:     { decision: 'accept', reason: 'fallback', action: 'flee',              say: 'Pulling back.'      },
  escape:   { decision: 'accept', reason: 'fallback', action: 'escape',            say: 'Climbing out.'      },
  eat:      { decision: 'accept', reason: 'fallback', action: 'eat_food',          say: 'Eating.'            },
  collect:  { decision: 'accept', reason: 'fallback', action: 'collect_items',     say: 'Picking up.'        },
  craft:    { decision: 'accept', reason: 'fallback', action: 'craft',             say: 'Let me try.'        },
  place:    { decision: 'accept', reason: 'fallback', action: 'place_block',       say: 'Placing it.'        },
  mine:     { decision: 'accept', reason: 'fallback', action: 'mine_block',        say: 'Digging in.'        },
  build:    { decision: 'accept', reason: 'fallback', action: 'build_house_smart', say: 'Starting build.'    },
  gather:   { decision: 'accept', reason: 'fallback', action: 'gather_wood',       say: 'Getting wood.'      },
  explore:  { decision: 'accept', reason: 'fallback', action: 'explore',           say: 'Going exploring.'   },
  query:    { decision: 'accept', reason: 'fallback', action: 'none',              say: '...'                },
  unknown:  { decision: 'accept', reason: 'fallback', action: 'none',              say: '...'                },
}

function safeDefault(intent) {
  return { ...(SAFE_DEFAULTS[intent] || SAFE_DEFAULTS.unknown) }
}

// ── Autonomous goal selection — priority-driven survival planner ────────────
//
// Order is strict (highest priority first):
//   1. THREATS    — hostile mob nearby                → attack
//   2. RESTING    — energy critical                   → null (let state-loop rest)
//   3. SCAVENGE   — items on ground (free resources)  → collect
//   4. CRAFT      — have logs, no planks yet          → craft_planks
//   5. CRAFT_TOOL — have planks but no pickaxe        → craft wooden_pickaxe
//   6. WOOD       — have <8 planks and trees nearby   → gather_wood
//   7. EXPLORE    — nothing else useful               → explore
//
// Each branch returns { action, say, target? }. Returning null = no autonomous action.

function countInv(inventory, predicate) {
  return inventory.filter(predicate).reduce((s, i) => {
    const m = i.match(/x(\d+)$/); return s + (m ? parseInt(m[1]) : 1)
  }, 0)
}

function selectAutonomousGoal(groundedState) {
  const inv          = groundedState.inventory
  const hasEnemies   = groundedState.hostileMobs.length > 0
  const hasDrops     = groundedState.droppedCount > 0
  const hasLog       = groundedState.nearbyBlocks.some(b => b.type.endsWith('_log'))
  const logsInInv    = inv.some(i => i.includes('_log'))
  const planksCount  = countInv(inv, i => i.includes('_planks'))
  const hasSticks    = inv.some(i => i === 'stick' || i.startsWith('stickx'))
  const hasPickaxe   = inv.some(i => i.includes('pickaxe'))
  const hasSword     = inv.some(i => i.includes('sword'))
  const hasTable     = inv.some(i => i === 'crafting_table' || i.startsWith('crafting_table'))
  const hasFood      = inv.some(i => /^(cooked_|bread|apple|carrot|baked_potato|melon|berries|cookie|pumpkin_pie)/.test(i.split('x')[0]))
  const food         = groundedState.self.food ?? 20
  const lowEnergy    = groundedState.self.energy < 40
  const criticalEnergy = groundedState.self.energy < 20

  // 0. EMERGENCY — flee if critical HP and threats nearby
  if (criticalEnergy && hasEnemies) {
    return { action: 'flee', say: pick(['Falling back!', 'Too risky.']) }
  }

  // 1. EAT — prevent hunger from blocking regen (Minecraft regens HP only when food >= 18)
  if (food < 16 && hasFood) {
    return { action: 'eat_food', say: pick(['Need food.', 'Eating up.']) }
  }

  // 2. THREAT — fight hostile mobs unless near death
  if (hasEnemies && !criticalEnergy) {
    return { action: 'attack_mobs', say: pick(['Hostile target.', 'Engaging.', 'Threat in range.']) }
  }

  // 3. RESTING — too tired for productive work
  if (criticalEnergy) return null

  // 3. SCAVENGE — free resources nearby (always worth picking up)
  if (hasDrops) {
    return { action: 'collect_items', say: pick(['Picking up drops.', 'Free loot.']) }
  }

  // 4. CRAFT planks — convert logs in inventory to planks (unblocks other crafts)
  if (logsInInv && planksCount < 16) {
    return { action: 'craft_planks', say: pick(['Making planks.', 'Processing logs.']) }
  }

  // 5. CRAFT crafting_table — needed before tools
  if (planksCount >= 4 && !hasTable) {
    return { action: 'craft', target: 'crafting_table', say: 'Need a crafting table.' }
  }

  // 6a. CRAFT sticks (prerequisite for all wooden tools)
  if (planksCount >= 4 && !hasSticks && (!hasPickaxe || !hasSword)) {
    return { action: 'craft', target: 'stick', say: 'Need sticks.' }
  }

  // 6b. CRAFT pickaxe (most important survival tool)
  if (planksCount >= 3 && hasSticks && !hasPickaxe && hasTable) {
    return { action: 'craft', target: 'wooden_pickaxe', say: 'Making a pickaxe.' }
  }

  // 7. CRAFT sword (defense)
  if (planksCount >= 2 && hasSticks && !hasSword && hasTable && hasPickaxe) {
    return { action: 'craft', target: 'wooden_sword', say: 'Making a sword.' }
  }

  // 8. GATHER wood — keep stockpile up if trees are around (skip in creative: no drops)
  const isCreative = groundedState.gameMode === 'creative'
  if (!isCreative && hasLog && planksCount < 32 && !lowEnergy) {
    return { action: 'gather_wood', say: pick(['Need wood.', 'Heading for that tree.']) }
  }

  // 9. EXPLORE — default behavior, find new resources
  if (!lowEnergy) {
    return { action: 'explore', say: pick(['Walking around.', 'Looking around.', 'Off to scout.']) }
  }

  return null  // resting, nothing to do
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }

module.exports = {
  classifyIntent, evaluateSurvival, validateLLMOutput, safeDefault, selectAutonomousGoal,
  detectInsult, CURSE_WORDS,
}
