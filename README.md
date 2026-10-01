# PACE bot

A local, inspectable controller for [Paradigm's PACE](https://www.paradigm.xyz/research/pace/). Every per-action decision is a pure local JavaScript function: no model calls or network inference.

## Install (Chrome, one time)

1. `npm run build` (writes `extension/pace-bot.js` from `src/`; a built copy is already there).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension/` folder.
3. Open https://www.paradigm.xyz/research/pace/. A small **PACE bot · v0.4** panel appears at the bottom right, **disarmed**.

After updating the code, reload the extension at `chrome://extensions` and refresh the game tab **between games**. The v0.4 label confirms the new build is loaded. Editing or rebuilding local files does not hot-reload an already-open game tab. A refresh resets the run count, match limit, and armed state; set the limit and click Start again.

The extension has no permissions. It only runs on `paradigm.xyz/research/pace*`, as one main-world content script. It never reads cookies, tokens, or network traffic, and your existing login session is left alone.

## Use

1. Use **Leaderboard** (`leaderboard`, the default) for average final cash with competitive pressure when behind. **Win-focused** (`competitive`) puts more weight on beating the opponent and accepts more risk. **Cash (legacy CPU)** and **Win (legacy CPU)** are the old practice-tuned presets, not the new online policies. `repro-cash` and `repro-win` remain available for reproduction.
2. Set the match limit (1–50, default 1) and click **Start**. Start or join the first game on the page. After each game, including a catastrophe, the bot stays armed and clicks the game's **Play again** button after a one-second delay if the limit has not been reached. This uses the site's normal matchmaking/rematch flow and waits when its button is disabled or unavailable. It requests each next game only once. In a private room, the opponent must also ready up.
3. **STOP**, or pressing **Esc**, releases the accelerator, disarms, and cancels any next-game click that has not happened yet. If a matchmaking request is already pending, use the site's Cancel control to leave that queue. The bot also disarms if a snapshot is malformed, the page is hidden, or the match limit is reached. Keep the game tab visible. A stale snapshot now **pauses** and releases input without disarming; two advancing snapshots arriving without another stale interval restore play automatically. Stop and other disarms never auto-resume.
4. **Export trace** downloads a JSON log with every observation, decision, input and acknowledgment, plus latency percentiles.
5. **run cash / game** shows mean terminal score for games the bot participated in during this page session, including zero-score crashes and forfeits. A game still counts if it finishes after a pause or Stop, provided the terminal snapshot arrives. It includes practice games and resets on page reload; it is not your account's all-time ranked average. The export includes those results for analysis.
6. The limit is the total completed-game count for this page session, not an additional-game count. To continue after reaching it, raise the limit and click **Start**. Lowering the limit to the completed count stops immediately.

Don't hold Space yourself while the bot is armed, because you share one accelerator.

The offline tests include the generated extension running against a simulated DOM/timer environment: automatic next-game clicks, exact match-limit stopping, Stop cancellation, stale-state recovery, and hidden-page stopping. No live matchmaking is exercised by these tests.

## How it works

- **Observation.** It wraps `customElements.get('pace-game').prototype.showMatch`, keeping `this`, the arguments, the return value and the original behavior. After the original render it copies an allowlist of player-visible fields into the agent (`src/agent.mjs: extractObservation`). The catastrophe threshold, RNG state and hidden opponent research are never read.
- **Input.** It dispatches `keydown`/`keyup` Space on the `pace-game` host, which is the same path a physical Space press takes. The widget's own handler runs its blocked, phase and dialog checks, then emits `pace:input` to the session. The agent checks the UI's `#accelerator[aria-pressed]` and the game's observed `held` against what it last issued, and resyncs if they differ.
- **Online policy** (`src/competitive.mjs`). Predicts frontier progress and opponent deployment from recent public observations, accounting for the game's two-second deployment lag. Scores candidate research targets using the public profit and catastrophe formulas. Risk is charged against accumulated cash and projected future earnings; competitive pressure increases when behind and relaxes when comfortably ahead. Forecasts are estimates, not knowledge of hidden research or future frontier changes.
- **Timing.** New policies project motion over estimated observation-to-command-effect delay, then check the stopping point after one further decision interval. Delay is estimated from input acknowledgements in game time, subtracting half a snapshot interval for sampling delay; it starts at seven frames and is bounded at thirty. Acknowledgement timing is not an exact network RTT. Retries retain their original timestamp, and timing/command state resets each match.
- **Legacy policy** (`src/policy.mjs`). Retains the original CPU-tuned target tracker for comparison. It does not use the new economic target or adaptive delay horizon.

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
- Live tests ran in headless Chrome. In a visible Chrome window, timers may fire at 60 Hz, giving snapshots about every 4 frames. The lookahead adapts to that, and offline results at 4 frames are similar ($18.28B). Background tabs are throttled, so keep the game tab in front; the bot disarms if the page is hidden.
- The historical v0.1 results above are against the built-in CPU. The new v0.2 results are offline simulations and replays, not live online validation.

## Layout

```
src/controller.mjs   handoff reproduction baseline (pure)
src/policy.mjs       target policy, movement projection, baselines
src/competitive.mjs  economic target selection and public-observation opponent prediction
src/agent.mjs        stateful agent: allowlist, ordering, staleness, match reset, latency stats
src/replay.mjs       guarded next-game scheduling through the normal Play again control
src/browser.mjs      page adapter + operator panel
extension/           MV3 extension (manifest + built bundle)
engine/extract.mjs   fetch + hash-check + verbatim slice of the public engine (offline only)
sim/                 evaluator, parameter search, final held-out comparison
tools/               bundler; live practice integration test (throwaway Chrome profile)
test/                node --test suites
```
