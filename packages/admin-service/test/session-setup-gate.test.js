/**
 * Copyright (C) 2022-2024 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Regression tests for the first-run admin-setup authorization gate.
 *
 * Background: in "setup mode" (no admin credential configured), POST /admin/setup
 * is unauthenticated by nature — it creates the very first credential. Without a
 * gate, the first network client to reach the port could claim admin ownership
 * (Codex finding "Unauthenticated first-run admin setup enables takeover").
 *
 * These tests exercise the gate logic in admin/middleware/session.js. The module
 * reads its config from env at load time, so each scenario clears the require
 * cache and re-requires with the desired env.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const SESSION_PATH = require.resolve('../admin/middleware/session.js');

let authFileSeq = 0;

// Load session.js fresh under a given env overlay. Auth-related env is wiped
// first so a stray ambient ADMIN_PASSWORD can't flip the module out of setup
// mode. ADMIN_AUTH_FILE is pointed at a throwaway path so no real file is read.
function loadSession(envOverlay = {}) {
  const AUTH_KEYS = [
    'ADMIN_PASSWORD',
    'ADMIN_PASSWORD_HASH',
    'ADMIN_AUTH_FILE',
    'ADMIN_SETUP_TOKEN',
    'ADMIN_TRUST_PROXY',
    'ADMIN_USERNAME',
  ];
  for (const k of AUTH_KEYS) delete process.env[k];
  process.env.ADMIN_AUTH_FILE = path.join(
    os.tmpdir(),
    `admin-auth-test-${process.pid}-${authFileSeq++}.json`
  );
  Object.assign(process.env, envOverlay);
  delete require.cache[SESSION_PATH];
  return require(SESSION_PATH);
}

// Minimal Koa-ctx stand-in for the gate: socket peer + optional headers.
function makeCtx({ remoteAddress = '', headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    req: { socket: { remoteAddress } },
    get(field) {
      return lower[String(field).toLowerCase()] || '';
    },
  };
}

test('isLoopbackAddr recognizes loopback forms and rejects routable IPs', () => {
  const s = loadSession();
  for (const a of ['127.0.0.1', '127.0.0.5', '::1', '::ffff:127.0.0.1']) {
    assert.equal(s.isLoopbackAddr(a), true, `${a} should be loopback`);
  }
  for (const a of ['10.0.0.5', '192.168.1.10', '8.8.8.8', '::ffff:10.0.0.5', '', undefined]) {
    assert.equal(s.isLoopbackAddr(a), false, `${a} should NOT be loopback`);
  }
});

test('loopback-only mode (default): localhost is allowed', () => {
  const s = loadSession();
  assert.equal(s.hasSetupToken(), false);
  const res = s.isSetupRequestAllowed(makeCtx({ remoteAddress: '127.0.0.1' }), {});
  assert.deepEqual(res, { ok: true });
});

test('loopback-only mode: remote client is blocked (the takeover vector)', () => {
  const s = loadSession();
  const res = s.isSetupRequestAllowed(makeCtx({ remoteAddress: '203.0.113.7' }), {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'remote_setup_not_allowed');
});

test('trusted proxy without a token blocks even a loopback socket', () => {
  // A reverse proxy makes every client appear to connect from loopback, so the
  // socket address can no longer prove locality — a token must be required.
  const s = loadSession({ ADMIN_TRUST_PROXY: 'true' });
  const res = s.isSetupRequestAllowed(makeCtx({ remoteAddress: '127.0.0.1' }), {});
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'proxy_requires_setup_token');
});

test('token mode: matching token in header authorizes a remote client', () => {
  const s = loadSession({ ADMIN_SETUP_TOKEN: 'super-secret-token' });
  assert.equal(s.hasSetupToken(), true);
  const ctx = makeCtx({
    remoteAddress: '203.0.113.7',
    headers: { 'x-admin-setup-token': 'super-secret-token' },
  });
  assert.deepEqual(s.isSetupRequestAllowed(ctx, {}), { ok: true });
});

test('token mode: matching token in body authorizes', () => {
  const s = loadSession({ ADMIN_SETUP_TOKEN: 'super-secret-token' });
  const ctx = makeCtx({ remoteAddress: '203.0.113.7' });
  assert.deepEqual(
    s.isSetupRequestAllowed(ctx, { setupToken: 'super-secret-token' }),
    { ok: true }
  );
});

test('token mode: wrong or missing token is blocked (even from loopback)', () => {
  const s = loadSession({ ADMIN_SETUP_TOKEN: 'super-secret-token' });
  const wrong = s.isSetupRequestAllowed(
    makeCtx({ remoteAddress: '127.0.0.1', headers: { 'x-admin-setup-token': 'nope' } }),
    {}
  );
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'invalid_or_missing_setup_token');

  const missing = s.isSetupRequestAllowed(makeCtx({ remoteAddress: '127.0.0.1' }), {});
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'invalid_or_missing_setup_token');
});

test('token mode: trusted proxy + matching token is allowed', () => {
  const s = loadSession({ ADMIN_SETUP_TOKEN: 'tok', ADMIN_TRUST_PROXY: 'true' });
  const ctx = makeCtx({ remoteAddress: '203.0.113.7', headers: { 'x-admin-setup-token': 'tok' } });
  assert.deepEqual(s.isSetupRequestAllowed(ctx, {}), { ok: true });
});

test('setupCredential persists a hash and refuses a second setup', async () => {
  const s = loadSession();
  assert.equal(s.isSetupMode(), true);

  const ok = await s.setupCredential('operator', 'a-strong-password');
  assert.equal(ok.ok, true);
  assert.equal(ok.username, 'operator');
  assert.equal(s.isSetupMode(), false, 'setup mode must close after provisioning');

  // File written hash-only, mode 600.
  const saved = JSON.parse(fs.readFileSync(process.env.ADMIN_AUTH_FILE, 'utf8'));
  assert.equal(saved.username, 'operator');
  assert.ok(saved.hash.startsWith('$argon2'), 'must store an Argon2id hash');
  assert.equal(saved.password, undefined, 'must not store plaintext');
  assert.equal(fs.statSync(process.env.ADMIN_AUTH_FILE).mode & 0o777, 0o600);

  // Re-setup is refused (not a password-reset back door).
  const again = await s.setupCredential('attacker', 'another-password');
  assert.equal(again.ok, false);

  fs.unlinkSync(process.env.ADMIN_AUTH_FILE);
});

test('setupCredential rejects a short password', async () => {
  const s = loadSession();
  const res = await s.setupCredential('operator', 'short');
  assert.equal(res.ok, false);
  assert.match(res.error, /at least 8/);
});
