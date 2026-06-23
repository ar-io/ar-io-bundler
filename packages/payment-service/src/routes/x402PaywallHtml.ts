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

interface PaywallHtmlParams {
  paymentRequirement: {
    scheme: string;
    network: string;
    maxAmountRequired: string;
    payTo: string;
    asset: string;
    resource: string;
    description: string;
    mimeType: string;
    maxTimeoutSeconds: number;
    extra?: {
      name?: string;
      version?: string;
    };
  };
  cdpClientKey?: string;
  appName?: string;
  appLogo?: string;
  /**
   * Trusted opener origins the signed payment authorization may be posted to.
   * Empty (default) => never postMessage to the opener (show the header instead).
   */
  allowedOrigins?: string[];
}

/**
 * Format USDC atomic units (6 decimals) to human-readable string
 */
function formatUSDC(atomicAmount: string): string {
  const amount = parseFloat(atomicAmount) / 1_000_000; // USDC has 6 decimals
  return amount.toFixed(6);
}

/**
 * Generate HTML paywall for browser clients
 *
 * This follows the x402 standard pattern:
 * 1. Show payment requirements to user
 * 2. User connects wallet and signs payment authorization
 * 3. Return payment signature to parent window/redirect
 *
 * The payment flow is client-side only - server just provides the UI
 */
