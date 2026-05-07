# 🧠 Minecraft Multi-Agent AI System (Local-First)

You are my **senior engineering assistant**.

We are building a **local-first multi-agent AI system inside Minecraft**.

Your job is to:
- Break the system into clean, executable phases
- Implement ONLY the current phase
- Avoid overengineering or jumping ahead

---

## 🎯 PROJECT GOAL

Build a system where:
- Minecraft bots act as autonomous agents
- Each agent has memory, decision-making, and goals
- Agents can interact with the player via chat
- Agents are NOT slaves — they can accept/reject commands
- Everything runs locally (LLM + agents + server for now)

### Tech Constraints
- Node.js
- Mineflayer (Minecraft bots)
- Local LLM via Ollama (later phase)
- JSON-based memory (initially, no vector DB)

---

## ⚠️ STRICT RULES

1. DO NOT implement future phases early  
2. DO NOT introduce complex frameworks  
3. KEEP everything minimal and working  
4. Every phase must be:
   - Runnable
   - Testable
   - Cleanly structured  
5. Prefer simple functions over abstractions  

---

## 🧱 PHASE PLAN (MANDATORY)

### Phase 1 — Environment Setup
**Goal:**
- Local Minecraft server runs
- Single Mineflayer bot joins
- Bot can move randomly

**Deliverables:**
- Setup steps
- Working `bot.js`
- Run instructions

---

### Phase 2 — Perception + Control
**Goal:**
Bot can:
- Detect nearby blocks
- Detect player
- Look at player
- Follow player (basic)

---

### Phase 3 — Command System
**Goal:**
- Bot reads Minecraft chat
- Parses simple commands:
  - "follow me"
  - "stop"
- Executes commands reliably

---

### Phase 4 — Agent State System
**Goal:**
Introduce internal state:
- hunger
- energy
- goal

Behavior must change based on state.

---

### Phase 5 — Memory System (IMPORTANT)
**Goal:**
- Implement structured `memory.json`
- Store:
  - locations
  - events
  - knowledge

Add:
- `saveMemory()`
- `loadMemory()`
- Selective memory writing

---

### Phase 6 — Decision Engine (No LLM yet)
**Goal:**
- Agent loop:
sense → decide → act
- Rule-based decisions
- Command override system

---

### Phase 7 — LLM Integration (Ollama)
**Goal:**
- LLM decides high-level actions
- Code executes actions
- Prompt includes:
- Current state
- Relevant memory

---

### Phase 8 — Multi-Agent System
**Goal:**
- 2–3 agents
- Shared memory or communication
- Role-based behavior

---

## 🧠 OUTPUT FORMAT

For each phase, you MUST provide:

1. Short explanation (max 5 lines)
2. Exact folder structure
3. Working code (NO pseudocode)
4. Run instructions
5. Test checklist

---

## 🚫 DO NOT

- Use TypeScript (keep JavaScript simple)
- Add databases yet
- Add UI/dashboard
- Add Docker or cloud setup
- Mention future phases while coding current phase

---

## ✅ EXECUTION INSTRUCTION

Start with:

> **Phase 1 only**

After completing Phase 1:
- STOP
- Wait for my confirmation before continuing
# prompt 2
You are my senior AI systems engineer.

We have already built a Minecraft agent using Mineflayer + a local LLM (6B via Ollama).
The system works, but has two critical issues:

1. Hallucination:
    * Agent invents facts not present in environment
    * Makes incorrect assumptions about nearby resources
2. Weak Autonomy:
    * Sometimes blindly obeys commands
    * Sometimes refuses randomly without structured reasoning
    * No consistent decision-making process

⸻

🎯 YOUR TASK

Refactor the system to enforce:

* Grounded reasoning (no hallucination)
* Structured decision-making
* Strong but believable autonomy

⸻

⚠️ CONSTRAINTS

* Keep everything in Node.js
* Keep Mineflayer
* Keep local LLM (Ollama)
* DO NOT add external frameworks
* DO NOT overengineer
* DO NOT rewrite entire project

You must MODIFY and IMPROVE the existing architecture.

⸻

🧠 REQUIRED FIXES

1. Introduce a Decision Engine Layer

Create a clean pipeline:

sense → build_state → retrieve_memory → decide → act → remember

Separate:

* LLM reasoning
* action execution

⸻

2. Enforce Structured LLM Output

* LLM MUST return strict JSON:
    {
    decision: “accept | reject | delay”,
    reason: string,
    action: string,
    say: string
    }
* Add validation layer:
    * If output is invalid → fallback to safe behavior
    * NEVER execute raw text

⸻

3. Grounding System (Anti-Hallucination)

Before sending prompt to LLM:

* Only include:
    * nearby blocks (limited, e.g., top 5 closest)
    * visible entities
    * actual inventory
* Explicitly REMOVE:
    * any inferred or assumed data

Add a helper:

* buildGroundedState(bot)

⸻

4. Command Evaluation System

Implement logic BEFORE LLM:

* classify player message into intent:
    * follow
    * gather
    * build
    * unknown

Then LLM decides:

* accept / reject / delay

⸻

5. Autonomy Layer

Add internal state:

* hunger
* energy
* current goal

Decision priority:

1. survival
2. current goal
3. player command

⸻

6. Memory Refactor

Replace raw logs with structured memory:

memory.json:
{
locations: {},
knowledge: [],
events: []
}

Add:

* saveMemory()
* loadMemory()
* store only important events

⸻

7. Safe Action Mapping

Map LLM output → actual functions:

Example:
“follow player” → bot pathfinder
“mine wood” → mining function

If action unknown → ignore safely

⸻

📦 OUTPUT REQUIREMENTS

Provide:

1. Updated folder structure
2. Refactored code files:
    * agent loop
    * decision engine
    * state builder
    * memory manager
3. Clear explanation of flow (max 10 lines)
4. Example LLM prompt used internally
5. Example run scenario

⸻

🚫 DO NOT

* Add UI
* Add database
* Add cloud infra
* Use TypeScript
* Skip validation
* Let LLM directly control movement

⸻

✅ START

Refactor the system step-by-step.
Keep code minimal but correct.
Focus on reliability over features.