// deploy/keys-to-env.sh runs on the server (as root, from the automatic updater): it writes the Helius link and the
// Jupiter key into the server's .env once. Here it runs against a throwaway folder, with stand-ins for the two
// docker commands it would call.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../deploy/keys-to-env.sh');
const RPC = 'https://mainnet.helius-rpc.com/?api-key=9e1b6213-aaaa-bbbb-cccc-1234567890ab';
const JUP = 'f3a1c0de-1111-2222-3333-444455556666';
const BASE_ENV = 'DOMAIN=example.app\nADMIN_PASSWORD=correct horse battery\nMASTER_KEY=' + 'ab'.repeat(32) + '\nPORT=3000\n';

function server(env: string, exported: string, exportFails = false) {
  const dir = mkdtempSync(join(tmpdir(), 'ml-keys-'));
  writeFileSync(join(dir, '.env'), env, { mode: 0o600 });
  writeFileSync(join(dir, 'exported.txt'), exported);
  writeFileSync(join(dir, 'export.sh'), `echo called >> "${dir}/export-calls"\n${exportFails ? 'exit 1' : `cat "${dir}/exported.txt"`}\n`);
  writeFileSync(join(dir, 'restart.sh'), `echo restarted >> "${dir}/restarts"\n`);
  const run = () => execFileSync('bash', [SCRIPT], {
    env: { ...process.env, MOTIONLARP_DIR: dir, MOTIONLARP_EXPORT: `bash ${dir}/export.sh`, MOTIONLARP_RESTART: `bash ${dir}/restart.sh` },
    encoding: 'utf8',
  });
  const env_ = () => readFileSync(join(dir, '.env'), 'utf8');
  const count = (file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8').trim().split('\n').length : 0);
  return { dir, run, env: env_, restarts: () => count('restarts'), exportCalls: () => count('export-calls') };
}

describe('moving the Helius link and the Jupiter key into the server file', () => {
  it('writes both into .env, keeps every other line, restarts once, and never prints a value', () => {
    const s = server(`${BASE_ENV}RPC_URL=\nLIVE_TRADING=false\n`, `RPC_URL=${RPC}\nJUPITER_API_KEY=${JUP}\n`);
    const out = s.run();
    const lines = s.env().trim().split('\n');
    expect(lines).toContain(`RPC_URL=${RPC}`);
    expect(lines).toContain(`JUPITER_API_KEY=${JUP}`);
    expect(lines.filter((l) => l.startsWith('RPC_URL='))).toHaveLength(1);
    for (const kept of ['DOMAIN=example.app', 'ADMIN_PASSWORD=correct horse battery', `MASTER_KEY=${'ab'.repeat(32)}`, 'PORT=3000', 'LIVE_TRADING=false']) expect(lines).toContain(kept);
    expect(s.restarts()).toBe(1);
    expect(out).not.toContain('9e1b6213');
    expect(out).not.toContain(JUP);
    expect(out).toMatch(/RPC_URL/);
    expect(statSync(join(s.dir, '.env')).mode & 0o777).toBe(0o600);
    // the file as it was is kept next to it, readable by root only
    expect(readFileSync(join(s.dir, '.env.before-keys'), 'utf8')).toBe(`${BASE_ENV}RPC_URL=\nLIVE_TRADING=false\n`);
    expect(statSync(join(s.dir, '.env.before-keys')).mode & 0o777).toBe(0o600);
  });

  it('running it again changes nothing and does not restart again', () => {
    const s = server(BASE_ENV, `RPC_URL=${RPC}\nJUPITER_API_KEY=${JUP}\n`);
    s.run();
    const after = s.env();
    s.run();
    expect(s.env()).toBe(after);
    expect(s.restarts()).toBe(1);
    expect(s.exportCalls()).toBe(1);
  });

  it('a value already in the file is never replaced', () => {
    const mine = 'https://mainnet.helius-rpc.com/?api-key=mine-mine-mine';
    const s = server(`${BASE_ENV}RPC_URL=${mine}\n`, `RPC_URL=${RPC}\nJUPITER_API_KEY=${JUP}\n`);
    s.run();
    const lines = s.env().trim().split('\n');
    expect(lines).toContain(`RPC_URL=${mine}`);
    expect(lines).not.toContain(`RPC_URL=${RPC}`);
    expect(lines).toContain(`JUPITER_API_KEY=${JUP}`);
  });

  it.each([
    ['nothing was ever saved on the admin page', '', false],
    ['the app is not running', `RPC_URL=${RPC}\n`, true],
    ['the output is not what was expected', 'Error: something else\nRPC_URL=\n', false],
  ])('%s: the file is left exactly as it was', (_why, exported, fails) => {
    const s = server(BASE_ENV, exported, fails);
    s.run();
    expect(s.env()).toBe(BASE_ENV);
    expect(s.restarts()).toBe(0);
    expect(existsSync(join(s.dir, '.env.before-keys'))).toBe(false);
  });

  it('set-keys.sh writes the two values the owner types on the server, replacing old ones, and restarts', () => {
    const s = server(`${BASE_ENV}RPC_URL=https://old.example/?api-key=old\n`, '');
    const out = execFileSync('bash', [resolve(__dirname, '../deploy/set-keys.sh')], {
      env: { ...process.env, MOTIONLARP_DIR: s.dir, MOTIONLARP_RESTART: `bash ${s.dir}/restart.sh`, MOTIONLARP_SKIP_CHECK: '1', HELIUS_RPC_URL: RPC, JUPITER_KEY: JUP },
      encoding: 'utf8',
    });
    const lines = s.env().trim().split('\n');
    expect(lines.filter((l) => l.startsWith('RPC_URL='))).toEqual([`RPC_URL=${RPC}`]);
    expect(lines).toContain(`JUPITER_API_KEY=${JUP}`);
    expect(lines).toContain('ADMIN_PASSWORD=correct horse battery');
    expect(statSync(join(s.dir, '.env')).mode & 0o777).toBe(0o600);
    expect(s.restarts()).toBe(1);
    expect(out).not.toContain('9e1b6213');
    expect(out).not.toContain(JUP);
  });

  it('set-keys.sh refuses something that is not a link and changes nothing', () => {
    const s = server(BASE_ENV, '');
    let failed = false;
    try {
      execFileSync('bash', [resolve(__dirname, '../deploy/set-keys.sh')], { env: { ...process.env, MOTIONLARP_DIR: s.dir, MOTIONLARP_RESTART: `bash ${s.dir}/restart.sh`, MOTIONLARP_SKIP_CHECK: '1', HELIUS_RPC_URL: 'my password 123', JUPITER_KEY: JUP }, encoding: 'utf8', stdio: 'pipe' });
    } catch { failed = true; }
    expect(failed).toBe(true);
    expect(s.env()).toBe(BASE_ENV);
    expect(s.restarts()).toBe(0);
  });

  it('no .env at all (not installed): does nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ml-keys-'));
    execFileSync('bash', [SCRIPT], { env: { ...process.env, MOTIONLARP_DIR: dir, MOTIONLARP_EXPORT: 'false', MOTIONLARP_RESTART: 'false' } });
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });
});
