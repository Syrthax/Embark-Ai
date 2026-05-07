// logger.js — Structured JSONL event logger
//
// Writes one JSON object per line to events.jsonl alongside bot.js.
// Each event has: ts (ISO), level, event, ...data.
//
// Levels: trace, debug, info, warn, error, fatal
// Designed for postmortem reconstruction — the TUI dashboard reads from this file.

const fs   = require('fs')
const path = require('path')

const EVENTS_FILE = path.join(__dirname, 'events.jsonl')
const MAX_FILE_BYTES = 5 * 1024 * 1024  // 5MB rotation threshold

const botName = process.env.BOT_NAME || 'bot'
let stream = null

function openStream() {
  // Rotate if file > MAX_FILE_BYTES
  try {
    const st = fs.statSync(EVENTS_FILE)
    if (st.size > MAX_FILE_BYTES) {
      fs.renameSync(EVENTS_FILE, EVENTS_FILE + '.1')
    }
  } catch {}
  stream = fs.createWriteStream(EVENTS_FILE, { flags: 'a' })
  stream.on('error', err => console.error('[logger] stream error:', err.message))
}

function write(level, event, data = {}) {
  if (!stream) openStream()
  const record = {
    ts: new Date().toISOString(),
    bot: botName,
    level,
    event,
    ...data,
  }
  try {
    stream.write(JSON.stringify(record) + '\n')
  } catch (e) {
    // Last-resort fallback to stderr
    console.error('[logger] write error:', e.message, JSON.stringify(record))
  }
  // Mirror to console for live log tailing
  const tail = Object.keys(data).length > 0 ? ' ' + JSON.stringify(data) : ''
  if (level === 'error' || level === 'fatal') {
    console.error(`[${level}] ${event}${tail}`)
  } else if (level === 'warn') {
    console.warn(`[${level}] ${event}${tail}`)
  } else {
    console.log(`[${level}] ${event}${tail}`)
  }
}

const trace = (event, data) => write('trace', event, data)
const debug = (event, data) => write('debug', event, data)
const info  = (event, data) => write('info',  event, data)
const warn  = (event, data) => write('warn',  event, data)
const error = (event, data) => write('error', event, data)
const fatal = (event, data) => write('fatal', event, data)

module.exports = { trace, debug, info, warn, error, fatal, EVENTS_FILE }
