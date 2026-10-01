// Continue through the game's normal Play again control, never its network internals.
// One request per completed match; re-check all guards when the delay expires.
export class ReplayQueue {
  constructor({ delayMs = 1000 } = {}) {
    this.delayMs = delayMs;
    this.match = null;
    this.due = null;
    this.requested = false;
    this.status = '';
  }

  tick(now, { agent, hidden = false, button = null }) {
    if (this.match !== agent.match) {
      this.match = agent.match; this.due = null; this.requested = false;
    }
    if (!agent.armed || agent.paused || (hidden && !agent.alwaysArmed) || agent.completed >= agent.matchLimit || !agent.endedCounted ||
        !['finished', 'crashed'].includes(agent.last?.phase)) {
      this.due = null; this.status = ''; return;
    }
    if (this.requested) { this.status = 'waiting for next game'; return; }
    this.due ??= now + this.delayMs;
    if (now < this.due) { this.status = 'next game shortly'; return; }
    // The widget disables this button when disconnected or already ready.
    if (!button?.isConnected || button.disabled || button.getAttribute('aria-disabled') === 'true' ||
        !button.getClientRects().length) {
      this.status = 'waiting for Play again'; return;
    }
    this.requested = true;
    this.status = 'waiting for next game';
    agent.log({ k: 'replay', now, match: this.match, completed: agent.completed, limit: agent.matchLimit });
    button.click();
  }
}
