// deploy/update.sh runs on the server every 2 minutes (cron): it pulls new commits, rebuilds and restarts. From the
// review of running unattended (27 Nov 2026): a failed build was never tried again (the checkout already said "up to
// date"), and a version that crashed at start was left crash-looping with every open position unattended. Here it runs
// against a throwaway git server and checkout, with stand-ins for docker (a build that works or fails, an app that
// answers or not).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../deploy/update.sh');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

function server() {
  const root = mkdtempSync(join(tmpdir(), 'ml-update-'));
  const origin = join(root, 'origin.git');
  const work = join(root, 'work');
  const dir = join(root, 'server');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, work]);
  const commit = (msg: string) => { writeFileSync(join(work, 'f.txt'), msg); git(work, 'add', '.'); git(work, 'commit', '-qm', msg); git(work, 'push', '-q', 'origin', 'HEAD:main'); return git(work, 'rev-parse', 'HEAD'); };
  const first = commit('v1');
  execFileSync('git', ['clone', '-q', origin, dir]);
  // stand-ins: "docker compose up -d --build" records the commit it built; the build or the app can be told to fail
  writeFileSync(join(root, 'compose.sh'), `echo "$(git -C "${dir}" rev-parse HEAD) COMMIT=$COMMIT" >> "${root}/builds"\n[ -f "${root}/build-fails" ] && [ "$(git -C "${dir}" rev-parse HEAD)" = "$(cat "${root}/build-fails")" ] && exit 1\nexit 0\n`);
  writeFileSync(join(root, 'health.sh'), `[ -f "${root}/app-dies" ] && [ "$(git -C "${dir}" rev-parse HEAD)" = "$(cat "${root}/app-dies")" ] && exit 1\nexit 0\n`);
  const run = () => execFileSync('bash', [SCRIPT], {
    env: { ...process.env, MOTIONLARP_DIR: dir, MOTIONLARP_COMPOSE: `bash ${root}/compose.sh`, MOTIONLARP_HEALTH: `bash ${root}/health.sh`, MOTIONLARP_HEALTH_TRIES: '2', MOTIONLARP_HEALTH_PAUSE: '0', MOTIONLARP_LOCK: join(root, 'lock') },
    encoding: 'utf8',
  });
  const builds = () => (existsSync(join(root, 'builds')) ? readFileSync(join(root, 'builds'), 'utf8').trim().split('\n') : []);
  return { root, dir, commit, first, run, builds, head: () => git(dir, 'rev-parse', 'HEAD'), deployed: () => (existsSync(join(dir, '.deployed')) ? readFileSync(join(dir, '.deployed'), 'utf8').trim() : null) };
}

describe('the automatic updater', () => {
  it('a new commit is built, checked that the app answers, and written down as deployed; the build knows its commit', () => {
    const s = server();
    const v2 = s.commit('v2');
    s.run();
    expect(s.head()).toBe(v2);
    expect(s.deployed()).toBe(v2);
    expect(s.builds()).toEqual([`${v2} COMMIT=${v2.slice(0, 7)}`]);
    s.run(); // nothing new: nothing built
    expect(s.builds()).toHaveLength(1);
  });

  it('a build that fails is tried again on a later run (it was never tried again)', () => {
    const s = server();
    const v2 = s.commit('v2');
    writeFileSync(join(s.root, 'build-fails'), v2);
    s.run();
    expect(s.deployed()).not.toBe(v2);
    expect(s.head()).toBe(s.first); // rolled back to what ran before
    // the cause goes away (the network, the disk): after the pause before a retry it is built again
    writeFileSync(join(s.root, 'build-fails'), 'none');
    writeFileSync(join(s.dir, '.failed'), `${v2} 0`); // the pause has passed
    s.run();
    expect(s.deployed()).toBe(v2);
  });

  it('a version whose app does not answer after the restart is rolled back to the one that ran before', () => {
    const s = server();
    s.run(); // v1 deployed
    const v2 = s.commit('v2 crashes at start');
    writeFileSync(join(s.root, 'app-dies'), v2);
    const out = s.run();
    expect(out).toMatch(/rolled back/i);
    expect(s.head()).toBe(s.first);
    expect(s.builds().at(-1)).toMatch(new RegExp(`^${s.first}`)); // the old version was built and started again
    expect(s.deployed()).toBe(s.first);
    s.run(); // the broken commit is not retried every 2 minutes (it would restart the app each time)
    expect(s.builds().filter((b) => b.startsWith(v2))).toHaveLength(1);
    const v3 = s.commit('v3 fixed');
    s.run();
    expect(s.deployed()).toBe(v3);
  });
});
