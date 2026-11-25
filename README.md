# Pump.fun Bot Sprint: Make Bot And Win

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/BIDGDCB/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/BIDGDCB/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Entry for the make.fun competition
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`.

A Solana trading bot for the `agent-fun/replay/v2` pump.fun replay: it
watches every coin from its `CreateEvent`, snipes launches that pass a rug
filter (real SOL already in the curve, creator has not sold, creator's own
buy is small, several distinct buyers, sells not eating the buys, price run-up
still modest, recent net flow positive), then takes profit fast, cuts losers
faster, trails winners, and exits at once when the creator sells or the coin
goes stale. With only five open positions allowed it recycles slots quickly.

`main.ts` is the entrypoint (Node 22, standard library only); the strategy
lives in `strategy.ts` and the protocol shim in `vendor/makefun-bot.ts` (a
copy of the kit's SDK, as its header directs). The bot is a pure function of
the batches it is fed — no clock, no randomness, no I/O — so two runs of the
same replay produce byte-identical action logs.
