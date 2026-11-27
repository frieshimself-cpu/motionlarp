// A seeded random generator and a virtual clock. Everything in a scenario runs on the virtual clock: the engine's
// own `now()`, the fake market's confirmation times and the engine's retry pauses (its `setTimeout` calls are routed
// here while a scenario runs). No real time passes, so a seed replays exactly.

/** mulberry32: small, fast, good enough for test generation. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
  /** Picks by weight: [[weight, value], ...]. */
  weighted<T>(items: readonly (readonly [number, T])[]): T {
    let total = 0;
    for (const [w] of items) total += w;
    let x = this.next() * total;
    for (const [w, v] of items) {
      x -= w;
      if (x < 0) return v;
    }
    return items[items.length - 1]![1];
  }
  /** An independent stream derived from this seed and a label. */
  static derive(seed: number, label: string): Rng {
    let h = (seed ^ 0x811c9dc5) >>> 0;
    for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 0x01000193) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return new Rng((h ^ (h >>> 16)) >>> 0);
  }
}

interface Ev { at: number; seq: number; fn: () => void; dead?: boolean }

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetImmediate = globalThis.setImmediate;

export class SimSpin extends Error {}

export class Sim {
  now: number;
  /** Events fired so far (a watchdog against an engine loop that never lets time pass). */
  fired = 0;
  private heap: Ev[] = [];
  private seq = 0;
  /** Called after each event's promise continuations have run. */
  afterEvent: (() => void) | null = null;
  maxEvents = 3_000_000;

  constructor(start: number) {
    this.now = start;
  }

  schedule(delayMs: number, fn: () => void): Ev {
    const ev: Ev = { at: this.now + Math.max(0, delayMs), seq: this.seq++, fn };
    this.push(ev);
    return ev;
  }

  pending(): number {
    return this.heap.length;
  }

  nextAt(): number | null {
    while (this.heap.length && this.heap[0]!.dead) this.pop();
    return this.heap.length ? this.heap[0]!.at : null;
  }

  /** Lets every promise continuation that is ready run to its next real wait. */
  drain(): Promise<void> {
    return new Promise((r) => realSetImmediate(r));
  }

  /** Fires every event due up to now + dt, in time order, letting the engine react after each; then sets the clock. */
  async advance(dt: number): Promise<void> {
    const target = this.now + Math.max(0, dt);
    let sameInstant = 0;
    let lastAt = -1;
    for (;;) {
      const at = this.nextAt();
      if (at === null || at > target) break;
      const ev = this.pop()!;
      if (ev.at > this.now) this.now = ev.at;
      if (ev.at === lastAt) sameInstant++; else { sameInstant = 0; lastAt = ev.at; }
      if (sameInstant > 200_000 || ++this.fired > this.maxEvents) throw new SimSpin(`the engine keeps scheduling work without finishing (${this.fired} events, ${sameInstant} at the same instant)`);
      ev.fn();
      await this.drain();
      this.afterEvent?.();
    }
    this.now = target;
    await this.drain();
    this.afterEvent?.();
  }

  /** Runs everything that is due right now (zero-delay retries and their consequences). */
  settle(): Promise<void> {
    return this.advance(0);
  }

  // ── a small binary heap ordered by (at, seq) ──
  private less(a: Ev, b: Ev): boolean {
    return a.at < b.at || (a.at === b.at && a.seq < b.seq);
  }
  private push(ev: Ev): void {
    const h = this.heap;
    h.push(ev);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  private pop(): Ev | undefined {
    const h = this.heap;
    if (!h.length) return undefined;
    const top = h[0]!;
    const last = h.pop()!;
    if (h.length) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
        if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }

  // ── the engine's setTimeout / clearTimeout, on the virtual clock ──
  private installed = false;
  install(): void {
    if (this.installed) return;
    this.installed = true;
    const sim = this;
    (globalThis as { setTimeout: unknown }).setTimeout = function (fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) {
      const ev = sim.schedule(Number(ms) || 0, () => fn(...args));
      const handle = { ev, ref: () => handle, unref: () => handle, hasRef: () => true, refresh: () => handle, [Symbol.toPrimitive]: () => ev.seq };
      return handle;
    };
    (globalThis as { clearTimeout: unknown }).clearTimeout = function (handle: unknown) {
      const ev = (handle as { ev?: Ev } | undefined)?.ev;
      if (ev) ev.dead = true;
      else realClearTimeout(handle as never);
    };
  }
  uninstall(): void {
    if (!this.installed) return;
    this.installed = false;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
}
