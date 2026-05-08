#!/usr/bin/env node
// cli.js — project-k Control Panel
// Manages the Minecraft server and Featherless-powered bots.
// No external dependencies — uses only Node built-ins.

// Load .env from project root
function _loadDotEnv() {
  const envPath = require('path').join(__dirname, '.env')
  try {
    for (const rawLine of require('fs').readFileSync(envPath, 'utf8').split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {}
}
_loadDotEnv()

const readline   = require('readline')
const { spawn, execSync } = require('child_process')
const fs         = require('fs')
const path       = require('path')
const https      = require('https')

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

// ── Read server port from server.properties ──────────────────────────────────
function getServerPort() {
  try {
    const props = fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8')
    const m = props.match(/^server-port=(\d+)/m)
    return m ? parseInt(m[1]) : 25565
  } catch { return 25565 }
}

// ── Detect process(es) listening on a port via lsof ─────────────────────────
// Works regardless of whether the server binds to 0.0.0.0, ::, or 127.0.0.1
function getServerPids(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port} 2>/dev/null`).toString().trim()
    if (!out) return []
    return out.split('\n').map(Number).filter(Boolean)
  } catch { return [] }
}

function isPortInUse(port) {
  return getServerPids(port).length > 0
}

// ── Show last N lines of a log file ─────────────────────────────────────────
function tailLog(logPath, lines = 8) {
  try {
    const content = fs.readFileSync(logPath, 'utf8').trim()
    if (!content) return
    const tail = content.split('\n').slice(-lines).join('\n')
    console.log(tag(c.gray, '─'.repeat(60)))
    console.log(tag(c.dim, tail))
    console.log(tag(c.gray, '─'.repeat(60)))
  } catch {}
}

// ── Process tracking ─────────────────────────────────────────────────────────
const state = {
  serverProc: null,
  serverLogPath: path.join(LOG_DIR, 'server.log'),
  bots: new Map(),  // name → { proc, model, logPath, startedAt }
}

// ── Readline ─────────────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const prompt = (q) => new Promise(res => rl.question(q, res))

// ── Featherless API ──────────────────────────────────────────────────────────
const FEATHERLESS_DEFAULT_MODELS = [
  'meta-llama/Meta-Llama-3.1-8B-Instruct',
  'meta-llama/Meta-Llama-3.1-70B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'mistralai/Mixtral-8x7B-Instruct-v0.1',
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen2.5-14B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'google/gemma-2-9b-it',
  'google/gemma-2-27b-it',
]

function fetchFeatherlessModels() {
  return new Promise((resolve) => {
    const apiKey = process.env.FEATHERLESS_API_KEY
    if (!apiKey) { resolve(FEATHERLESS_DEFAULT_MODELS); return }
    const req = https.request({
      hostname: 'api.featherless.ai',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'project-k/1.0',  // Featherless rejects no-UA requests on /models
      },
      timeout: 3000,
    }, (res) => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          const live = Array.isArray(parsed.data) ? parsed.data.map(m => m.id).filter(Boolean) : []
          const seen = new Set(FEATHERLESS_DEFAULT_MODELS)
          const extras = live.filter(id => !seen.has(id)).slice(0, 20)
          resolve([...FEATHERLESS_DEFAULT_MODELS, ...extras])
        } catch { resolve(FEATHERLESS_DEFAULT_MODELS) }
      })
    })
    req.on('error', () => resolve(FEATHERLESS_DEFAULT_MODELS))
    req.on('timeout', () => { req.destroy(); resolve(FEATHERLESS_DEFAULT_MODELS) })
    req.end()
  })
}

// ── Java detection (Minecraft 1.21+ requires Java 21+) ───────────────────────
function findJava() {
  // Check the version of a given java binary
  const javaVersion = (bin) => {
    try {
      const out = execSync(`"${bin}" -version 2>&1`).toString()
      const m = out.match(/version "(\d+)/)
      return m ? parseInt(m[1]) : 0
    } catch { return 0 }
  }

  // 1. Respect JAVA_HOME if set and valid
  if (process.env.JAVA_HOME) {
    const bin = path.join(process.env.JAVA_HOME, 'bin', 'java')
    if (javaVersion(bin) >= 21) return bin
  }

  // 2. Homebrew latest openjdk (no version suffix = newest)
  const brew = '/opt/homebrew/opt/openjdk/bin/java'
  if (javaVersion(brew) >= 21) return brew

  // 3. macOS java_home for Java 21–25
  for (const v of [21, 22, 23, 24, 25]) {
    try {
      const home = execSync(`/usr/libexec/java_home -v ${v} 2>/dev/null`).toString().trim()
      if (home) {
        const bin = path.join(home, 'bin', 'java')
        if (javaVersion(bin) >= 21) return bin
      }
    } catch {}
  }

  // 4. System default — might be too old
  return 'java'
}

// ── Server management ────────────────────────────────────────────────────────
async function startServer() {
  if (state.serverProc) {
    console.log(tag(c.yellow, 'Server is already running.'))
    return
  }

  const jarPath = path.join(SERVER_DIR, SERVER_JAR)
  if (!fs.existsSync(jarPath)) {
    console.log(tag(c.red, `server.jar not found at ${jarPath}`))
    console.log(tag(c.dim, 'Download a Spigot/Paper jar and place it at that path.'))
    return
  }

  const port = getServerPort()
  if (isPortInUse(port)) {
    console.log(tag(c.red, `Port ${port} is already in use — another server may be running.`))
    console.log(tag(c.dim, 'Stop the existing server first, then try again.'))
    return
  }

  // Validate Java version before spawning
  const javaBin = findJava()
  let javaVer = 0
  try {
    const out = execSync(`"${javaBin}" -version 2>&1`).toString()
    const m = out.match(/version "(\d+)/)
    javaVer = m ? parseInt(m[1]) : 0
  } catch {}

  if (javaVer < 21) {
    console.log(tag(c.red, `Java ${javaVer || '?'} found — Minecraft 1.21+ requires Java 21+.`))
    console.log(tag(c.dim, 'Install Java 21: brew install openjdk@21'))
    console.log(tag(c.dim, 'Or set JAVA_HOME to a Java 21+ installation.'))
    return
  }

  console.log(tag(c.cyan, `Starting Minecraft server with Java ${javaVer}...`))
  const logFd = fs.openSync(state.serverLogPath, 'w')
  const proc = spawn(javaBin, ['-Xmx2G', '-jar', SERVER_JAR, 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', logFd, logFd],  // 'pipe' not 'ignore' — prevents Paper from reading EOF and shutting down
  })
  proc.stdin.end()  // close stdin immediately so server doesn't block, but pipe prevents EOF signal

  proc.on('error', (err) => {
    console.log(tag(c.red, `Failed to start server: ${err.message}`))
    state.serverProc = null
  })

  // Show log on any early exit (code 0 or non-zero) — Paper exits 0 even on fatal errors
  let fullyStarted = false
  const startTimer = setTimeout(() => { fullyStarted = true }, 20000)

  proc.on('exit', (code) => {
    clearTimeout(startTimer)
    if (!fullyStarted) {
      console.log(tag(c.red, `Server exited early (code ${code}). Last log output:`))
      tailLog(state.serverLogPath, 15)
    } else {
      console.log(tag(c.gray, `Server stopped (code ${code})`))
    }
    state.serverProc = null
  })

  state.serverProc = proc

  const addr = `localhost:${port}`
  console.log(tag(c.green, `Server starting — connect at: ${addr}`))
  console.log(tag(c.dim, 'Wait ~20s for it to be ready, then spawn a bot.'))
  console.log(tag(c.dim, `Logs: ${state.serverLogPath}`))
}

function stopServer() {
  const port = getServerPort()

  if (!state.serverProc) {
    // Server wasn't started by this CLI — find and kill it by port
    const pids = getServerPids(port)
    if (!pids.length) {
      console.log(tag(c.yellow, `No server running on port ${port}.`))
      return
    }
    try {
      for (const pid of pids) process.kill(pid, 'SIGTERM')
      console.log(tag(c.green, `Server on port ${port} stopped (killed ${pids.join(', ')}).`))
    } catch (e) {
      console.log(tag(c.red, `Failed to stop server: ${e.message}`))
    }
    return
  }

  console.log(tag(c.cyan, 'Stopping server...'))
  try { state.serverProc.kill('SIGTERM') } catch (e) {
    console.log(tag(c.red, `Kill failed: ${e.message}`))
  }
}

// ── Bot management ───────────────────────────────────────────────────────────

// Programmatic spawn — used by auto-respawn after fatal desync quit.
function spawnBotDirect(name, model) {
  if (state.bots.has(name)) return  // already running
  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  const logFd   = fs.openSync(logPath, 'a')  // append so we keep the old log

  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: name, FEATHERLESS_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })

  proc.on('error', (err) => {
    console.log(tag(c.red, `Auto-respawn of "${name}" failed: ${err.message}`))
    state.bots.delete(name)
  })

  proc.on('exit', (code) => {
    const b = state.bots.get(name)
    const uptime = b ? Date.now() - b.startedAt : 0
    state.bots.delete(name)
    if (b && code !== 0 && code !== null) {
      console.log(tag(c.red, `Bot "${name}" crashed on respawn (code ${code}). Manual restart required.`))
      tailLog(logPath)
    } else if (b && code === 0 && uptime > 60000) {
      console.log(tag(c.yellow, `Bot "${name}" disconnected again — auto-respawning...`))
      spawnBotDirect(name, model)
    } else {
      console.log(tag(c.gray, `Bot "${name}" stopped`))
    }
  })

  state.bots.set(name, { proc, model, logPath, startedAt: Date.now() })
  const port = getServerPort()
  console.log(tag(c.green, `Bot "${name}" respawned — joining localhost:${port} with ${model}`))
}

async function spawnBot() {
  const name = (await prompt(`${c.bold}Bot name${c.reset} (default Ember): `)).trim() || 'Ember'

  if (state.bots.has(name)) {
    console.log(tag(c.red, `A bot named "${name}" is already running.`))
    return
  }

  if (!process.env.FEATHERLESS_API_KEY) {
    console.log(tag(c.red, 'FEATHERLESS_API_KEY not set in .env'))
    console.log(tag(c.dim, `Add it to ${path.join(ROOT, '.env')}`))
    return
  }

  const models = await fetchFeatherlessModels()
  console.log(`${c.bold}Available Featherless models:${c.reset}`)
  models.slice(0, 15).forEach((m, i) => console.log(`  ${c.cyan}[${i+1}]${c.reset} ${m}`))

  const idxRaw = await prompt(`Select model # (default 1): `)
  const idx = parseInt(idxRaw) - 1
  const model = models[isNaN(idx) ? 0 : idx]
  if (!model) { console.log(tag(c.red, 'Invalid selection.')); return }

  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  const logFd = fs.openSync(logPath, 'w')

  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: name, FEATHERLESS_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })

  proc.on('error', (err) => {
    console.log(tag(c.red, `Failed to start bot "${name}": ${err.message}`))
    state.bots.delete(name)
  })

  proc.on('exit', (code) => {
    const b = state.bots.get(name)
    const uptime = b ? Date.now() - b.startedAt : 0
    state.bots.delete(name)

    if (b && code !== 0 && code !== null) {
      console.log(tag(c.red, `Bot "${name}" crashed (code ${code}). Last log output:`))
      tailLog(logPath)
    } else if (b && code === 0 && uptime > 60000) {
      // Clean exit after >60s uptime — likely a fatal desync quit from fatalDesyncRecovery.js.
      // Auto-respawn so the bot recovers without manual intervention.
      console.log(tag(c.yellow, `Bot "${name}" disconnected (fatal desync) — auto-respawning...`))
      spawnBotDirect(name, b.model)
    } else {
      console.log(tag(c.gray, `Bot "${name}" stopped`))
    }
  })

  state.bots.set(name, { proc, model, logPath, startedAt: Date.now() })

  const port = getServerPort()
  console.log(tag(c.green, `Bot "${name}" started — joining localhost:${port} with ${model}`))
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
  await new Promise(res => setTimeout(res, 1500))

  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  const logFd = fs.openSync(logPath, 'w')
  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: name, FEATHERLESS_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })

  proc.on('error', (err) => {
    console.log(tag(c.red, `Failed to restart "${name}": ${err.message}`))
    state.bots.delete(name)
  })

  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(tag(c.red, `Bot "${name}" crashed (code ${code}). Last log output:`))
      tailLog(logPath)
    } else {
      console.log(tag(c.gray, `Bot "${name}" stopped`))
    }
    state.bots.delete(name)
  })

  state.bots.set(name, { proc, model, logPath, startedAt: Date.now() })
  const port = getServerPort()
  console.log(tag(c.green, `Bot "${name}" restarted — joining localhost:${port}`))
}

