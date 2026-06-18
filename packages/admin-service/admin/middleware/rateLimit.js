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
 * Rate Limiting Middleware for Admin Dashboard
 *
 * Prevents abuse of stats API endpoint
 * Limit: 60 requests per minute per IP
 */

const rateLimit = require('koa-ratelimit');

const RATE_LIMIT_WINDOW = 60000; // 1 minute in milliseconds
const RATE_LIMIT_MAX = 60; // requests per window

/**
 * In-memory rate limiting for admin stats endpoint
 * For production with multiple instances, use Redis driver instead
 */
const statsRateLimiter = rateLimit({
  driver: 'memory',
  db: new Map(),
  duration: RATE_LIMIT_WINDOW,
  errorMessage: {
    error: 'Too many requests',
    message: 'Please wait before requesting stats again',
    retryAfter: RATE_LIMIT_WINDOW / 1000
  },
  id: (ctx) => ctx.ip,
  headers: {
    remaining: 'X-RateLimit-Remaining',
    reset: 'X-RateLimit-Reset',
    total: 'X-RateLimit-Limit'
  },
  max: RATE_LIMIT_MAX,
  disableHeader: false,
  whitelist: (ctx) => {
    // Allow localhost without rate limiting in development
    return process.env.NODE_ENV === 'development' &&
           (ctx.ip === '127.0.0.1' || ctx.ip === '::1' || ctx.ip === 'localhost');
  },
  blacklist: (ctx) => {
    // Could blacklist IPs here if needed
    return false;
  }
});

module.exports = { statsRateLimiter };
