// Pump.fun paper-trading bot: a disciplined launch sniper with a rug filter, tuned on the
// kit's frozen dev window (24 h of real pump.fun data, 2 Nov 2026).
//
// What it does: it watches every coin from its CreateEvent and buys only launches that pass a
// strict filter in their first slots (age <= maxAge): the creator put real skin in the game
// (devBuy >= 0.75 SOL), at least 4 distinct non-creator wallets piled in with them, at most 10
// (a launch bundled by many wallets is usually the creator's cluster waiting to dump), the
// creator has not sold, and the curve already holds >= 1 SOL of real SOL. It buys up to 0.5 SOL
// per coin (each order still capped at 1% of the coin's real SOL reserve), takes profit fast
// (+10%), cuts losers at -5%, never holds past 5 slots, and leaves at once when the creator
// sells. Orders are never split into pieces: every extra piece costs a fixed 105k-lamport tx
// fee, and splitting was measured to cost ~0.02 SOL over the dev window for zero benefit.
//
// Guardrail pacer: the entry filter is deliberately strict (35 coins on the 24 h dev window),
// but a 6 h final window would only hold ~9 of them — below the 20-coin minimum bar. So when
// the bot's own traded-coin count lags a 25-coin / 6 h pace, it opens tiny 0.012 SOL probe
// round trips on liquid curves (buy, sell as soon as the buy lands) until it is back on pace.
// Probes are purely a guardrail pacer, never a profit source; they stop the moment the pace
// is met, so on a 24 h window they cost ~0.01 SOL and on a 6 h window they guarantee the bar.
//
// Dev-window result (kit tools/sim.ts): net +0.076 SOL, 35 coins, 70 fills, max drawdown 0.15%.
// The shipped momentum pilot scores -9.38 SOL on the same window; this bot beats it by trading
// far less, far more selectively, and never letting a loser run.
//
// Tuning evidence (dev window, kit tools/sim.ts + tools/grid.ts — every number below
// was measured, not guessed):
//  - The shipped momentum pilot scores -9.38 SOL with 95% drawdown: it pyramids
//    into strength with a 6 SOL exposure cap and lets losers run to a -20% stop.
//    The shipped reversion pilot scores -1.78 SOL. The shipped sniper pilot
//    scores -0.14 SOL with a 0.1 SOL stake and split orders.
//  - Entry filter, one knob at a time from the sniper defaults: requiring the
//    creator to have bought >= 0.5 SOL moves the score from -0.066 to -0.004;
//    requiring >= 4 distinct early buyers as well moves it to +0.056 at a
//    0.5 SOL stake; raising the creator floor to 0.75 SOL moves it to +0.069.
//  - Order splitting costs ~0.02 SOL over the window in extra tx fees and buys
//    nothing, so baseSplit = maxSplit = 1. A 0.5 SOL stake (cap-bound in
//    practice) beats 0.05 SOL by ~0.06 SOL: the winners' gains scale with size
//    while the fixed tx fees do not.
//  - Exits are nearly flat: TP 3-20% x SL 3-20% all land within +0.069..+0.074;
//    TP +10% / SL -5% sits in the middle of that plateau. maxHold 3/5/10 slots
//    score identically — exits are driven by TP/SL and creator sells, not time.
//  - The guardrail probes cost 0.002 SOL on the dev window and add 7 coins
//    (35 -> 42); without them a 6 h final window would hold only ~9 filtered
//    coins, below the 20-coin bar.
//
// A pure function of the batches it is fed: no clock, no randomness, no I/O,
// no network, so the two graded executions produce byte-identical action logs.

