// Stateful controller between a snapshot source and an input sink. No DOM access here.
// Keeps authoritative (observed) state, desired action and last issued action separate.
import { decideTarget, PRESETS } from './policy.mjs';
import { decideCompetitive, COMPETITIVE_PRESETS } from './competitive.mjs';

export const OBJECTIVES = ['leaderboard', 'competitive', 'cash', 'win', 'repro-cash', 'repro-win'];
export const normalizeMatchLimit = n => Math.max(1, Math.min(50, Math.trunc(Number(n)) || 1));

// Allowlisted, player-visible fields only. Nothing else from the snapshot is retained.
export function extractObservation(snap) {
  const g = snap?.game, p = snap?.player;
  if (!g || (p !== 0 && p !== 1)) return null;
  const me = g.labs?.[p], op = g.labs?.[1 - p];
  if (!me || !op) return null;
  return {
    match: `${snap.room}:${snap.match}`,
    t: g.t, phase: g.phase, safety: g.safety, hazard: g.hazard,
    own: { position: me.position, speed: me.speed, deployed: me.deployed, held: me.held, cash: me.cash, profit: me.profit, score: g.scores?.[p] ?? null },
    opponent: { deployed: op.deployed, cash: op.cash, profit: op.profit, score: g.scores?.[1 - p] ?? null },
  };
}

const pct = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
export const summarize = xs => ({ n: xs.length, median: pct(xs, .5), p95: pct(xs, .95), p99: pct(xs, .99), max: xs.length ? Math.max(...xs) : null });

export class Agent {
  constructor({ objective = 'leaderboard', matchLimit = 1, staleMs = null, traceLimit = 200000, policyParams = null } = {}) {
    this.objective = objective;
    this.policyParams = policyParams ? { ...policyParams } : null;
    this.matchLimit = normalizeMatchLimit(matchLimit);
    this.staleMsOverride = staleMs;
    this.traceLimit = traceLimit;
    this.armed = false;
    this.completed = 0;
    this.results = [];
    this.reason = 'disarmed on load';
    this.trace = [];
    this.stats = { interArrival: [], ackMs: [], ackGame: [], stale: 0, duplicates: 0, outOfOrder: 0, missedIntervals: 0, rejected: 0 };
    this.resetMatch(null);
  }

  resetMatch(match) {
    this.match = match;
    this.history = [];
    this.frameGaps = [];
    this.recentAckGame = [];
    this.lastIssued = false;
    this.lastResync = null;
    this.last = null;          // last accepted observation
    this.lastRecv = null;      // monotonic ms of last accepted snapshot
    this.desired = false;
    this.pending = null;       // issued input awaiting observed effect
    this.decision = null;
    this.endedCounted = false;
    this.participated = false;
    this.paused = false;
    this.freshSnapshots = 0;
  }

  get staleMs() {
    if (this.staleMsOverride) return this.staleMsOverride;
    const p = pct(this.stats.interArrival.slice(-300), .95);
    return Math.max(250, 4 * (p ?? 67));
  }

  log(e) { if (this.trace.length < this.traceLimit) this.trace.push(e); }

  arm(now) {
    if (this.completed >= this.matchLimit) { this.reason = `match limit ${this.matchLimit} reached`; return false; }
    if (['running', 'settling'].includes(this.last?.phase)) this.participated = true;
    this.armed = true; this.reason = 'armed'; this.log({ k: 'arm', now, objective: this.objective });
    return true;
  }

  setMatchLimit(n, now) {
    this.matchLimit = normalizeMatchLimit(n);
    return this.armed && this.completed >= this.matchLimit ? this.disarm(now, `match limit ${this.matchLimit} reached`) : null;
  }

  // Returns the input the adapter must issue (always a release) or null.
  disarm(now, reason = 'user stop') {
    const was = this.armed;
    this.armed = false; this.paused = false; this.freshSnapshots = 0; this.desired = false; this.reason = reason;
    this.log({ k: 'disarm', now, reason });
    return was || this.lastIssued ? this.issue(false, now, reason) : null;
  }