// ── Log viewing ──────────────────────────────────────────────────────────────
async function viewLogs() {
  const sources = []
  if (state.serverProc) sources.push({ label: 'Server', path: state.serverLogPath })
  for (const [name, b] of state.bots) sources.push({ label: `Bot: ${name}`, path: b.logPath })

  if (!sources.length) { console.log(tag(c.yellow, 'No active processes.')); return }

  console.log(`${c.bold}Logs available:${c.reset}`)
  sources.forEach((s, i) => console.log(`  ${c.cyan}[${i+1}]${c.reset} ${s.label}`))

  const idxRaw = await prompt('Select log #: ')
  const src = sources[parseInt(idxRaw) - 1]
  if (!src) { console.log(tag(c.red, 'Invalid.')); return }

  console.log(tag(c.dim, `Tailing ${src.label} — press Enter to stop`))
  console.log(tag(c.gray, '─'.repeat(60)))

  const tail = spawn('tail', ['-n', '40', '-f', src.path], { stdio: ['ignore', 'pipe', 'pipe'] })
  tail.stdout.on('data', d => process.stdout.write(d))
  tail.stderr.on('data', d => process.stderr.write(d))

  await prompt('')
  tail.kill()
  console.log(tag(c.gray, '─'.repeat(60)))
}

