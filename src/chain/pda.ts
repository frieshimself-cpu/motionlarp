// Program addresses (PDAs) are worked out once and remembered. The same seeds and program always give the same address,
// and working one out costs 0.1 to 0.2 ms in JavaScript (a hash and a curve check per try). A copy buy works out about a
// dozen (our own, pump.fun's SDK's, Anchor's and spl-token's, several of them twice): it was about 40 % of the time from
// their trade heard to ours sent. Remembered, those of the programs, of the wallet and of a coin seen before cost
// nothing. web3.js has one copy in node_modules, loaded through its CommonJS build by everyone (our code, the SDKs,
// Anchor, spl-token), so remembering it there covers every caller.
import { PublicKey } from '@solana/web3.js';

type Found = [PublicKey, number];
const CAP = 50_000;
const memo = new Map<string, Found>();
/** Each program's bytes as a string, by its PublicKey object (programs are mostly module constants). */
const programKeys = new WeakMap<PublicKey, string>();
/** Marks the remembering function (a test process may load this module more than once: it is put in place once). */
const REMEMBERING = Symbol.for('motionlarp.rememberProgramAddresses');

function programKey(programId: PublicKey): string {
  let k = programKeys.get(programId);
  if (k === undefined) {
    k = programId.toBuffer().toString('latin1');
    programKeys.set(programId, k);
  }
  return k;
}

/** The seeds exactly (each one's length, then its bytes) and the program. */
function keyOf(seeds: ReadonlyArray<Uint8Array>, programId: PublicKey): string {
  let k = '';
  for (const s of seeds) k += `${s.length}:${Buffer.from(s.buffer, s.byteOffset, s.byteLength).toString('latin1')}|`;
  return k + programKey(programId);
}

/** From now on PublicKey.findProgramAddressSync (and findProgramAddress, which calls it) remembers what it works out. */
export function rememberProgramAddresses(): void {
  if ((PublicKey.findProgramAddressSync as unknown as Record<symbol, boolean>)[REMEMBERING]) return;
  const find = PublicKey.findProgramAddressSync;
  const remembering = function (this: typeof PublicKey, seeds: Array<Buffer | Uint8Array>, programId: PublicKey): Found {
    const key = keyOf(seeds, programId);
    const hit = memo.get(key);
    if (hit) return [hit[0], hit[1]];
    // (a derivation that throws, a seed too long, is not remembered: it throws again next time)
    const found = find.call(this, seeds, programId) as Found;
    if (memo.size >= CAP) memo.delete(memo.keys().next().value!);
    memo.set(key, [found[0], found[1]]);
    return [found[0], found[1]];
  } as typeof PublicKey.findProgramAddressSync;
  (remembering as unknown as Record<symbol, boolean>)[REMEMBERING] = true;
  PublicKey.findProgramAddressSync = remembering;
}

/** Marks the remembering toBase58. */
const REMEMBERING_TEXT = Symbol.for('motionlarp.rememberAddressText');
const texts = new WeakMap<PublicKey, string>();

/**
 * From now on a PublicKey's base58 text is worked out once per key object and remembered. web3.js turns every account
 * of every instruction into its text to put a transaction together (about 3 µs each in JavaScript, some forty per copy
 * buy, several times over): about a quarter of the build once program addresses were remembered. A PublicKey never
 * changes, and toString and toJSON go through toBase58.
 */
export function rememberAddressText(): void {
  const proto = PublicKey.prototype as unknown as { toBase58: () => string } & Record<symbol, boolean>;
  if ((proto.toBase58 as unknown as Record<symbol, boolean>)[REMEMBERING_TEXT]) return;
  const toBase58 = proto.toBase58;
  const remembering = function (this: PublicKey): string {
    let s = texts.get(this);
    if (s === undefined) {
      s = toBase58.call(this);
      texts.set(this, s);
    }
    return s;
  };
  (remembering as unknown as Record<symbol, boolean>)[REMEMBERING_TEXT] = true;
  proto.toBase58 = remembering;
}
