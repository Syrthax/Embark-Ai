#!/usr/bin/env node
// tui.js — embark-ai Live Control Dashboard (sole entry point)
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
//   │                      │ [7] List models           │
//   │                      │ [8] Reconfigure           │
//   │                      │ [q] Quit                  │
//   └──────────────────────┴───────────────────────────┘
//
// Keys: 1-8 = actions · q/Ctrl+C = quit · Tab = focus cycle
//       ↑↓/PgUp/Dn = scroll log · r = refresh · s = switch bot
//
// First run: onboarding wizard prompts for Ollama or Featherless API setup.
// Config saved to .ember-config.json (not .env).

// Load .env from project root if present (optional — config.json is primary)
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
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
  } catch {}
}
loadDotEnv()

const blessed = require('blessed')
const { spawn, execSync } = require('child_process')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')
const https   = require('https')
const createBotSupervisor = require('./botSupervisor')

// ── Paths & constants ─────────────────────────────────────────────────────────
const ROOT        = __dirname
const SERVER_DIR  = path.join(ROOT, 'mc-server')
const BOT_DIR     = path.join(ROOT, 'mc-server', 'bot')
const LOG_DIR     = path.join(ROOT, '.cli-logs')
const CONFIG_FILE = path.join(ROOT, '.ember-config.json')
const SERVER_JAR  = 'server.jar'
const MC_VERSION  = '1.21.4'
const EVENTS_FILE = path.join(BOT_DIR, 'events.jsonl')

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })

// ── Process state ─────────────────────────────────────────────────────────────
const state = {
  serverProc:         null,
  serverLogPath:      path.join(LOG_DIR, 'server.log'),
  selectedBot:        null,
  botStates:          new Map(),
  eventsFollowOffset: 0,
}

let supervisor = null
let appConfig  = null  // loaded by startup()

// ── Config management ─────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }
  catch { return null }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2))
}

// Sets process.env so the supervisor's spawned bot processes inherit the right vars.
// Ollama reuses the Featherless-compatible URL env vars — llm.js talks to Ollama's
// OpenAI-compatible endpoint without any code change.
function applyConfig(cfg) {
  if (!cfg) return
  if (cfg.llmMode === 'ollama') {
    process.env.FEATHERLESS_URL     = 'http://localhost:11434/v1/chat/completions'
    process.env.FEATHERLESS_API_KEY = 'ollama'
    process.env.FEATHERLESS_MODEL   = cfg.ollamaModel || 'llama3.2'
  } else {
    delete process.env.FEATHERLESS_URL
    process.env.FEATHERLESS_API_KEY = cfg.featherlessApiKey || ''
    process.env.FEATHERLESS_MODEL   = cfg.featherlessModel  || ''
  }
}

function configSummary(cfg) {
  if (!cfg) return '{red-fg}not configured — press [8]{/}'
  if (cfg.llmMode === 'ollama')
    return `{green-fg}Ollama{/} {gray-fg}(${cfg.ollamaModel || 'no model'}){/}`
  return `{cyan-fg}Featherless API{/} {gray-fg}(${cfg.featherlessModel || 'no model'}){/}`
}

// ── Hardware / Ollama helpers ─────────────────────────────────────────────────
function detectRAMGB() {
  return Math.round(os.totalmem() / (1024 ** 3))
}

function recommendOllamaModel(ramGB) {
  if (ramGB >= 32) return 'qwen2.5:32b'
  if (ramGB >= 16) return 'qwen2.5-coder:14b'
  if (ramGB >= 8)  return 'llama3.2'
  return 'llama3.2:1b'
}

function isOllamaInstalled() {
  try { execSync('ollama --version', { stdio: 'pipe' }); return true }
  catch { return false }
}

function getOllamaModels() {
  try {
    const out = execSync('ollama list', { stdio: ['pipe', 'pipe', 'pipe'] }).toString()
    return out.trim().split('\n')
      .slice(1)
      .map(l => l.trim().split(/\s+/)[0])
      .filter(m => m && m !== 'NAME')
  } catch { return [] }
}