  issue(held, now, reason) {
    this.lastIssued = held;
    this.seq = (this.seq || 0) + 1;
    // Retrying the same command must not restart its acknowledgement timer.
    const retryOf = this.pending?.held === held ? this.pending.seq : null;
    if (retryOf == null) this.pending = { seq: this.seq, held, now, t: this.last?.t ?? null };
    this.log({ k: 'input', now, seq: this.seq, held, t: this.last?.t ?? null, reason, retryOf });
    return { held, seq: this.seq, reason };
  }

  // Called for each snapshot delivered to the game's render boundary.
  onSnapshot(snap, now) {
    const o = extractObservation(snap);
    if (!o) { this.stats.rejected++; return this.armed ? this.disarm(now, 'malformed snapshot') : null; }
    if (o.match !== this.match) { this.resetMatch(o.match); this.log({ k: 'match', now, match: o.match }); }
    if (this.last) {
      // A forfeit can finish at the same game time as the previous running state.
      if (o.t === this.last.t && o.phase === this.last.phase) { this.stats.duplicates++; return null; }
      if (o.t < this.last.t) { this.stats.outOfOrder++; return null; }
    }
    if (this.lastRecv != null) {
      const gap = now - this.lastRecv;
      if (this.paused && gap > this.staleMs) this.freshSnapshots = 0;
      this.stats.interArrival.push(gap);
      if (gap > 2.5 * (pct(this.stats.interArrival.slice(-300), .5) || 67)) this.stats.missedIntervals++;
    }
    if (this.last) {
      this.frameGaps.push(Math.round((o.t - this.last.t) * 60));
      if (this.frameGaps.length > 60) this.frameGaps.shift();
    }
    this.last = o; this.lastRecv = now;
    if (this.armed && ['running', 'settling'].includes(o.phase)) this.participated = true;
    this.history.push({ t: o.t, safety: o.safety, opponent: o.opponent.deployed });
    if (this.history.length > 64) this.history.splice(0, this.history.length - 32);

    // Acknowledge the pending input once the observed held state matches it.
    if (this.pending && o.own.held === this.pending.held) {
      const ms = now - this.pending.now;
      this.stats.ackMs.push(ms);
      if (this.pending.t != null) {
        const dt = o.t - this.pending.t;
        this.stats.ackGame.push(dt);
        if (o.phase === 'running' && dt > 0) {
          this.recentAckGame.push(dt);
          if (this.recentAckGame.length > 40) this.recentAckGame.shift();
        }
      }
      this.log({ k: 'ack', now, seq: this.pending.seq, t: o.t, ms });
      this.pending = null;
    }

    const entry = { k: 'obs', now, objective: this.objective, t: o.t, phase: o.phase, S: o.safety, x: o.own.position, v: o.own.speed,
      dep: o.own.deployed, held: o.own.held, opp: o.opponent.deployed, cash: o.own.cash, oppCash: o.opponent.cash, hz: o.hazard };

    if (o.phase !== 'running') {
      if (['finished', 'crashed'].includes(o.phase) && !this.endedCounted && this.participated) {
        this.endedCounted = true; this.completed++;
        this.results.push({ match: this.match, objective: this.objective, phase: o.phase,
          cash: o.phase === 'crashed' ? 0 : o.own.score ?? o.own.cash,
          opponentCash: o.phase === 'crashed' ? 0 : o.opponent.score ?? o.opponent.cash });
        this.log({ k: 'end', now, phase: o.phase, cash: o.own.cash, oppCash: o.opponent.cash, hazard: o.hazard });
      }
      if (['finished', 'crashed'].includes(o.phase)) { this.paused = false; this.freshSnapshots = 0; }
      this.log(entry);
      if (this.armed && this.completed >= this.matchLimit && ['finished', 'crashed'].includes(o.phase))
        return this.disarm(now, `match limit ${this.matchLimit} reached`);
      if (this.lastIssued) return this.issue(false, now, 'phase ' + o.phase);
      return null;
    }
    if (!this.armed) { this.log(entry); return null; }
    if (this.paused) {
      // Recover from a transient stall only after two advancing snapshots arrive.
      // Explicit Stop, hidden-page and malformed-state disarms never auto-resume.
      if (++this.freshSnapshots < 2) { this.log(entry); return null; }
      this.paused = false; this.freshSnapshots = 0;
      this.log({ k: 'resume', now, reason: 'fresh snapshots restored' });
    }

    const competitive = COMPETITIVE_PRESETS[this.objective] && { ...COMPETITIVE_PRESETS[this.objective], ...this.policyParams };
    const params = PRESETS[this.objective];
    if (!competitive && !params) return this.disarm(now, 'unknown objective');
    // Compensated presets look ahead one observed decision interval (frames between snapshots).
    const cadence = Math.max(1, Math.min(12, pct(this.frameGaps, .5) ?? 5));
    const lookahead = competitive ? cadence : params.lookahead > 0 ? cadence : 0;
    // Ack delay includes waiting for the next snapshot. Subtract half an interval;
    // this is an estimate of observation-to-input effect delay, not an exact RTT.
    const delayFrames = Math.max(0, Math.min(30, (pct(this.recentAckGame, .5) ?? (7 + cadence / 2) / 60) * 60 - cadence / 2));
    const pendingFrames = this.pending?.t != null ? Math.max(0, delayFrames - (o.t - this.pending.t) * 60) : 0;
    const state = { held: this.lastIssued, history: this.history, lookahead };
    const d = competitive ? decideCompetitive(o, { ...state, params: competitive, delayFrames, pendingFrames }) : decideTarget(o, { ...state, params });
    this.decision = d; this.desired = d.held; this.reason = d.reason;
    entry.desired = d.held; entry.look = lookahead; entry.stop = d.stop; entry.target = d.target; entry.slope = d.slope;
    if (competitive) {
      entry.delayFrames = delayFrames; entry.pendingFrames = pendingFrames; entry.predictedOpponent = d.predictedOpponent;
      entry.predictedSafety = d.predictedSafety; entry.opponentSpeed = d.opponentSpeed;
    }
    this.log(entry);
    if (d.held !== !!this.lastIssued) return this.issue(d.held, now, d.reason);
    return null;
  }

