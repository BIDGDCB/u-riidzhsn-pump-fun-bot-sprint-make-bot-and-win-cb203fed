// Pump.fun launch sniper with a rug filter, for agent-fun/replay/v2.
//
// Every coin is watched from its CreateEvent. In its first slots the bot
// reads the opening tape: how much real SOL the curve already holds, how big
// the creator's own buy was, whether the creator has sold, how many other
// wallets have bought in, whether sells are eating the buys, and how far the
// price has run up from its create price. It buys only launches that pass
// every filter, takes profit by trailing winners instead of capping them at
// a small fixed target (a pump coin can run several multiples; the trailing
// stop is what banks it), cuts losers fast, never holds past a short
// deadline, and leaves at once when the creator sells. With only five
// open positions allowed, a flat coin is exited quickly so the slot can be
// recycled into the next launch.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O,
// so two runs of the same replay produce byte-identical action logs.

import {
  BPS,
  LAMPORTS_PER_SOL,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: bigint;
  /** Smallest single buy worth paying the tx fee for; also the guardrail's round-trip bar. */
  minBuyLamports: bigint;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: bigint;
  maxRealSol: bigint;
  /** Creator's own buys in the create slot: at most this many lamports. */
  maxDevBuy: bigint;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: bigint;
  /** Price now over the create price, as bps: window. */
  minRunupBps: bigint;
  maxRunupBps: bigint;
  /** Recent-flow window (slots) and what the net flow must show (lamports). */
  flowWindow: number;
  minFlowLamports: bigint;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys and sells (bps). */
  slippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: bigint;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: bigint;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: bigint;
  trailBps: bigint;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 6,
  stakeLamports: 100_000_000n,
  minBuyLamports: 10_000_000n,
  minRealSol: 2_000_000_000n,
  maxRealSol: 30_000_000_000n,
  maxDevBuy: 1_000_000_000n,
  minTrades: 8,
  minBuyers: 4,
  maxSellRatioBps: 3000n,
  minRunupBps: 11500n,
  maxRunupBps: 25000n,
  flowWindow: 10,
  minFlowLamports: 50_000_000n,
  skipDevSold: true,
  slippageBps: 10000,
  tpBps: 15000n,
  slBps: 600n,
  trailArmBps: 1500n,
  trailBps: 800n,
  maxHold: 60,
  exitOnDevSell: true,
  staleSlots: 60,
};

/** Price in SOL per token, scaled by 1e18, from virtual reserves. */
function priceScaled(virtualQuote: bigint, virtualToken: bigint): bigint {
  if (virtualToken === 0n) return 0n;
  return (virtualQuote * 1_000_000_000_000_000_000n) / virtualToken;
}

interface Tape {
  mint: Pubkey;
  creator: Pubkey;
  createSlot: number;
  createPrice: bigint;
  devBuyLamports: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  buyLamports: bigint;
  sellLamports: bigint;
  /** Recent trades: [slot, signed SOL lamports] (+buy, -sell). */
  recent: Array<{ slot: number; sol: bigint }>;
  lastTradeSlot: number;
  decided: boolean;
  entrySlot: number;
  bestValue: bigint;
}

