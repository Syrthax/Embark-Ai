#!/usr/bin/env node
// tui.js — project-k Live Control Dashboard
// Blessed-based TUI replacing the prompt-driven cli.js.
//
// Layout:
//   ┌─ Header ─────────────────────────────────────────┐
//   │ Server status, bot list, uptime                  │
//   ├─ Bot Status ─────────┬─ Actions ─────────────────┤
//   │ HP, food, goal, pos, │ [1] Start server          │
//   │ inventory, anger     │ [2] Stop server           │
//   ├─ Live Log ───────────┤ [3] Spawn bot             │
//   │ JSONL events,        │ [4] Stop bot              │
//   │ auto-scrolling       │ [5] Restart bot           │
//   │                      │ [6] World settings        │
//   │                      │ [7] Models  [q] Quit      │
//   └──────────────────────┴───────────────────────────┘
//
// Keys:
//   1-7         action shortcuts
//   q / Ctrl+C  quit (kills all processes)
//   Tab         cycle focus between panels
//   ↑↓ / PgUp/Dn scroll log panel
//   r           manually refresh status

// Load .env from project root (FEATHERLESS_API_KEY, FEATHERLESS_MODEL)
function loadDotEnv() {
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
loadDotEnv()

const blessed = require('blessed')
const { spawn, execSync } = require('child_process')
const fs    = require('fs')
const path  = require('path')
const https = require('https')
const readline = require('readline')

// ── Paths & constants ────────────────────────────────────────────────────────
const ROOT       = __dirname
const SERVER_DIR = path.join(ROOT, 'mc-server')
const BOT_DIR    = path.join(ROOT, 'mc-server', 'bot')
const LOG_DIR    = path.join(ROOT, '.cli-logs')
const SERVER_JAR = 'server.jar'
const EVENTS_FILE = path.join(BOT_DIR, 'events.jsonl')

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// ── Process state ────────────────────────────────────────────────────────────
const state = {
  serverProc: null,
  serverLogPath: path.join(LOG_DIR, 'server.log'),
  bots: new Map(),       // name → { proc, model, logPath, startedAt }
  selectedBot: null,     // name of bot currently displayed in status panel
  botStates: new Map(),  // name → latest 'state' event from events.jsonl
  eventsFollowOffset: 0, // file position for tail-following events.jsonl
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getServerPort() {
  try {
    const props = fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8')
    const m = props.match(/^server-port=(\d+)/m)
    return m ? parseInt(m[1]) : 25565
  } catch { return 25565 }
}

function getServerPids(port) {
  try {
    const out = execSync(`lsof -ti tcp:${port} 2>/dev/null`).toString().trim()
    return out ? out.split('\n').map(Number).filter(Boolean) : []
  } catch { return [] }
}

const isPortInUse = (port) => getServerPids(port).length > 0

// Curated default list (Featherless hosts thousands; these are reliable for JSON output)
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

// Returns models — first tries Featherless API for the live list, falls back to curated.
function fetchFeatherlessModels() {
  return new Promise((resolve) => {
    const apiKey = process.env.FEATHERLESS_API_KEY
    if (!apiKey) {
      resolve(FEATHERLESS_DEFAULT_MODELS)
      return
    }
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
          // Show curated options first (reliable for JSON), then up to 20 more from the live list
          const seen = new Set(FEATHERLESS_DEFAULT_MODELS)
          const extras = live.filter(id => !seen.has(id)).slice(0, 20)
          resolve([...FEATHERLESS_DEFAULT_MODELS, ...extras])
        } catch {
          resolve(FEATHERLESS_DEFAULT_MODELS)
        }
      })
    })
    req.on('error', () => resolve(FEATHERLESS_DEFAULT_MODELS))
    req.on('timeout', () => { req.destroy(); resolve(FEATHERLESS_DEFAULT_MODELS) })
    req.end()
  })
}

