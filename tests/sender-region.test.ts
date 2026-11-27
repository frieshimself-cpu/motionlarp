import { describe, expect, it } from 'vitest';
import { chooseSender, SENDER_REGIONS } from '../src/tx/sender-region.js';

describe('nearest Helius Sender region', () => {
  it('picks the region that answers fastest (best of its tries)', async () => {
    const ms: Record<string, number[]> = { fra: [9, 4], ams: [12, 11], lon: [20, 19] };
    const tries: Record<string, number> = {};
    const r = await chooseSender(async (region) => {
      const i = (tries[region] = (tries[region] ?? 0) + 1) - 1;
      const v = ms[region]?.[i];
      if (v === undefined) throw new Error('unreachable');
      return v;
    });
    expect(r).toEqual({ region: 'fra', url: 'http://fra-sender.helius-rpc.com/fast', ms: 4 });
  });
  it('no region answers: null (the global endpoint stays)', async () => {
    expect(await chooseSender(async () => { throw new Error('down'); })).toBeNull();
  });
  it('knows the regions Helius lists', () => {
    expect(SENDER_REGIONS).toEqual(['slc', 'ewr', 'lon', 'fra', 'ams', 'sg', 'tyo']);
  });
});
