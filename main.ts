// Pump.fun Bot Sprint entry: a launch sniper with a rug filter.
// Run by the grader as `node /bot/main.ts`; the strategy lives in
// strategy.ts, the protocol in the vendored SDK shim (vendor/makefun-bot.ts,
// a copy of the kit's sdk/ts/makefun-bot.ts, kept out of the authorship
// counts as the SDK's own header directs).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
