// ported from velo/src/tx/send.ts
// The only place a transaction can leave the process. Rule 1: LIVE_TRADING=true or it is simulated.
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { config, executionMode } from '../config.js';
import { getConnection } from '../chain/connection.js';
import { log, safeErrorMessage } from '../log.js';

export type SendOutcome =
  | { ok: true; signature: string; simulated: boolean; computeUnits?: number; route: 'simulate' | 'rpc' | 'jito' }
  | { ok: false; error: string; logs?: string[] };

// Jito's published tip accounts, refreshed from the block engine at startup when reachable.
const DEFAULT_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];
let tipAccounts: string[] = DEFAULT_TIP_ACCOUNTS;

export async function refreshJitoTipAccounts(): Promise<void> {
  if (!config.jitoUrl) return;
  try {
    const res = await fetch(`${config.jitoUrl.replace(/\/$/, '')}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
    });
    const body = (await res.json()) as { result?: string[] };
    if (Array.isArray(body.result) && body.result.length > 0) tipAccounts = body.result;
  } catch (err) {
    log.warn('could not refresh Jito tip accounts; using defaults', { error: safeErrorMessage(err) });
  }
}

export function randomTipAccount(): PublicKey {
  const pick = tipAccounts[Math.floor(Math.random() * tipAccounts.length)] ?? DEFAULT_TIP_ACCOUNTS[0]!;
  return new PublicKey(pick);
}

export async function simulate(tx: VersionedTransaction): Promise<SendOutcome> {
  const connection = getConnection();
  const sim = await connection.simulateTransaction(tx, { sigVerify: true, commitment: 'confirmed' });
  if (sim.value.err) {
    const logs = sim.value.logs ?? [];
    const programLog = logs.filter((l) => /failed|Error|error/.test(l)).slice(-3).join(' | ');
    return { ok: false, error: `simulation failed: ${JSON.stringify(sim.value.err)} ${programLog}`.slice(0, 300), logs };
  }
  const sig = Buffer.from(tx.signatures[0] ?? new Uint8Array(0)).toString('hex').slice(0, 16);
  return { ok: true, signature: `SIMULATED_${sig}`, simulated: true, computeUnits: sim.value.unitsConsumed, route: 'simulate' };
}

async function sendViaRpc(tx: VersionedTransaction): Promise<SendOutcome> {
  const connection = getConnection();
  const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  return { ok: true, signature, simulated: false, route: 'rpc' };
}

async function sendViaJito(tx: VersionedTransaction): Promise<SendOutcome> {
  const base64 = Buffer.from(tx.serialize()).toString('base64');
  const res = await fetch(`${config.jitoUrl.replace(/\/$/, '')}/api/v1/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [base64, { encoding: 'base64' }] }),
  });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (!body.result) return { ok: false, error: `jito: ${body.error?.message ?? `HTTP ${res.status}`}`.slice(0, 300) };
  return { ok: true, signature: body.result, simulated: false, route: 'jito' };
}

/**
 * Simulate first in every mode; only a clean simulation may go live. `mevProtect` picks Jito over plain RPC.
 */
export async function sendTransaction(tx: VersionedTransaction, mevProtect: boolean): Promise<SendOutcome> {
  const mode = executionMode();
  if (mode === 'offline') return { ok: false, error: 'no RPC_URL configured' };
  const sim = await simulate(tx);
  if (!sim.ok || mode === 'simulate') return sim;
  // LIVE_TRADING=true and the simulation passed.
  try {
    return mevProtect ? await sendViaJito(tx) : await sendViaRpc(tx);
  } catch (err) {
    return { ok: false, error: `send failed: ${safeErrorMessage(err)}` };
  }
}
