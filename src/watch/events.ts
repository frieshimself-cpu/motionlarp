// The fast path: a followed wallet's pump.fun curve BUY read straight from the websocket logs (the program emits
// a tradeEvent), so the copy starts without fetching the transaction first. Anything this cannot read with
// certainty (sells, which need the wallet's balance before; PumpSwap; no event) returns null and goes through the
// normal fetch-and-parse path.
import { Connection } from '@solana/web3.js';
import { pumpSdk } from '../venues/sdk.js';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM, WSOL_MINT, type LeaderTrade } from './parse.js';

/** pump.fun writes the zero key as the quote mint of a SOL-priced coin. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// The program object is only used for its event decoder; this connection is never called.
let coder: { decode: (b64: string) => { name: string; data: Record<string, unknown> } | null } | null = null;
function events() {
  if (!coder) coder = pumpSdk.getPumpProgram(new Connection('http://127.0.0.1:1')).coder.events as never;
  return coder!;
}

const str = (v: unknown) => (v && typeof (v as { toString: () => string }).toString === 'function' ? (v as { toString: () => string }).toString() : String(v));

const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

export function fastBuysFromLogs(logs: string[], signature: string, leader: string, slot: number, heardAt?: number): LeaderTrade[] | null {
  if (logs.some((l) => l.includes(PUMP_AMM_PROGRAM) || /log truncated/i.test(l))) return null;
  const buys: LeaderTrade[] = [];
  // Which program is running: a "Program data" line counts only when pump.fun itself wrote it. (Any program can
  // log a line shaped like pump.fun's trade event, naming any wallet; pump.fun only writes one for a buy its user
  // signed.)
  const running: string[] = [];
  // The token program pump.fun itself called in this trade (to move the coin): the coin's own (classic SPL or
  // Token-2022). Checked against the coins' real programs on the real transactions in tests/fixtures.
  let coinTokenProgram: string | undefined;
  for (const line of logs) {
    const call = /^Program (\w{32,44}) invoke \[/.exec(line);
    if (call) {
      if (call[1] === PUMP_PROGRAM) coinTokenProgram = undefined;
      else if (running[running.length - 1] === PUMP_PROGRAM && TOKEN_PROGRAMS.has(call[1]!)) coinTokenProgram = call[1];
      running.push(call[1]!);
      continue;
    }
    if (/^Program \w{32,44} (success|failed)/.test(line)) { running.pop(); continue; }
    if (!line.startsWith('Program data: ') || running[running.length - 1] !== PUMP_PROGRAM) continue;
    let ev: { name: string; data: Record<string, unknown> } | null = null;
    try {
      ev = events().decode(line.slice('Program data: '.length));
    } catch {
      continue;
    }
    if (!ev || ev.name !== 'tradeEvent' || str(ev.data.user) !== leader) continue;
    if (str(ev.data.isBuy) !== 'true') return null; // a sell: needs the full transaction
    // A coin priced in another token (USDC, USD1, …): the amounts are not SOL. The full transaction decides.
    const quote = ev.data.quoteMint === undefined ? '' : str(ev.data.quoteMint);
    if (quote && quote !== SYSTEM_PROGRAM && quote !== WSOL_MINT) return null;
    // What the wallet handed pump.fun: the SOL for the curve, the protocol fee and the creator fee (checked to the
    // lamport against the instruction's own amount on the Scharo wallet's real buys of 27 Nov 2026; the buyback fee
    // is a slice of the protocol fee, and holder rewards repeat the creator fee, so they are not added again). A
    // trading bot's own fee is not in the event: the engine allows for it.
    const part = (k: string) => BigInt(ev!.data[k] === undefined || ev!.data[k] === null ? '0' : str(ev!.data[k]));
    const sol = part('solAmount') + part('fee') + part('creatorFee');
    const tokens = BigInt(str(ev.data.tokenAmount));
    // The curve right after their buy, as pump.fun wrote it: our buy is built from it with no network read.
    const has = (k: string) => ev!.data[k] !== undefined && ev!.data[k] !== null;
    const curve = {
      virtualTokenReserves: part('virtualTokenReserves'),
      virtualQuoteReserves: has('virtualQuoteReserves') && part('virtualQuoteReserves') > 0n ? part('virtualQuoteReserves') : part('virtualSolReserves'),
      realTokenReserves: part('realTokenReserves'),
      realQuoteReserves: has('realQuoteReserves') && part('realQuoteReserves') > 0n ? part('realQuoteReserves') : part('realSolReserves'),
      creator: str(ev.data.creator),
      mayhem: str(ev.data.mayhemMode) === 'true',
      cashback: part('cashbackFeeBasisPoints') > 0n || part('cashback') > 0n,
      ...(coinTokenProgram ? { tokenProgram: coinTokenProgram } : {}),
    };
    buys.push({ signature, leader, mint: str(ev.data.mint), side: 'buy', solLamports: sol, tokenAmount: tokens, tokensBefore: 0n, tokensAfter: tokens, venue: 'pumpfun', slot, blockTime: null, approx: true, curve, ...(heardAt ? { heardAt } : {}) });
  }
  return buys.length ? buys : null;
}
