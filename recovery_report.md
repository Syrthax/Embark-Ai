# Recovery Report — Automatic Fatal Desync Recovery

**Date:** 2026-05-08  
**Status:** Implemented  
**Phase:** Post-Phase-6 (Supervisor layer)

---

## What was implemented

### `botSupervisor.js` (NEW — project root)

A supervised lifecycle manager that wraps bot process spawning with:

- **Exit reason classification** — reads `exit_reason.json` from the bot directory on each exit, classifies the failure, and selects an appropriate base backoff delay:
  | Class | Base backoff |
  |---|---|
  | `entity_desync` | 3s |
  | `kicked` | 20s |
  | `crash` | 30s |
  | `server_disconnect` | 45s |
  | `unknown_clean` | 5s |
  | `unknown_dirty` | 30s |

- **Exponential backoff** — each consecutive failure in the same chain multiplies the delay by 2×, capped at 5 minutes. This prevents rapid reconnect storms on persistent failures.

- **Restart storm prevention** — if a bot restarts ≥5 times within a 10-minute sliding window, the supervisor halts respawn and fires `onStorm`. The operator must manually restart. Additional auto-restarts beyond this threshold make persistent failures worse, not better.

- **Recovery chain IDs** — each new chain (first launch or manual restart) mints a random 4-byte hex ID. The chain ID is passed to the bot process as `RECOVERY_CHAIN_ID` env var and threaded through all logs, making it trivial to correlate "which restart attempt produced which events" in `events.jsonl`.

- **Callbacks** — `onLog`, `onRespawn`, `onStorm` allow `cli.js` and `tui.js` to surface supervisor events in their UIs without coupling to the supervisor internals.

### `mc-server/bot/bot.js` (MODIFIED)

- **`exit_reason.json` writing** — each exit path now writes a JSON file before process.exit:
  - `bot.on('end')` → `entity_desync` if liveness was `LIVE_FATAL`, else `server_disconnect`
  - `bot.on('kicked')` → `kicked`
  - `process.on('uncaughtException')` → `crash`
  
  The supervisor reads and deletes this file on the next launch to classify the restart.

- **`RECOVERY_CHAIN_ID` logging** — if the `RECOVERY_CHAIN_ID` env var is set (injected by supervisor), it is logged in the `spawned` event and a dedicated `recovery_chain_active` event for easy grep in `events.jsonl`.

- **Post-spawn integrity check** — a 30-second polling interval confirms entity liveness reaches `LIVE_VALID` after spawn. If it doesn't within 30s, `spawn_integrity_fail` is logged. On successful restart from a desync, `spawn_integrity_ok` is logged with timing. This closes the loop: the supervisor can be extended to read this event to confirm the restart actually resolved the underlying condition.

### `cli.js` (MODIFIED)

- `spawnBotDirect` removed — replaced entirely by `supervisor.launch()`
- `spawnBot()` calls `supervisor.launch()` with `{ fresh: true }` 
- `stopBot()` calls `supervisor.stop()` — marks `manualStopping = true` so the supervisor does not respawn
- `restartBot()` stops + relaunches with a new chain ID (fresh log)
- Status `header()` uses `supervisor.getState()` — shows restart count, chain ID, respawn-pending indicator

### `tui.js` (MODIFIED)

- Same supervisor integration as `cli.js`
- Bot list in header shows `↺` counter for restarts and yellow `○` when awaiting respawn
- All `actSpawnBot`, `actStopBot`, `actRestartBot`, `actSwitchBot`, `quit()` use supervisor

---

## Failure classification logic

```
exit_reason.json present → use its .reason field
exit_reason.json absent + code 0 → unknown_clean
exit_reason.json absent + code ≠ 0 → unknown_dirty
```

`exit_reason.json` is consumed (deleted) by the supervisor on read, so stale files from a previous crash never mislead the next cycle.

---

## What remains intentionally outside this layer

- **Storm recovery** — after 5 restarts in 10 minutes the supervisor halts. Automatic recovery from a restart storm would require knowing *why* the storm happened (server down? version mismatch? config error?) — classifying that reliably is out of scope for this layer. The correct action is operator inspection.

- **Server-side recovery** — if the Minecraft server itself is down, the bot will cycle through `server_disconnect` → 45s backoff → reconnect attempts. This is correct behavior: the backoff grows exponentially so we don't hammer a restarting server.

- **`tui.js` supervisor.getState()` for `logPath`** — tui.js supervisor state does not currently expose `logPath` in `getState()`. The log path is reconstructed locally from `LOG_DIR + bot_${name}.log` on spawn/restart. This is acceptable because both sides use the same formula.

---

## How to trace a recovery chain in logs

```bash
# Find all events for chain 'a3f1b2c4'
grep '"chainId":"a3f1b2c4"' mc-server/bot/events.jsonl

# See the full restart sequence
grep '"msg":"supervisor' .cli-logs/supervisor.log  # if piped

# Confirm integrity check passed
grep '"spawn_integrity_ok"' mc-server/bot/events.jsonl
```