function findJava() {
  const javaVersion = (bin) => {
    try {
      const out = execSync(`"${bin}" -version 2>&1`).toString()
      const m = out.match(/version "(\d+)/)
      return m ? parseInt(m[1]) : 0
    } catch { return 0 }
  }
  if (process.env.JAVA_HOME) {
    const bin = path.join(process.env.JAVA_HOME, 'bin', 'java')
    if (javaVersion(bin) >= 21) return bin
  }
  const brew = '/opt/homebrew/opt/openjdk/bin/java'
  if (javaVersion(brew) >= 21) return brew
  for (const v of [21, 22, 23, 24, 25]) {
    try {
      const home = execSync(`/usr/libexec/java_home -v ${v} 2>/dev/null`).toString().trim()
      if (home) {
        const bin = path.join(home, 'bin', 'java')
        if (javaVersion(bin) >= 21) return bin
      }
    } catch {}
  }
  return 'java'
}

// ── Blessed screen setup ─────────────────────────────────────────────────────
const screen = blessed.screen({
  smartCSR: true,
  title: 'project-k',
  fullUnicode: true,
})

const header = blessed.box({
  parent: screen,
  top: 0, left: 0, right: 0, height: 3,
  border: { type: 'line' },
  style: { border: { fg: 'cyan' } },
  tags: true,
  padding: { left: 1, right: 1 },
})

const statusPanel = blessed.box({
  parent: screen,
  label: ' Bot Status ',
  top: 3, left: 0, width: '60%', height: '40%',
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green' } },
  tags: true,
  padding: { left: 1, right: 1 },
})

const logPanel = blessed.log({
  parent: screen,
  label: ' Live Log ',
  top: '43%', left: 0, width: '60%', bottom: 1,
  border: { type: 'line' },
  style: { border: { fg: 'blue' }, label: { fg: 'blue' } },
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: '│', track: { bg: 'gray' }, style: { bg: 'cyan' } },
  keys: true,
  mouse: true,
  padding: { left: 1, right: 1 },
})

const actionsPanel = blessed.box({
  parent: screen,
  label: ' Actions ',
  top: 3, left: '60%', right: 0, bottom: 1,
  border: { type: 'line' },
  style: { border: { fg: 'magenta' }, label: { fg: 'magenta' } },
  tags: true,
  padding: { left: 1, right: 1 },
})

const statusBar = blessed.box({
  parent: screen,
  bottom: 0, left: 0, right: 0, height: 1,
  style: { fg: 'white', bg: 'blue' },
  tags: true,
  padding: { left: 1, right: 1 },
})

// ── Rendering ────────────────────────────────────────────────────────────────
function renderHeader() {
  const port = getServerPort()
  let serverLine
  if (state.serverProc) {
    serverLine = `{green-fg}●{/} Server  {bold}localhost:${port}{/bold}  (CLI-managed)`
  } else if (isPortInUse(port)) {
    serverLine = `{yellow-fg}●{/} Server  {bold}localhost:${port}{/bold}  (external)`
  } else {
    serverLine = `{gray-fg}○{/} Server  {gray-fg}stopped{/}`
  }

  let botsLine
  if (state.bots.size === 0) {
    botsLine = '{gray-fg}no bots running{/}'
  } else {
    const items = []
    for (const [name, b] of state.bots) {
      const up = Math.floor((Date.now() - b.startedAt) / 1000)
      const upStr = up >= 60 ? `${Math.floor(up / 60)}m${up % 60}s` : `${up}s`
      const marker = name === state.selectedBot ? `{green-fg}●{/}` : `{cyan-fg}●{/}`
      items.push(`${marker} {bold}${name}{/bold} {gray-fg}(${b.model}, ${upStr}){/}`)
    }
    botsLine = items.join('   ')
  }

  header.setContent(`{bold}{cyan-fg}project-k{/}{/bold}   ${serverLine}   |   Bots:  ${botsLine}`)
}