// ── Featherless model helpers ─────────────────────────────────────────────────
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
    if (!apiKey || apiKey === 'ollama') { resolve(FEATHERLESS_DEFAULT_MODELS); return }
    const req = https.request({
      hostname: 'api.featherless.ai',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'User-Agent': 'embark-ai/1.0',
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

// ── Server helpers ────────────────────────────────────────────────────────────
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

// ── Blessed screen setup ──────────────────────────────────────────────────────
const screen = blessed.screen({ smartCSR: true, title: 'embark-ai', fullUnicode: true })

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

// ── Supervisor ────────────────────────────────────────────────────────────────
supervisor = createBotSupervisor({
  botDir: BOT_DIR,
  logDir: LOG_DIR,
  onLog: (entry) => {
    const clr = entry.level === 'error' ? '{red-fg}' : entry.level === 'warn' ? '{yellow-fg}' : '{gray-fg}'
    logPanel.log(`${clr}[supervisor] ${entry.msg}{/}`)
  },
  onRespawn: ({ name, chainId, restartCount }) => {
    const port = getServerPort()
    logPanel.log(`{yellow-fg}[supervisor] Bot "${name}" respawning (chain ${chainId}, attempt #${restartCount}) — localhost:${port}{/}`)
    refresh()
  },
  onStorm: ({ name, chainId, restartCount }) => {
    logPanel.log(`{red-fg}[supervisor] RESTART STORM: bot "${name}" restarted ${restartCount}x in 10 min (chain ${chainId}). Halted.{/}`)
    state.botStates.delete(name)
    if (state.selectedBot === name) state.selectedBot = null
    refresh()
  },
})

// ── Rendering ─────────────────────────────────────────────────────────────────
function renderHeader() {
  const port = getServerPort()
  let serverLine
  if (state.serverProc) {
    serverLine = `{green-fg}●{/} Server  {bold}localhost:${port}{/bold}  (managed)`
  } else if (isPortInUse(port)) {
    serverLine = `{yellow-fg}●{/} Server  {bold}localhost:${port}{/bold}  (external)`
  } else {
    serverLine = `{gray-fg}○{/} Server  {gray-fg}stopped{/}`
  }

  const sv = supervisor ? supervisor.getState() : {}
  const svNames = Object.keys(sv)
  let botsLine
  if (!svNames.length) {
    botsLine = '{gray-fg}no bots running{/}'
  } else {
    const items = []
    for (const [name, b] of Object.entries(sv)) {
      const up = Math.floor((b.uptimeMs || 0) / 1000)
      const upStr = up >= 60 ? `${Math.floor(up / 60)}m${up % 60}s` : `${up}s`
      const dot = b.running ? (name === state.selectedBot ? `{green-fg}●{/}` : `{cyan-fg}●{/}`)
                : b.awaitingRespawn ? `{yellow-fg}○{/}` : `{gray-fg}○{/}`
      const restarts = b.restartCount > 0 ? ` {yellow-fg}[${b.restartCount}↺]{/}` : ''
      items.push(`${dot} {bold}${name}{/bold} {gray-fg}(${b.model}, ${upStr}){/}${restarts}`)
    }
    botsLine = items.join('   ')
  }

  header.setContent(`{bold}{cyan-fg}embark-ai{/}{/bold}   ${serverLine}   |   Bots:  ${botsLine}`)
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
  const modeStr = configSummary(appConfig)
  const lines = [
    `{bold}AI:{/bold} ${modeStr}`,
    ``,
    `{bold}{cyan-fg}[1]{/} Start server`,
    `{bold}{cyan-fg}[2]{/} Stop server`,
    `{bold}{cyan-fg}[3]{/} Spawn bot`,
    `{bold}{cyan-fg}[4]{/} Stop bot`,
    `{bold}{cyan-fg}[5]{/} Restart bot`,
    `{bold}{cyan-fg}[6]{/} World settings`,
    `{bold}{cyan-fg}[7]{/} List models`,
    `{bold}{cyan-fg}[8]{/} Reconfigure`,
    `{bold}{cyan-fg}[s]{/} Switch active bot`,
    ``,
    `{gray-fg}─── navigation ───{/}`,
    `{cyan-fg}↑↓{/}   scroll log`,
    `{cyan-fg}Tab{/}  switch focus`,
    `{cyan-fg}r{/}    refresh status`,
    `{cyan-fg}q{/}    quit`,
    ``,
    `{gray-fg}Logs in:{/}`,
    `{gray-fg}${LOG_DIR}{/}`,
  ]
  actionsPanel.setContent(lines.join('\n'))
}

function renderStatusBar(message) {
  if (message) {
    statusBar.setContent(`{bold}${message}{/}`)
  } else {
    const port = getServerPort()
    const hint = (!supervisor || !Object.keys(supervisor.getState()).length) && !state.serverProc && !isPortInUse(port)
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

// ── Live log streaming from events.jsonl ──────────────────────────────────────
function appendLogLine(record) {
  const t = record.ts ? record.ts.slice(11, 19) : ''
  const lvl = record.level
  const colors = { trace: 'gray', debug: 'gray', info: 'cyan', warn: 'yellow', error: 'red', fatal: 'red' }
  const c = colors[lvl] || 'white'

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
  let lastSize = 0
  try { lastSize = fs.statSync(EVENTS_FILE).size } catch {}
  state.eventsFollowOffset = lastSize

  const tail = setInterval(() => {
    let stat
    try { stat = fs.statSync(EVENTS_FILE) } catch { return }
    if (stat.size <= state.eventsFollowOffset) {
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
      } catch {}
    }
  }, 500)

  return () => clearInterval(tail)
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
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
    blessed.text({ parent: box, top: 0, left: 1, content: question })
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
      top: 'center', left: 'center', width: '65%', height: Math.min(items.length + 4, 18),
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
    top: 'center', left: 'center', width: '55%', height: 'shrink',
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

// Shows a command to run in a terminal. Enter = done, Esc = cancel.
function modalCommand(title, instruction, command, note) {
  return new Promise((resolve) => {
    const noteBlock = note ? `\n\n{gray-fg}${note}{/}` : ''
    const content =
      `{bold}${instruction}{/bold}\n\n` +
      `{green-fg}{bold}  ${command}{/bold}{/}` +
      noteBlock +
      `\n\n{gray-fg}Enter = done  ·  Esc = cancel{/}`

    const noteLines = note ? note.split('\n').length : 0
    const height = Math.min(8 + noteLines, 18)

    const box = blessed.box({
      parent: screen,
      top: 'center', left: 'center', width: '70%', height,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      label: ` ${title} `,
      tags: true,
      content,
      padding: { left: 2, right: 2, top: 1, bottom: 1 },
    })
    screen.render()

    const onKey = (ch, key) => {
      if (key.name === 'return' || key.name === 'enter') {
        screen.removeListener('keypress', onKey)
        box.destroy(); screen.render(); resolve(true)
      } else if (key.name === 'escape') {
        screen.removeListener('keypress', onKey)
        box.destroy(); screen.render(); resolve(false)
      }
    }
    screen.on('keypress', onKey)
  })
}

// ── Onboarding wizard ─────────────────────────────────────────────────────────
async function runOnboarding() {
  await modalMessage(
    `{bold}{cyan-fg}Welcome to embark-ai{/}{/bold}  {yellow-fg}[beta]{/}\n\n` +
    `Ember is an autonomous Minecraft agent powered by AI.\n` +
    `Let\'s set up your AI backend and verify your server.\n\n` +
    `{yellow-fg}⚠ This is a beta release — some features may be\n` +
    `  unstable. Please report issues on GitHub.{/}\n\n` +
    `{gray-fg}This takes about 2 minutes on first run.{/}`,
    'cyan'
  )

  // Step 1: choose backend
  const mode = await modalSelect('Step 1 of 3 — AI Backend', [
    { label: 'Ollama          local AI, runs on your machine (free, private)', value: 'ollama' },
    { label: 'Featherless API cloud AI, no GPU needed (requires API key)',      value: 'featherless' },
  ])
  if (!mode) return null

  const cfg = { llmMode: mode }

  // ── Ollama path ──────────────────────────────────────────────────────────────
  if (mode === 'ollama') {

    // Check installation
    while (!isOllamaInstalled()) {
      const ok = await modalCommand(
        'Install Ollama',
        'Ollama is not installed. Run this in a separate terminal:',
        'curl -fsSL https://ollama.com/install.sh | sh',
        'On macOS with Homebrew: brew install ollama\nPress Enter once installation finishes.',
      )
      if (!ok) return null
      if (!isOllamaInstalled()) {
        await modalMessage(
          '{yellow-fg}Ollama still not detected.{/}\nMake sure the installation completed and try again.',
          'yellow'
        )
      }
    }

    await modalMessage('{green-fg}Ollama detected!{/}', 'green')

    // Check for installed models
    let models = getOllamaModels()

    if (!models.length) {
      const ramGB = detectRAMGB()
      const rec   = recommendOllamaModel(ramGB)

      const MODEL_OPTIONS = [
        { value: 'llama3.2:1b',        label: 'llama3.2:1b          1.3 GB   (< 4 GB RAM)' },
        { value: 'llama3.2',            label: 'llama3.2             2.0 GB   (4–8 GB RAM)' },
        { value: 'qwen2.5-coder:14b',   label: 'qwen2.5-coder:14b   9.0 GB   (16 GB RAM)' },
        { value: 'qwen2.5:32b',         label: 'qwen2.5:32b         20 GB    (32 GB RAM)' },
      ].map(o => o.value === rec
        ? { ...o, label: o.label + '  ← recommended' }
        : o
      )

      while (!models.length) {
        const chosen = await modalSelect(
          `Step 2 of 3 — Choose Model to Install  (${ramGB} GB RAM detected)`,
          MODEL_OPTIONS
        )
        if (!chosen) return null

        const ok = await modalCommand(
          'Download Model',
          `Run in a separate terminal (may take several minutes):`,
          `ollama pull ${chosen}`,
          `Wait for "success" to appear, then press Enter.`,
        )
        if (!ok) return null

        models = getOllamaModels()
        if (!models.length) {
          await modalMessage(
            '{yellow-fg}No models found yet.{/}\nPlease wait for the download to complete.',
            'yellow'
          )
        }
      }
    }

    // Pick from installed models
    const model = models.length === 1
      ? models[0]
      : await modalSelect('Step 2 of 3 — Select Ollama Model', models)
    if (!model) return null

    cfg.ollamaModel = model

  // ── Featherless path ─────────────────────────────────────────────────────────
  } else {
    let apiKey = ''
    while (!apiKey) {
      const input = await modalPrompt('Step 2 of 3 — Enter Featherless API key (starts with rc_...):', '')
      if (input === null) return null
      apiKey = input.trim()
      if (!apiKey) await modalMessage('{red-fg}API key cannot be empty.{/}', 'red')
    }
    cfg.featherlessApiKey = apiKey

    process.env.FEATHERLESS_API_KEY = apiKey
    const models = await fetchFeatherlessModels()
    const model = await modalSelect('Step 2 of 3 — Select Featherless Model', models)
    if (!model) return null
    cfg.featherlessModel = model
  }

  // ── Step 3: Minecraft server check ──────────────────────────────────────────
  const jarPath = path.join(SERVER_DIR, SERVER_JAR)
  if (!fs.existsSync(jarPath)) {
    await modalCommand(
      `Step 3 of 3 — Minecraft Server  (requires Java Edition ${MC_VERSION})`,
      `server.jar not found. Place it at:`,
      `${jarPath}`,
      `embark-ai requires Minecraft Java Edition ${MC_VERSION} specifically.\n` +
      `minecraft.net only offers the latest version — search for:\n` +
      `"Minecraft ${MC_VERSION} server jar" or use mcversions.net\n\n` +
      `Rename the downloaded file to server.jar and place it at the path above.\n` +
      `Press Enter once done, or Esc to set up later.`,
    )
  } else {
    await modalMessage(
      `{green-fg}Minecraft server jar found.{/} {gray-fg}(Java Edition ${MC_VERSION}){/}`,
      'green'
    )
  }

  // Save and confirm
  saveConfig(cfg)
  const modeLine = cfg.llmMode === 'ollama'
    ? `Ollama — ${cfg.ollamaModel}`
    : `Featherless API — ${cfg.featherlessModel}`

  await modalMessage(
    `{green-fg}{bold}Setup complete!{/}{/bold}\n\n` +
    `Mode: {bold}${modeLine}{/bold}\n\n` +
    `Press {cyan-fg}[1]{/} to start the server, then {cyan-fg}[3]{/} to spawn Ember.`,
    'green'
  )
  return cfg
}

// ── Action handlers ───────────────────────────────────────────────────────────
async function actStartServer() {
  if (state.serverProc) return modalMessage('{yellow-fg}Server is already running.{/}')
  const jarPath = path.join(SERVER_DIR, SERVER_JAR)
  if (!fs.existsSync(jarPath)) {
    return modalMessage(
      `{red-fg}server.jar not found at:{/}\n${path.join(SERVER_DIR, SERVER_JAR)}\n` +
      `Run setup again with {cyan-fg}[8]{/} for download instructions.`,
      'red'
    )
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
    return modalMessage(
      `{red-fg}Java ${javaVer || '?'} found — need Java 21+.{/}\nInstall: brew install openjdk@21`,
      'red'
    )
  }

  // Auto-accept the Minecraft EULA so the server doesn't exit on first run
  const eulaPath = path.join(SERVER_DIR, 'eula.txt')
  if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
    fs.writeFileSync(eulaPath, '#By running embark-ai you agree to the Minecraft EULA\n#https://www.minecraft.net/en-us/eula\neula=true\n')
    logPanel.log('{gray-fg}Accepted Minecraft EULA (eula.txt written){/}')
  }

  refresh(`{cyan-fg}Starting server with Java ${javaVer}...{/}`)
  const logFd = fs.openSync(state.serverLogPath, 'w')
  const proc = spawn(javaBin, ['-Xmx2G', '-jar', SERVER_JAR, 'nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', logFd, logFd],
  })
  proc.stdin.end()
  proc.on('error', (err) => {
    logPanel.log(`{red-fg}server error: ${err.message}{/}`)
    state.serverProc = null
    refresh()
  })

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
  try { state.serverProc.kill('SIGTERM') }
  catch (e) { modalMessage(`{red-fg}Kill failed: ${e.message}{/}`, 'red') }
}

async function actSpawnBot() {
  if (!appConfig) {
    return modalMessage('{red-fg}Not configured yet.{/}\nPress {cyan-fg}[8]{/} to run the setup wizard.', 'red')
  }

  const name = await modalPrompt('Bot name (default Ember):', 'Ember')
  if (name === null) return
  const botName = name.trim() || 'Ember'

  if (supervisor.has(botName)) {
    return modalMessage(`{red-fg}Bot "${botName}" is already running.{/}`, 'red')
  }

  let model
  if (appConfig.llmMode === 'ollama') {
    const models = getOllamaModels()
    if (!models.length) {
      return modalMessage(
        '{red-fg}No Ollama models installed.{/}\nPress {cyan-fg}[8]{/} to run setup and install a model.',
        'red'
      )
    }
    model = models.length === 1
      ? models[0]
      : await modalSelect('Select Ollama Model', models)
  } else {
    const models = await fetchFeatherlessModels()
    model = await modalSelect('Select Featherless Model', models)
  }
  if (!model) return

  // Persist last used model and re-apply env so the supervisor spawn gets it
  if (appConfig.llmMode === 'ollama') appConfig.ollamaModel = model
  else appConfig.featherlessModel = model
  saveConfig(appConfig)
  applyConfig(appConfig)

  const logPath = path.join(LOG_DIR, `bot_${botName}.log`)
  supervisor.launch(botName, model, logPath, { fresh: true })

  state.selectedBot = botName
  logPanel.log(`{green-fg}Bot "${botName}" starting with ${model} (supervised){/}`)
  refresh()
}

async function actStopBot() {
  const sv = supervisor.getState()
  const names = Object.keys(sv)
  if (!names.length) return modalMessage('{yellow-fg}No bots running.{/}')
  const items = names.map(n => ({ label: `${n} (${sv[n].model})`, value: n }))
  const name = await modalSelect('Stop which bot?', items)
  if (!name) return
  supervisor.stop(name)
  state.botStates.delete(name)
  if (state.selectedBot === name)
    state.selectedBot = Object.keys(supervisor.getState()).find(n => n !== name) || null
  logPanel.log(`{cyan-fg}Stopping ${name} (supervisor disabled){/}`)
  refresh()
}

async function actRestartBot() {
  const sv = supervisor.getState()
  const names = Object.keys(sv)
  if (!names.length) return modalMessage('{yellow-fg}No bots running.{/}')
  const items = names.map(n => ({ label: `${n} (${sv[n].model})`, value: n }))
  const name = await modalSelect('Restart which bot?', items)
  if (!name) return
  const { model } = sv[name]
  supervisor.stop(name)
  await new Promise(r => setTimeout(r, 1500))
  const logPath = path.join(LOG_DIR, `bot_${name}.log`)
  supervisor.launch(name, model, logPath, { fresh: true })
  state.selectedBot = name
  logPanel.log(`{green-fg}Bot "${name}" restarted (clean chain){/}`)
  refresh()
}

async function actSwitchBot() {
  const sv = supervisor.getState()
  const names = Object.keys(sv)
  if (!names.length) return modalMessage('{yellow-fg}No bots running.{/}')
  const items = names.map(n => ({
    label: n + (n === state.selectedBot ? ' (active)' : ''),
    value: n,
  }))
  const name = await modalSelect('Show which bot in status panel?', items)
  if (!name) return
  state.selectedBot = name
  refresh()
}

async function actListModels() {
  if (!appConfig) {
    return modalMessage('{red-fg}Not configured. Press [8] to run setup.{/}', 'red')
  }
  if (appConfig.llmMode === 'ollama') {
    const models = getOllamaModels()
    if (!models.length) {
      return modalMessage('{yellow-fg}No Ollama models installed.{/}\nPress [8] to run setup.', 'yellow')
    }
    const list = models.map(m => `  {green-fg}●{/} ${m}`).join('\n')
    await modalMessage(`{bold}Installed Ollama models:{/}\n\n${list}`, 'green')
  } else {
    const models = await fetchFeatherlessModels()
    if (!models.length) return modalMessage('{red-fg}Could not reach Featherless API.{/}', 'red')
    const list = models.slice(0, 15).map(m => `  {green-fg}●{/} ${m}`).join('\n')
    const more = models.length > 15 ? `\n{gray-fg}…and ${models.length - 15} more{/}` : ''
    await modalMessage(`{bold}Featherless models:{/}\n\n${list}${more}`, 'green')
  }
}

async function actReconfigure() {
  const cfg = await runOnboarding()
  if (cfg) {
    appConfig = cfg
    applyConfig(cfg)
    logPanel.log(`{green-fg}Reconfigured:{/} ${configSummary(cfg).replace(/\{[^}]+\}/g, '')}`)
    refresh()
  }
}

// ── World Settings ────────────────────────────────────────────────────────────
const WORLD_DEFS = [
  { key: 'gamemode',             label: 'Game Mode',      type: 'cycle',
    options: ['survival','creative','adventure','spectator'] },
  { key: 'difficulty',           label: 'Difficulty',     type: 'cycle',
    options: ['peaceful','easy','normal','hard'] },
  { key: 'pvp',                  label: 'PVP',            type: 'cycle', options: ['true','false'] },
  { key: 'hardcore',             label: 'Hardcore',       type: 'cycle', options: ['false','true'] },
  { key: 'level-type',           label: 'World Type',     type: 'cycle',
    options: ['minecraft:normal','minecraft:flat','minecraft:large_biomes','minecraft:amplified'] },
  { key: 'level-seed',           label: 'Seed',           type: 'text' },
  { key: 'generate-structures',  label: 'Structures',     type: 'cycle', options: ['true','false'] },
  { key: 'max-players',          label: 'Max Players',    type: 'num', min: 1,  max: 200 },
  { key: 'view-distance',        label: 'View Distance',  type: 'num', min: 3,  max: 32 },
  { key: 'allow-flight',         label: 'Allow Flight',   type: 'cycle', options: ['false','true'] },
  { key: 'spawn-monsters',       label: 'Spawn Monsters', type: 'cycle', options: ['true','false'] },
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
    items.push({ label: '── Cancel ──',        value: '__cancel__' })

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
      const val = await modalPrompt(
        `${def.label} (${def.min}-${def.max}, current: ${draft[def.key]})`, draft[def.key]
      )
      if (val !== null) {
        const n = parseInt(val.trim())
        if (!isNaN(n) && n >= def.min && n <= def.max) draft[def.key] = String(n)
        else await modalMessage(`{red-fg}Invalid — must be ${def.min}-${def.max}.{/}`, 'red')
      }
    }
  }
}

