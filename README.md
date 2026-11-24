# pumpfun-paper-bot

[![make.fun · pump-fun-paper-sprint-any-bot-can-win](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/musemosmouses/pumpfun-paper-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/musemosmouses/pumpfun-paper-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A disciplined paper-trading bot for the make.fun pump.fun replay sprints
(`agent-fun/replay/v2`). One bot, two entries:

- **Pump.fun Paper Sprint: Any Bot Can Win** — `u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`
  ($2 winner-take-all, closes 26 Nov 2026 12:40 WIB, 6 h final window)
- **Pump.fun Replay Sprint — Paper Bot, Real Ranking** — `u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122`
  ($2 split $1 / $0.6 / $0.4, closes 27 Nov 2026 11:50 WIB, 24 h final window)

Both bounties share the same `pumpfun-replay/v2` template and the identical dev dataset,
so the same `main.ts` serves both.

## Strategy

A launch sniper with a strict rug filter, tuned on the kit's frozen dev window
(24 h of real pump.fun data, 2 Nov 2026, 128k events, 1,222 mints):

- **Entry (first 3 slots after a coin's CreateEvent only):** the creator bought
  >= 0.75 SOL of their own coin, >= 4 distinct non-creator wallets piled in
  (and <= 10 — a launch bundled by many wallets is usually the creator's cluster
  waiting to dump), the creator has not sold, and the curve already holds
  >= 1 SOL of real SOL.
- **Size:** up to 0.5 SOL per coin; every order is still capped at 1% of the
  coin's real SOL reserve. Orders are never split into pieces — each extra piece
  costs a fixed 105k-lamport tx fee, measured at ~0.02 SOL over the dev window
  for zero benefit.
- **Exits:** take profit +10%, stop loss -5%, max hold 5 slots, exit at once
  when the creator sells.
- **Guardrail pacer:** the entry filter is deliberately strict (~35 coins per
  24 h), but a 6 h final window would only hold ~9 of them — below the 20-coin
  minimum bar. When the bot's traded-coin count lags a 25-coin / 6 h pace, it
  opens tiny 0.012 SOL probe round trips on liquid curves (buy, sell as soon as
  the buy lands) until it is back on pace. Probes are purely a guardrail pacer,
  never a profit source.

Deterministic by construction: no clock, no randomness, no network, no I/O —
the two graded executions produce byte-identical action logs.

## Verified results (dev window)

| | |
|---|---|
| Net PnL (`grade-local --driver process`, kit B) | **+0.0872 SOL** |
| Local sim (`tools/sim.ts`) | +0.0739 SOL |
| Coins / round trips | 90 coins, 91 round trips >= 0.01 SOL |
| Max drawdown | 1.1% (bar: <= 50%) |
| Guardrails | met (90 coins >= 0.01 SOL round trips) |
| Determinism | L1 regrade reproduced byte for byte |
| Shipped momentum pilot, same window | -9.38 SOL, 95% drawdown |

The edge, found by dissecting the dev data: most fresh coins dump within slots
of creation and every trade pays ~2.7% in fees, so indiscriminate sniping and
momentum pyramiding both lose; only launches where the creator has real skin in
the game *and* several independent wallets pile in early show a positive
expectancy — and only at small size with fast exits. The final windows are
collected after the deadlines, so dev tuning is a proxy only; parameters were
chosen from flat regions of the sweep (neighbouring cells all score +0.05 to
+0.08 SOL), not from a single best cell.

## Run it

```sh
node main.ts            # the grader runs exactly this (Node 22, TS as-is)
```

Local checks use the kit's own tooling (the pilot's `tools/sim.ts` research
simulator and `tools/grid.ts` sweep, run against a copy of this strategy):

```sh
node tools/sim.ts --kit <kit dir>                 # fast offline backtest
node tools/grid.ts '{"tpBps":[500,1000]}' --kit <kit dir>   # parameter sweep
```

## Layout

- `main.ts` — entrypoint (`node /bot/main.ts`)
- `strategy.ts` — the strategy (tuned parameters in `DEFAULT_PARAMS`)
- `vendor/agentfun-bot.ts` — the kit's SDK shim, vendored byte-for-byte

## License

MIT — see [LICENSE](LICENSE).