function renderStatus() {
  const name = state.selectedBot
  if (!name || !state.botStates.has(name)) {
    statusPanel.setContent(
      `{gray-fg}No active bot.{/}\n\n` +
      `Press {cyan-fg}[3]{/} to spawn one.\n\n` +
      `{gray-fg}Once a bot is online, this panel will show its{/}\n` +
      `{gray-fg}HP, food, goal, position, and inventory in real-time.{/}`
    )
    return
  }

  const s = state.botStates.get(name)
  const hp     = s.hp ?? 0
  const food   = s.food ?? 0
  const hpBar  = renderBar(hp, 20, 'red', 'green')
  const foodBar = renderBar(food, 20, 'yellow', 'yellow')
  const pos    = s.pos ? `(${s.pos.x}, ${s.pos.y}, ${s.pos.z})` : 'unknown'
  const inv    = s.inventory && s.inventory.length > 0 ? s.inventory.join(', ') : '{gray-fg}empty{/}'

  let goalColor = 'white'
  if (s.goal === 'idle')      goalColor = 'gray'
  if (s.goal === 'attacking') goalColor = 'red'
  if (s.goal === 'following') goalColor = 'cyan'
  if (s.goal === 'resting')   goalColor = 'yellow'

  const lines = [
    `{bold}{green-fg}${name}{/}{/bold}`,
    ``,
    `{bold}HP:{/bold}     ${hpBar} ${hp.toFixed(1)}/20`,
    `{bold}Food:{/bold}   ${foodBar} ${food}/20`,
    `{bold}Goal:{/bold}   {${goalColor}-fg}${s.goal}{/}${s.busy ? '  {yellow-fg}(busy){/}' : ''}`,
    `{bold}Pos:{/bold}    ${pos}`,
    s.followTarget ? `{bold}Following:{/bold} ${s.followTarget}` : '',
    `{bold}Anger:{/bold}  ${s.anger > 0 ? '{red-fg}' + s.anger + ' player(s){/}' : '{gray-fg}none{/}'}`,
    ``,
    `{bold}Inventory:{/bold}`,
    `  ${inv}`,
  ].filter(Boolean)

  statusPanel.setContent(lines.join('\n'))
}

function renderBar(value, max, lowColor, highColor) {
  const width = 14
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)))
  const empty = width - filled
  const color = value < max * 0.3 ? lowColor : highColor
  return `{${color}-fg}${'█'.repeat(filled)}{/}{gray-fg}${'░'.repeat(empty)}{/}`
}

function renderActions() {
  const lines = [
    `{bold}{cyan-fg}[1]{/} Start server`,
    `{bold}{cyan-fg}[2]{/} Stop server`,
    `{bold}{cyan-fg}[3]{/} Spawn bot`,
    `{bold}{cyan-fg}[4]{/} Stop bot`,
    `{bold}{cyan-fg}[5]{/} Restart bot`,
    `{bold}{cyan-fg}[6]{/} World settings`,
    `{bold}{cyan-fg}[7]{/} List Featherless models`,
    `{bold}{cyan-fg}[s]{/} Switch active bot`,
    ``,
    `{gray-fg}─── navigation ───{/}`,
    `{cyan-fg}↑↓{/}   scroll log`,
    `{cyan-fg}Tab{/}  switch focus`,
    `{cyan-fg}r{/}    refresh status`,
    `{cyan-fg}q{/}    quit`,
    ``,
    `{gray-fg}Logs in:{/}`,
    `{gray-fg}${LOG_DIR.replace(process.env.HOME, '~')}{/}`,
  ]
  actionsPanel.setContent(lines.join('\n'))
}

function renderStatusBar(message) {
  if (message) {
    statusBar.setContent(`{bold}${message}{/}`)
  } else {
    const port = getServerPort()
    const hint = state.bots.size === 0 && !state.serverProc && !isPortInUse(port)
      ? '{yellow-fg}Press [1] to start the server, then [3] to spawn a bot.{/}'
      : 'Press a key to act, or [q] to quit.'
    statusBar.setContent(hint)
  }
}

function refresh(message) {
  renderHeader()
  renderStatus()
  renderActions()
  renderStatusBar(message)
  screen.render()
}

// ── Live log streaming from events.jsonl ─────────────────────────────────────
function appendLogLine(record) {
  const t = record.ts ? record.ts.slice(11, 19) : ''
  const lvl = record.level
  const colors = { trace: 'gray', debug: 'gray', info: 'cyan', warn: 'yellow', error: 'red', fatal: 'red' }
  const c = colors[lvl] || 'white'

  // 'state' events are tracked but not shown in log (too spammy)
  if (record.event === 'state') {
    if (record.bot) state.botStates.set(record.bot, record)
    if (!state.selectedBot && record.bot) state.selectedBot = record.bot
    renderStatus()
    renderHeader()
    screen.render()
    return
  }

  const data = Object.entries(record).filter(([k]) =>
    !['ts', 'level', 'event', 'bot'].includes(k)
  ).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' ')

  const botTag = record.bot ? `{magenta-fg}${record.bot}{/} ` : ''
  logPanel.log(`{gray-fg}${t}{/} {${c}-fg}[${lvl}]{/} ${botTag}{bold}${record.event}{/bold} {gray-fg}${data}{/}`)
}