// ── Cleanup & quit ────────────────────────────────────────────────────────────
async function quit() {
  refresh('{yellow-fg}Shutting down...{/}')
  for (const name of Object.keys(supervisor.getState())) {
    supervisor.stop(name)
  }
  if (state.serverProc) {
    try { state.serverProc.kill('SIGTERM') } catch {}
  }
  await new Promise(r => setTimeout(r, 800))
  screen.destroy()
  process.exit(0)
}

// ── Key bindings ──────────────────────────────────────────────────────────────
screen.key(['1'], actStartServer)
screen.key(['2'], actStopServer)
screen.key(['3'], actSpawnBot)
screen.key(['4'], actStopBot)
screen.key(['5'], actRestartBot)
screen.key(['6'], actWorldSettings)
screen.key(['7'], actListModels)
screen.key(['8'], actReconfigure)
screen.key(['s'], actSwitchBot)
screen.key(['r'], () => refresh())
screen.key(['q', 'C-c'], quit)
screen.key(['tab'], () => screen.focusNext())

logPanel.key(['up','down','pageup','pagedown'], () => {})
logPanel.focus()

// ── Startup ───────────────────────────────────────────────────────────────────
refresh()
followEvents()
setInterval(() => renderHeader() || screen.render(), 1000)

logPanel.log(`{green-fg}embark-ai started.{/}  Minecraft ${MC_VERSION}`)
logPanel.log(`{gray-fg}Watching: ${EVENTS_FILE}{/}`)

async function startup() {
  appConfig = loadConfig()
  if (!appConfig) {
    logPanel.log('{yellow-fg}No configuration found — starting setup wizard...{/}')
    screen.render()
    await new Promise(r => setTimeout(r, 400))
    const cfg = await runOnboarding()
    if (cfg) {
      appConfig = cfg
      applyConfig(cfg)
      logPanel.log(`{green-fg}Configuration saved.{/}`)
    } else {
      logPanel.log('{yellow-fg}Setup cancelled. Press [8] to configure when ready.{/}')
    }
  } else {
    applyConfig(appConfig)
    const summary = appConfig.llmMode === 'ollama'
      ? `Ollama (${appConfig.ollamaModel})`
      : `Featherless API (${appConfig.featherlessModel || 'no model'})`
    logPanel.log(`{green-fg}Config loaded:{/} {bold}${summary}{/bold}`)
  }
  refresh()
}

process.on('SIGINT', quit)
process.on('SIGTERM', quit)

startup().catch(err => logPanel.log(`{red-fg}Startup error: ${err.message}{/}`))
