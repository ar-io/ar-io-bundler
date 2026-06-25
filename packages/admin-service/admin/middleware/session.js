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
 * Admin Dashboard Session Authentication
 *
 * Replaces HTTP Basic Auth with a proper login flow:
 *  - POST /admin/login verifies credentials, then issues a SIGNED, httpOnly,
 *    SameSite cookie holding an opaque server-side session id.
 *  - Sessions expire after ADMIN_SESSION_TTL_MS and can be revoked via logout.
 *  - Per-IP brute-force lockout throttles credential guessing.
 *
 * Passwords are verified against an Argon2id hash (ADMIN_PASSWORD_HASH), the
 * OWASP first-choice password KDF. Legacy scrypt hashes (scrypt$…) are still
 * accepted so older configs keep working, and a plaintext ADMIN_PASSWORD is
 * accepted as a last resort but logs a warning recommending migration to a hash
 * (generate one with `yarn hash-password`).
 *
 * Argon2id is provided by hash-wasm (pure WebAssembly) so there is no native
 * build/node-gyp dependency.
 */

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { argon2id, argon2Verify } = require('hash-wasm');

const COOKIE_NAME = 'arbundler_admin_session';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // legacy plaintext fallback

// File where a password set via the first-run UI is persisted (hash only). Lives
// outside the git tree so deploys don't clobber it; chmod 600. Env vars above
// take precedence over this file when set.
const ADMIN_AUTH_FILE = process.env.ADMIN_AUTH_FILE
  || path.join(__dirname, '../../../../.admin-auth.json');

// In-memory copy of the file credential: { username, hash } or null.
let fileCredential = loadFileCredential();

function loadFileCredential() {
  try {
    const raw = fs.readFileSync(ADMIN_AUTH_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j.username === 'string' && typeof j.hash === 'string' && j.hash) {
      return { username: j.username, hash: j.hash };
    }
  } catch { /* not set up yet */ }
  return null;
}

const SESSION_TTL_MS = parseInt(
  process.env.ADMIN_SESSION_TTL_MS || String(8 * 60 * 60 * 1000), // 8 hours
  10
);
// Cookies are marked Secure by default. When the dashboard is reached over a
// plain-HTTP tunnel (the documented admin-only access model), set
// ADMIN_COOKIE_SECURE=false so the browser will actually send the cookie back.
const SECURE_COOKIES = process.env.ADMIN_COOKIE_SECURE !== 'false';

const MAX_FAILED_LOGINS = parseInt(process.env.ADMIN_MAX_FAILED_LOGINS || '5', 10);
const LOCKOUT_MS = parseInt(
  process.env.ADMIN_LOCKOUT_MS || String(15 * 60 * 1000), // 15 minutes
  10
);

// First-run setup is UNAUTHENTICATED by nature (it creates the very first admin
// credential), so it must be gated to the operator or the first network client
// to reach the port could claim admin ownership. Two gates:
//   - ADMIN_SETUP_TOKEN: when set, a matching token (header x-admin-setup-token
//     or JSON body `setupToken`) authorizes setup from anywhere — the explicit
//     operator-secret path for proxied/remote deployments.
//   - otherwise: setup is permitted only from a loopback peer (the documented
//     SSH-tunnel / localhost admin model). A trusted reverse proxy makes every
//     remote client's socket look loopback, so when ADMIN_TRUST_PROXY is on we
//     can no longer treat socket-loopback as proof of locality — a token (or
//     env-provisioned credential) is then required.
const ADMIN_SETUP_TOKEN = process.env.ADMIN_SETUP_TOKEN || '';
const ADMIN_TRUST_PROXY = process.env.ADMIN_TRUST_PROXY === 'true';

// ---------------------------------------------------------------------------
// Password hashing (scrypt)
// ---------------------------------------------------------------------------

const SCRYPT_KEYLEN = 64;

// Argon2id parameters (meet/exceed OWASP minimums: m=19 MiB, t=2, p=1).
const ARGON2_OPTS = {
  parallelism: 1,
  iterations: 3,
  memorySize: 19456, // KiB (~19 MiB)
  hashLength: 32,
  outputType: 'encoded', // standard PHC string: $argon2id$v=19$m=...$salt$hash
};

/** Produce an Argon2id PHC hash string for ADMIN_PASSWORD_HASH. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return argon2id({ password: String(password), salt, ...ARGON2_OPTS });
}

/** Verify a password against a stored Argon2id PHC hash. */
async function verifyArgon2Hash(password, stored) {
  try {
    return await argon2Verify({ password: String(password), hash: stored });
  } catch {
    return false;
  }
}