function followEvents() {
  // Tail events.jsonl: read new lines as they're appended
  let lastSize = 0
  try { lastSize = fs.statSync(EVENTS_FILE).size } catch {}
  state.eventsFollowOffset = lastSize  // start at end (don't replay history)

  const tail = setInterval(() => {
    let stat
    try { stat = fs.statSync(EVENTS_FILE) } catch { return }
    if (stat.size <= state.eventsFollowOffset) {
      // File rotated/truncated
      if (stat.size < state.eventsFollowOffset) state.eventsFollowOffset = 0
      return
    }
    const fd = fs.openSync(EVENTS_FILE, 'r')
    const buf = Buffer.alloc(stat.size - state.eventsFollowOffset)
    fs.readSync(fd, buf, 0, buf.length, state.eventsFollowOffset)
    fs.closeSync(fd)
    state.eventsFollowOffset = stat.size

    const lines = buf.toString('utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const rec = JSON.parse(line)
        appendLogLine(rec)
      } catch { /* malformed line — skip */ }
    }
  }, 500)

  return () => clearInterval(tail)
}

// ── Modal prompts (blocking input via blessed) ───────────────────────────────
function modalPrompt(question, defaultValue = '') {
  return new Promise((resolve) => {
    const box = blessed.form({
      parent: screen,
      top: 'center', left: 'center', width: '60%', height: 7,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      label: ' Input ',
      keys: true,
      tags: true,
    })
    blessed.text({
      parent: box, top: 0, left: 1, content: question,
    })
    const input = blessed.textbox({
      parent: box, top: 2, left: 1, right: 1, height: 1,
      inputOnFocus: true,
      style: { fg: 'white', bg: 'black' },
      value: defaultValue,
    })
    blessed.text({
      parent: box, bottom: 0, left: 1,
      content: '{gray-fg}Enter to confirm, Esc to cancel{/}',
      tags: true,
    })

    input.focus()
    input.readInput()

    input.key(['escape'], () => { box.destroy(); screen.render(); resolve(null) })
    input.on('submit', (val) => { box.destroy(); screen.render(); resolve(val) })
    screen.render()
  })
}

function modalSelect(title, items) {
  return new Promise((resolve) => {
    if (items.length === 0) { resolve(null); return }
    const box = blessed.list({
      parent: screen,
      top: 'center', left: 'center', width: '60%', height: Math.min(items.length + 4, 15),
      border: { type: 'line' },
      style: { border: { fg: 'yellow' }, selected: { bg: 'blue', bold: true } },
      label: ` ${title} `,
      keys: true, mouse: true,
      items: items.map(it => typeof it === 'string' ? it : it.label),
      tags: true,
    })
    box.focus()
    box.on('select', (_, idx) => {
      const chosen = items[idx]
      box.destroy(); screen.render()
      resolve(typeof chosen === 'string' ? chosen : chosen.value)
    })
    box.key(['escape'], () => { box.destroy(); screen.render(); resolve(null) })
    screen.render()
  })
}

function modalMessage(text, color = 'cyan') {
  const box = blessed.box({
    parent: screen,
    top: 'center', left: 'center', width: '50%', height: 'shrink',
    border: { type: 'line' },
    style: { border: { fg: color } },
    label: ' Info ',
    tags: true,
    content: text + '\n\n{gray-fg}Press any key{/}',
    padding: 1,
  })
  screen.render()
  return new Promise((resolve) => {
    screen.once('keypress', () => { box.destroy(); screen.render(); resolve() })
  })
}

