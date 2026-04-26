#!/usr/bin/env node
// cli.js — project-k Control Panel
// Manages the Minecraft server and Ollama-powered bots.
// No external dependencies — uses only Node built-ins.

const readline   = require('readline')
const { spawn }  = require('child_process')
const fs         = require('fs')
const path       = require('path')
const http       = require('http')

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT       = __dirname
const SERVER_DIR = path.join(ROOT, 'mc-server')
const BOT_DIR    = path.join(ROOT, 'mc-server', 'bot')
const LOG_DIR    = path.join(ROOT, '.cli-logs')
const SERVER_JAR = 'server.jar'

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// ── Colors ───────────────────────────────────────────────────────────────────
const c = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  blue:'\x1b[34m', magenta:'\x1b[35m', cyan:'\x1b[36m', gray:'\x1b[90m',
}
const tag = (clr, label) => `${clr}${label}${c.reset}`

// ── Process tracking ─────────────────────────────────────────────────────────
const state = {
  serverProc: null,
  serverLogPath: path.join(LOG_DIR, 'server.log'),
  bots: new Map(),  // name → { proc, model, logPath, startedAt }
}

// ── Readline ─────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const prompt = (q) => new Promise(res => rl.question(q, res))

// ── Ollama API ───────────────────────────────────────────────────────────────
function fetchOllamaModels() {
  return new Promise((resolve) => {
    const req = http.get('http://localhost:11434/api/tags', (res) => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          resolve((parsed.models || []).map(m => m.name))
        } catch { resolve([]) }
      })
    })
    req.on('error', () => resolve([]))
    req.setTimeout(2000, () => { req.destroy(); resolve([]) })
  })
}

// ── Server management ────────────────────────────────────────────────────────
function startServer() {
  if (state.serverProc) {
    console.log(tag(c.yellow, 'Server is already running.'))
    return
  }
  const jarPath = path.join(SERVER_DIR, SERVER_JAR)
  if (!fs.existsSync(jarPath)) {
    console.log(tag(c.red, `server.jar not found at ${jarPath}`))
    return
  }

  console.log(tag(c.cyan, 'Starting Minecraft server...'))
  const logFd = fs.openSync(state.serverLogPath, 'w')
  const proc = spawn('java', ['-Xmx2G', '-jar', SERVER_JAR, 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['ignore', logFd, logFd],
  })

  proc.on('exit', (code) => {
    console.log(tag(c.gray, `Server exited (code ${code})`))
    state.serverProc = null
  })

  state.serverProc = proc
  console.log(tag(c.green, `Server PID ${proc.pid}. Logs: ${state.serverLogPath}`))
  console.log(tag(c.dim, 'Wait ~10s for it to be ready before spawning bots.'))
}

function stopServer() {
  if (!state.serverProc) {
    console.log(tag(c.yellow, 'Server is not running.'))
    return
  }
  console.log(tag(c.cyan, 'Stopping server...'))
  try { state.serverProc.kill('SIGTERM') } catch (e) {
    console.log(tag(c.red, `Kill failed: ${e.message}`))
  }
}

// ── Bot management ───────────────────────────────────────────────────────────
async function spawnBot() {
  const name = (await prompt(`${c.bold}Bot name${c.reset} (default Ember): `)).trim() || 'Ember'

  if (state.bots.has(name)) {
    console.log(tag(c.red, `A bot named "${name}" is already running.`))
    return
  }

  const models = await fetchOllamaModels()
  if (!models.length) {
    console.log(tag(c.red, 'Ollama not reachable at localhost:11434. Is it running?'))
    console.log(tag(c.dim, 'Try: ollama serve'))
    return
  }

  console.log(`${c.bold}Available models:${c.reset}`)
  models.forEach((m, i) => console.log(`  ${c.cyan}[${i+1}]${c.reset} ${m}`))

  const idxRaw = await prompt(`Select model # (default 1): `)
  const idx = parseInt(idxRaw) - 1
  const model = models[isNaN(idx) ? 0 : idx]
  if (!model) { console.log(tag(c.red, 'Invalid selection.')); return }

  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  const logFd = fs.openSync(logPath, 'w')

  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: name, OLLAMA_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })

  proc.on('exit', (code) => {
    console.log(tag(c.gray, `Bot "${name}" exited (code ${code})`))
    state.bots.delete(name)
  })

  state.bots.set(name, { proc, model, logPath, startedAt: Date.now() })
  console.log(tag(c.green, `Bot "${name}" spawned. PID: ${proc.pid} | Model: ${model}`))
  console.log(tag(c.dim, `Logs: ${logPath}`))
}