// ── List models ──────────────────────────────────────────────────────────────
async function listModels() {
  if (!process.env.FEATHERLESS_API_KEY) {
    console.log(tag(c.red, 'FEATHERLESS_API_KEY not set in .env'))
    return
  }
  const models = await fetchFeatherlessModels()
  console.log(`${c.bold}Featherless models:${c.reset}`)
  models.slice(0, 20).forEach(m => console.log(`  ${c.green}●${c.reset} ${m}`))
  if (models.length > 20) console.log(tag(c.dim, `  …and ${models.length - 20} more`))
}

// ── World Settings ────────────────────────────────────────────────────────────

function readServerProps() {
  try {
    const raw = fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8')
    const props = {}
    for (const line of raw.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue
      const eq = line.indexOf('=')
      props[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return props
  } catch { return {} }
}

function writeServerProps(changes) {
  const propsPath = path.join(SERVER_DIR, 'server.properties')
  let raw = ''
  try { raw = fs.readFileSync(propsPath, 'utf8') } catch {}
  for (const [key, value] of Object.entries(changes)) {
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re  = new RegExp(`^${esc}=.*$`, 'm')
    raw = re.test(raw) ? raw.replace(re, `${key}=${value}`) : raw + `\n${key}=${value}`
  }
  fs.writeFileSync(propsPath, raw)
}

const WORLD_DEFS = [
  { key: 'gamemode',            label: 'Game Mode',       type: 'cycle',
    options: ['survival','creative','adventure','spectator'],
    display: v => ({ survival:'Survival', creative:'Creative', adventure:'Adventure', spectator:'Spectator' })[v] || v },
  { key: 'difficulty',          label: 'Difficulty',      type: 'cycle',
    options: ['peaceful','easy','normal','hard'],
    display: v => v.charAt(0).toUpperCase() + v.slice(1) },
  { key: 'pvp',                 label: 'PVP',             type: 'cycle',   options: ['true','false'],  display: v => v === 'true' ? 'On' : 'Off' },
  { key: 'hardcore',            label: 'Hardcore',        type: 'cycle',   options: ['false','true'],  display: v => v === 'true' ? 'On' : 'Off' },
  { key: 'level-type',          label: 'World Type',      type: 'cycle',
    options: ['minecraft:normal','minecraft:flat','minecraft:large_biomes','minecraft:amplified'],
    display: v => ({'minecraft:normal':'Normal','minecraft:flat':'Flat','minecraft:large_biomes':'Large Biomes','minecraft:amplified':'Amplified'})[v] || v },
  { key: 'level-seed',          label: 'Seed',            type: 'text',    placeholder: '(blank = random)' },
  { key: 'generate-structures', label: 'Structures',      type: 'cycle',   options: ['true','false'],  display: v => v === 'true' ? 'On' : 'Off' },
  { key: 'max-players',         label: 'Max Players',     type: 'num',     min: 1,  max: 200 },
  { key: 'view-distance',       label: 'View Distance',   type: 'num',     min: 3,  max: 32  },
  { key: 'allow-flight',        label: 'Allow Flight',    type: 'cycle',   options: ['false','true'],  display: v => v === 'true' ? 'On' : 'Off' },
  { key: 'spawn-monsters',      label: 'Spawn Monsters',  type: 'cycle',   options: ['true','false'],  display: v => v === 'true' ? 'On' : 'Off' },
  { key: 'enable-command-block',label: 'Command Blocks',  type: 'cycle',   options: ['true','false'],  display: v => v === 'true' ? 'On' : 'Off' },
]

const WORLD_KEYS = {
  g: 'gamemode', d: 'difficulty', v: 'pvp', h: 'hardcore',
  t: 'level-type', e: 'level-seed', n: 'generate-structures',
  p: 'max-players', r: 'view-distance',
  f: 'allow-flight', m: 'spawn-monsters', c: 'enable-command-block',
}

async function worldSettings() {
  const props = readServerProps()
  const draft = {}
  for (const def of WORLD_DEFS) {
    draft[def.key] = props[def.key] !== undefined ? props[def.key]
      : def.type === 'cycle' ? def.options[0]
      : def.type === 'text'  ? ''
      : '10'
  }

  const running = !!(state.serverProc || isPortInUse(getServerPort()))

  while (true) {
    const btn = (def) => {
      const val = draft[def.key] ?? ''
      const label = def.display ? def.display(val) : (val || def.placeholder || '')
      return def.type === 'cycle' ? `◀ ${label.padEnd(13)} ▶` : label
    }
    const row = (shortcut, key) => {
      const def = WORLD_DEFS.find(d => d.key === key)
      console.log(`  ${c.cyan}[${shortcut}]${c.reset} ${def.label.padEnd(18)} ${c.green}${btn(def)}${c.reset}`)
    }

    console.log()
    console.log(c.cyan + c.bold + '╔══════════════════════════════════════════════╗' + c.reset)
    console.log(c.cyan + c.bold + '║             World Settings                   ║' + c.reset)
    console.log(c.cyan + c.bold + '╚══════════════════════════════════════════════╝' + c.reset)
    if (running) console.log(`  ${c.yellow}⚠  Server running — restart to apply changes${c.reset}`)
    console.log()

    console.log(`  ${c.bold}── Gameplay ──────────────────────────────────────${c.reset}`)
    row('g', 'gamemode')
    row('d', 'difficulty')
    row('v', 'pvp')
    row('h', 'hardcore')
    console.log()

    console.log(`  ${c.bold}── World  ${c.dim}(seed & type apply to new worlds only)${c.reset}`)
    row('t', 'level-type')
    row('e', 'level-seed')
    row('n', 'generate-structures')
    console.log()

    console.log(`  ${c.bold}── Server ────────────────────────────────────────${c.reset}`)
    row('p', 'max-players')
    row('r', 'view-distance')
    row('f', 'allow-flight')
    row('m', 'spawn-monsters')
    row('c', 'enable-command-block')
    console.log()

    console.log(`  ${c.cyan}[s]${c.reset} Save & Done    ${c.cyan}[x]${c.reset} Discard & Back`)
    console.log()

    const choice = (await prompt('  > ')).trim().toLowerCase()

    if (choice === 's') {
      writeServerProps(draft)
      console.log(tag(c.green, '  Saved to server.properties.'))
      if (running) console.log(tag(c.dim, '  Restart the server for changes to apply.'))
      await new Promise(r => setTimeout(r, 1400))
      return
    }
    if (choice === 'x') return

    const defKey = WORLD_KEYS[choice]
    if (!defKey) { continue }

    const def = WORLD_DEFS.find(d => d.key === defKey)
    if (def.type === 'cycle') {
      const opts = def.options
      const idx  = opts.indexOf(draft[defKey])
      draft[defKey] = opts[(idx + 1) % opts.length]
    } else if (def.type === 'text') {
      const cur = draft[defKey] || ''
      draft[defKey] = (await prompt(`  ${def.label} (current: "${cur || 'blank'}", Enter to keep): `)).trim()
    } else if (def.type === 'num') {
      const input = await prompt(`  ${def.label} (${def.min}–${def.max}, current: ${draft[defKey]}): `)
      const n = parseInt(input.trim())
      if (!isNaN(n) && n >= def.min && n <= def.max) {
        draft[defKey] = String(n)
      } else {
        console.log(tag(c.red, `  Invalid — must be ${def.min}–${def.max}.`))
        await new Promise(r => setTimeout(r, 800))
      }
    }
  }
}

// ── Status display ───────────────────────────────────────────────────────────
function header() {
  const port = getServerPort()
  const addr = `localhost:${port}`

  console.log()
  console.log(c.cyan + c.bold + '╔══════════════════════════════════════════════╗' + c.reset)
  console.log(c.cyan + c.bold + '║          project-k Control Panel             ║' + c.reset)
  console.log(c.cyan + c.bold + '╚══════════════════════════════════════════════╝' + c.reset)

  let serverDot, serverInfo
  if (state.serverProc) {
    serverDot = `${c.green}●${c.reset}`
    serverInfo = `Running  —  connect at ${c.bold}${addr}${c.reset}`
  } else if (isPortInUse(port)) {
    serverDot = `${c.yellow}●${c.reset}`
    serverInfo = `Running externally  —  connect at ${c.bold}${addr}${c.reset}`
  } else {
    serverDot = `${c.gray}○${c.reset}`
    serverInfo = 'Stopped'
  }
  console.log(`${c.bold}Server:${c.reset} ${serverDot} ${serverInfo}`)

  console.log(`${c.bold}Bots:${c.reset}   ${state.bots.size === 0 ? c.gray + 'none' + c.reset : ''}`)
  for (const [name, b] of state.bots) {
    const uptime = Math.floor((Date.now() - b.startedAt) / 1000)
    const mins = Math.floor(uptime / 60)
    const secs = uptime % 60
    const uptimeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
    console.log(`  ${c.green}●${c.reset} ${c.bold}${name}${c.reset} ${c.dim}(${b.model}, up ${uptimeStr})${c.reset}`)
  }
  console.log()
}

function menu() {
  console.log(`${c.bold}Actions:${c.reset}`)
  console.log(`  ${c.cyan}[1]${c.reset} Start server         ${c.cyan}[5]${c.reset} Restart bot`)
  console.log(`  ${c.cyan}[2]${c.reset} Stop server          ${c.cyan}[6]${c.reset} View logs`)
  console.log(`  ${c.cyan}[3]${c.reset} Spawn bot            ${c.cyan}[7]${c.reset} List Featherless models`)
  console.log(`  ${c.cyan}[4]${c.reset} Stop bot             ${c.cyan}[8]${c.reset} World settings`)
  console.log(`                             ${c.cyan}[q]${c.reset} Quit (kills everything)`)
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
        case '1': await startServer(); break
        case '2': stopServer(); break
        case '3': await spawnBot(); break
        case '4': await stopBot(); break
        case '5': await restartBot(); break
        case '6': await viewLogs(); break
        case '7': await listModels(); break
        case '8': await worldSettings(); break
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
    console.log(tag(c.gray, `  stopped bot ${name}`))
  }
  if (state.serverProc) {
    try { state.serverProc.kill('SIGTERM') } catch {}
    console.log(tag(c.gray, `  stopped server`))
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