// ── Action handlers ──────────────────────────────────────────────────────────
async function actStartServer() {
  if (state.serverProc) return modalMessage('{yellow-fg}Server is already running.{/}')
  const jarPath = path.join(SERVER_DIR, SERVER_JAR)
  if (!fs.existsSync(jarPath)) {
    return modalMessage(`{red-fg}server.jar not found at ${jarPath}{/}`, 'red')
  }
  const port = getServerPort()
  if (isPortInUse(port)) {
    return modalMessage(`{red-fg}Port ${port} already in use.{/}\nStop the running server first.`, 'red')
  }
  const javaBin = findJava()
  let javaVer = 0
  try {
    const m = execSync(`"${javaBin}" -version 2>&1`).toString().match(/version "(\d+)/)
    javaVer = m ? parseInt(m[1]) : 0
  } catch {}
  if (javaVer < 21) {
    return modalMessage(`{red-fg}Java ${javaVer || '?'} found — need Java 21+.{/}\nInstall: brew install openjdk@21`, 'red')
  }

  refresh(`{cyan-fg}Starting server with Java ${javaVer}...{/}`)
  const logFd = fs.openSync(state.serverLogPath, 'w')
  const proc = spawn(javaBin, ['-Xmx2G', '-jar', SERVER_JAR, 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', logFd, logFd],
  })
  proc.stdin.end()
  proc.on('error', (err) => { logPanel.log(`{red-fg}server error: ${err.message}{/}`); state.serverProc = null; refresh() })

  let fullyStarted = false
  const startTimer = setTimeout(() => { fullyStarted = true }, 20000)
  proc.on('exit', (code) => {
    clearTimeout(startTimer)
    if (!fullyStarted) {
      logPanel.log(`{red-fg}Server exited early (code ${code}){/}`)
      try {
        const tail = fs.readFileSync(state.serverLogPath, 'utf8').trim().split('\n').slice(-10).join('\n')
        for (const line of tail.split('\n')) logPanel.log(`{gray-fg}  ${line}{/}`)
      } catch {}
    } else {
      logPanel.log(`{gray-fg}Server stopped (code ${code}){/}`)
    }
    state.serverProc = null
    refresh()
  })

  state.serverProc = proc
  logPanel.log(`{green-fg}Server starting — connect at localhost:${port}{/}`)
  refresh()
}

function actStopServer() {
  const port = getServerPort()
  if (!state.serverProc) {
    const pids = getServerPids(port)
    if (!pids.length) return modalMessage(`{yellow-fg}No server running on port ${port}.{/}`)
    try {
      for (const pid of pids) process.kill(pid, 'SIGTERM')
      logPanel.log(`{green-fg}Server on port ${port} stopped (pids ${pids.join(', ')}){/}`)
      refresh()
    } catch (e) {
      modalMessage(`{red-fg}Stop failed: ${e.message}{/}`, 'red')
    }
    return
  }
  logPanel.log('{cyan-fg}Stopping server...{/}')
  try { state.serverProc.kill('SIGTERM') } catch (e) {
    modalMessage(`{red-fg}Kill failed: ${e.message}{/}`, 'red')
  }
}

async function actSpawnBot() {
  const name = await modalPrompt('Bot name (default Ember):', 'Ember')
  if (name === null) return
  const botName = name.trim() || 'Ember'

  if (state.bots.has(botName)) {
    return modalMessage(`{red-fg}Bot "${botName}" already running.{/}`, 'red')
  }

  if (!process.env.FEATHERLESS_API_KEY) {
    return modalMessage(`{red-fg}FEATHERLESS_API_KEY not set in .env{/}\nAdd it to ${path.join(ROOT, '.env')}`, 'red')
  }

  const models = await fetchFeatherlessModels()
  const model = await modalSelect('Select Featherless model', models)
  if (!model) return

  const logPath = path.join(LOG_DIR, `bot_${botName}.log`)
  const logFd = fs.openSync(logPath, 'w')
  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: botName, FEATHERLESS_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })

  proc.on('error', (err) => {
    logPanel.log(`{red-fg}Bot "${botName}" failed: ${err.message}{/}`)
    state.bots.delete(botName)
    refresh()
  })
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      logPanel.log(`{red-fg}Bot "${botName}" crashed (code ${code}){/}`)
    } else {
      logPanel.log(`{gray-fg}Bot "${botName}" stopped{/}`)
    }
    state.bots.delete(botName)
    state.botStates.delete(botName)
    if (state.selectedBot === botName) state.selectedBot = state.bots.keys().next().value || null
    refresh()
  })

  state.bots.set(botName, { proc, model, logPath, startedAt: Date.now() })
  state.selectedBot = botName
  logPanel.log(`{green-fg}Bot "${botName}" starting with ${model}{/}`)
  refresh()
}

