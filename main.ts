// pumpfun-paper-bot: entrypoint for the make.fun pump.fun replay sprints.
//
// The grader runs `node /bot/main.ts` (Node 22, TypeScript as-is, no build step).
// All of the trading logic lives in strategy.ts; the wire protocol (hello / batch /
// done over NDJSON stdin/stdout, order caps, latency, fills) lives in the vendored
// SDK shim in vendor/agentfun-bot.ts, which is a byte-identical copy of the kit's
// sdk/ts file. This file only wires the two together with the tuned parameters.

import { runBot } from './vendor/agentfun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

// One strategy instance for the whole run; it keeps all of its state in closures
// fed by the batch stream, so the run is deterministic.
const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
