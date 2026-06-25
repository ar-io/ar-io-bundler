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
 * End-to-end HTTP test of the first-run /admin/setup gate against a REAL Koa
 * server and real request sockets/headers — exercising sessionAuth's gate the
 * same way server.js does, without the full stats/Bull-Board stack.
 *
 * It demonstrates the takeover fix: a setup POST that fails the gate gets 403 and
 * never provisions a credential; one that passes provisions and logs in.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Koa = require('koa');

const SESSION_PATH = require.resolve('../admin/middleware/session.js');
let seq = 0;

function loadSession(envOverlay = {}) {
  for (const k of ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'ADMIN_AUTH_FILE',
    'ADMIN_SETUP_TOKEN', 'ADMIN_TRUST_PROXY', 'ADMIN_USERNAME']) delete process.env[k];
  process.env.ADMIN_AUTH_FILE = path.join(os.tmpdir(), `admin-auth-http-${process.pid}-${seq++}.json`);
  Object.assign(process.env, envOverlay);
  delete require.cache[SESSION_PATH];
  return require(SESSION_PATH);
}

// Build a Koa app exposing POST /admin/setup with the SAME gate wiring as
// server.js (the gate is the security boundary under test).
function buildApp(sessionAuth) {
  const app = new Koa();
  app.keys = ['test-cookie-signing-key']; // required for signed session cookies
  app.proxy = process.env.ADMIN_TRUST_PROXY === 'true';
  app.use(async (ctx) => {
    if (ctx.method !== 'POST' || ctx.path !== '/admin/setup') { ctx.status = 404; return; }
    if (!sessionAuth.isSetupMode()) { ctx.status = 409; ctx.body = { error: 'configured' }; return; }
    const body = await new Promise((resolve) => {
      let d = '';
      ctx.req.on('data', (c) => (d += c));
      ctx.req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
    });
    const access = sessionAuth.isSetupRequestAllowed(ctx, body);
    if (!access.ok) { ctx.status = 403; ctx.body = { error: 'blocked', reason: access.reason }; return; }
    const result = await sessionAuth.setupCredential(body.username, body.password);
    if (!result.ok) { ctx.status = 400; ctx.body = { error: result.error }; return; }
    const sid = sessionAuth.createSession(result.username);
    sessionAuth.setSessionCookie(ctx, sid);
    ctx.body = { ok: true };
  });
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function postSetup(server, { body = {}, headers = {} } = {}) {
  const payload = JSON.stringify(body);
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', path: '/admin/setup',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {}, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test('loopback POST provisions the admin credential and sets a session cookie', async () => {
  // Plain-HTTP test socket → mirror the documented tunnel setting so the signed
  // session cookie isn't rejected for being Secure over an unencrypted socket.
  const sessionAuth = loadSession({ ADMIN_COOKIE_SECURE: 'false' });
  const server = await listen(buildApp(sessionAuth));
  try {
    const res = await postSetup(server, { body: { username: 'operator', password: 'a-strong-password' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(String(res.headers['set-cookie'] || '').includes('arbundler_admin_session'));
    assert.equal(sessionAuth.isSetupMode(), false);
  } finally {
    server.close();
    fs.rmSync(process.env.ADMIN_AUTH_FILE, { force: true });
  }
});

test('trusted-proxy POST without token is rejected and provisions NOTHING', async () => {
  // Connection is loopback, but ADMIN_TRUST_PROXY=true means socket-loopback no
  // longer proves locality, so the takeover path must be blocked.
  const sessionAuth = loadSession({ ADMIN_TRUST_PROXY: 'true' });
  const server = await listen(buildApp(sessionAuth));
  try {
    const res = await postSetup(server, {
      body: { username: 'attacker', password: 'attacker-password' },
      headers: { 'x-forwarded-for': '203.0.113.9' },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.reason, 'proxy_requires_setup_token');
    assert.equal(sessionAuth.isSetupMode(), true, 'credential must NOT have been created');
    assert.equal(fs.existsSync(process.env.ADMIN_AUTH_FILE), false);
  } finally {
    server.close();
  }
});

test('token mode: correct x-admin-setup-token provisions; wrong token is blocked', async () => {
  const sessionAuth = loadSession({ ADMIN_SETUP_TOKEN: 'operator-secret', ADMIN_TRUST_PROXY: 'true', ADMIN_COOKIE_SECURE: 'false' });
  const server = await listen(buildApp(sessionAuth));
  try {
    const bad = await postSetup(server, {
      body: { username: 'x', password: 'password-1234' },
      headers: { 'x-admin-setup-token': 'wrong' },
    });
    assert.equal(bad.status, 403);
    assert.equal(bad.body.reason, 'invalid_or_missing_setup_token');
    assert.equal(sessionAuth.isSetupMode(), true);

    const good = await postSetup(server, {
      body: { username: 'operator', password: 'password-1234' },
      headers: { 'x-admin-setup-token': 'operator-secret' },
    });
    assert.equal(good.status, 200);
    assert.equal(good.body.ok, true);
    assert.equal(sessionAuth.isSetupMode(), false);
  } finally {
    server.close();
    fs.rmSync(process.env.ADMIN_AUTH_FILE, { force: true });
  }
});
