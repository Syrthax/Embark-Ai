// env.js — Minimal .env loader (zero deps)
// Looks up the project root by walking parent directories, loads .env if found.
// Existing process.env values take precedence (so CLI/TUI can override).

const fs   = require('fs')
const path = require('path')

function loadEnv() {
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, '.env')
    if (fs.existsSync(candidate)) {
      try {
        const content = fs.readFileSync(candidate, 'utf8')
        for (const rawLine of content.split('\n')) {
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
      return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) break  // reached filesystem root
    dir = parent
  }
  return null
}

module.exports = { loadEnv }