  // Periodic service: staleness, hidden page, and reconciling UI held state with the issued state.
  // uiHeld: the accelerator state the page UI currently shows (null if unknown).
  tick(now, { hidden = false, uiHeld = null } = {}) {
    if (!this.armed) return null;
    if (hidden) return this.disarm(now, 'page hidden');
    if (this.lastRecv != null && this.last?.phase === 'running' && now - this.lastRecv > this.staleMs) {
      this.freshSnapshots = 0;
      if (this.paused) return null;
      this.stats.stale++; this.paused = true; this.desired = false;
      this.reason = `paused: stale state (${Math.round(now - this.lastRecv)} ms)`;
      this.log({ k: 'pause', now, reason: this.reason });
      return this.issue(false, now, this.reason);
    }
    if (this.paused) return null;
    if (uiHeld != null && this.last?.phase === 'running' && uiHeld !== !!this.lastIssued &&
        now - Math.max(this.pending?.now ?? -Infinity, this.lastResync ?? -Infinity) > 50) {
      this.lastResync = now;
      this.log({ k: 'resync', now, uiHeld, want: !!this.lastIssued });
      return this.issue(!!this.lastIssued, now, 'resync UI');
    }
    return null;
  }

  latency() {
    return { snapshotIntervalMs: summarize(this.stats.interArrival), inputAckMs: summarize(this.stats.ackMs),
      inputAckGameSec: summarize(this.stats.ackGame), stale: this.stats.stale, duplicates: this.stats.duplicates,
      outOfOrder: this.stats.outOfOrder, missedIntervals: this.stats.missedIntervals, rejected: this.stats.rejected };
  }

  performance() {
    const games = this.results.length;
    return { games, averageCash: games ? this.results.reduce((sum, r) => sum + r.cash, 0) / games : null,
      wins: this.results.filter(r => r.phase === 'finished' && r.cash > r.opponentCash).length,
      crashes: this.results.filter(r => r.phase === 'crashed').length };
  }
}
