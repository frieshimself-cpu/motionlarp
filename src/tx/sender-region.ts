// Helius Sender has regional endpoints; the one closest to this server saves a round trip across the world on
// every tipped trade. At start each region is timed and the fastest is used (regions from Helius's Sender docs).
export const SENDER_REGIONS = ['slc', 'ewr', 'lon', 'fra', 'ams', 'sg', 'tyo'];
export const GLOBAL_SENDER = 'https://sender.helius-rpc.com/fast';

export const regionUrl = (region: string) => `http://${region}-sender.helius-rpc.com/fast`;

/** Milliseconds for one GET of the region's /ping; throws when it does not answer. */
export async function pingRegion(region: string): Promise<number> {
  const t0 = performance.now();
  const res = await fetch(`http://${region}-sender.helius-rpc.com/ping`, { signal: AbortSignal.timeout(3_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await res.text();
  return performance.now() - t0;
}

/** Two tries per region (the first includes connection setup); the lowest time wins. */
export async function chooseSender(ping: (region: string) => Promise<number> = pingRegion): Promise<{ region: string; url: string; ms: number } | null> {
  const timed = await Promise.all(SENDER_REGIONS.map(async (region) => {
    let best = Infinity;
    for (let i = 0; i < 2; i++) {
      try {
        best = Math.min(best, await ping(region));
      } catch {
        // this try failed; the other may not
      }
    }
    return { region, ms: best };
  }));
  const winner = timed.filter((t) => Number.isFinite(t.ms)).sort((a, b) => a.ms - b.ms)[0];
  return winner ? { region: winner.region, url: regionUrl(winner.region), ms: Math.round(winner.ms) } : null;
}
