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
 * Admin Dashboard Authentication Middleware
 *
 * Uses Basic Auth to protect all admin routes
 * Credentials configured via environment variables:
 * - ADMIN_USERNAME (default: admin)
 * - ADMIN_PASSWORD (required)
 */

const auth = require('koa-basic-auth');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.warn('⚠️  ADMIN_PASSWORD not set! Admin dashboard will be inaccessible.');
  console.warn('   Set ADMIN_PASSWORD in your .env file to enable admin access.');
}

/**
 * Basic Auth middleware for admin routes
 * Usage: app.use(authenticateAdmin)
 */
async function authenticateAdmin(ctx, next) {
  // Skip auth if password not configured (but log warning)
  if (!ADMIN_PASSWORD) {
    ctx.status = 503;
    ctx.body = {
      error: 'Admin dashboard not configured',
      message: 'ADMIN_PASSWORD must be set in environment variables'
    };
    return;
  }

  try {
    await auth({
      name: ADMIN_USERNAME,
      pass: ADMIN_PASSWORD
    })(ctx, next);
  } catch (err) {
    // Log failed authentication attempts
    console.warn(`Failed admin auth attempt from ${ctx.ip} at ${new Date().toISOString()}`);

    ctx.status = 401;
    ctx.set('WWW-Authenticate', 'Basic realm="AR.IO Bundler Admin"');
    ctx.body = { error: 'Authentication required' };
  }
}

module.exports = { authenticateAdmin };
