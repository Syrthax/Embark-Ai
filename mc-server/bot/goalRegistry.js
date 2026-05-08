// goalRegistry.js — Encapsulates state.goal mutations.
// Every transition is logged with source, previous goal, and reason.
// Invariant violations are logged loudly but still proceed — the mutation
// is not blocked, which avoids introducing new failure modes during the refactor.

const COMBAT_GOALS = new Set(['attacking'])

module.exports = function createGoalRegistry(state, getOwnership, log) {
  // getOwnership() → { taskBusy, currentTaskToken }

  function setGoal(name, meta = {}) {
    const prev = state.goal
    const { source = 'unknown', token = null, reason = null } = meta
    const { taskBusy, currentTaskToken } = getOwnership()

    // Invariant: 'following' must not overwrite active combat
    if (name === 'following' && COMBAT_GOALS.has(prev)) {
      log.warn('invariant_violation', {
        violation: 'follow_overwrites_combat',
        prev, next: name, source,
        ...(reason && { reason }),
      })
    }

    // Invariant: goal should not be set to a task name when no task is active
    // (source 'task_start' is exempt — taskBusy is set the line before setGoal is called)
    if (name !== 'idle' && name !== 'following' && name !== 'resting' &&
        source !== 'task_start' && !taskBusy) {
      log.warn('invariant_violation', {
        violation: 'task_goal_without_active_task',
        next: name, source, taskBusy,
        ...(reason && { reason }),
      })
    }

    log.debug('goal_transition', {
      prev,
      next: name,
      source,
      taskBusy,
      ...(reason && { reason }),
      ...(token && { token: token.toString() }),
    })

    state.goal = name
  }

  return { setGoal }
}
