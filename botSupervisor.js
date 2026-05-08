// botSupervisor.js — Supervised bot lifecycle manager.
//
// Wraps bot process spawning with:
//   - Exit reason classification from exit_reason.json
//   - Per-class base backoff with exponential growth and a 5-minute cap
//   - Restart storm prevention: ≥5 restarts in 10 minutes → halt with alert
//   - Recovery chain IDs: each restart chain gets a unique UUID-like ID
//   - onLog / onRespawn callbacks for integration with cli.js and tui.js
//
// Storm prevention intentionally halts rather than continuing — if 5 restarts
// in 10 minutes haven't fixed it, additional restarts make the problem worse.
// The operator must inspect and manually restart.

'use strict'

const { spawn } = require('child_process')
const fs         = require('fs')
const path       = require('path')
const crypto     = require('crypto')

const EXIT_REASON_FILE = 'exit_reason.json'

// Base backoff (ms) per exit reason class.
// entity_desync: short — just reconnect after a brief pause
// kicked:        moderate — give the server time to allow reconnect
// crash:         longer — likely a bug; give things time to settle
// server_disconnect: long — server may still be restarting
// unknown_clean: minimal — was working fine, probably transient
// unknown_dirty: moderate — some non-zero exit; be cautious
const BASE_BACKOFF_MS = {
  entity_desync:     3_000,
  kicked:           20_000,
  crash:            30_000,
  server_disconnect:45_000,
  unknown_clean:     5_000,
  unknown_dirty:    30_000,
}

const BACKOFF_MULTIPLIER = 2
const BACKOFF_CAP_MS     = 5 * 60 * 1000   // 5 minutes maximum

const STORM_WINDOW_MS    = 10 * 60 * 1000   // 10-minute window
const STORM_MAX          = 5                 // halt after this many restarts in the window

function generateChainId() {
  return crypto.randomBytes(4).toString('hex')
}

function readExitReason(botDir) {
  const p = path.join(botDir, EXIT_REASON_FILE)
  try {
    const raw = fs.readFileSync(p, 'utf8')
    const obj = JSON.parse(raw)
    fs.unlinkSync(p)   // consume so stale file doesn't mislead next exit
    return obj
  } catch {
    return null
  }
}