export function generatePaywallHtml(params: PaywallHtmlParams): string {
  const {
    paymentRequirement,
    cdpClientKey,
    appName = "AR.IO Bundler",
    appLogo,
    allowedOrigins = [],
  } = params;

  const usdcFormatted = formatUSDC(paymentRequirement.maxAmountRequired);
  const networkDisplay =
    paymentRequirement.network === "base"
      ? "Base"
      : paymentRequirement.network === "base-sepolia"
      ? "Base Sepolia (Testnet)"
      : paymentRequirement.network;

  // Onramp integration only if CDP client key provided
  const onrampEnabled = !!cdpClientKey;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${appName} - Payment Required</title>
  ${
    onrampEnabled
      ? '<script src="https://cdn.onramper.com/onramper-widget.js"></script>'
      : ""
  }
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 16px;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      max-width: 500px;
      width: 100%;
      padding: 40px;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
    }
    .logo {
      width: 80px;
      height: 80px;
      margin: 0 auto 20px;
    }
    h1 {
      color: #1a202c;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #718096;
      font-size: 16px;
    }
    .payment-details {
      background: #f7fafc;
      border-radius: 12px;
      padding: 24px;
      margin: 30px 0;
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
    }
    .detail-row:last-child {
      margin-bottom: 0;
    }
    .detail-label {
      color: #718096;
      font-size: 14px;
      font-weight: 500;
    }
    .detail-value {
      color: #1a202c;
      font-size: 16px;
      font-weight: 600;
      text-align: right;
    }
    .price-value {
      color: #667eea;
      font-size: 24px;
      font-weight: 700;
    }
    .button {
      width: 100%;
      padding: 16px;
      border: none;
      border-radius: 12px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
      margin-bottom: 12px;
    }
    .button:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    }
    .button:active {
      transform: translateY(0);
    }
    .button-primary {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .button-secondary {
      background: white;
      color: #667eea;
      border: 2px solid #667eea;
    }
    .status-message {
      margin-top: 20px;
      padding: 16px;
      border-radius: 12px;
      font-size: 14px;
      display: none;
    }
    .status-message.show {
      display: block;
    }
    .status-loading {
      background: #bee3f8;
      color: #2c5282;
    }
    .status-success {
      background: #c6f6d5;
      color: #22543d;
    }
    .status-error {
      background: #fed7d7;
      color: #742a2a;
    }
    .info-text {
      color: #718096;
      font-size: 14px;
      text-align: center;
      margin-top: 20px;
      line-height: 1.5;
    }
    .network-badge {
      display: inline-block;
      padding: 4px 12px;
      background: #edf2f7;
      color: #4a5568;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
    }
    code {
      background: #edf2f7;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 13px;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      ${
        appLogo
          ? `<img src="${appLogo}" alt="${appName}" class="logo">`
          : ""
      }
      <h1>Payment Required</h1>
      <p class="subtitle">${paymentRequirement.description}</p>
    </div>

    <div class="payment-details">
      <div class="detail-row">
        <span class="detail-label">Amount</span>
        <span class="detail-value price-value">${usdcFormatted} USDC</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Network</span>
        <span class="detail-value"><span class="network-badge">${networkDisplay}</span></span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Recipient</span>
        <span class="detail-value" style="font-size: 12px; font-family: monospace;">${paymentRequirement.payTo.slice(0, 6)}...${paymentRequirement.payTo.slice(-4)}</span>
      </div>
    </div>

    <button id="connect-wallet" class="button button-primary">
      Connect Wallet & Authorize Payment
    </button>

    ${
      onrampEnabled
        ? `
    <button id="buy-usdc" class="button button-secondary">
      Don't have USDC? Buy some first
    </button>
    `
        : ""
    }

    <div id="status" class="status-message"></div>

    <p class="info-text">
      You will be prompted to sign a payment authorization using your wallet.
      No funds are transferred until you complete your upload.
    </p>
  </div>

  <script type="module">
    // Payment requirement from server
    const paymentReq = ${JSON.stringify(paymentRequirement)};
    const cdpKey = ${cdpClientKey ? `'${cdpClientKey}'` : "null"};

    // Status display helpers
    function showStatus(message, type) {
      const statusEl = document.getElementById('status');
      statusEl.textContent = message;
      statusEl.className = 'status-message show status-' + type;
    }

    // Connect wallet and authorize payment
    document.getElementById('connect-wallet').onclick = async () => {
      try {
        showStatus('Connecting to your wallet...', 'loading');

        // Check if wallet is available
        if (!window.ethereum) {
          showStatus('No Ethereum wallet detected. Please install MetaMask or another Web3 wallet.', 'error');
          return;
        }

        // Request wallet connection
        const accounts = await window.ethereum.request({
          method: 'eth_requestAccounts'
        });

        const account = accounts[0];
        showStatus('Wallet connected. Preparing payment authorization...', 'loading');

        // Get current chain ID
        const chainId = await window.ethereum.request({
          method: 'eth_chainId'
        });

        // Verify network matches
        const expectedChainId = paymentReq.network === 'base' ? '0x2105' : '0x14a34'; // Base mainnet : Base Sepolia
        if (chainId !== expectedChainId) {
          const networkName = paymentReq.network === 'base' ? 'Base' : 'Base Sepolia';
          showStatus(\`Please switch your wallet to \${networkName} network.\`, 'error');
          return;
        }

        // Create EIP-712 payment authorization
        const domain = {
          name: paymentReq.extra?.name || 'USD Coin',
          version: paymentReq.extra?.version || '2',
          chainId: parseInt(chainId, 16),
          verifyingContract: paymentReq.asset
        };

        const types = {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' }
          ]
        };

        const validAfter = 0;
        const validBefore = Math.floor(Date.now() / 1000) + paymentReq.maxTimeoutSeconds;
        const nonce = '0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
          .map(b => b.toString(16).padStart(2, '0'))
          .join('');

        const message = {
          from: account,
          to: paymentReq.payTo,
          value: paymentReq.maxAmountRequired,
          validAfter: validAfter,
          validBefore: validBefore,
          nonce: nonce
        };

        showStatus('Please sign the payment authorization in your wallet...', 'loading');

        // Request signature
        const signature = await window.ethereum.request({
          method: 'eth_signTypedData_v4',
          params: [account, JSON.stringify({ domain, types, message, primaryType: 'TransferWithAuthorization' })]
        });

        // Create payment payload
        const paymentPayload = {
          scheme: paymentReq.scheme,
          network: paymentReq.network,
          authorization: {
            from: account,
            to: paymentReq.payTo,
            value: paymentReq.maxAmountRequired,
            validAfter: validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce: nonce,
            signature: signature
          },
          asset: paymentReq.asset
        };

        // Encode as base64 for X-PAYMENT header
        const paymentHeader = btoa(JSON.stringify(paymentPayload));

        showStatus('Payment authorized successfully!', 'success');

        // SECURITY: the payment header is a bearer-style signed authorization
        // (the victim's funds). Return it to the opener ONLY via explicitly
        // trusted origins — never with a wildcard targetOrigin, which would leak
        // it to any opener (e.g. a malicious site that popped this paywall).
        // Posting
        // with a SPECIFIC targetOrigin means the browser delivers it only to a
        // window actually at that origin, so a non-allowlisted opener gets
        // nothing. If no trusted origins are configured, do not post at all —
        // fall back to showing the header for the user to copy.
        var ALLOWED_PARENT_ORIGINS = ${JSON.stringify(allowedOrigins)};
        if (window.opener && ALLOWED_PARENT_ORIGINS.length > 0) {
          ALLOWED_PARENT_ORIGINS.forEach(function (trustedOrigin) {
            window.opener.postMessage({
              type: 'X402_PAYMENT_AUTHORIZED',
              payment: paymentHeader
            }, trustedOrigin);
          });
          setTimeout(function () { window.close(); }, 1000);
        } else {
          // No trusted opener configured (or opened directly) — show the header
          // for the user to copy. Never broadcast it to an untrusted opener.
          document.getElementById('status').innerHTML =
            '<strong>Payment Ready!</strong><br><br>' +
            'Add this header to your upload request:<br>' +
            '<code style="display: block; margin-top: 10px; padding: 10px;">X-PAYMENT: ' + paymentHeader + '</code>';
        }

      } catch (error) {
        console.error('Payment authorization failed:', error);
        showStatus('Payment authorization failed: ' + (error.message || 'Unknown error'), 'error');
      }
    };

    ${
      onrampEnabled
        ? `
    // Onramp integration (optional)
    document.getElementById('buy-usdc').onclick = () => {
      showStatus('Opening Coinbase Onramp...', 'loading');

      try {
        const onramp = Onramper.createWidget({
          clientId: cdpKey,
          defaultCrypto: 'USDC',
          defaultNetwork: paymentReq.network,
          walletAddress: paymentReq.payTo,
          onClose: () => {
            showStatus('Onramp closed. If you purchased USDC, you can now authorize payment.', 'loading');
          }
        });
        onramp.show();
      } catch (error) {
        showStatus('Failed to load Onramp widget: ' + error.message, 'error');
      }
    };
    `
        : ""
    }
  </script>
</body>
</html>`;
}