/** Verify a password against a legacy `scrypt$<saltHex>$<hashHex>` hash. */
function verifyScryptHash(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

/** Constant-time string comparison that tolerates differing lengths. */
function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Hash both to a fixed length so length differences don't leak and
  // timingSafeEqual never throws on mismatched sizes.
  const ha = crypto.createHash('sha256').update(bufA).digest();
  const hb = crypto.createHash('sha256').update(bufB).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Whether any admin credential is configured (env var OR the first-run file). */
function isConfigured() {
  return Boolean(ADMIN_PASSWORD_HASH || ADMIN_PASSWORD || fileCredential);
}

/** True when NO credential exists yet — the dashboard is awaiting first-run setup. */
function isSetupMode() {
  return !isConfigured();
}

/** Normalize an IPv4-mapped IPv6 address (`::ffff:127.0.0.1` → `127.0.0.1`). */
function normalizeAddr(addr) {
  if (typeof addr !== 'string') return '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** True for IPv4 (127.0.0.0/8) or IPv6 (::1) loopback addresses. */
function isLoopbackAddr(addr) {
  const a = normalizeAddr(addr);
  if (a === '::1') return true;
  if (net.isIPv4(a)) return a.startsWith('127.');
  return false;
}

/** Whether a first-run setup token is configured (gates remote setup). */
function hasSetupToken() {
  return Boolean(ADMIN_SETUP_TOKEN);
}

/**
 * Decide whether an UNAUTHENTICATED first-run setup request may create the admin
 * credential. Callers must only invoke this while `isSetupMode()` is true.
 * Returns { ok: boolean, reason?: string }. See the ADMIN_SETUP_TOKEN /
 * ADMIN_TRUST_PROXY notes above for the gating rationale.
 */
function isSetupRequestAllowed(ctx, body) {
  if (ADMIN_SETUP_TOKEN) {
    const headerToken = (ctx && typeof ctx.get === 'function') ? ctx.get('x-admin-setup-token') : '';
    const bodyToken = (body && typeof body.setupToken === 'string') ? body.setupToken : '';
    const presented = headerToken || bodyToken;
    if (presented && timingSafeStringEqual(presented, ADMIN_SETUP_TOKEN)) {
      return { ok: true };
    }
    return { ok: false, reason: 'invalid_or_missing_setup_token' };
  }
  // No token configured: a reverse proxy in front makes socket-loopback
  // meaningless as a locality signal, so require the token (or env credential).
  if (ADMIN_TRUST_PROXY) {
    return { ok: false, reason: 'proxy_requires_setup_token' };
  }
  const addr = ctx && ctx.req && ctx.req.socket ? ctx.req.socket.remoteAddress : '';
  if (isLoopbackAddr(addr)) return { ok: true };
  return { ok: false, reason: 'remote_setup_not_allowed' };
}

/** Whether a credential is provisioned via the env override (vs the first-run file). */
function configuredViaEnv() {
  return Boolean(ADMIN_PASSWORD_HASH || ADMIN_PASSWORD);
}

function usingPlaintextPassword() {
  return Boolean(!ADMIN_PASSWORD_HASH && ADMIN_PASSWORD);
}

/** The configured admin username (env override wins; else the file credential). */
function currentUsername() {
  if (configuredViaEnv()) return ADMIN_USERNAME;
  if (fileCredential) return fileCredential.username;
  return ADMIN_USERNAME;
}

/** Verify a hash string (Argon2id or legacy scrypt) against a password. */
async function verifyHash(password, stored) {
  if (!stored) return false;
  if (stored.startsWith('$argon2')) return verifyArgon2Hash(password, stored);
  if (stored.startsWith('scrypt$')) {
    try { return verifyScryptHash(password, stored); } catch { return false; }
  }
  return false;
}

/** Verify a submitted username/password against the configured credentials. */
async function verifyCredentials(username, password) {
  if (!isConfigured()) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;

  // Env override takes precedence; otherwise the first-run file credential.
  let expectedUser;
  let passOk = false;
  if (configuredViaEnv()) {
    expectedUser = ADMIN_USERNAME;
    if (ADMIN_PASSWORD_HASH) passOk = await verifyHash(password, ADMIN_PASSWORD_HASH);
    else passOk = timingSafeStringEqual(password, ADMIN_PASSWORD);
  } else {
    expectedUser = fileCredential.username;
    passOk = await verifyHash(password, fileCredential.hash);
  }

  const userOk = timingSafeStringEqual(username, expectedUser);
  return userOk && passOk;
}

/**
 * First-run: hash a chosen password (Argon2id) and persist the HASH only to the
 * auth file (chmod 600). Refuses if a credential already exists — re-setup must
 * not be a back door to overwrite the password.
 */
async function setupCredential(username, password) {
  if (isConfigured()) return { ok: false, error: 'Admin access is already configured' };
  const user = (typeof username === 'string' && username.trim()) ? username.trim() : ADMIN_USERNAME;
  if (typeof password !== 'string' || password.length < 8) {
    return { ok: false, error: 'Password must be at least 8 characters' };
  }
  const hash = await hashPassword(password);
  const payload = JSON.stringify({ username: user, hash, createdAt: new Date().toISOString() }, null, 2);
  fs.writeFileSync(ADMIN_AUTH_FILE, payload, { mode: 0o600 });
  try { fs.chmodSync(ADMIN_AUTH_FILE, 0o600); } catch { /* best effort on platforms without chmod */ }
  fileCredential = { username: user, hash };
  return { ok: true, username: user };
}

// ---------------------------------------------------------------------------
// Server-side session store (in-memory; admin-dashboard is single-instance)
// ---------------------------------------------------------------------------

const sessions = new Map(); // sid -> { username, expiresAt }

function createSession(username) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { username, expiresAt: Date.now() + SESSION_TTL_MS });
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sid);
    return null;
  }
  return session;
}

