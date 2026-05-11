// tasks.js — All the `taskXxx` bodies + their helpers, extracted from bot.js.
//
// Behaviour-preserving move (Fix 9 Step 2). createTasks(deps) returns the bound
// task functions; bot.js calls them via `tasks.taskXxx`. The task runner
// (runTask/replaceTask/cancelCurrentTask), navNear, makeMovements, and the goto
// lifecycle tracking stay in bot.js — tasks receive navNear as a dependency.
//
// Two small non-functional clean-ups vs. the original bodies (forced by the move
// into a module that has `log` (the logger) in scope):
//   - taskGatherWood / taskBuildHouseSmart: the `findBlock` result was named `log`,
//     shadowing the logger — renamed to `logBlock`.
//   - taskCraftPlanks: the `for (const log of logs)` loop var renamed to `logItem`.
// Everything else is verbatim.

'use strict'

const { HOSTILE_MOB_NAMES } = require('./state')

module.exports = function createTasks(deps) {
  const {
    bot, log, state, memory, movement, liveness,
    safeChat,
    safeDig, safeCraft, safeEquip, safeConsume, safePlaceBlock, safeAttack,
    navNear, awaitValidPosition,
    isValidVec, isFiniteNum, safeFloor, safeNormalize2D,
    rememberEvent, rememberLocation, recallLocation,
    anger,
    BOT_NAME,
    getLastEnvScan, getEnvPerception, getLocomotionRecovery,
  } = deps

  // ── Shared item-name constants / helpers ─────────────────────────────────────

  const LOG_NAMES   = ['oak_log','birch_log','spruce_log','jungle_log','acacia_log','dark_oak_log','mangrove_log','cherry_log']
  const PLANK_NAMES = ['oak_planks','birch_planks','spruce_planks','jungle_planks','acacia_planks','dark_oak_planks','mangrove_planks','cherry_planks']

  const logIds   = () => LOG_NAMES.map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
  const plankIds = () => PLANK_NAMES.map(n => bot.registry.itemsByName[n]?.id).filter(Boolean)

  function countInInv(names) {
    return bot.inventory.items()
      .filter(i => names.includes(i.name))
      .reduce((s, i) => s + i.count, 0)
  }

  async function equipBestWeapon() {
    const weapons = [
      'netherite_sword','diamond_sword','iron_sword','stone_sword','wooden_sword',
      'netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe',
    ]
    for (const w of weapons) {
      const id = bot.registry.itemsByName[w]?.id
      const item = id ? bot.inventory.findInventoryItem(id, null, false) : null
      if (item) { await safeEquip(bot, item, 'hand'); return w }
    }
    return null
  }

  async function equipBestTool(blockName) {
    // Map block to preferred tool tier (best first)
    const toolPrefs = {
      stone:        ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe'],
      coal_ore:     ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe'],
      iron_ore:     ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe','stone_pickaxe'],
      diamond_ore:  ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe'],
      gold_ore:     ['netherite_pickaxe','diamond_pickaxe','iron_pickaxe'],
      sand:         ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel'],
      gravel:       ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel'],
      dirt:         ['netherite_shovel','diamond_shovel','iron_shovel','stone_shovel','wooden_shovel'],
    }
    const isLog = blockName.endsWith('_log')
    const prefs = isLog
      ? ['netherite_axe','diamond_axe','iron_axe','stone_axe','wooden_axe']
      : (toolPrefs[blockName] || [])
    for (const tool of prefs) {
      const id = bot.registry.itemsByName[tool]?.id
      const item = id ? bot.inventory.findInventoryItem(id, null, false) : null
      if (item) {
        try { await safeEquip(bot, item, 'hand'); return tool } catch {}
      }
    }
    return null
  }

  // ── Crafting helpers ─────────────────────────────────────────────────────────

  // Items whose recipes always require sticks (vanilla wooden/stone/iron/gold/diamond/netherite tools)
  const STICK_TOOL_RE = /^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|sword|axe|shovel|hoe)$/

  function countItemsByName(name) {
    // Match by name string — more robust across protocol/registry version drift
    return bot.inventory.items()
      .filter(i => i.name === name)
      .reduce((s, i) => s + i.count, 0)
  }

  function countMaterialFamily(suffix) {
    // e.g., "_planks" → counts all plank types together
    return bot.inventory.items()
      .filter(i => i.name.endsWith(suffix))
      .reduce((s, i) => s + i.count, 0)
  }

  // Track items that "successfully" crafted but didn't actually consume materials —
  // likely a mineflayer/server protocol mismatch. Don't keep retrying these.
  const phantomCraftBlocklist = new Map()  // itemName -> blockedUntilTimestamp
  const PHANTOM_BLOCK_MS = 5 * 60 * 1000  // block re-attempts for 5 minutes

  function inventoryHas(predicate) {
    return bot.inventory.items().some(predicate)
  }

  // Auto-craft sticks if needed. Returns true if sticks are now available.
  async function ensureSticks() {
    const stickId = bot.registry.itemsByName['stick']?.id
    if (!stickId) return false
    if (bot.inventory.findInventoryItem(stickId, null, false)) return true

    // Need at least 2 planks (any kind). If we don't have planks but have logs, craft planks first.
    const totalPlanks = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
    if (totalPlanks < 2) {
      if (bot.inventory.items().some(i => i.name.endsWith('_log'))) {
        log.info('auto_craft_planks_for_sticks')
        await taskCraftPlanks()
      } else {
        log.warn('cannot_make_sticks', { reason: 'no planks or logs' })
        return false
      }
    }

    // Sticks: 2 planks → 4 sticks. Inventory crafting (no table required).
    const recipes = bot.recipesFor(stickId, null, 1, null)
    if (!recipes.length) {
      log.warn('no_stick_recipe_available', { invPlanks: totalPlanks })
      return false
    }
    try {
      await safeCraft(bot, recipes[0], 1, null)
      log.info('crafted_sticks_auto', { sticksNow: countItemsByName('stick') })
      return true
    } catch (e) {
      log.error('stick_craft_exception', { message: e.message })
      return false
    }
  }

  // Determine which ingredients are missing for a recipe (best-effort diagnostic).
  function describeRecipe(itemId) {
    // Search the registry for any recipe producing this item
    try {
      const recipes = bot.registry.recipes?.[itemId]
      if (!recipes || !recipes.length) return null
      return recipes[0]  // raw shape varies by mineflayer version, used for logging only
    } catch { return null }
  }

  // Place a block from inventory in front of the bot (or adjacent if blocked).
  // Returns true on success, false if no spot found or no item.
  async function placeFromInventory(blockName) {
    const normalized = blockName.replace(/ /g, '_').toLowerCase()
    const itemId = bot.registry.itemsByName[normalized]?.id
    if (!itemId) return false
    const item = bot.inventory.findInventoryItem(itemId, null, false)
    if (!item) return false

    await safeEquip(bot, item, 'hand')

    // Compute "in front of bot" target — uses yaw to find facing direction
    const yaw = bot.entity.yaw
    const dx = -Math.round(Math.sin(yaw))
    const dz = -Math.round(Math.cos(yaw))
    const here = bot.entity.position.floored()

    // Try positions in priority order: directly in front (ground level), then sides, then behind
    const offsets = [
      [dx, 0, dz], [dx, -1, dz],          // in front, ground or one below
      [dz, 0, -dx], [-dz, 0, dx],         // left, right
      [-dx, 0, -dz],                      // behind (last resort)
    ]

    for (const [ox, oy, oz] of offsets) {
      const targetPos = here.offset(ox, oy, oz)
      const current = bot.blockAt(targetPos)
      if (!current || (current.name !== 'air' && current.name !== 'cave_air' && current.name !== 'grass')) continue

      // Find a solid reference block adjacent to the target to "click on"
      const adj = [[0,-1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1],[0,1,0]]
      for (const [adx, ady, adz] of adj) {
        const refBlock = bot.blockAt(targetPos.offset(adx, ady, adz))
        if (!refBlock || refBlock.boundingBox !== 'block') continue
        try {
          const faceVec = targetPos.minus(refBlock.position)
          await safePlaceBlock(bot, refBlock, faceVec)
          log.info('placed_block', { block: normalized, pos: { x: targetPos.x, y: targetPos.y, z: targetPos.z } })
          return true
        } catch (e) {
          // Try next reference block
        }
      }
    }
    return false
  }

  // ── Tasks: gather / craft / mine / eat ───────────────────────────────────────

  async function taskExplore() {
    let p
    try { p = await awaitValidPosition(2000) }
    catch (e) { log.warn('explore_skip_invalid_position', { reason: e.message }); return }

    const angle = Math.random() * Math.PI * 2
    const dist  = 10 + Math.random() * 20  // 10-30 blocks — short enough to reliably reach
    const tx    = Math.floor(p.x + Math.sin(angle) * dist)
    const ty    = Math.floor(p.y)
    const tz    = Math.floor(p.z + Math.cos(angle) * dist)
    if (!isFiniteNum(tx) || !isFiniteNum(ty) || !isFiniteNum(tz)) {
      log.error('explore_target_invalid', { tx, ty, tz })
      return
    }
    log.debug('explore_target', { from: safeFloor(p), to: { x: tx, y: ty, z: tz } })

    // Fail fast on complex terrain — try another direction next idle cycle
    movement.setThinkingTimeout(2000)
    try {
      await navNear(tx, ty, tz, 5)
      rememberLocation(memory, 'last_explored', bot.entity.position)
    } finally {
      movement.restoreThinkingTimeout()
    }
  }

  async function taskGatherWood() {
    const ids = logIds()
    const logBlock = bot.findBlock({ matching: ids, maxDistance: 50 })
    if (!logBlock) { safeChat('No trees in range.'); return }
    console.log(`[${BOT_NAME}] Chopping log at ${logBlock.position}`)
    await navNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2)
    const fresh = bot.blockAt(logBlock.position)
    if (fresh && ids.includes(fresh.type) && bot.canDigBlock(fresh)) {
      await safeDig(bot, fresh)
      // Step into the drop so the item entity is auto-collected
      await new Promise(r => setTimeout(r, 300))
      try { await navNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 0) } catch {}
      safeChat('Got wood.')
      rememberEvent(memory, 'gathered_wood', {})
    }
  }

  async function taskCraftPlanks() {
    const logs = bot.inventory.items().filter(i => LOG_NAMES.includes(i.name))
    if (!logs.length) { safeChat('No logs to convert.'); return }

    let totalCrafted = 0
    for (const logItem of logs) {
      const plankName = logItem.name.replace('_log', '_planks')
      const plankId = bot.registry.itemsByName[plankName]?.id
      if (!plankId) continue

      const recipes = bot.recipesFor(plankId, null, 1, null)
      if (!recipes.length) continue

      try {
        const count = logItem.count
        await safeCraft(bot, recipes[0], count, null)
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
    const normalized = (itemName || '').replace(/ /g, '_').toLowerCase()
    if (!normalized) { safeChat('Craft what?'); return }

    const itemData = bot.registry.itemsByName[normalized]
    if (!itemData) { safeChat(`Don't know what "${itemName}" is.`); return }

    // Skip items that previously phantom-crafted (succeeded silently without consuming materials)
    const blockedUntil = phantomCraftBlocklist.get(normalized)
    if (blockedUntil && Date.now() < blockedUntil) {
      const secsLeft = Math.ceil((blockedUntil - Date.now()) / 1000)
      log.warn('craft_skip_phantom_blocked', { item: normalized, secsLeft })
      safeChat(`Skipping ${itemName} — recipe seems broken.`)
      return
    }

    const beforeCount = countItemsByName(normalized)
    const invSnapshot = bot.inventory.items().map(i => `${i.name}x${i.count}`)
    log.info('craft_start', { item: normalized, before: beforeCount, inventory: invSnapshot })

    // ── 1. Try inventory crafting (recipes that don't need a table) ────────────
    let recipes = bot.recipesFor(itemData.id, null, 1, null)
    if (recipes.length > 0) {
      try {
        const stickBefore = countItemsByName('stick')
        const planksBefore = countMaterialFamily('_planks')
        await safeCraft(bot, recipes[0], 1, null)
        const after = countItemsByName(normalized)
        const stickAfter = countItemsByName('stick')
        const planksAfter = countMaterialFamily('_planks')
        const consumed = (stickAfter < stickBefore) || (planksAfter < planksBefore)
        if (after > beforeCount && consumed) {
          safeChat(`Crafted ${itemName}.`)
          log.info('craft_success', { item: normalized, table: false, before: beforeCount, after })
          rememberEvent(memory, 'crafted', { item: itemName })
          return
        }
        if (after > beforeCount && !consumed) {
          log.error('craft_phantom', { item: normalized, table: false, beforeCount, after, stickBefore, stickAfter, planksBefore, planksAfter })
          phantomCraftBlocklist.set(normalized, Date.now() + PHANTOM_BLOCK_MS)
          safeChat(`Recipe broken for ${itemName}.`)
          return
        }
        log.warn('craft_no_count_change', { item: normalized, table: false })
      } catch (e) {
        log.error('craft_inventory_exception', { item: normalized, message: e.message })
      }
    }

    // ── 2. Need a crafting table — find or auto-place one ──────────────────────
    const tableId = bot.registry.blocksByName['crafting_table']?.id
    let table = tableId ? bot.findBlock({ matching: [tableId], maxDistance: 20 }) : null

    if (!table) {
      const tableItemId = bot.registry.itemsByName['crafting_table']?.id
      if (tableItemId && bot.inventory.findInventoryItem(tableItemId, null, false)) {
        log.info('auto_place_table', { reason: `crafting ${normalized}` })
        const placed = await placeFromInventory('crafting_table')
        if (placed) {
          await new Promise(r => setTimeout(r, 300))
          table = tableId ? bot.findBlock({ matching: [tableId], maxDistance: 5 }) : null
        }
      }
    }

    if (!table) {
      safeChat('No crafting table.')
      log.warn('craft_no_table', { item: normalized, hasTableInInv: inventoryHas(i => i.name === 'crafting_table') })
      return
    }
    await navNear(table.position.x, table.position.y, table.position.z, 2)

    // ── 3. Try with the table ──────────────────────────────────────────────────
    recipes = bot.recipesFor(itemData.id, null, 1, table)

    // ── 4. If no recipe is currently makeable and this is a tool, auto-make sticks ──
    if (recipes.length === 0 && STICK_TOOL_RE.test(normalized) && !inventoryHas(i => i.name === 'stick')) {
      log.info('auto_resolve_sticks', { reason: `tool prerequisite for ${normalized}` })
      safeChat('Need sticks first.')
      const ok = await ensureSticks()
      if (ok) {
        recipes = bot.recipesFor(itemData.id, null, 1, table)
      }
    }

    // ── 5. Final sanity check ──────────────────────────────────────────────────
    if (recipes.length === 0) {
      const inv = bot.inventory.items().map(i => `${i.name}x${i.count}`).join(', ') || 'empty'
      log.warn('craft_failed_no_recipe', { item: normalized, inventory: inv })
      safeChat(`Can't craft ${itemName}. Have: ${inv.length > 80 ? inv.slice(0, 77) + '...' : inv}`)
      return
    }

    // ── 6. Craft and verify (also detect phantom: success but materials not consumed) ──
    try {
      const stickBefore = countItemsByName('stick')
      const planksBefore = countMaterialFamily('_planks')
      await safeCraft(bot, recipes[0], 1, table)
      const after = countItemsByName(normalized)
      const stickAfter = countItemsByName('stick')
      const planksAfter = countMaterialFamily('_planks')
      const consumed = (stickAfter < stickBefore) || (planksAfter < planksBefore)

      if (after > beforeCount && consumed) {
        safeChat(`Crafted ${itemName}.`)
        log.info('craft_success', { item: normalized, table: true, before: beforeCount, after, consumed: { stick: stickBefore - stickAfter, planks: planksBefore - planksAfter } })
        rememberEvent(memory, 'crafted', { item: itemName })
      } else if (after > beforeCount && !consumed) {
        // Phantom craft: server didn't actually accept the recipe (likely protocol/data version drift)
        // Don't keep retrying the same item — block for 5 minutes.
        log.error('craft_phantom', { item: normalized, table: true, beforeCount, after, stickBefore, stickAfter, planksBefore, planksAfter })
        phantomCraftBlocklist.set(normalized, Date.now() + PHANTOM_BLOCK_MS)
        safeChat(`Recipe broken for ${itemName}. Skipping.`)
      } else {
        log.warn('craft_silent_failure', { item: normalized, before: beforeCount, after })
        safeChat(`Crafted ${itemName} but inventory unchanged?`)
      }
    } catch (e) {
      log.error('craft_table_exception', { item: normalized, message: e.message, stack: e.stack?.split('\n')[1]?.trim() })
      safeChat(`Craft error: ${e.message.slice(0, 50)}`)
    }
  }

  async function taskPlaceBlock(blockName) {
    const normalized = (blockName || '').replace(/ /g, '_').toLowerCase()
    if (!normalized) { safeChat("Place what?"); return }
    if (!bot.registry.itemsByName[normalized]) {
      safeChat(`Don't know what "${blockName}" is.`); return
    }
    const itemId = bot.registry.itemsByName[normalized].id
    if (!bot.inventory.findInventoryItem(itemId, null, false)) {
      safeChat(`No ${blockName} in inventory.`); return
    }
    const ok = await placeFromInventory(normalized)
    if (ok) {
      safeChat(`Placed ${blockName}.`)
      rememberEvent(memory, 'placed', { block: normalized })
    } else {
      safeChat(`No good spot to place ${blockName}.`)
    }
  }

  // Generic mining — works for stone, ores, sand, etc.
  // Resolves singular → plural (e.g. "stone" finds stone block).
  async function taskMineBlock(blockName, count = 1) {
    const normalized = (blockName || '').replace(/ /g, '_').toLowerCase()
    if (!normalized) { safeChat('Mine what?'); return }

    // Resolve a few common aliases
    const aliasMap = {
      wood: 'oak_log', tree: 'oak_log', log: 'oak_log',
      stone_block: 'stone',
      iron: 'iron_ore', coal: 'coal_ore', gold: 'gold_ore', diamond: 'diamond_ore',
    }
    const target = aliasMap[normalized] || normalized
    const blockId = bot.registry.blocksByName[target]?.id
    if (!blockId) {
      safeChat(`Don't know how to find "${blockName}".`)
      log.warn('mine_unknown_block', { block: normalized })
      return
    }

    log.info('mine_start', { block: target, count })
    let mined = 0
    let consecutiveFailures = 0
    while (mined < count && consecutiveFailures < 3) {
      const block = bot.findBlock({ matching: [blockId], maxDistance: 32 })
      if (!block) {
        log.warn('mine_no_block_found', { block: target, mined, requested: count })
        safeChat(mined > 0 ? `Got ${mined}. No more nearby.` : `No ${blockName} nearby.`)
        return
      }

      if (!bot.canDigBlock(block)) {
        log.warn('mine_cant_dig', { block: target, hasPickaxe: inventoryHas(i => i.name.includes('pickaxe')) })
        safeChat(`Can't break ${blockName} — wrong tool?`)
        return
      }

      try {
        await navNear(block.position.x, block.position.y, block.position.z, 2)
        const fresh = bot.blockAt(block.position)
        if (!fresh || fresh.type !== blockId) {
          consecutiveFailures++
          continue  // someone else broke it, or it changed
        }
        // Equip the best tool we have
        await equipBestTool(target)
        await safeDig(bot, fresh)
        mined++
        consecutiveFailures = 0
        log.info('mined', { block: target, count: mined })
      } catch (e) {
        consecutiveFailures++
        log.error('mine_exception', { block: target, message: e.message, attempt: consecutiveFailures })
      }
    }

    if (mined > 0) {
      safeChat(`Got ${mined} ${blockName}.`)
      rememberEvent(memory, 'mined', { block: target, count: mined })
    } else {
      safeChat(`Couldn't mine ${blockName}.`)
    }
  }

  // Eat food when hungry. Picks the best available food (cooked > raw > emergency).
  const FOOD_PRIORITY = [
    'cooked_beef','cooked_porkchop','cooked_chicken','cooked_mutton','cooked_rabbit',
    'cooked_cod','cooked_salmon','baked_potato','bread','pumpkin_pie',
    'beef','porkchop','chicken','mutton','rabbit',
    'apple','carrot','melon_slice','sweet_berries','cookie','golden_apple',
    // Last resort — these have side effects
    'rotten_flesh','spider_eye','poisonous_potato',
  ]

  async function taskEatFood() {
    if (bot.food >= 20) { safeChat('Already full.'); return }

    const inv = bot.inventory.items()
    let food = null
    for (const fn of FOOD_PRIORITY) {
      food = inv.find(i => i.name === fn)
      if (food) break
    }

    if (!food) {
      log.warn('eat_no_food', { hunger: bot.food })
      safeChat('No food.')
      return
    }

    log.info('eat_start', { food: food.name, hungerBefore: bot.food })
    try {
      await safeEquip(bot, food, 'hand')
      await safeConsume(bot)
      log.info('eat_success', { food: food.name, hungerBefore: bot.food, hungerAfter: bot.food })
      safeChat(`Ate ${food.name.replace(/_/g, ' ')}.`)
      rememberEvent(memory, 'ate', { food: food.name })
    } catch (e) {
      log.error('eat_exception', { food: food.name, message: e.message })
      safeChat(`Couldn't eat: ${e.message.slice(0, 50)}`)
    }
  }

  // ── Tasks: combat / survival ─────────────────────────────────────────────────

  async function taskAttackMobs() {
    const mob = bot.nearestEntity(e =>
      e.name && HOSTILE_MOB_NAMES.has(e.name) && e.position.distanceTo(bot.entity.position) < 20
    )
    if (!mob) { safeChat('No hostile mobs nearby.'); return }

    const weapon = await equipBestWeapon()
    console.log(`[${BOT_NAME}] Attacking ${mob.name} with ${weapon || 'fists'}`)
    safeChat(`Fighting ${mob.name}.`)
    await safeAttack(bot, mob, { maxMs: 10_000, label: mob.name })

    if (mob.isValid) safeChat('Got away.')
    else            { safeChat(`${mob.name} down.`); rememberEvent(memory, 'killed_mob', { name: mob.name }) }
  }

  async function taskAttackPlayer(entity, username) {
    if (!entity || !entity.isValid) { safeChat(`${username} is gone.`); return }

    const weapon = await equipBestWeapon()
    console.log(`[${BOT_NAME}] Attacking player ${username} with ${weapon || 'fists'}`)
    safeChat(`Coming for you, ${username}.`)
    await safeAttack(bot, entity, { maxMs: 10_000, label: username })

    // Reduce anger after fighting
    const rec = anger.get(username)
    if (rec) rec.level = Math.max(0, rec.level - 3)
    safeChat('We even now.')
    rememberEvent(memory, 'fought_player', { username })
  }

  // Escape from being stuck (in a hole, surrounded, etc.)
  // Strategy: try to navigate to a higher Y at our current X/Z (pathfinder will dig
  // or pillar with our scaffolding blocks). If that fails, dig straight up as a last resort.
  async function taskEscape() {
    let p
    try { p = await awaitValidPosition(2000) }
    catch (e) { log.warn('escape_skip_invalid_position', { reason: e.message }); safeChat("Can't escape yet."); return }

    // Get current perception to classify stuck state and orient escape
    const ep = getEnvPerception()
    const scan = getLastEnvScan() || (ep ? ep.scan() : null)
    const stuckClass = scan?.stuckClass || 'unknown'

    log.info('escape_start', {
      from: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
      stuckClass,
      locomotionRisk: scan?.locomotionRisk ?? null,
      hazardSummary:  scan?.hazardSummary  ?? null,
    })
    safeChat('Stuck — escaping.')

    // Phase 1: locomotion micro-escape first (fast, no pathfinder)
    const lr = getLocomotionRecovery()
    if (lr && scan?.valid !== false) {
      log.info('escape_attempt', { method: 'locomotion_phase', stuckClass })
      await lr.runHazardEscape(stuckClass, scan, 'task_escape')
      await new Promise(r => setTimeout(r, 300))
    }

    // Re-read position after locomotion phase
    const p2 = bot.entity?.position
    if (!isValidVec(p2)) {
      log.warn('escape_position_invalid_after_locomotion')
      return
    }

    const startY = Math.floor(p2.y)
    const targetY = Math.min(75, startY + 15)

    // Phase 2: pathfinder escape — prefer escape-vector direction if known
    const ev = scan?.escapeVector
    const cx  = Math.floor(p2.x)
    const cz  = Math.floor(p2.z)

    const attempts = [
      { x: cx, z: cz, y: targetY },  // straight up
      // Escape-vector-biased targets first
      ...(ev ? [
        { x: cx + ev.dx * 6, z: cz + ev.dz * 6, y: targetY },
        { x: cx + ev.dx * 4, z: cz + ev.dz * 4, y: startY  },
      ] : []),
      { x: cx + 6, z: cz,     y: targetY },
      { x: cx - 6, z: cz,     y: targetY },
      { x: cx,     z: cz + 6, y: targetY },
      { x: cx,     z: cz - 6, y: targetY },
    ]

    movement.setThinkingTimeout(5000)
    try {
      for (const a of attempts) {
        if (!isFiniteNum(a.x) || !isFiniteNum(a.y) || !isFiniteNum(a.z)) continue
        try {
          await navNear(Math.floor(a.x), Math.floor(a.y), Math.floor(a.z), 3)
          const newY = Math.floor(bot.entity.position.y)
          log.info('escape_complete', { method: 'pathfinder', reached: a, newY, stuckClass })
          safeChat('Out!')
          return
        } catch (e) {
          log.warn('escape_attempt_failed', { target: a, message: e.message })
        }
      }
    } finally {
      movement.restoreThinkingTimeout()
    }

    // Phase 3: dig up as last resort
    log.warn('escape_falling_back_to_dig_up', { stuckClass })
    await digUp(12)
    log.info('escape_complete', { method: 'dig_up', endY: Math.floor(bot.entity.position.y) })
  }

  // Mine the block above the bot's head, jump to fill the new space, repeat.
  // Used when pathfinder can't find a way out.
  async function digUp(maxBlocks = 10) {
    let dug = 0
    for (let i = 0; i < maxBlocks; i++) {
      const headBlock = bot.blockAt(bot.entity.position.offset(0, 2, 0))
      if (!headBlock || ['air', 'cave_air', 'void_air'].includes(headBlock.name)) {
        break  // already at open air
      }
      if (!bot.canDigBlock(headBlock)) {
        log.warn('dig_up_blocked', { block: headBlock.name })
        safeChat(`Can't dig ${headBlock.name} — wrong tool?`)
        break
      }
      try {
        await equipBestTool(headBlock.name)
        await safeDig(bot, headBlock)
        dug++
        // Jump up to occupy the new block space
        bot.setControlState('jump', true)
        await new Promise(r => setTimeout(r, 350))
        bot.setControlState('jump', false)
      } catch (e) {
        log.warn('dig_up_step_failed', { message: e.message })
        break
      }
    }
    return dug
  }

  // Step away from an environmental hazard (cactus, lava, fire, etc.).
  // `hazard` is optional — if null, just moves 5 blocks in a random horizontal direction.
  async function taskEvadeHazard(hazard) {
    // Wait for valid position — critical right after teleport / respawn,
    // when bot.entity.position briefly has NaN x/z.
    let pos
    try {
      pos = await awaitValidPosition(2000)
    } catch (e) {
      log.warn('evade_skip_invalid_position', { reason: e.message, hazard: hazard?.name })
      safeChat('Need a moment.')
      return
    }

    // Compute escape vector — always via safeNormalize2D so length-0 / NaN
    // can never produce NaN target coords.
    let rawDx, rawDz, label
    const hazardPos = hazard?.block?.position
    if (hazard && isValidVec(hazardPos)) {
      rawDx = pos.x - hazardPos.x
      rawDz = pos.z - hazardPos.z
      label = (hazard.name || 'something').replace(/_/g, ' ')
    } else {
      rawDx = NaN
      rawDz = NaN  // forces safeNormalize2D into random fallback
      label = hazard?.name?.replace(/_/g, ' ') || 'something'
    }

    const { dx, dz, fallback } = safeNormalize2D(rawDx, rawDz)
    if (fallback) log.debug('evade_normalize_fallback', { reason: fallback, hazard: hazard?.name })

    const tx = Math.floor(pos.x + dx * 5)
    const ty = Math.floor(pos.y)
    const tz = Math.floor(pos.z + dz * 5)

    // Final safety net: if for any reason we still have NaN, pick a random walkable spot
    if (!isFiniteNum(tx) || !isFiniteNum(ty) || !isFiniteNum(tz)) {
      log.error('evade_target_invalid_after_safety', { tx, ty, tz, hazard: hazard?.name })
      return
    }

    log.info('evade_start', {
      hazard: hazard?.name || null,
      from: safeFloor(pos),
      to: { x: tx, y: ty, z: tz },
    })
    safeChat(`Ow — ${label}!`)

    movement.forceStop('evade_start')
    bot.clearControlStates()
    await new Promise(r => setTimeout(r, 100))
    await navNear(tx, ty, tz, 2, movement.PRIORITY.HIGH)
    log.info('evade_complete', { newPos: safeFloor(bot.entity?.position) })
  }

  // Run away from any nearby threats
  async function taskFlee() {
    let pos
    try { pos = await awaitValidPosition(2000) }
    catch (e) { log.warn('flee_skip_invalid_position', { reason: e.message }); return }

    const threats = Object.values(bot.entities)
      .filter(e => e.name && HOSTILE_MOB_NAMES.has(e.name) && isValidVec(e.position) && e.position.distanceTo(pos) < 24)

    if (threats.length === 0) {
      safeChat('Nothing to run from.')
      log.info('flee_no_threats')
      return
    }

    // Direction directly away from the centroid of threats — guarded against NaN.
    let avgX = 0, avgZ = 0
    for (const t of threats) { avgX += t.position.x; avgZ += t.position.z }
    avgX /= threats.length; avgZ /= threats.length
    const { dx, dz, fallback } = safeNormalize2D(pos.x - avgX, pos.z - avgZ)
    if (fallback) log.debug('flee_normalize_fallback', { reason: fallback })

    const fleeX = Math.floor(pos.x + dx * 30)
    const fleeY = Math.floor(pos.y)
    const fleeZ = Math.floor(pos.z + dz * 30)
    if (!isFiniteNum(fleeX) || !isFiniteNum(fleeY) || !isFiniteNum(fleeZ)) {
      log.error('flee_target_invalid', { fleeX, fleeY, fleeZ })
      return
    }

    log.info('flee_start', { threats: threats.map(t => t.name), to: { x: fleeX, y: fleeY, z: fleeZ } })
    safeChat('Falling back!')
    try {
      await navNear(fleeX, fleeY, fleeZ, 5)
      log.info('flee_complete', { newPos: safeFloor(bot.entity?.position) })
    } catch (e) {
      log.warn('flee_path_failed', { message: e.message })
    }
  }

  // Blind survival: sprint away in a random direction using raw control states.
  // Used when position is invalid (NaN) — does NOT use the pathfinder.
  // This breaks the "validator dead-end" failure where the bot stands still dying
  // because all damage events are dropped due to stale position cache (diagnosis F18).
  async function taskBlindSurvival() {
    const ep = getEnvPerception()
    const scan  = getLastEnvScan() || (ep ? ep.scan() : null)
    const stuck = scan?.stuckClass || 'unknown'
    log.warn('blind_survival_start', { livenessState: liveness.getState(), stuckClass: stuck, risk: scan?.locomotionRisk ?? null })
    safeChat('Taking hits. Moving.')

    const lr = getLocomotionRecovery()
    if (lr && scan?.valid !== false) {
      // Use perception-aware escape rather than random yaw
      await lr.runHazardEscape(stuck, scan, 'blind_survival')
    } else {
      // Fallback: random direction sprint
      const angle = Math.random() * Math.PI * 2
      try { bot.entity.yaw = angle } catch {}
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.setControlState('jump', true)
      await new Promise(r => setTimeout(r, 400))
      bot.setControlState('jump', false)
      await new Promise(r => setTimeout(r, 1600))
      bot.clearControlStates()
    }

    log.info('blind_survival_complete', { livenessState: liveness.getState() })
  }

  // ── Tasks: building ──────────────────────────────────────────────────────────

  async function placeBlockAt(targetPos, blockName) {
    const current = bot.blockAt(targetPos)
    if (current && current.name !== 'air' && current.name !== 'cave_air') return true

    const itemId = bot.registry.itemsByName[blockName]?.id
    const item   = itemId ? bot.inventory.findInventoryItem(itemId, null, false) : null
    if (!item) return false

    await safeEquip(bot, item, 'hand')

    const adj = [[0,-1,0],[0,1,0],[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
    for (const [dx, dy, dz] of adj) {
      const refBlock = bot.blockAt(targetPos.offset(dx, dy, dz))
      if (!refBlock || refBlock.boundingBox !== 'block') continue
      try {
        await navNear(targetPos.x, targetPos.y, targetPos.z, 4)
        const faceVec = targetPos.minus(refBlock.position)
        await safePlaceBlock(bot, refBlock, faceVec)
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

  // Smart agentic house building — auto-chains: gather wood → craft planks → place blocks
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
        const logBlock = bot.findBlock({ matching: ids, maxDistance: 60 })
        if (!logBlock) { safeChat('No more trees in range. Stopping.'); return }
        try {
          await navNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 2)
          const fresh = bot.blockAt(logBlock.position)
          if (fresh && ids.includes(fresh.type)) {
            await safeDig(bot, fresh)
            await new Promise(r => setTimeout(r, 300))
            try { await navNear(logBlock.position.x, logBlock.position.y, logBlock.position.z, 0) } catch {}
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

  return {
    taskExplore, taskGatherWood, taskCraftPlanks, taskGoTo, taskAttackMobs, taskAttackPlayer,
    taskCollectNearby, taskCraftItem, taskPlaceBlock, taskMineBlock, taskEatFood,
    taskEscape, taskEvadeHazard, taskFlee, taskBuildHouseSmart, taskBlindSurvival,
    FOOD_PRIORITY,
  }
}
