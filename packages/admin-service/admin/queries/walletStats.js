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
 * Bundle-signing Wallet Balance
 *
 * When the bundle-signing wallet runs out of AR, posting to Arweave fails and
 * retries forever — a silent outage. Surface its balance with a low-balance
 * threshold so the operator sees it coming.
 *
 * Balance is read from the gateway (GET /wallet/{address}/balance → Winston).
 * The address comes from ARWEAVE_ADDRESS, falling back to deriving it from the
 * JWK file (TURBO_JWK_FILE) so it works even if the env var isn't set.
 */

const crypto = require('crypto');
const fs = require('fs');

const WINSTON_PER_AR = 1e12;

/** Derive an Arweave address from a JWK's modulus (n). */
function deriveAddressFromJwk(jwkPath) {
  try {
    const jwk = JSON.parse(fs.readFileSync(jwkPath, 'utf8'));
    if (!jwk.n) return null;
    const modulus = Buffer.from(jwk.n, 'base64url');
    return crypto.createHash('sha256').update(modulus).digest('base64url');
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} config
 * @param {string} config.gateway   - e.g. http://localhost:3000
 * @param {string} [config.address] - Arweave address (else derived from jwkFile)
 * @param {string} [config.jwkFile] - path to the signing JWK
 * @param {number} [config.lowAr]   - low-balance threshold in AR
 */
async function getWalletStats(config = {}) {
  const gateway = (config.gateway || 'https://arweave.net').replace(/\/$/, '');
  const lowThresholdAr = config.lowAr != null ? Number(config.lowAr) : 0.5;

  let address = config.address;
  if (!address && config.jwkFile) {
    address = deriveAddressFromJwk(config.jwkFile);
  }

  if (!address) {
    return {
      configured: false,
      status: 'unknown',
      error: 'No ARWEAVE_ADDRESS and could not derive from TURBO_JWK_FILE',
    };
  }

  const base = {
    configured: true,
    address,
    gateway,
    lowThresholdAr,
  };

  try {
    const res = await fetchWithTimeout(`${gateway}/wallet/${address}/balance`);
    if (!res.ok) {
      return { ...base, status: 'unknown', error: `gateway HTTP ${res.status}` };
    }
    const text = (await res.text()).trim();
    const winc = Number(text);
    if (!Number.isFinite(winc)) {
      return { ...base, status: 'unknown', error: `unexpected balance response: ${text.slice(0, 40)}` };
    }
    const ar = winc / WINSTON_PER_AR;

    let status = 'healthy';
    if (winc <= 0) status = 'critical';
    else if (ar < lowThresholdAr) status = 'low';

    return {
      ...base,
      balanceWinc: String(winc),
      balanceAr: ar.toFixed(6),
      status,
    };
  } catch (error) {
    return { ...base, status: 'unknown', error: error.message };
  }
}

module.exports = { getWalletStats, deriveAddressFromJwk };