async function actStopBot() {
  if (state.bots.size === 0) return modalMessage('{yellow-fg}No bots running.{/}')
  const items = [...state.bots.entries()].map(([name, b]) => ({ label: `${name} (${b.model})`, value: name }))
  const name = await modalSelect('Stop which bot?', items)
  if (!name) return
  const bot = state.bots.get(name)
  if (!bot) return
  try { bot.proc.kill('SIGTERM') } catch (e) {
    return modalMessage(`{red-fg}Kill failed: ${e.message}{/}`, 'red')
  }
  logPanel.log(`{cyan-fg}Stopping ${name}...{/}`)
}

async function actRestartBot() {
  if (state.bots.size === 0) return modalMessage('{yellow-fg}No bots running.{/}')
  const items = [...state.bots.entries()].map(([name, b]) => ({ label: `${name} (${b.model})`, value: name }))
  const name = await modalSelect('Restart which bot?', items)
  if (!name) return
  const old = state.bots.get(name)
  const model = old.model
  try { old.proc.kill('SIGTERM') } catch {}
  await new Promise(r => setTimeout(r, 1500))

  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  const logFd = fs.openSync(logPath, 'w')
  const proc = spawn('node', ['bot.js'], {
    cwd: BOT_DIR,
    env: { ...process.env, BOT_NAME: name, FEATHERLESS_MODEL: model },
    stdio: ['ignore', logFd, logFd],
  })
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) logPanel.log(`{red-fg}Bot "${name}" crashed (code ${code}){/}`)
    else logPanel.log(`{gray-fg}Bot "${name}" stopped{/}`)
    state.bots.delete(name)
    state.botStates.delete(name)
    if (state.selectedBot === name) state.selectedBot = state.bots.keys().next().value || null
    refresh()
  })
  state.bots.set(name, { proc, model, logPath, startedAt: Date.now() })
  state.selectedBot = name
  logPanel.log(`{green-fg}Bot "${name}" restarted{/}`)
  refresh()
}

async function actSwitchBot() {
  if (state.bots.size === 0) return modalMessage('{yellow-fg}No bots running.{/}')
  const items = [...state.bots.keys()].map(n => ({ label: n + (n === state.selectedBot ? ' (active)' : ''), value: n }))
  const name = await modalSelect('Show which bot in status panel?', items)
  if (!name) return
  state.selectedBot = name
  refresh()
}

async function actListModels() {
  if (!process.env.FEATHERLESS_API_KEY) {
    return modalMessage('{red-fg}FEATHERLESS_API_KEY not set in .env{/}', 'red')
  }
  const models = await fetchFeatherlessModels()
  if (!models.length) return modalMessage('{red-fg}Could not reach Featherless API.{/}', 'red')
  const list = models.slice(0, 15).map(m => `  {green-fg}●{/} ${m}`).join('\n')
  const more = models.length > 15 ? `\n{gray-fg}…and ${models.length - 15} more{/}` : ''
  await modalMessage(`{bold}Featherless models:{/}\n\n${list}${more}`, 'green')
}

