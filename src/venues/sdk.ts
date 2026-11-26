// ported from velo/src/venues/sdk.ts
// The pump.fun SDKs' ESM builds import a named export from a CommonJS dependency, which Node's ESM loader
// rejects ("Named export 'BN' not found"). Their CommonJS builds load fine, so we require() those and keep the types.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const pumpSdk = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
export const pumpSwapSdk = require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');

export type { FeeConfig, Global } from '@pump-fun/pump-sdk';
export type { SwapSolanaState } from '@pump-fun/pump-swap-sdk';
