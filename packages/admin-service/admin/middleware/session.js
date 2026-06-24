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
const { argon2id, argon2Verify } = require('hash-wasm');

const COOKIE_NAME = 'arbundler_admin_session';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // legacy plaintext fallback

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

/** Whether any admin credential is configured at all. */
function isConfigured() {
  return Boolean(ADMIN_PASSWORD_HASH || ADMIN_PASSWORD);
}

function usingPlaintextPassword() {
  return Boolean(!ADMIN_PASSWORD_HASH && ADMIN_PASSWORD);
}

/** Verify a submitted username/password against the configured credentials. */
async function verifyCredentials(username, password) {
  if (!isConfigured()) return false;
  if (typeof username !== 'string' || typeof password !== 'string') return false;

  const userOk = timingSafeStringEqual(username, ADMIN_USERNAME);

  let passOk = false;
  if (ADMIN_PASSWORD_HASH) {
    if (ADMIN_PASSWORD_HASH.startsWith('$argon2')) {
      passOk = await verifyArgon2Hash(password, ADMIN_PASSWORD_HASH);
    } else if (ADMIN_PASSWORD_HASH.startsWith('scrypt$')) {
      try {
        passOk = verifyScryptHash(password, ADMIN_PASSWORD_HASH);
      } catch {
        passOk = false;
      }
    }
  } else if (ADMIN_PASSWORD) {
    passOk = timingSafeStringEqual(password, ADMIN_PASSWORD);
  }

  return userOk && passOk;
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
  if (!isConfigured()) {
    ctx.status = 503;
    ctx.body = {
      error: 'Admin dashboard not configured',
      message:
        'Set ADMIN_PASSWORD_HASH (preferred) or ADMIN_PASSWORD in the environment to enable admin access.',
    };
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