// ── World Settings (modal) ───────────────────────────────────────────────────
const WORLD_DEFS = [
  { key: 'gamemode', label: 'Game Mode', type: 'cycle',
    options: ['survival','creative','adventure','spectator'] },
  { key: 'difficulty', label: 'Difficulty', type: 'cycle',
    options: ['peaceful','easy','normal','hard'] },
  { key: 'pvp', label: 'PVP', type: 'cycle', options: ['true','false'] },
  { key: 'hardcore', label: 'Hardcore', type: 'cycle', options: ['false','true'] },
  { key: 'level-type', label: 'World Type', type: 'cycle',
    options: ['minecraft:normal','minecraft:flat','minecraft:large_biomes','minecraft:amplified'] },
  { key: 'level-seed', label: 'Seed', type: 'text' },
  { key: 'generate-structures', label: 'Structures', type: 'cycle', options: ['true','false'] },
  { key: 'max-players', label: 'Max Players', type: 'num', min: 1, max: 200 },
  { key: 'view-distance', label: 'View Distance', type: 'num', min: 3, max: 32 },
  { key: 'allow-flight', label: 'Allow Flight', type: 'cycle', options: ['false','true'] },
  { key: 'spawn-monsters', label: 'Spawn Monsters', type: 'cycle', options: ['true','false'] },
  { key: 'enable-command-block', label: 'Command Blocks', type: 'cycle', options: ['true','false'] },
]

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

async function actWorldSettings() {
  const props = readServerProps()
  const draft = {}
  for (const def of WORLD_DEFS) {
    draft[def.key] = props[def.key] ?? (def.type === 'cycle' ? def.options[0] : def.type === 'num' ? '10' : '')
  }

  while (true) {
    const items = WORLD_DEFS.map(def => ({
      label: `${def.label.padEnd(20)} ${draft[def.key] || '(blank)'}`,
      value: def.key,
    }))
    items.push({ label: '── Save & close ──', value: '__save__' })
    items.push({ label: '── Cancel ──', value: '__cancel__' })

    const choice = await modalSelect('World Settings', items)
    if (!choice || choice === '__cancel__') return
    if (choice === '__save__') {
      writeServerProps(draft)
      await modalMessage('{green-fg}Saved to server.properties.{/}\nRestart server to apply.', 'green')
      return
    }

    const def = WORLD_DEFS.find(d => d.key === choice)
    if (def.type === 'cycle') {
      const idx = def.options.indexOf(draft[def.key])
      draft[def.key] = def.options[(idx + 1) % def.options.length]
    } else if (def.type === 'text') {
      const val = await modalPrompt(`${def.label} (current: "${draft[def.key] || 'blank'}")`, draft[def.key] || '')
      if (val !== null) draft[def.key] = val.trim()
    } else if (def.type === 'num') {
      const val = await modalPrompt(`${def.label} (${def.min}-${def.max}, current: ${draft[def.key]})`, draft[def.key])
      if (val !== null) {
        const n = parseInt(val.trim())
        if (!isNaN(n) && n >= def.min && n <= def.max) draft[def.key] = String(n)
        else await modalMessage(`{red-fg}Invalid — must be ${def.min}-${def.max}.{/}`, 'red')
      }
    }
  }
}

// ── Cleanup & quit ───────────────────────────────────────────────────────────
async function quit() {
  refresh('{yellow-fg}Shutting down...{/}')
  for (const [, b] of state.bots) {
    try { b.proc.kill('SIGTERM') } catch {}
  }
  if (state.serverProc) {
    try { state.serverProc.kill('SIGTERM') } catch {}
  }
  await new Promise(r => setTimeout(r, 800))
  screen.destroy()
  process.exit(0)
}

// ── Key bindings ─────────────────────────────────────────────────────────────
screen.key(['1'], actStartServer)
screen.key(['2'], actStopServer)
screen.key(['3'], actSpawnBot)
screen.key(['4'], actStopBot)
screen.key(['5'], actRestartBot)
screen.key(['6'], actWorldSettings)
screen.key(['7'], actListModels)
screen.key(['s'], actSwitchBot)
screen.key(['r'], () => refresh())
screen.key(['q', 'C-c'], quit)
screen.key(['tab'], () => screen.focusNext())

logPanel.key(['up','down','pageup','pagedown'], () => {})  // enables built-in scroll
logPanel.focus()

// ── Initial state & periodic refresh ─────────────────────────────────────────
refresh()
followEvents()
setInterval(() => renderHeader() || screen.render(), 1000)  // uptime ticker

// Show a welcome line in the log
logPanel.log('{green-fg}project-k TUI started.{/} Press [3] to spawn a bot, or use number keys for actions.')
logPanel.log(`{gray-fg}Watching events from: ${EVENTS_FILE}{/}`)

process.on('SIGINT', quit)
process.on('SIGTERM', quit)
