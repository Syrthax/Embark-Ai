const fs = require('fs')
const path = require('path')

const MEMORY_FILE = path.join(__dirname, 'memory.json')

const EMPTY = {
  locations: [],   // { name, pos: {x,y,z}, timestamp }
  events: [],      // { type, data..., timestamp }
  knowledge: {},   // key-value facts
}

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return JSON.parse(JSON.stringify(EMPTY))
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
  } catch {
    return JSON.parse(JSON.stringify(EMPTY))
  }
}

function saveMemory(memory) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2))
}

function rememberLocation(memory, name, pos) {
  const entry = {
    name,
    pos: { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z) },
    timestamp: new Date().toISOString(),
  }
  const idx = memory.locations.findIndex((l) => l.name === name)
  if (idx >= 0) memory.locations[idx] = entry
  else memory.locations.push(entry)
  saveMemory(memory)
}

function rememberEvent(memory, type, data) {
  memory.events.push({ type, ...data, timestamp: new Date().toISOString() })
  if (memory.events.length > 50) memory.events = memory.events.slice(-50)
  saveMemory(memory)
}

function rememberKnowledge(memory, key, value) {
  memory.knowledge[key] = value
  saveMemory(memory)
}

function recallLocation(memory, name) {
  return memory.locations.find((l) => l.name === name) || null
}

module.exports = {
  loadMemory,
  saveMemory,
  rememberLocation,
  rememberEvent,
  rememberKnowledge,
  recallLocation,
}