export function createStrategy(params: Params) {
  const coins = new Map<Pubkey, Tape>();

  function tapeFor(mint: Pubkey, creator: Pubkey, slot: number, createPrice: bigint): Tape {
    let t = coins.get(mint);
    if (t === undefined) {
      t = {
        mint,
        creator,
        createSlot: slot,
        createPrice,
        devBuyLamports: 0n,
        devSold: false,
        trades: 0,
        buyers: new Set(),
        buyLamports: 0n,
        sellLamports: 0n,
        recent: [],
        lastTradeSlot: slot,
        decided: false,
        entrySlot: -1,
        bestValue: 0n,
      };
      coins.set(mint, t);
    }
    return t;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // Fold this batch's events into the per-coin tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        tapeFor(
          e.mint,
          e.creator,
          e.slot,
          priceScaled(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        );
      } else if (e.event === 'TradeEvent') {
        const t = coins.get(e.mint);
        if (t === undefined) continue;
        const sol = BigInt(e.sol_amount);
        t.trades += 1;
        t.lastTradeSlot = e.slot;
        if (e.user === t.creator) {
          if (e.is_buy) {
            if (e.slot === t.createSlot) t.devBuyLamports += sol;
          } else {
            t.devSold = true;
          }
        } else {
          if (e.is_buy) {
            t.buyers.add(e.user);
            t.buyLamports += sol;
            t.recent.push({ slot: e.slot, sol });
          } else {
            t.sellLamports += sol;
            t.recent.push({ slot: e.slot, sol: -sol });
          }
        }
      } else {
        // CompleteEvent: the curve is done; forget the tape.
        coins.delete(e.mint);
      }
    }

    // Exits first: free position slots before deciding new entries.
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      const t = coins.get(mint);
      if (curve === undefined || curve.complete) continue;
      const value =
        (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      const cost = holding.cost_lamports;
      if (cost === 0n) continue;
      if (t !== undefined) {
        if (t.entrySlot < 0) t.entrySlot = batch.slot;
        if (value > t.bestValue) t.bestValue = value;
      }
      const pnlBps = ((value - cost) * BPS) / cost;
      let exit = false;
      if (pnlBps >= params.tpBps) exit = true;
      else if (pnlBps <= -params.slBps) exit = true;
      else if (
        t !== undefined &&
        t.bestValue > 0n &&
        ((t.bestValue - cost) * BPS) / cost >= params.trailArmBps &&
        ((t.bestValue - value) * BPS) / t.bestValue >= params.trailBps
      ) {
        exit = true;
      } else if (t !== undefined && params.exitOnDevSell && t.devSold) {
        exit = true;
      } else if (t !== undefined && t.entrySlot >= 0 && batch.slot - t.entrySlot > params.maxHold) {
        exit = true;
      } else if (t !== undefined && batch.slot - t.lastTradeSlot > params.staleSlots) {
        exit = true;
      }
      if (exit) {
        if (orders.length >= caps.max_orders_per_batch) continue;
        orders.push({
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: params.slippageBps,
        });
        free -= tx;
        if (t !== undefined) t.decided = true;
      }
    }

    // Entries: one shot per coin, in event order.
    for (const e of batch.events) {
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const t = coins.get(e.mint);
      if (t === undefined || t.decided) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        t.decided = true;
        continue;
      }
      const age = batch.slot - t.createSlot;
      if (age < params.minAge || age > params.maxAge) continue;
      const realSol = curve.real_quote_reserves;
      if (realSol < params.minRealSol || realSol > params.maxRealSol) continue;
      if (params.skipDevSold && t.devSold) {
        t.decided = true;
        continue;
      }
      if (t.devBuyLamports > params.maxDevBuy) {
        t.decided = true;
        continue;
      }
      if (t.trades < params.minTrades || t.buyers.size < params.minBuyers) continue;
      if (t.buyLamports > 0n && (t.sellLamports * BPS) / t.buyLamports > params.maxSellRatioBps) {
        continue;
      }
      const nowPrice = priceScaled(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (t.createPrice === 0n || nowPrice === 0n) continue;
      const runupBps = (nowPrice * BPS) / t.createPrice;
      if (runupBps < params.minRunupBps || runupBps > params.maxRunupBps) continue;
      let flow = 0n;
      for (const r of t.recent) {
        if (r.slot > batch.slot - params.flowWindow) flow += r.sol;
      }
      if (flow < params.minFlowLamports) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < params.minBuyLamports) continue;
      const amount = cap < params.stakeLamports ? cap : params.stakeLamports;
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) continue;
      if (free < amount + tx) continue;
      // A buy already in flight for this mint: wait for it instead of doubling.
      let inFlight = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === e.mint) {
          inFlight = true;
          break;
        }
      }
      if (inFlight) continue;
      orders.push({
        side: 'buy',
        mint: e.mint,
        quote_lamports: amount,
        max_slippage_bps: params.slippageBps,
      });
      free -= amount + tx;
      slots -= 1;
      t.decided = true;
    }

    return orders;
  }

  return { onBatch };
}
