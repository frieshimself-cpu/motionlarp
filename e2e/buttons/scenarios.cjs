'use strict';
// The order of the whole suite for one screen size.
const { freshUser } = require('./s-fresh.cjs');

async function runAll(env) {
  const parts = {};
  for (const [name, file, fn] of [
    ['admin-first', './s-admin.cjs', 'adminFirstLook'],
    ['fresh', './s-fresh.cjs', 'freshUser'],
    ['alice', './s-alice.cjs', 'alice'],
    ['bob', './s-bob.cjs', 'bob'],
    ['admin', './s-admin.cjs', 'adminEverything'],
    ['admin-typing', './s-admin-typing.cjs', 'adminTyping'],
    ['extra', './s-extra.cjs', 'extras'],
  ]) {
    let mod;
    try { mod = require(file); } catch (err) { if (err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(file.slice(2))) { env.book.log(`(part ${name} not written yet)`); continue; } throw err; }
    if (typeof mod[fn] !== 'function') continue;
    try { parts[name] = await mod[fn](env, parts); } catch (err) { env.book.ok(`part "${name}" ran to its end`, false, String(err && err.stack ? err.stack : err).slice(0, 1500)); }
  }
}

module.exports = { runAll };