function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

// Periodically evict expired sessions so the Map can't grow unbounded.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [sid, session] of sessions) {
    if (now > session.expiresAt) sessions.delete(sid);
  }
}, 10 * 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

// ---------------------------------------------------------------------------
// Per-IP brute-force lockout
// ---------------------------------------------------------------------------

const failuresByIp = new Map(); // ip -> { count, lockUntil }

function lockStatus(ip) {
  const entry = failuresByIp.get(ip);
  if (entry && entry.lockUntil && Date.now() < entry.lockUntil) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockUntil - Date.now()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

function recordFailure(ip) {
  const entry = failuresByIp.get(ip) || { count: 0, lockUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_FAILED_LOGINS) {
    entry.lockUntil = Date.now() + LOCKOUT_MS;
    entry.count = 0; // reset the counter; lockUntil now gates access
  }
  failuresByIp.set(ip, entry);
}

function clearFailures(ip) {
  failuresByIp.delete(ip);
}

// ---------------------------------------------------------------------------
// Koa helpers
// ---------------------------------------------------------------------------

function getSessionFromCtx(ctx) {
  const sid = ctx.cookies.get(COOKIE_NAME, { signed: true });
  return getSession(sid);
}

function setSessionCookie(ctx, sid) {
  ctx.cookies.set(COOKIE_NAME, sid, {
    signed: true,
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'lax',
    maxAge: SESSION_TTL_MS,
    overwrite: true,
  });
}

function clearSessionCookie(ctx) {
  ctx.cookies.set(COOKIE_NAME, null, {
    signed: true,
    httpOnly: true,
    secure: SECURE_COOKIES,
    sameSite: 'lax',
    overwrite: true,
  });
}

function wantsHtml(ctx) {
  return ctx.accepts('html', 'json') === 'html';
}

/**
 * Gate middleware: requires a valid session, otherwise redirects browsers to the
 * login page and returns 401 to API/JSON clients.
 */
async function requireAuth(ctx, next) {
  // No credential yet → send browsers to first-run setup; tell API clients.
  if (isSetupMode()) {
    if (wantsHtml(ctx)) { ctx.redirect('/admin/setup'); return; }
    ctx.status = 503;
    ctx.body = { error: 'Admin access not set up', setupUrl: '/admin/setup' };
    return;
  }

  const session = getSessionFromCtx(ctx);
  if (session) {
    ctx.state.adminUser = session.username;
    return next();
  }

  if (wantsHtml(ctx)) {
    ctx.redirect('/admin/login');
    return;
  }
  ctx.status = 401;
  ctx.body = { error: 'Authentication required', loginUrl: '/admin/login' };
}

module.exports = {
  COOKIE_NAME,
  ADMIN_USERNAME,
  SESSION_TTL_MS,
  SECURE_COOKIES,
  hashPassword,
  verifyCredentials,
  isConfigured,
  isSetupMode,
  isLoopbackAddr,
  hasSetupToken,
  isSetupRequestAllowed,
  configuredViaEnv,
  setupCredential,
  currentUsername,
  usingPlaintextPassword,
  createSession,
  destroySession,
  getSessionFromCtx,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  lockStatus,
  recordFailure,
  clearFailures,
};
