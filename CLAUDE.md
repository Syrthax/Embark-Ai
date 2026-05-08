# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

project-k is **Ember** — an autonomous Minecraft agent built on Mineflayer + Featherless AI. No TypeScript, no databases. Two independent npm packages: the root CLI/TUI and the bot itself.

## Running the Project

### Recommended: CLI control panel
```bash
node cli.js        # interactive: start server, spawn bots, tail logs
# or
node tui.js        # blessed TUI variant (same features, terminal UI)
```

### Manual start
```bash
# Terminal 1 — Minecraft server
cd mc-server && java -Xmx2G -jar server.jar nogui

# Terminal 2 — bot (default name=Ember, model=qwen2.5-coder:14b)
cd mc-server/bot && npm start

# Override per-bot env vars
BOT_NAME=Flint npm start
```

### Install dependencies
```bash
npm install                        # root (blessed for CLI/TUI)
cd mc-server/bot && npm install    # bot (mineflayer + pathfinder + pvp)
```

## Architecture

### Request pipeline (bot.js orchestrates)
```
chat message
  → detectInsult() / engine.classifyIntent()
  → evaluateSurvival()          ← short-circuits LLM if exhausted
  → state.buildGroundedState()  ← real Mineflayer sensor data only
  → llm.queryLLM()              ← Featherless AI, strict JSON output
  → engine.validateLLMOutput()  ← schema check → safeDefault() on failure
  → executeAction()             ← LLM never controls pathfinder directly
```

### Source files (`mc-server/bot/`)
| File | Responsibility |
|------|---------------|
| `bot.js` | Main loop, action execution, pathfinder tasks, self-defense |
| `engine.js` | Intent classifier (regex pre-LLM), survival check, LLM validation, anger/insult detection, `safeDefault()` |
| `state.js` | `buildGroundedState()` — pulls real inventory, nearby blocks, entities from Mineflayer APIs |
| `llm.js` | Featherless AI integration, prompt builder, JSON parser; outputs `{decision, reason, action, say}` |
| `memory.js` | `memory.json` persistence — locations, events, knowledge key-values |
| `logger.js` | Structured log output |
| `env.js` | Environment variable defaults |

### Background loops (always running in bot.js)
- `entityHurt` listener → identify attacker → fight back
- Threat loop (2.5s) → auto-engage hostile mobs within 10 blocks
- Anger decay (1s) — insults add 1, hits add 4, decays 0.05/s; warn at 3, attack at 5
- State loop (1s) → energy/hunger drain, autonomous goal selection
- Agent loop (250ms) → look-at player, follow, water survival

### LLM output schema
```json
{ "decision": "accept|reject|delay", "reason": "...", "action": "follow|stop|explore|gather_wood|go_to|remember_here|none", "say": "..." }
```
Invalid outputs fall back to `safeDefault(intent)`. The LLM never receives movement control — only picks an action label.

### CLI/TUI (`cli.js` / `tui.js`)
Manages child processes for the Minecraft server and one or more bots. Logs go to `.cli-logs/`. Only tracks processes it spawned — externally started servers are invisible to it.

## Key Design Constraints

- **Anti-hallucination** — `buildGroundedState()` only returns verified Mineflayer data. The LLM prompt explicitly forbids inventing facts.
- **Survival is hardcoded** — energy, exhaustion, water survival, and threat reaction live outside the LLM path entirely.
- **Errors surface in-game** — every task wraps in try/catch and calls `bot.chat("Error: ...")`.

## Environment Variables

| Variable | Default |
|----------|---------|
| `BOT_NAME` | `Ember` |
| `SERVER_HOST` | `localhost` |
| `SERVER_PORT` | `25565` |
| `MC_VERSION` | `1.21.4` |