async function stopBot() {
  if (state.bots.size === 0) { console.log(tag(c.yellow, 'No bots running.')); return }

  const names = Array.from(state.bots.keys())
  console.log(`${c.bold}Active bots:${c.reset}`)
  names.forEach((n, i) => console.log(`  ${c.cyan}[${i+1}]${c.reset} ${n} (${state.bots.get(n).model})`))

  const idxRaw = await prompt('Select bot # to stop: ')
  const idx = parseInt(idxRaw) - 1
  const name = names[idx]
  if (!name) { console.log(tag(c.red, 'Invalid selection.')); return }

  const bot = state.bots.get(name)
  console.log(tag(c.cyan, `Stopping ${name}...`))
  try { bot.proc.kill('SIGTERM') } catch (e) {
    console.log(tag(c.red, `Failed: ${e.message}`))
  }
}

async function restartBot() {
  if (state.bots.size === 0) { console.log(tag(c.yellow, 'No bots running.')); return }

  const names = Array.from(state.bots.keys())
  console.log(`${c.bold}Active bots:${c.reset}`)
  names.forEach((n, i) => console.log(`  ${c.cyan}[${i+1}]${c.reset} ${n} (${state.bots.get(n).model})`))

  const idxRaw = await prompt('Select bot # to restart: ')
  const idx = parseInt(idxRaw) - 1
  const name = names[idx]
  if (!name) { console.log(tag(c.red, 'Invalid selection.')); return }

  const oldBot = state.bots.get(name)
  const model = oldBot.model
  console.log(tag(c.cyan, `Restarting ${name}...`))

  oldBot.proc.kill('SIGTERM')
  // Wait for exit
  await new Promise(res => setTimeout(res, 1500))

  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  const logFd = fs.openSync(logPath, 'w')
  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: name, OLLAMA_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })
  proc.on('exit', () => state.bots.delete(name))
  state.bots.set(name, { proc, model, logPath, startedAt: Date.now() })
  console.log(tag(c.green, `Bot "${name}" restarted. PID: ${proc.pid}`))
}

// ── Log viewing ──────────────────────────────────────────────────────────────
async function viewLogs() {
  const sources = []
  if (state.serverProc) sources.push({ label: `Server (PID ${state.serverProc.pid})`, path: state.serverLogPath })
  for (const [name, b] of state.bots) sources.push({ label: `Bot ${name} (PID ${b.proc.pid})`, path: b.logPath })

  if (!sources.length) { console.log(tag(c.yellow, 'No active processes.')); return }

  console.log(`${c.bold}Logs available:${c.reset}`)
  sources.forEach((s, i) => console.log(`  ${c.cyan}[${i+1}]${c.reset} ${s.label}`))

  const idxRaw = await prompt('Select log #: ')
  const src = sources[parseInt(idxRaw) - 1]
  if (!src) { console.log(tag(c.red, 'Invalid.')); return }

  console.log(tag(c.dim, `Tailing ${src.path} — press Enter to stop`))
  console.log(tag(c.gray, '─'.repeat(60)))

  const tail = spawn('tail', ['-n', '40', '-f', src.path], { stdio: ['ignore', 'pipe', 'pipe'] })
  tail.stdout.on('data', d => process.stdout.write(d))
  tail.stderr.on('data', d => process.stderr.write(d))

  await prompt('')  // wait for Enter
  tail.kill()
  console.log(tag(c.gray, '─'.repeat(60)))
}