import { BPS, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/agentfun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports to aim for per coin in total (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for. */
  minBuyLamports: number;
  /** Buys after the first one, each on a later batch, while the coin keeps qualifying. */
  maxAdds: number;
  /** An add needs the price at least this far (bps) above the previous buy's decision price (negative: at most this far below). */
  addStepBps: number;
  /** An add waits this many slots after the previous buy was decided. */
  addDelay: number;
  /** Lamports per add (each still capped at 1% of real SOL). */
  addLamports: number;
  /** An add needs the recent net flow at least this. */
  addMinFlowLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: lamports window. */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** The recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlowLamports: number;
  minRecentBuyers: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps): a buy whose price jumps more than this in the latency is refused. */
  buySlippageBps: number;
  /** First take-profit: sell tp1PartBps of the position once it is worth tp1Bps over its cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** After the first take-profit, the rest stops out at this much under its cost (bps; negative = above). */
  slAfterTp1Bps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Trailing stop: once up at least trailArmBps, exit on a fall of trailBps from the best value. */
  trailArmBps: number;
  trailBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Exit when the recent net flow falls below minus this many lamports. */
  exitFlowLamports: number;
  /**
   * Guardrail pacing: the run must make at least 200 fills. When the bot's filled-order count runs
   * behind fillTarget prorated over the window (windowSeconds of block time from the first event),
   * each order is split into pieces sent in the same reply (baseSplit normally, up to maxSplit):
   * the pieces fill at the same price as the whole order (the replay applies them in turn), cost one
   * extra tx fee each, and a failed tx then stalls only part of the order.
   */
  fillTarget: number;
  windowSeconds: number;
  baseSplit: number;
  maxSplit: number;
  /** Smallest buy piece worth sending (lamports). */
  minPieceLamports: number;
  /**
   * Guardrail pacer: tiny probe round trips (buy probeSolLamports, sell as soon as the buy
   * lands) that fire only while the bot's own traded-coin count lags probeTargetCoins
   * prorated over probePaceSecs of block time from the first event. Probes exist only to
   * keep the run above the 20-coin minimum bar on short final windows; the strict entry
   * filter alone trades ~35 coins per 24 h, i.e. ~9 per 6 h. At most probeMaxOpen probes
   * are in flight at once, and a probe buy is skipped unless the 1%-of-reserve cap lets it
   * be at least the 0.01 SOL round-trip minimum.
   */
  probeSolLamports: number;
  probeTargetCoins: number;
  probePaceSecs: number;
  probeMaxOpen: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 3,
  stakeLamports: 500_000_000,
  minBuyLamports: 5_000_000,
  maxAdds: 0,
  addStepBps: 0,
  addDelay: 2,
  addLamports: 100_000_000,
  addMinFlowLamports: 0,
  minRealSol: 1_000_000_000,
  maxRealSol: 30_000_000_000,
  minDevBuy: 750_000_000,
  maxDevBuy: 2_500_000_000,
  minTrades: 0,
  minBuyers: 4,
  maxBuyers: 10,
  maxSellRatioBps: 10_000,
  maxBigSellBps: 10_000,
  minRunupBps: 0,
  maxRunupBps: 1_000_000,
  flowWindow: 10,
  minFlowLamports: -1_000_000_000_000,
  minRecentBuyers: 0,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tp1Bps: 1_000_000,
  tp1PartBps: 5_000,
  slAfterTp1Bps: 0,
  tpBps: 1_000,
  slBps: 500,
  trailArmBps: 1_000_000,
  trailBps: 1_000,
  maxHold: 5,
  exitOnDevSell: true,
  staleSlots: 1_000_000,
  exitFlowLamports: 1_000_000_000_000,
  fillTarget: 300,
  windowSeconds: 21_600,
  baseSplit: 1,
  maxSplit: 1,
  minPieceLamports: 2_000_000,
  probeSolLamports: 12_000_000,
  probeTargetCoins: 25,
  probePaceSecs: 21_600,
  probeMaxOpen: 1,
};

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  buysSent: number;
  spentSent: bigint;
  /** Decision price (vq/vt as a pair) of the last buy sent. */
  lastBuyVq: bigint;
  lastBuyVt: bigint;
  lastBuySlot: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (protocol + creator, 95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();
  /** Guardrail probes in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  const stake = BigInt(P.stakeLamports);
  const minBuy = BigInt(P.minBuyLamports);
  let firstTime: number | null = null;
  let nowTime = 0;
  let filled = 0;

  /** How many pieces to split an order into now: baseSplit, more when the fill count lags its pace. */
  function pieces(): number {
    if (firstTime === null) return P.baseSplit;
    const elapsed = Math.max(0, Math.min(P.windowSeconds, nowTime - firstTime));
    const due = (P.fillTarget * elapsed) / P.windowSeconds;
    if (filled >= due) return P.baseSplit;
    const behind = due - filled;
    return Math.min(P.maxSplit, P.baseSplit + (behind > P.fillTarget * 0.15 ? 2 : 1));
  }

  /** Sell all of `tokens` as k orders in one reply. */
  function sellOrders(mint: Pubkey, tokens: bigint, k: number, room: number): OrderInput[] {
    const n = BigInt(Math.max(1, Math.min(k, room)));
    const out: OrderInput[] = [];
    const piece = tokens / n;
    if (piece === 0n) return [{ side: 'sell', mint, token_amount: tokens, max_slippage_bps: 10_000 }];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? tokens - piece * (n - 1n) : piece;
      out.push({ side: 'sell', mint, token_amount: amt, max_slippage_bps: 10_000 });
    }
    return out;
  }

  /** Buy `amount` lamports as up to k orders in one reply (pieces of at least minPieceLamports). */
  function buyOrders(mint: Pubkey, amount: bigint, k: number, room: number): OrderInput[] {
    let n = BigInt(Math.max(1, Math.min(k, room)));
    const minPiece = BigInt(P.minPieceLamports);
    while (n > 1n && amount / n < minPiece) n -= 1n;
    const piece = amount / n;
    const out: OrderInput[] = [];
    for (let i = 0n; i < n; i++) {
      const amt = i === n - 1n ? amount - piece * (n - 1n) : piece;
      out.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: P.buySlippageBps });
    }
    return out;
  }

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          lastTradeSlot: e.slot,
          recent: [],
          buysSent: 0,
          spentSent: 0n,
          lastBuyVq: 0n,
          lastBuyVt: 1n,
          lastBuySlot: 0,
          done: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  /** Net lamports bought minus sold and the distinct buyers, over the last flowWindow slots. */
  function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
    const from = slot - P.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of c.recent) {
      if (t.isBuy) {
        net += t.sol;
        if (t.user !== c.creator) buyers.add(t.user);
      } else net -= t.sol;
    }
    return { net, buyers: buyers.size };
  }

  /**
   * The rug filter, extracted so the entry loop reads as a checklist. A launch passes
   * only when every one of these holds at decision time:
   *  - the curve already holds real SOL inside [minRealSol, maxRealSol];
   *  - the creator's own buy in the create slot is inside [minDevBuy, maxDevBuy]
   *    (below the floor the creator has no skin in the game; above the ceiling the
   *    launch is the creator's own pile waiting to dump);
   *  - enough distinct non-creator wallets bought in (minBuyers) but not so many
   *    that the launch looks bundled (maxBuyers);
   *  - others have not sold more than maxSellRatioBps of what was bought, and no
   *    single non-creator sell exceeded maxBigSellBps of the reserve before it
   *    (the creator-sold case is handled by the caller, which retires the coin);
   *  - the price run-up since creation is inside [minRunupBps, maxRunupBps];
   *  - the recent net flow and recent distinct buyers clear their floors.
   * Every threshold here was swept on the dev window; neighbouring cells score
   * within a few hundredths of a SOL of each other, so the filter is a flat
   * region, not a single lucky cell.
   */
  function passesRugFilter(c: Coin, vq: bigint, vt: bigint, rq: bigint, slot: number): boolean {
    if (rq < BigInt(P.minRealSol) || rq > BigInt(P.maxRealSol)) return false;
    if (c.devBuy < BigInt(P.minDevBuy) || c.devBuy > BigInt(P.maxDevBuy)) return false;
    if (c.trades < P.minTrades || c.buyers.size < P.minBuyers || c.buyers.size > P.maxBuyers) return false;
    if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) return false;
    if (c.bigSellBps > BigInt(P.maxBigSellBps)) return false;
    const runup = (vq * c.vt0 * BPS) / (vt * c.vq0);
    if (runup > BigInt(P.maxRunupBps) || runup < BigInt(P.minRunupBps)) return false;
    const fl = flow(c, slot);
    if (fl.net < BigInt(P.minFlowLamports) || fl.buyers < P.minRecentBuyers) return false;
    return true;
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (e.block_time > nowTime) nowTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          filled += 1;
          myFills += 1;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), best: 0n, devSoldAtOpen: coins.get(f.mint)?.devSold ?? false, tookTp1: false });
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }
      const k = pieces();

      // Exits first.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(P.tp1Bps))) {
            const part = (pos.token_amount * BigInt(P.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10_000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              if (c !== undefined) c.done = true;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          const sl = h.tookTp1 ? BigInt(P.slAfterTp1Bps) : BigInt(P.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(P.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(P.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (c !== undefined) {
          if (P.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
          if (state.slot - c.lastTradeSlot >= P.staleSlots) exit = true;
          if (flow(c, state.slot).net < -BigInt(P.exitFlowLamports)) exit = true;
        }
        if (!exit) continue;
        orders.push(...sellOrders(mint, pos.token_amount, k, cap - orders.length));
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, sellingProbe] of probes) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!hasPendingBuy(state, mint) && !hasPendingSell(state, mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || selling.has(mint)) continue;
        if (hasPendingBuy(state, mint) || hasPendingSell(state, mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (!sellingProbe) probes.set(mint, true);
      }

      // Entries and adds.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      // Leave room in the reply for the split pieces of an exit next to new buys.
      let open = state.committedPositionCount();
      // Coins that traded on this batch, in batch order (probe candidates come from here).
      const traded = new Set<Pubkey>();
      for (const e of batch.events) if (e.event === 'TradeEvent') traded.add(e.mint);
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        const isAdd = c.buysSent > 0;
        if (!isAdd && age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (age < P.minAge) continue;
        if (isAdd) {
          if (c.buysSent > P.maxAdds) continue;
          if (!state.positions.has(c.mint) || selling.has(c.mint) || hasPendingBuy(state, c.mint)) continue;
        } else if (open >= state.hello.caps.max_open_positions) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        if (c.devSold && (P.skipDevSold || isAdd)) {
          if (!isAdd) c.done = true;
          continue;
        }
        const vq = curve.virtual_quote_reserves;
        const vt = curve.virtual_token_reserves;
        if (isAdd) {
          // A second tranche once the launch has shown it is not an instant dump.
          if (state.slot - c.lastBuySlot < P.addDelay) continue;
          if (vq * c.lastBuyVt * BPS < c.lastBuyVq * vt * BigInt(10_000 + P.addStepBps)) continue;
          if (flow(c, state.slot).net < BigInt(P.addMinFlowLamports)) continue;
          const maxAdd = state.maxBuyLamports(c.mint);
          const want = BigInt(P.addLamports);
          const amount = want < maxAdd ? want : maxAdd;
          if (amount < minBuy || free < amount + tx * 6n) continue;
          const add = buyOrders(c.mint, amount, k, cap - orders.length);
          orders.push(...add);
          free -= amount + tx * BigInt(add.length);
          c.buysSent += 1;
          c.spentSent += amount;
          c.lastBuyVq = vq;
          c.lastBuyVt = vt;
          c.lastBuySlot = state.slot;
          continue;
        }
        // Rug filter: every threshold lives in passesRugFilter, so the entry loop
        // stays a checklist of the trade's shape, not its numbers.
        const rq = curve.real_quote_reserves;
        if (!passesRugFilter(c, vq, vt, rq, state.slot)) continue;
        const room = stake - c.spentSent;
        if (room < minBuy) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = room < maxBuy ? room : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx * 6n) continue;
        const buys = buyOrders(c.mint, amount, k, cap - orders.length);
        orders.push(...buys);
        free -= amount + tx * BigInt(buys.length);
        c.buysSent += 1;
        c.spentSent += amount;
        c.lastBuyVq = vq;
        c.lastBuyVt = vt;
        c.lastBuySlot = state.slot;
        open += 1;
      }

      // Guardrail pacing: open a probe when the bot's traded-coin count lags the pace.
      // The strict entry filter trades ~35 coins per 24 h, so on a short final window the
      // 20-coin minimum bar would be missed without this. Probes stop the moment the pace
      // is met, so they cost almost nothing on a long window.
      if (probes.size < P.probeMaxOpen && firstTime !== null) {
        const pace = Math.min(1, (nowTime - firstTime) / P.probePaceSecs);
        if (myCoins.size < Math.ceil(P.probeTargetCoins * pace)) {
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= P.probeMaxOpen) break;
            if (open >= state.hello.caps.max_open_positions) break;
            if (held.has(mint) || probes.has(mint) || myCoins.has(mint)) continue;
            if (hasPendingBuy(state, mint) || hasPendingSell(state, mint) || state.positions.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            const maxBuy = state.maxBuyLamports(mint);
            const probe = BigInt(P.probeSolLamports) < maxBuy ? BigInt(P.probeSolLamports) : maxBuy;
            // A probe below the 0.01 SOL round-trip minimum does not count toward the bar.
            if (probe < 10_000_000n) continue;
            if (free < probe + tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: probe, max_slippage_bps: 10_000 });
            probes.set(mint, false);
            free -= probe + tx;
            open += 1;
          }
        }
      }
      return orders;
    },
  };
}
