# PACE bot

A local, inspectable controller for [Paradigm's PACE](https://www.paradigm.xyz/research/pace/). Every per-action decision is a pure local JavaScript function: no model calls or network inference.

## Install (Chrome, one time)

1. `npm run build` (writes `extension/pace-bot.js` from `src/`; a built copy is already there).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
3. Open https://www.paradigm.xyz/research/pace/. A small **PACE bot · v0.6.0** panel appears at the bottom right, **automatically armed**.

After updating the code, reload the extension at `chrome://extensions` and refresh the game tab **between games**. The v0.6.0 label confirms the new build is loaded. Editing or rebuilding local files does not hot-reload an already-open game tab. A refresh resets the run count and match limit to 999 and automatically arms the bot. Set a lower limit if desired before joining a game.

The extension has no permissions. It only runs on `paradigm.xyz/research/pace*`, as one main-world content script. It never reads cookies, tokens, or network traffic, and your existing login session is left alone.

## Use

1. The live bot always optimizes **average final cash per game**, including catastrophe zeros. There is no policy dropdown or objective-switching API. It automatically selects **@egornomic cash** for that exact game-provided account, and **general** for other/unknown opponents. Candidate selection is based on expected own cash, not wins. The general controller retains v0.4's relative-cash heuristic because removing it lowered expected cash in validation; the dedicated profile has no win bonus. Historical win-focused and legacy presets remain available only to offline evaluators. The internal/exported objective name remains `leaderboard` for compatibility.
2. The bot is always armed until the match limit is reached (**1–999, default 999**). There are no Start/Stop buttons or live arm/stop API, and Esc does not disarm it. Start or join the first game on the page. After each game, including a catastrophe, the bot clicks the game's **Play again** button after a one-second delay if the limit has not been reached. This uses the site's normal matchmaking/rematch flow and waits when its button is disabled or unavailable. It requests each next game only once. In a private room, the opponent must also ready up.
3. Switching tabs or hiding the page no longer disarms the bot or blocks autoplay. Stale or malformed snapshots and adapter errors **pause** and release input without disabling play; two fresh advancing snapshots restore play automatically. Actual page navigation/suspension releases input too, and a restored page recovers automatically. Browser throttling or suspension can still interrupt timely play; background operation is not a guarantee of uninterrupted updates. To end a run, close the game tab, or lower the limit to the completed count (minimum 1). An already-pending matchmaking request must be cancelled using the game's Cancel control. To prevent automatic control on future page loads, disable the extension and reload/close existing game tabs.
4. **Export trace** downloads observations, decisions, inputs and acknowledgments, plus latency percentiles. Detailed events are capped at 200,000 per page session; terminal results and cash/game accounting continue through all games, including a full 999-game run.
5. **run cash / game** shows mean terminal score for games the bot participated in during this page session, including zero-score crashes and forfeits. A game still counts if it finishes after a pause or a limit change, provided the terminal snapshot arrives. It includes practice games and resets on page reload; it is not your account's all-time ranked average. The export includes those results for analysis.
6. The limit is the total completed-game count for this page session, not an additional-game count. At the limit, the panel shows **LIMIT REACHED** and no further games are requested. Raising the limit automatically resumes the run without resetting the count. Lowering the limit to the completed count releases input and cancels any next-game click that has not happened yet.

Don't hold Space yourself while the bot is armed, because you share one accelerator.

The offline tests include the generated extension running against a simulated DOM/timer environment: automatic arming, background play and replay, exact stopping after 999 games, limit-change cancellation/resumption, stale/malformed-state recovery, and page suspension/restoration. No live matchmaking is exercised by these tests. Manual arming/disarming remains available in the core agent only for offline tests and evaluators.

## How it works

- **Observation.** It wraps `customElements.get('pace-game').prototype.showMatch`, keeping `this`, the arguments, the return value and the original behavior. After the original render it copies an allowlist of player-visible fields into the agent (`src/agent.mjs: extractObservation`), including the other seat's public account type and username. The catastrophe threshold, RNG state and hidden opponent research are never read.
- **Input.** It dispatches `keydown`/`keyup` Space on the `pace-game` host, which is the same path a physical Space press takes. The widget's own handler runs its blocked, phase and dialog checks, then emits `pace:input` to the session. The agent checks the UI's `#accelerator[aria-pressed]` and the game's observed `held` against what it last issued, and resyncs if they differ.
- **Online policy** (`src/competitive.mjs`). Predicts frontier progress and opponent deployment from recent public observations, accounting for the game's two-second deployment lag. Scores candidate research targets using the public profit and catastrophe formulas. Risk is charged against accumulated cash and projected future earnings; competitive pressure increases when behind and relaxes when comfortably ahead. Forecasts are estimates, not knowledge of hidden research or future frontier changes.
- **Timing.** New policies project motion over estimated observation-to-command-effect delay, then check the stopping point after one further decision interval. Delay is estimated from input acknowledgements in game time, subtracting half a snapshot interval for sampling delay; it starts at seven frames and is bounded at thirty. Acknowledgement timing is not an exact network RTT. Retries retain their original timestamp, and timing/command state resets each match.
- **Legacy policy** (`src/policy.mjs`). Retains the original CPU-tuned target tracker for comparison. It does not use the new economic target or adaptive delay horizon.

## Opponent-specific cash routing (v0.5.1)

v0.5.1 corrects the account spelling from `@ergonomic` to `@egornomic`; the former no longer selects the dedicated profile.

The automatic selector checks `snapshot.players[1 - snapshot.player]`. Only `kind: 'twitter'` with the exact case-normalized `username: 'egornomic'` selects `egornomic-cash-v1`. A guest named `@egornomic`, a similar username, a display name, or the user's own account cannot trigger it. This uses the public account metadata the game uses to render its `@username` label, not cookies, authentication tokens, network interception, or a claim that the opponent is a bot. It is handle-based, not an immutable account-ID match; a changed handle falls back to general.

The dedicated profile is exactly the frozen `forecast20` cash-only candidate below: a two-second frontier forecast, `winWeight: 0`, and the existing catch-up cap, latency compensation and deadline handling. It is selected for the reported recurring opponent, **not** promoted to all matchups. General play retains v0.4. The live objective is fixed to cash/game; routing chooses the research policy automatically. This is the best-supported policy choice from the current comparisons, not a guarantee of a globally optimal strategy.

The panel displays the detected opponent and selected profile. Identity is cleared at every new match. Once observed, identity survives metadata-free deltas within the same match; explicit invalid/guest/changed metadata clears or updates it. Duplicate and out-of-order snapshots cannot change the profile. Missing identity at the start of a match selects general, without blocking play.

Version 3 trace exports record opponent identity, profile changes, each observation's selected profile, and terminal results with all profiles selected during participation. Older traces lack account identity: attribution of those matches to `@egornomic` comes from the user's report, not verified identifiers in those files. Their replay gains are promising but **not** live proof that the dedicated profile improves this account's long-run cash/game. New exports allow that attribution to be checked. Replay analysis respects recorded identity; anonymous older paths still need explicit candidate parameters for comparisons.

The generated-bundle tests cover the absence of a policy selector, the fixed cash objective, switching to the dedicated profile, returning to general on autoplay, panel/export state, and the match limit. No browser reload or live matchmaking was performed during implementation. Reload between games to use v0.6.0; routing needs no manual policy selection.

## Cash-only experiments and selection evidence

The optimization criterion is **mean terminal own cash per game**, including zero-score catastrophes. Winning, score margin, and the opponent's cash are not selection criteria. Opponent research still matters because it affects our profit and shared catastrophe risk. A lower win rate is acceptable when expected own cash increases.

`sim/cash.mjs` tests cash-only candidates with `winWeight: 0` against a fully specified v0.4 reference. Eighteen candidates were explored on eight tuning seeds (LCG indices 11000–11007), both latency conditions, and the two online trace exports. Five configurations were then frozen before running **3,200 held-out simulations**: 40 fresh seeds (12000–12039), eight opponent styles, two latency conditions. These validation seeds were not used for further tuning.

| Expected cash / game | Frozen v0.4 | Remove win bonus only | Cash-only, 1.5s forecast | Cash-only, 2s forecast | Cash-only, 2s + slowdown |
|---|---:|---:|---:|---:|---:|
| Normal simulated timing | $12.78B | $12.51B | $12.82B | $12.52B | $12.73B |
| Higher delay + 5% snapshot loss | $12.51B | $12.29B | $12.40B | $11.92B | $12.28B |
| Older trace: 14 complete paths | $13.47B | $12.96B | $13.67B | $13.98B | $13.90B |
| Newest trace: 6 complete paths | $12.98B | $12.51B | $12.94B | $13.13B | $13.00B |

Removing the bonus alone reduces expected cash by $276M/game at normal timing (paired 95% interval: -$380M to -$171M) and $221M under higher delay (-$312M to -$130M). The two-second cash-only forecast looks better against the recorded opponent paths but worse across the equal-weight synthetic mix: -$264M and -$594M, respectively. The small +$38M result for the 1.5-second forecast at normal timing has an interval spanning zero. **No challenger replaces the general fallback.** v0.5 routes only the reported recurring account to the two-second cash-only candidate. Choice of target opponent population matters; these results do not establish a universal best policy.

The trace paths were used during development, keep opponent actions fixed, and are not independent validation. Five early-catastrophe paths are retained in the reports but excluded from full-length replay averages because their unseen endings cannot be reconstructed. This does **not** exclude catastrophes from the live cash/game metric or from simulated expected cash. The simulations integrate survival probability as `exp(-hazard)` and count catastrophe cash as zero. Their opponent mix is not a measured distribution of online players.

Optional experimental parameters, both disabled in the default, are `slowdownFactor` (dampen extrapolation using a shorter observed slope) and `deploymentForecastBoost` (extend the forecast when recent opponent deployment has a positive frontier offset). Both use only past public observations, not hidden research. The adaptive variants did not improve both trace sets and are not promoted.

Evidence is saved in `runs/cash-tuning.json`, `runs/cash-tuning-slowdown.json`, `runs/cash-tuning-adaptive.json`, and `runs/cash-validation.json`. Reproduce the three tuning stages with `npm run eval:cash -- tune-basic 8`, `tune-slowdown 8`, or `tune-adaptive 8`, followed by an output path and optional trace paths. Validate with:

```sh
npm run eval:cash -- validate 40 runs/cash-validation.json /path/to/older-trace.json /path/to/newest-trace.json
```

No live games were played or browser tabs reloaded during this investigation. v0.5 added the account-specific routing above without changing general strategy or cash accounting; v0.6 adds always-armed operation as described under Use.

## Opponent-aware cap and endgame (v0.4)

Leaderboard now permits its research target to reach the opponent's **already-deployed** research when that exceeds the normal cap of predicted frontier + 2. A speculative opponent forecast cannot unlock this exception. Catching up to known deployment need not raise the shared maximum driving catastrophe risk, but inertia, forecast errors, and an opponent reacting differently still matter. This is not a guarantee of zero additional risk.

Over the last six seconds of acceleration, the frontier forecast gradually extends from one second to the two-second deployment horizon. The stopping calculation also accounts for the engine zeroing speed at 90 seconds: it no longer brakes for coasting that cannot occur beyond that cutoff. Commands predicted to arrive after the cutoff cannot request acceleration. Win-focused is unchanged, as are autoplay and Stop behavior.

`runs/finish-validation.json` compares frozen v0.3.1, catch-up alone, v0.4, and v0.2 over **2,560 simulations**: 40 fresh seeds (LCG indices 9000–9039), eight opponent styles, and two latency conditions. The new stress mix adds sustained and late aggressive escalations, so its absolute scores should not be compared directly with older benchmark mixes. Tuning used seeds 8000–8007 and the v0.3.1 traces; the validation seeds were not used for tuning.

| Timing | v0.3.1 expected cash | Catch-up only | v0.4 | v0.4 gain over v0.3.1, paired 95% interval |
|---|---:|---:|---:|---:|
| Normal | $12.57B | $12.81B | $12.88B | +$0.31B [$0.28B, $0.34B] |
| Higher delay + 5% snapshot loss | $12.30B | $12.55B | $12.60B | +$0.31B [$0.27B, $0.34B] |

The endgame changes add about $66M/game at normal latency and $57M/game under higher latency beyond catch-up alone. Survival changes from 73.28% to 73.18% and 71.44% to 71.27%, respectively: this is a modest expected-cash improvement, not a claim of reduced overall catastrophe risk. Intervals group games by frontier seed before averaging opponent styles.

The 14 full-length recorded-path replays improve from $13.09B to $13.47B expected cash. Game 11 improves from about $7.69B to $12.40B cash conditional on survival, while game 12's replay changes from a loss to a win. These paths were used during development, are not held out, and keep opponent behavior fixed. The early catastrophe is reported separately and excluded from full-game replay averages; it is not treated as a completed 92-second simulation.

**Remaining limitation:** frozen v0.2 still earns more on these recorded paths ($13.74B expected cash) and on the normal-delay stress mix ($13.25B vs $12.88B), especially against extreme escalation. v0.4 is better than v0.3.1 in this evaluation, not a universal best policy or a proven live leaderboard improvement. No live v0.4 matches were played during validation.

Reproduce with `npm run eval:finish -- 40 /path/to/export.json runs/finish-validation.json`. New trace fields record the target ceiling, catch-up exception, endgame blend, forecast horizon, and deadline-limited braking.

## Historical leaderboard refinement (v0.3)

v0.3.1 changes session continuation, stale-state recovery, and result accounting only; the v0.3 strategy is unchanged. Later v0.2 traces challenged that strategy refinement: fixed-opponent replays of three uninterrupted online wins produced lower expected cash under v0.3 across three timing settings. The historical synthetic results below do not establish an improvement against that real opponent.

v0.3 introduced a shorter, one-second frontier forecast, predicted opponent progress through brief accelerator pauses, and capped its research target at two points above the predicted frontier. The cap cannot guarantee a risk limit: forecasts can be wrong and deployed research is irreversible. Motion prediction also distinguishes a command still in transit from one already applied. Win-focused retained its v0.2 settings.

The frozen comparison in `runs/refinement-validation.json` uses 40 new seeds (LCG indices 7000–7039), eight opponent styles including two unseen during tuning, and two timing conditions. Three configurations were compared, totaling 1,920 simulations. Expected cash includes zero-score catastrophe outcomes.

| Timing / equal-weight opponent mix | v0.2 Leaderboard | v0.3 Leaderboard | Paired improvement, 95% interval |
|---|---:|---:|---:|
| Normal online delay | $15.33B | $15.51B | +$0.17B [$0.09B, $0.26B] |
| Higher delay and 5% snapshot loss | $14.60B | $15.21B | +$0.61B [$0.50B, $0.72B] |

Normal-delay survival improved from 81.5% to 84.2%, while expected wins fell from 60.3% to 58.4%. This is a modest improvement toward average cash rather than a claim of more wins. The paired intervals average each seed across opponent styles before estimating uncertainty, because games sharing a frontier seed are correlated. These intervals describe this simulation mix, not live online players.

The exported-match replays remain wins, conditional on survival: $18.86B vs $11.05B and $18.18B vs $13.77B. Expected own cash changes from $17.77B to $17.57B in the first replay and $16.71B to $16.86B in the second, so this refinement is not a universal improvement. No live v0.2 or v0.3 online trace was available for tuning; new exports are needed to test the real advantage.

Reproduce with `npm run eval:refine -- 40 /path/to/export.json runs/refinement-validation.json`. The v0.3 release passed 27 unit tests, including target caps, commands in transit, and cash averages that honor terminal scores and include crashes.

## Historical online-policy validation (v0.2)

The public page labels its leaderboard **Avg Final Cash / Game**, not win rate. The live public engine bundle was verified unchanged against its pinned SHA256 on September 30, 2026.

`runs/online-validation.json` contains 1,920 simulated games: four modes, six opponent styles, and 80 held-out seeds per matchup (LCG indices 4000–4079). Our bot receives snapshots every five physics frames, with three frames of observation delay and four of input delay; simulated opponents have no network delay. Catastrophe is integrated as `exp(-hazard)`, so both expected cash and win probability include the chance of losing all cash.

| Policy | Expected cash, equal-weight opponent mix | Expected win rate |
|---|---:|---:|
| Legacy win | $11.74B | 42.7% |
| Leaderboard (v0.2) | $15.28B | 62.6% |
| Win-focused | $14.91B | 69.7% |

Opponent-specific Leaderboard results range from $10.10B to $19.63B. It wins frequently against the CPU and moderate frontier trackers, but aggressive and reactive chasing opponents remain difficult. This test mix is not a measured distribution of online players and does not establish a real leaderboard rank.

An additional 360 simulations (20 new seeds per opponent and mode, indices 4400–4419) use six frames of observation delay, eight frames of input delay, and 5% snapshot loss. Expected cash averaged $14.35B for Leaderboard versus $11.57B for legacy win; full results are in `runs/online-stress.json`.

Fixed-opponent replays of the two exported losses give the following **conditional-on-survival** cash results:

| Match | Actual old own/opponent | Leaderboard replay own/opponent | Replay survival probability |
|---|---:|---:|---:|
| 1 | $9.41B / $19.87B | $18.85B / $12.21B | 94.3% |
| 2 | $12.71B / $18.78B | $17.67B / $14.70B | 94.6% |

Replays interpolate the observed frontier and opponent deployment. The opponent's cash is recomputed because our changed deployment changes both players' profits. These are counterfactual simulations; the real opponent could react differently. The timing model reproduces the original own cash at $9.40B and $12.87B respectively, but is not an exact reconstruction of every network event.

Reproduce with `npm run eval:online -- 80 /path/to/export.json runs/online-validation.json`. Omit the trace path to run duels only. `node tools/preview.mjs` serves an offline browser smoke test using the built bundle and the public engine. New traces include the bot version, each observation's objective, forecasts, and estimated delay.

The v0.2 bundle passed 24 unit tests and an offline Chrome smoke test for default selection, arming, observed accelerator input, mid-game Stop/release, objective selection, and a complete CPU game. This checks the adapter and bundle, not live multiplayer behavior.

## Historical CPU-only results (v0.1)

Offline evaluation uses the verbatim public engine. `npm run engine` fetches it and checks its sha256. Catastrophe is disabled only offline, and cash is weighted by `exp(-H)`. The table uses **fresh held-out seeds** (LCG indices 2000–2999, never used for tuning) at the measured practice cadence. Full tables are in `runs/offline-final.txt`.

| policy | E[cash] | survival | P(win vs CPU) |
|---|---|---|---|
| **cash** (old default) | **$18.18B ±0.04** | 99.996% | 0% |
| **win** | $17.43B ±0.05 | 97.2% | **96.9%** |
| handoff repro-cash | $17.15B | 98.8% | 64.3% |
| handoff repro-win | $17.11B | 96.6% | 95.7% |
| cash without lookahead | $17.12B | 99.0% | 0% |

The `cash` policy deliberately lets the CPU edge ahead: triggering the CPU's counter-escalation costs more than leading earns. The policy stays robust under degraded timing (0–2 frames of observation and input delay, 5% dropped snapshots, stalls): $17.83–17.86B.

Live practice runs used the real page in a separate throwaway Chrome profile (`npm run live`), with the same script injected at document start:

- The controls test passed: a synthetic press showed up as `held` with rising speed, and release and Stop were both confirmed in game state and in the UI.
- cash: $16.92B, $18.80B, $18.45B, $18.65B (all games finished, cumulative risk <0.001%; the CPU finished ahead each time).
- win: $17.97B vs $12.93B (risk 1.24%), $18.85B vs $13.12B (risk 2.69%). Won both.
- Latency: snapshots arrive every 80 ms (median; p95 82, p99 84, max 93 ms). An input shows up in the next snapshot: 80 ms median, p99 84 ms, which is 5 physics frames. There were zero stale, duplicate, out-of-order or missed intervals.

## Limits and caveats

- The adapter does not gate operation on the snapshot's `bot` or `ranked` fields. You are responsible for where and how you run it.
- The handoff's quoted $17.0455B and 95.4% could not be reproduced from its written controller description, because its `sim.cjs` wasn't included. Three baselines do reproduce exactly (always-accelerate, ideal mirror $18.839873B, frontier+1 $15.383345B). The described 5 Hz cash controller gives $16.34B. Run at the real 15 Hz cadence, it gives about $17.15B.
- Historical live tests ran in headless Chrome. In a visible Chrome window, timers may fire at 60 Hz, giving snapshots about every 4 frames. The lookahead adapts to that, and offline results at 4 frames are similar ($18.28B). Background tabs can be throttled: v0.6 no longer disarms on visibility changes, but still pauses when snapshots go stale. Background lifecycle behavior is covered by offline tests, not a live browser run.
- The historical v0.1 results above are against the built-in CPU. The new v0.2 results are offline simulations and replays, not live online validation.

## Layout

```
src/controller.mjs   handoff reproduction baseline (pure)
src/policy.mjs       target policy, movement projection, baselines
src/competitive.mjs  economic target selection and public-observation opponent prediction
src/opponents.mjs    exact public-account routing to a frozen cash-only profile
src/agent.mjs        stateful agent: allowlist, ordering, staleness, match reset, latency stats
src/replay.mjs       guarded next-game scheduling through the normal Play again control
src/browser.mjs      page adapter + operator panel
extension/           MV3 extension (manifest + built bundle)
engine/extract.mjs   fetch + hash-check + verbatim slice of the public engine (offline only)
sim/                 evaluator, parameter search, final held-out comparison
tools/               bundler; live practice integration test (throwaway Chrome profile)
test/                node --test suites
```
