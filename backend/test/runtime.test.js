// Catches "works on my machine, crashes on Vercel" before it ships.
// No emulator needed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BACKEND = path.join(__dirname, '..');
const pkg = require('../package.json');

describe('Vercel runtime compatibility', () => {
  // firebase-admin 14 pulled in an ESM-only `jose` through jwks-rsa. That
  // loads on Node versions that allow require() of ES modules and crashed
  // on Vercel with ERR_REQUIRE_ESM. Every function must load without it.
  for (const file of fs.readdirSync(path.join(BACKEND, 'api'))) {
    test(`api/${file} loads in a fresh process without require(esm)`, () => {
      const run = spawnSync(
        process.execPath,
        ['--no-experimental-require-module', '-e', `require('./api/${file}')`],
        { cwd: BACKEND, encoding: 'utf8' }
      );
      assert.equal(run.status, 0, run.stderr);
    });
  }

  test('tests run on the Node major that Vercel deploys (package.json engines)', () => {
    const wanted = pkg.engines.node.match(/^(\d+)\.x$/);
    assert.ok(wanted, `engines.node should be "<major>.x" so Vercel and CI resolve the same major, got ${pkg.engines.node}`);
    assert.equal(process.versions.node.split('.')[0], wanted[1], `running Node ${process.version}`);
  });
});