function classifyExit(exitReason, code, uptimeMs) {
  if (exitReason) return exitReason.reason
  if (code === 0 && uptimeMs > 60_000) return 'unknown_clean'
  if (code === 0 && uptimeMs <= 60_000) return 'unknown_clean'
  return 'unknown_dirty'
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = function createBotSupervisor({ botDir, logDir, onLog, onRespawn, onStorm }) {
  // bots: name → { proc, model, logPath, startedAt, chainId, restartCount,
  //                backoffMs, restartTimestamps, manualStopping, timer }
  const bots = new Map()

  function _log(level, msg, meta = {}) {
    const entry = { t: new Date().toISOString(), level, msg, ...meta }
    if (onLog) onLog(entry)
  }

  function launch(name, model, logPath, { fresh = true, chainId = null } = {}) {
    if (bots.has(name)) {
      const existing = bots.get(name)
      if (existing.proc) return  // already running
    }

    const myChainId = chainId || generateChainId()
    const isResume  = bots.has(name)
    const prev      = bots.get(name)

    const entry = {
      proc:               null,
      model,
      logPath,
      startedAt:          Date.now(),
      chainId:            myChainId,
      restartCount:       isResume ? prev.restartCount : 0,
      backoffMs:          isResume ? prev.backoffMs    : BASE_BACKOFF_MS.unknown_clean,
      restartTimestamps:  isResume ? prev.restartTimestamps : [],
      manualStopping:     false,
      timer:              null,
    }
    bots.set(name, entry)

    _log('info', 'supervisor_launch', {
      name, model, chainId: myChainId,
      restartCount: entry.restartCount,
      backoffMs: isResume ? entry.backoffMs : 0,
    })

    const logFd = fs.openSync(logPath, fresh ? 'w' : 'a')
    const env = {
      ...process.env,
      BOT_NAME: name,
      FEATHERLESS_MODEL: model,
      RECOVERY_CHAIN_ID: myChainId,
    }

    const proc = spawn('node', ['bot.js'], {
      cwd: botDir,
      env,
      stdio: ['ignore', logFd, logFd],
    })

    entry.proc = proc

    proc.on('error', (err) => {
      _log('error', 'supervisor_spawn_error', { name, message: err.message, chainId: myChainId })
      entry.proc = null
    })

    proc.on('exit', (code, signal) => {
      const uptimeMs = Date.now() - entry.startedAt
      entry.proc = null

      if (entry.manualStopping) {
        _log('info', 'supervisor_manual_stop', { name, code, uptimeMs, chainId: myChainId })
        bots.delete(name)
        return
      }

      _onExit(name, code, signal, uptimeMs)
    })
  }

  function _onExit(name, code, signal, uptimeMs) {
    const entry = bots.get(name)
    if (!entry) return

    const exitReason = readExitReason(botDir)
    const reasonClass = classifyExit(exitReason, code, uptimeMs)
    const base = BASE_BACKOFF_MS[reasonClass] ?? BASE_BACKOFF_MS.unknown_dirty

    // Escalate backoff: cap at BACKOFF_CAP_MS
    const newBackoff = Math.min(entry.backoffMs * BACKOFF_MULTIPLIER, BACKOFF_CAP_MS)
    const delayMs    = reasonClass === 'unknown_clean' && uptimeMs > 60_000
      ? base
      : Math.max(base, newBackoff)

    entry.backoffMs = delayMs
    entry.restartCount++
    entry.restartTimestamps.push(Date.now())

    // Prune timestamps outside storm window
    const cutoff = Date.now() - STORM_WINDOW_MS
    entry.restartTimestamps = entry.restartTimestamps.filter(t => t > cutoff)

    _log('warn', 'supervisor_exit', {
      name, code, signal, uptimeMs, reasonClass,
      restartCount: entry.restartCount,
      delayMs,
      chainId: entry.chainId,
      restartsInWindow: entry.restartTimestamps.length,
      ...(exitReason && { exitDetail: exitReason }),
    })

    // Storm check
    if (entry.restartTimestamps.length >= STORM_MAX) {
      _log('error', 'supervisor_restart_storm', {
        name, restartsInWindow: entry.restartTimestamps.length,
        windowMs: STORM_WINDOW_MS, chainId: entry.chainId,
      })
      if (onStorm) onStorm({ name, chainId: entry.chainId, restartCount: entry.restartCount })
      bots.delete(name)
      return
    }

    _log('info', 'supervisor_schedule_respawn', {
      name, delayMs, chainId: entry.chainId, reasonClass,
    })

    entry.timer = setTimeout(() => {
      entry.timer = null
      const current = bots.get(name)
      if (!current || current.manualStopping) return

      _log('info', 'supervisor_respawn', { name, chainId: entry.chainId, restartCount: entry.restartCount })
      if (onRespawn) onRespawn({ name, model: entry.model, chainId: entry.chainId, restartCount: entry.restartCount })

      launch(name, entry.model, entry.logPath, { fresh: false, chainId: entry.chainId })
    }, delayMs)
  }

  function stop(name) {
    const entry = bots.get(name)
    if (!entry) return false
    entry.manualStopping = true
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null }
    if (entry.proc) {
      try { entry.proc.kill('SIGTERM') } catch {}
    } else {
      bots.delete(name)
    }
    return true
  }

  function getState() {
    const out = {}
    for (const [name, e] of bots) {
      out[name] = {
        running:       !!e.proc,
        model:         e.model,
        logPath:       e.logPath,
        chainId:       e.chainId,
        restartCount:  e.restartCount,
        backoffMs:     e.backoffMs,
        restartsInWindow: e.restartTimestamps.filter(t => t > Date.now() - STORM_WINDOW_MS).length,
        uptimeMs:      e.startedAt ? Date.now() - e.startedAt : null,
        awaitingRespawn: !!e.timer,
      }
    }
    return out
  }

  function has(name) { return bots.has(name) }

  return { launch, stop, getState, has }
}