// ── List models ──────────────────────────────────────────────────────────────
async function listModels() {
  const models = await fetchOllamaModels()
  if (!models.length) {
    console.log(tag(c.red, 'Ollama not reachable. Start it with: ollama serve'))
    return
  }
  console.log(`${c.bold}Ollama models installed:${c.reset}`)
  models.forEach(m => console.log(`  ${c.green}●${c.reset} ${m}`))
}

// ── Status display ───────────────────────────────────────────────────────────
function header() {
  console.log()
  console.log(c.cyan + c.bold + '╔══════════════════════════════════════════════╗' + c.reset)
  console.log(c.cyan + c.bold + '║          project-k Control Panel             ║' + c.reset)
  console.log(c.cyan + c.bold + '╚══════════════════════════════════════════════╝' + c.reset)

  const serverDot = state.serverProc ? `${c.green}●${c.reset}` : `${c.gray}○${c.reset}`
  const serverInfo = state.serverProc ? `Running (PID ${state.serverProc.pid})` : 'Stopped'
  console.log(`${c.bold}Server:${c.reset} ${serverDot} ${serverInfo}`)

  console.log(`${c.bold}Bots:${c.reset}   ${state.bots.size === 0 ? c.gray + 'none' + c.reset : ''}`)
  for (const [name, b] of state.bots) {
    const uptime = Math.floor((Date.now() - b.startedAt) / 1000)
    console.log(`  ${c.green}●${c.reset} ${c.bold}${name}${c.reset} ${c.dim}(${b.model}, PID ${b.proc.pid}, up ${uptime}s)${c.reset}`)
  }
  console.log()
}

function menu() {
  console.log(`${c.bold}Actions:${c.reset}`)
  console.log(`  ${c.cyan}[1]${c.reset} Start server         ${c.cyan}[5]${c.reset} Restart bot`)
  console.log(`  ${c.cyan}[2]${c.reset} Stop server          ${c.cyan}[6]${c.reset} View logs`)
  console.log(`  ${c.cyan}[3]${c.reset} Spawn bot            ${c.cyan}[7]${c.reset} List Ollama models`)
  console.log(`  ${c.cyan}[4]${c.reset} Stop bot             ${c.cyan}[q]${c.reset} Quit (kills everything)`)
  console.log()
}

// ── Main loop ────────────────────────────────────────────────────────────────
async function loop() {
  while (true) {
    header()
    menu()
    const choice = (await prompt('> ')).trim().toLowerCase()
    console.log()
    try {
      switch (choice) {
        case '1': startServer(); break
        case '2': stopServer(); break
        case '3': await spawnBot(); break
        case '4': await stopBot(); break
        case '5': await restartBot(); break
        case '6': await viewLogs(); break
        case '7': await listModels(); break
        case 'q': case 'quit': case 'exit': await cleanup(); return
        case '': break
        default: console.log(tag(c.red, `Unknown choice: "${choice}"`))
      }
    } catch (err) {
      console.log(tag(c.red, `Error: ${err.message}`))
    }

    if (choice && choice !== 'q') {
      await prompt(c.dim + '\n[Enter to continue]' + c.reset)
    }
  }
}

async function cleanup() {
  console.log(tag(c.cyan, 'Shutting down all processes...'))
  for (const [name, b] of state.bots) {
    try { b.proc.kill('SIGTERM') } catch {}
    console.log(tag(c.gray, `  killed bot ${name}`))
  }
  if (state.serverProc) {
    try { state.serverProc.kill('SIGTERM') } catch {}
    console.log(tag(c.gray, `  killed server`))
  }
  await new Promise(r => setTimeout(r, 1000))
  rl.close()
  console.log(tag(c.green, 'Goodbye.'))
}

// ── Signal handling ──────────────────────────────────────────────────────────
process.on('SIGINT',  async () => { console.log(); await cleanup(); process.exit(0) })
process.on('SIGTERM', async () => { await cleanup(); process.exit(0) })

// ── Boot ─────────────────────────────────────────────────────────────────────
console.log(tag(c.bold + c.green, '\nproject-k CLI started.'))
console.log(tag(c.dim, `Project: ${ROOT}`))
console.log(tag(c.dim, `Logs:    ${LOG_DIR}`))
loop().catch(err => { console.error(err); process.exit(1) })
