import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { newLicenseKey, licenseHash } from '../src/licenses.js';
import { validateSettings } from '../src/engine/settings.js';

const LEADER = '2526KSACRprzAPEGYFvrDLP1EFQddZ5m6j4kDPwaNXYB';
let store: Store;
beforeEach(() => { store = new Store(':memory:'); });

describe('license keys', () => {
  it('a key looks like WM-XXXX-XXXX-XXXX-XXXX and hashes the same whatever its case or spacing', () => {
    const k = newLicenseKey();
    expect(k).toMatch(/^WM-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(licenseHash(` ${k.toLowerCase()} `)).toBe(licenseHash(k));
    expect(newLicenseKey()).not.toBe(k);
  });

  it('is stored hashed, redeemed once, and carries its own fee', () => {
    const key = newLicenseKey();
    const id = store.createLicense({ keyHash: licenseHash(key), hint: key.slice(-4), label: 'Tom', feeBps: 50 });
    expect(JSON.stringify(store.licenses())).not.toContain(key);
    const alice = store.createUser('alice', 'x');
    const bob = store.createUser('bob', 'x');
    expect(store.redeemLicense(id, alice)).toBe(true);
    expect(store.redeemLicense(id, bob)).toBe(false);
    expect(store.licenses()[0]).toMatchObject({ label: 'Tom', feeBps: 50, usedBy: alice, username: 'alice', revoked: false });
    expect(store.userLicense(alice)).toMatchObject({ feeBps: 50 });
    expect(store.userLicense(bob)).toBeUndefined();
  });

  it('a revoked key cannot be redeemed; revoking a used key disables its user, restoring re-enables', () => {
    const unused = store.createLicense({ keyHash: 'h1', hint: 'aaaa', label: 'a', feeBps: null });
    store.setLicenseRevoked(unused, true);
    const u = store.createUser('carl', 'x');
    expect(store.redeemLicense(unused, u)).toBe(false);

    const used = store.createLicense({ keyHash: 'h2', hint: 'bbbb', label: 'b', feeBps: null });
    store.redeemLicense(used, u);
    store.setLicenseRevoked(used, true);
    expect(store.user(u)!.disabled).toBe(true);
    store.setLicenseRevoked(used, false);
    expect(store.user(u)!.disabled).toBe(false);
  });

  it('only an unused key can be deleted', () => {
    const a = store.createLicense({ keyHash: 'h1', hint: 'aaaa', label: 'a', feeBps: null });
    const b = store.createLicense({ keyHash: 'h2', hint: 'bbbb', label: 'b', feeBps: null });
    store.redeemLicense(b, store.createUser('dan', 'x'));
    expect(store.deleteLicense(a)).toBe(true);
    expect(store.deleteLicense(b)).toBe(false);
  });

  it("a disabled user's copies are not served and their leaders not watched", () => {
    const u = store.createUser('eve', 'x');
    store.createCopy(u, validateSettings({ leader: LEADER, buySol: 0.1 }));
    expect(store.enabledCopiesForLeader(LEADER)).toHaveLength(1);
    store.setUserDisabled(u, true);
    expect(store.enabledCopiesForLeader(LEADER)).toHaveLength(0);
    expect(store.watchedLeaders()).toEqual([]);
  });
});

describe('owner settings', () => {
  it('are saved and read back; later values replace earlier ones', () => {
    store.setSettings({ fee_bps: '100', live_trading: 'false' });
    store.setSettings({ fee_bps: '250' });
    expect(store.settings()).toEqual({ fee_bps: '250', live_trading: 'false' });
  });
});
