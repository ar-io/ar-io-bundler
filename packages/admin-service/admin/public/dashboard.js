/**
 * AR.IO Bundler Admin Dashboard - Client-Side Logic
 *
 * Handles:
 * - Fetching stats from /admin/stats API
 * - Updating UI with fresh data
 * - Creating Chart.js visualizations
 * - Manual refresh (no auto-refresh per user request)
 */

// Chart instances (global to allow updates)
let signatureChart = null;
let paymentModeChart = null;
let networkChart = null;
let cryptoTokenChart = null;
const sparkCharts = {};

/**
 * Fetch trend history and render sparklines.
 */
async function fetchHistory() {
  try {
    const res = await fetch('/admin/history?hours=24', { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    renderSparklines(data.points || []);
  } catch (err) {
    /* trends are best-effort */
  }
}

function renderSparkline(canvasId, points, accessor, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const vals = points.map(accessor);
  const cfg = {
    type: 'line',
    data: {
      labels: points.map(p => p.t),
      datasets: [{
        data: vals,
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2,
        fill: true,
        pointRadius: 0,
        tension: 0.3,
        spanGaps: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: {
          title: (items) => new Date(items[0].label).toLocaleTimeString(),
          label: (item) => `${item.formattedValue}`,
        },
      } },
      scales: {
        x: { display: false },
        y: { display: true, beginAtZero: true, ticks: { maxTicksLimit: 3, font: { size: 10 } }, grid: { display: false } },
      },
    },
  };
  if (sparkCharts[canvasId]) sparkCharts[canvasId].destroy();
  sparkCharts[canvasId] = new Chart(canvas.getContext('2d'), cfg);
}

function renderSparklines(points) {
  const empty = document.getElementById('trends-empty');
  if (points.length < 2) { if (empty) empty.style.display = 'block'; return; }
  if (empty) empty.style.display = 'none';
  renderSparkline('spark-backlog', points, p => p.bk, '#f5a623');
  renderSparkline('spark-failed', points, p => p.rf, '#e74c3c');
  renderSparkline('spark-bundles', points, p => p.bp, '#16a34a');
  renderSparkline('spark-wallet', points, p => p.w, '#0070f3');
}

/**
 * Fetch stats from API and update dashboard
 */
async function fetchStats() {
  const refreshBtn = document.getElementById('refresh-btn');
  const refreshIcon = document.getElementById('refresh-icon');
  const loading = document.getElementById('loading');
  const error = document.getElementById('error');
  const dashboard = document.getElementById('dashboard');

  // Show loading state
  refreshBtn.classList.add('loading');
  refreshBtn.disabled = true;
  if (dashboard.style.display === 'none') {
    loading.style.display = 'block';
  }
  error.style.display = 'none';

  try {
    const response = await fetch('/admin/stats', {
      headers: { 'Accept': 'application/json' }
    });

    if (response.status === 401) {
      // Session expired or missing — send the user to the login page.
      window.location.href = '/admin/login';
      return;
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const stats = await response.json();

    // Hide loading, show dashboard
    loading.style.display = 'none';
    dashboard.style.display = 'block';

    // Update all dashboard sections
    updateStatusBanner(stats.health);
    updatePipeline(stats.pipeline);
    updateWallet(stats.wallet);
    updateThroughput(stats.throughput);
    updateSystemHealth(stats.system);
    updateStorageHealth(stats.system?.storage);
    updateSchedulerHealth(stats.system?.schedulers);
    updateOverviewCards(stats);
    updateCharts(stats);
    updateQueueStatus(stats.system.queues);
    updateMoneyIntegrity(stats.payments?.integrity);
    updateTopupProviderTable(stats.payments?.topUps || {});
    updateTopUploaders(stats.uploads.topUploaders);
    updateRecentUploads(stats.uploads.recentUploads);
    updateRecentTopups(stats.payments?.recentTopUps || []);
    updateRecentTraditionalPayments(stats.payments?.recentPayments || []);
    updateRecentX402Payments(stats.x402Payments?.recentPayments || []);
    updateFailedPayments(stats.payments?.integrity?.failedCrypto?.recent || []);
    updateFailedBundles(stats.bundles?.recentFailed || []);
    updatePostedBundles(stats.bundles?.recentPosted || []);
    updateRecentBundles(stats.bundles?.recentPermanent || []);

    // Update last refresh time
    updateLastRefresh(stats.timestamp, stats._cached, stats._cacheAge);

    // Trends (separate, non-blocking)
    fetchHistory();

  } catch (err) {
    console.error('Failed to fetch stats:', err);

    // Show error banner
    loading.style.display = 'none';
    error.style.display = 'flex';
    document.getElementById('error-message').textContent = err.message;

  } finally {
    // Reset button state
    refreshBtn.classList.remove('loading');
    refreshBtn.disabled = false;
  }
}

/* ---------- helpers ---------- */
function fmtBytes(bytes) {
  let n = Number(bytes) || 0;
  if (n === 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(2)} ${u[i]}`;
}
function fmtAge(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}
function fmtDur(sec) {
  if (sec == null) return '—';
  if (sec < 90) return `${Math.round(sec)}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
function metricCard(label, value, sub, severity) {
  return `<div class="metric-card ${severity || ''}">
    <div class="metric-value">${value}</div>
    <div class="metric-label">${label}</div>
    ${sub ? `<div class="metric-sub">${sub}</div>` : ''}
  </div>`;
}

/**
 * Aggregate status banner + nav status dot.
 */
function updateStatusBanner(health) {
  const banner = document.getElementById('status-banner');
  const dot = document.getElementById('status-dot');
  if (!health) { banner.style.display = 'none'; return; }
  banner.style.display = 'block';

  const labels = { ok: 'All systems healthy', degraded: 'Degraded', critical: 'Critical' };
  const icons = { ok: '✅', degraded: '⚠️', critical: '🚨' };
  banner.className = `status-banner ${health.status}`;
  if (dot) dot.className = `status-dot ${health.status}`;

  const issues = health.issues || [];
  const issueHtml = issues.length
    ? `<ul class="status-issues">${issues.map(i =>
        `<li class="sev-${i.severity}"><span class="sev-tag">${i.severity}</span>
         <span class="sev-area">${escapeHtml(i.area)}</span> ${escapeHtml(i.message)}</li>`).join('')}</ul>`
    : `<div class="status-clear">No issues detected.</div>`;

  banner.innerHTML = `
    <div class="status-head">
      <span class="status-icon">${icons[health.status] || '•'}</span>
      <span class="status-title">${labels[health.status] || health.status}</span>
      ${health.counts ? `<span class="status-counts">${health.counts.critical} critical · ${health.counts.degraded} warnings</span>` : ''}
    </div>
    ${issueHtml}
  `;
}

/**
 * Bundle pipeline: at-risk headline + state funnel.
 */
function updatePipeline(pipeline) {
  const atrisk = document.getElementById('pipeline-atrisk');
  const funnel = document.getElementById('pipeline-funnel');
  if (!pipeline) { atrisk.innerHTML = ''; funnel.innerHTML = ''; return; }

  const r = pipeline.atRisk || {};
  const backlogSev = r.backlogOldestAgeSec >= 7200 ? 'critical' : r.backlogOldestAgeSec >= 1800 ? 'warn' : (r.backlogItems > 0 ? 'info' : 'ok');
  const stuckSev = r.stuckPostedBundles >= 10 ? 'critical' : r.stuckPostedBundles > 0 ? 'warn' : 'ok';
  const failSev = r.failedBundles > 0 ? 'warn' : 'ok';
  const failItemSev = r.failedDataItems > 0 ? 'warn' : 'ok';

  atrisk.innerHTML =
    metricCard('Backlog (unbundled)', (r.backlogItems || 0).toLocaleString(), `oldest ${fmtAge(r.backlogOldestAgeSec)}`, backlogSev) +
    metricCard('In-flight bundles', (r.inFlightBundles || 0).toLocaleString(), 'plan → posted → seeded', 'info') +
    metricCard('Stuck posted', (r.stuckPostedBundles || 0).toLocaleString(), `> ${fmtAge(r.stuckPostedThresholdSec)}`, stuckSev) +
    metricCard('Failed bundles', (r.failedBundles || 0).toLocaleString(), 'need review', failSev) +
    metricCard('Failed items', (r.failedDataItems || 0).toLocaleString(), 'dead-letter', failItemSev);

  const di = pipeline.dataItems || {};
  const bu = pipeline.bundles || {};
  const stage = (label, obj, showAge) => `
    <div class="funnel-stage">
      <div class="funnel-count">${(obj?.count || 0).toLocaleString()}</div>
      <div class="funnel-label">${label}</div>
      ${showAge && obj?.oldestAgeSec != null ? `<div class="funnel-age">oldest ${fmtAge(obj.oldestAgeSec)}</div>` : ''}
    </div>`;
  const arrow = '<div class="funnel-arrow">→</div>';

  funnel.innerHTML = `
    <div class="funnel-row">
      <div class="funnel-track-label">Data items</div>
      ${stage('New', di.new, true)}${arrow}${stage('Planned', di.planned, true)}${arrow}${stage('Failed', di.failed, false)}
    </div>
    <div class="funnel-row">
      <div class="funnel-track-label">Bundles</div>
      ${stage('New', bu.newBundle, false)}${arrow}${stage('Plan', bu.planned, false)}${arrow}${stage('Posted', bu.posted, true)}${arrow}${stage('Seeded', bu.seeded, true)}${arrow}${stage('Failed', bu.failed, false)}
    </div>`;
}

/**
 * Bundle-signing wallet balance card.
 */
function updateWallet(wallet) {
  const el = document.getElementById('wallet-card');
  if (!wallet || !wallet.configured) {
    el.innerHTML = `<div class="wallet-unknown">Wallet not configured${wallet?.error ? ': ' + escapeHtml(wallet.error) : ''}</div>`;
    return;
  }
  const sevClass = wallet.status === 'critical' ? 'critical' : wallet.status === 'low' ? 'warn' : wallet.status === 'unknown' ? 'info' : 'ok';
  const balance = wallet.balanceAr != null ? `${parseFloat(wallet.balanceAr).toLocaleString(undefined, { maximumFractionDigits: 6 })} AR` : '—';
  el.innerHTML = `
    <div class="wallet-card ${sevClass}">
      <div class="wallet-balance">${balance}</div>
      <div class="wallet-status">${wallet.status.toUpperCase()}${wallet.status !== 'healthy' ? ` (warn &lt; ${wallet.lowThresholdAr} AR)` : ''}</div>
      <div class="wallet-meta">${makeCopyable(wallet.address, null, 'address')}</div>
      ${wallet.error ? `<div class="wallet-err">${escapeHtml(wallet.error)}</div>` : ''}
    </div>`;
}

/**
 * Throughput & latency key-values.
 */
function updateThroughput(tp) {
  const el = document.getElementById('throughput-grid');
  if (!tp) { el.innerHTML = ''; return; }
  const lat = tp.permanenceLatency || {};
  const kv = (k, v) => `<div class="kv"><span class="kv-k">${k}</span><span class="kv-v">${v}</span></div>`;
  el.innerHTML =
    kv('Arrivals', `${tp.arrivals.lastHour}/h · ${tp.arrivals.last24h}/24h`) +
    kv('Items permanent', `${tp.itemsPermanent.lastHour}/h · ${tp.itemsPermanent.last24h}/24h`) +
    kv('Bundles permanent', `${tp.bundlesPermanent.lastHour}/h · ${tp.bundlesPermanent.last24h}/24h`) +
    kv('Data permanent (24h)', fmtBytes(tp.bundlesPermanent.bytes24h)) +
    kv('Upload→permanent p50', fmtDur(lat.p50Sec)) +
    kv('Upload→permanent avg/max', `${fmtDur(lat.avgSec)} / ${fmtDur(lat.maxSec)}`);
}

/**
 * Storage health (MinIO + disk).
 */
function updateStorageHealth(storage) {
  const grid = document.getElementById('storage-grid');
  if (!storage) { grid.innerHTML = ''; return; }
  let html = '';
  if (storage.minio) {
    const ok = storage.minio.status === 'healthy';
    html += `<div class="health-item ${storage.minio.status}">
      <span class="health-icon">${ok ? '✅' : '❌'}</span>
      <div><div class="health-name">MinIO Object Storage</div>
      <div class="health-meta">${ok ? escapeHtml(storage.minio.endpoint || '') : escapeHtml(storage.minio.error || 'down')}</div></div></div>`;
  }
  if (storage.disk) {
    const d = storage.disk;
    const cls = d.status === 'healthy' ? 'healthy' : d.status === 'unknown' ? 'unknown' : 'unhealthy';
    html += `<div class="health-item ${cls}">
      <span class="health-icon">${cls === 'healthy' ? '✅' : cls === 'unknown' ? '❔' : '❌'}</span>
      <div><div class="health-name">Disk (${escapeHtml(d.path || '/')})</div>
      <div class="health-meta">${d.usedPct != null ? `${d.usedPct}% used · ${d.freeFormatted} free of ${d.totalFormatted}` : escapeHtml(d.error || '')}</div></div></div>`;
  }
  grid.innerHTML = html || '<div class="health-meta">No storage data</div>';
}

/**
 * Scheduler health (plan/cleanup/redrive registered + next run).
 */
function updateSchedulerHealth(schedulers) {
  const grid = document.getElementById('scheduler-grid');
  if (!schedulers) { grid.innerHTML = ''; return; }
  grid.innerHTML = Object.entries(schedulers).map(([name, s]) => {
    const ok = s.registered;
    const meta = ok
      ? `${s.pattern || ''}${s.nextRun ? ` · next ${new Date(s.nextRun).toLocaleString()}` : ''}`
      : (s.error || 'NOT REGISTERED');
    return `<div class="health-item ${ok ? 'healthy' : 'unhealthy'}">
      <span class="health-icon">${ok ? '✅' : '❌'}</span>
      <div><div class="health-name">${escapeHtml(name)} scheduler</div>
      <div class="health-meta">${escapeHtml(meta)}</div></div></div>`;
  }).join('');
}

/**
 * Money integrity metrics + failed-payment context.
 */
function updateMoneyIntegrity(integ) {
  const grid = document.getElementById('integrity-grid');
  if (!integ) { grid.innerHTML = ''; return; }
  const pend = integ.pendingCrypto || {};
  const pendSev = pend.count > 0 && pend.oldestAgeSec >= 7200 ? 'critical' : pend.count > 0 && pend.oldestAgeSec >= 1800 ? 'warn' : pend.count > 0 ? 'info' : 'ok';
  grid.innerHTML =
    metricCard('Uncredited crypto', (pend.count || 0).toLocaleString(), `${parseFloat(pend.ar || 0).toFixed(4)} AR · oldest ${fmtAge(pend.oldestAgeSec)}`, pendSev) +
    metricCard('Failed crypto', (integ.failedCrypto?.count || 0).toLocaleString(), 'need review', (integ.failedCrypto?.count > 0 ? 'warn' : 'ok')) +
    metricCard('Failed top-up quotes', (integ.failedTopUpQuotes?.count || 0).toLocaleString(), '', 'info') +
    metricCard('Chargebacks', (integ.chargebacks?.count || 0).toLocaleString(), '', (integ.chargebacks?.count > 0 ? 'warn' : 'ok'));
}

function updateFailedPayments(rows) {
  const table = document.getElementById('failed-payments-table');
  if (!rows || rows.length === 0) {
    table.innerHTML = '<tr><td colspan="5" class="empty-cell">No failed crypto payments</td></tr>';
    return;
  }
  table.innerHTML = `
    <thead><tr><th>Tx</th><th>Token</th><th style="text-align:right;">Credits (AR)</th><th>Reason</th><th>Time</th></tr></thead>
    <tbody>${rows.map(r => `<tr>
      <td>${makeCopyable(r.transactionId, null, 'transaction')}</td>
      <td>${escapeHtml(r.tokenType || '')}</td>
      <td style="text-align:right;">${parseFloat(r.ar || 0).toFixed(6)}</td>
      <td class="reason-cell">${escapeHtml(r.reason || '')}</td>
      <td>${formatTime(r.timestamp)}</td></tr>`).join('')}</tbody>`;
}

function updateFailedBundles(rows) {
  const table = document.getElementById('failed-bundles-table');
  if (!rows || rows.length === 0) {
    table.innerHTML = '<tr><td colspan="4" class="empty-cell">No failed bundles 🎉</td></tr>';
    return;
  }
  table.innerHTML = `
    <thead><tr><th>Bundle ID</th><th>Plan ID</th><th>Reason</th><th>Failed</th></tr></thead>
    <tbody>${rows.map(b => `<tr>
      <td>${makeCopyable(b.bundleId, null, 'bundle ID')}</td>
      <td>${makeCopyable(b.planId, null, 'plan ID')}</td>
      <td class="reason-cell">${escapeHtml(b.failedReason || '—')}</td>
      <td>${formatTime(b.failedDate)}</td></tr>`).join('')}</tbody>`;
}

function updatePostedBundles(rows) {
  const table = document.getElementById('posted-bundles-table');
  if (!rows || rows.length === 0) {
    table.innerHTML = '<tr><td colspan="4" class="empty-cell">No bundles awaiting seed/verify</td></tr>';
    return;
  }
  table.innerHTML = `
    <thead><tr><th>Bundle ID</th><th style="text-align:right;">Size</th><th>Reward</th><th>Posted</th></tr></thead>
    <tbody>${rows.map(b => `<tr>
      <td>${makeCopyable(b.bundleId, null, 'bundle ID')}</td>
      <td style="text-align:right;">${b.payloadSizeFormatted}</td>
      <td>${escapeHtml(String(b.reward || ''))}</td>
      <td>${formatTime(b.postedDate)}</td></tr>`).join('')}</tbody>`;
}

/**
 * Update system health indicators
 */
function updateSystemHealth(health) {
  const grid = document.getElementById('health-grid');
  grid.innerHTML = '';

  // Services
  Object.entries(health.services || {}).forEach(([name, data]) => {
    const el = document.createElement('div');
    el.className = `health-item ${data.status}`;
    el.innerHTML = `
      <span class="health-icon">${data.status === 'healthy' ? '✅' : '❌'}</span>
      <div>
        <div class="health-name">${formatServiceName(name)}</div>
        <div class="health-meta">${data.uptime || 'Unknown'} | ${data.memory || '--'}</div>
      </div>
    `;
    grid.appendChild(el);
  });

  // Infrastructure
  Object.entries(health.infrastructure || {}).forEach(([name, data]) => {
    const el = document.createElement('div');
    el.className = `health-item ${data.status}`;
    el.innerHTML = `
      <span class="health-icon">${data.status === 'healthy' ? '✅' : '❌'}</span>
      <div>
        <div class="health-name">${formatServiceName(name)}</div>
        <div class="health-meta">${data.memoryUsed || data.connections ? `${data.connections || ''} ${data.memoryUsed || ''}`.trim() : 'Active'}</div>
      </div>
    `;
    grid.appendChild(el);
  });
}

/**
 * Update overview stat cards
 */
function updateOverviewCards(stats) {
  // Today's uploads
  document.getElementById('today-uploads').textContent =
    stats.uploads.today.totalUploads.toLocaleString();
  document.getElementById('today-bytes').textContent =
    stats.uploads.today.totalBytesFormatted;

  // All time uploads
  document.getElementById('total-uploads').textContent =
    stats.uploads.allTime.totalUploads.toLocaleString();
  document.getElementById('total-bytes').textContent =
    stats.uploads.allTime.totalBytesFormatted;

  // Unique users
  document.getElementById('unique-users').textContent =
    stats.uploads.allTime.uniqueUploaders.toLocaleString();
  document.getElementById('users-today').textContent =
    `${stats.uploads.today.uniqueUploaders} today`;

  // Credit top-ups (Stripe + crypto, from payment_service.payment_receipt)
  const topUp = stats.payments?.topUps?.total || { count: 0, ar: '0.000000' };
  document.getElementById('topup-total').textContent =
    `${parseFloat(topUp.ar).toLocaleString(undefined, { maximumFractionDigits: 4 })} AR`;
  document.getElementById('topup-count').textContent =
    `${(topUp.count || 0).toLocaleString()} top-ups credited`;

  // Outstanding credit balances (from payment_service.user)
  const balances = stats.payments?.balances || { totalAr: '0.000000', usersWithBalance: 0 };
  document.getElementById('balance-total').textContent =
    `${parseFloat(balances.totalAr).toLocaleString(undefined, { maximumFractionDigits: 4 })} AR`;
  document.getElementById('balance-users').textContent =
    `${(balances.usersWithBalance || 0).toLocaleString()} wallets with credit`;

  // x402 payments (from upload_service - x402_payments table)
  const x402Total = stats.x402Payments?.total?.totalUSDC || '0.000000';
  const x402Count = stats.x402Payments?.total?.totalCount || 0;
  document.getElementById('x402-total').textContent =
    `$${parseFloat(x402Total).toLocaleString()}`;
  document.getElementById('x402-count').textContent =
    `${x402Count.toLocaleString()} payments`;
}

/**
 * Update all Chart.js visualizations
 */
function updateCharts(stats) {
  updateSignatureChart(stats.uploads.bySignatureType);
  updateCryptoTokenChart(stats.payments?.cryptoTopUps?.byToken || {});
  updatePaymentTypeChart(stats.payments?.x402Payments?.byMode || {});
  updateNetworkChart(stats.x402Payments?.byNetwork || {});
}

/**
 * Update crypto top-ups by token chart (Doughnut)
 */
function updateCryptoTokenChart(byToken) {
  const ctx = document.getElementById('crypto-token-chart').getContext('2d');

  const data = Object.entries(byToken).map(([token, d]) => ({
    label: token,
    value: d.count
  }));

  if (data.length === 0) {
    data.push({ label: 'No Data', value: 1 });
  }

  const chartData = {
    labels: data.map(d => d.label),
    datasets: [{
      data: data.map(d => d.value),
      backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4'],
      borderWidth: 2,
      borderColor: '#ffffff'
    }]
  };

  const config = {
    type: 'doughnut',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { padding: 16, font: { size: 13 } } },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              return `${label}: ${value.toLocaleString()} top-ups`;
            }
          }
        }
      }
    }
  };

  if (cryptoTokenChart) {
    cryptoTokenChart.destroy();
  }
  cryptoTokenChart = new Chart(ctx, config);
}

/**
 * Update signature type distribution chart (Doughnut)
 */
function updateSignatureChart(byType) {
  const ctx = document.getElementById('signature-chart').getContext('2d');

  const data = Object.entries(byType).map(([type, data]) => ({
    label: type,
    value: data.count
  }));

  const chartData = {
    labels: data.map(d => d.label),
    datasets: [{
      data: data.map(d => d.value),
      backgroundColor: [
        '#3b82f6', // Blue (Ethereum)
        '#10b981', // Green (Arweave)
        '#f59e0b', // Amber (Solana)
        '#8b5cf6', // Purple
        '#ec4899', // Pink
      ],
      borderWidth: 2,
      borderColor: '#ffffff'
    }]
  };

  const config = {
    type: 'doughnut',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 16,
            font: { size: 13 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = ((value / total) * 100).toFixed(1);
              return `${label}: ${value.toLocaleString()} (${percentage}%)`;
            }
          }
        }
      }
    }
  };

  if (signatureChart) {
    signatureChart.destroy();
  }
  signatureChart = new Chart(ctx, config);
}

/**
 * Update traditional payment type distribution chart (Pie)
 */
function updatePaymentTypeChart(byMode) {
  const ctx = document.getElementById('payment-type-chart').getContext('2d');

  const data = Object.entries(byMode).map(([mode, data]) => ({
    label: mode.toUpperCase(),
    value: data.count
  }));

  if (data.length === 0) {
    data.push({ label: 'No Data', value: 1 });
  }

  const chartData = {
    labels: data.map(d => d.label),
    datasets: [{
      data: data.map(d => d.value),
      backgroundColor: [
        '#06b6d4', // Cyan (PAYG)
        '#8b5cf6', // Purple (TopUp)
        '#10b981', // Green (Hybrid)
      ],
      borderWidth: 2,
      borderColor: '#ffffff'
    }]
  };

  const config = {
    type: 'pie',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            padding: 16,
            font: { size: 13 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed || 0;
              return `${label}: ${value.toLocaleString()} payments`;
            }
          }
        }
      }
    }
  };

  if (paymentModeChart) {
    paymentModeChart.destroy();
  }
  paymentModeChart = new Chart(ctx, config);
}

// For backward compatibility, keep the old name as an alias
const updatePaymentModeChart = updatePaymentTypeChart;

/**
 * Update network distribution chart (Bar)
 */
function updateNetworkChart(byNetwork) {
  const ctx = document.getElementById('network-chart').getContext('2d');

  const data = Object.entries(byNetwork).map(([network, data]) => ({
    label: formatNetworkName(network),
    count: data.count,
    amount: parseFloat(data.amount)
  }));

  const chartData = {
    labels: data.map(d => d.label),
    datasets: [
      {
        label: 'Payment Count',
        data: data.map(d => d.count),
        backgroundColor: '#3b82f6',
        borderRadius: 6,
        yAxisID: 'y'
      },
      {
        label: 'Total USDC',
        data: data.map(d => d.amount),
        backgroundColor: '#10b981',
        borderRadius: 6,
        yAxisID: 'y1'
      }
    ]
  };

  const config = {
    type: 'bar',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            padding: 16,
            font: { size: 13 }
          }
        }
      },
      scales: {
        y: {
          type: 'linear',
          display: true,
          position: 'left',
          title: {
            display: true,
            text: 'Payment Count'
          }
        },
        y1: {
          type: 'linear',
          display: true,
          position: 'right',
          title: {
            display: true,
            text: 'Total USDC'
          },
          grid: {
            drawOnChartArea: false
          }
        }
      }
    }
  };

  if (networkChart) {
    networkChart.destroy();
  }
  networkChart = new Chart(ctx, config);
}

/**
 * Update queue status summary and grid
 */
function updateQueueStatus(queues) {
  // Summary — "Failed (1h)" is the alerting signal; "Failed (total)" is mostly
  // stale cruft BullMQ keeps until cleaned.
  const summary = document.getElementById('queue-summary');
  const recent = queues.totalRecentFailed || 0;
  summary.innerHTML = `
    <div class="queue-stat">
      <div class="queue-stat-value">${queues.totalActive || 0}</div>
      <div class="queue-stat-label">Active</div>
    </div>
    <div class="queue-stat">
      <div class="queue-stat-value">${queues.totalWaiting || 0}</div>
      <div class="queue-stat-label">Waiting</div>
    </div>
    <div class="queue-stat">
      <div class="queue-stat-value ${recent > 0 ? 'text-danger' : ''}">${recent}${recent >= 50 ? '+' : ''}</div>
      <div class="queue-stat-label">Failed (1h)</div>
    </div>
    <div class="queue-stat">
      <div class="queue-stat-value muted">${(queues.totalFailed || 0).toLocaleString()}</div>
      <div class="queue-stat-label">Failed (total)</div>
    </div>
    <div class="queue-stat">
      <div class="queue-stat-value">${queues.totalDelayed || 0}</div>
      <div class="queue-stat-label">Delayed</div>
    </div>
  `;

  // Grid
  const grid = document.getElementById('queue-grid');
  grid.innerHTML = '';

  (queues.byQueue || []).forEach(q => {
    const el = document.createElement('div');
    // Highlight only queues failing RECENTLY (active incident); a big stale
    // `failed` total with 0 recent is not alarming.
    const activeIncident = (q.recentFailed || 0) > 0;
    el.className = `queue-card ${activeIncident ? 'has-failures' : ''}`;
    const boardUrl = `/admin/queues/queue/${encodeURIComponent(q.name)}`;
    const failedLabel = activeIncident
      ? `${q.recentFailed}${q.recentFailedCapped ? '+' : ''} in 1h`
      : (q.failed > 0 ? `${q.failed.toLocaleString()} (stale)` : '0');
    const failedClass = activeIncident ? 'text-danger' : (q.failed > 0 ? 'muted' : '');
    el.innerHTML = `
      <div class="queue-head">
        <a class="queue-name" href="${boardUrl}" title="Open in Bull Board">${q.name} ↗</a>
        ${q.failed > 0 ? `<button class="btn btn-xs" onclick="retryQueue('${escapeHtml(q.name)}')">Retry ${q.failed.toLocaleString()}</button>` : ''}
      </div>
      <div class="queue-stats">
        <span>
          <div class="value">${q.active}</div>
          <div class="label">Active</div>
        </span>
        <span>
          <div class="value">${q.waiting}</div>
          <div class="label">Waiting</div>
        </span>
        <span>
          <div class="value ${failedClass}" style="font-size:15px;">${failedLabel}</div>
          <div class="label">Failed</div>
        </span>
      </div>
    `;
    grid.appendChild(el);
  });
}

/**
 * Update top uploaders table
 */
function updateTopUploaders(uploaders) {
  const table = document.getElementById('top-uploaders-table');

  if (uploaders.length === 0) {
    table.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 40px; color: var(--text-secondary);">No data available</td></tr>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Address</th>
        <th style="text-align: right;">Upload Count</th>
        <th style="text-align: right;">Total Size</th>
      </tr>
    </thead>
    <tbody>
      ${uploaders.map(u => `
        <tr>
          <td>${makeCopyable(u.address, null, 'address')}</td>
          <td style="text-align: right;">${u.uploadCount.toLocaleString()}</td>
          <td style="text-align: right;">${u.totalBytesFormatted}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

/**
 * Update recent uploads table
 */
function updateRecentUploads(uploads) {
  const table = document.getElementById('recent-uploads-table');

  if (uploads.length === 0) {
    table.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: var(--text-secondary);">No recent uploads</td></tr>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Data Item ID</th>
        <th>Size</th>
        <th>Signature Type</th>
        <th>Owner</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
      ${uploads.map(u => `
        <tr>
          <td>${makeCopyable(u.id, null, 'data item ID')}</td>
          <td>${u.sizeFormatted}</td>
          <td>${u.signatureType}</td>
          <td>${makeCopyable(u.owner, null, 'address')}</td>
          <td>${formatTime(u.timestamp)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

/**
 * Update credit top-ups by provider table (from payment_service.payment_receipt)
 */
function updateTopupProviderTable(topUps) {
  const table = document.getElementById('topup-provider-table');
  const byProvider = topUps.byProvider || {};
  const fiatByCurrency = topUps.fiatByCurrency || {};
  const providers = Object.entries(byProvider);

  if (providers.length === 0) {
    table.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 40px; color: var(--text-secondary);">No top-ups yet</td></tr>';
    return;
  }

  // Show fiat totals (e.g. USD) as a hint next to the credits.
  const fiatSummary = Object.entries(fiatByCurrency)
    .map(([cur, d]) => `${parseFloat(d.amount).toLocaleString()} ${cur.toUpperCase()}`)
    .join(', ');

  table.innerHTML = `
    <thead>
      <tr>
        <th>Provider</th>
        <th style="text-align: right;">Top-ups</th>
        <th style="text-align: right;">Credits (AR)</th>
      </tr>
    </thead>
    <tbody>
      ${providers.map(([provider, d]) => `
        <tr>
          <td><span class="badge">${escapeHtml(provider)}</span></td>
          <td style="text-align: right;">${(d.count || 0).toLocaleString()}</td>
          <td style="text-align: right;">${parseFloat(d.ar).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
        </tr>
      `).join('')}
      ${fiatSummary ? `<tr><td colspan="3" style="color: var(--text-secondary); font-size: 13px;">Fiat received: ${escapeHtml(fiatSummary)}</td></tr>` : ''}
    </tbody>
  `;
}

/**
 * Update recent credit top-ups table (Stripe + crypto, from payment_service)
 */
function updateRecentTopups(topUps) {
  const table = document.getElementById('recent-topups-table');

  if (!topUps || topUps.length === 0) {
    table.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: var(--text-secondary);">No recent top-ups</td></tr>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Provider</th>
        <th>Address</th>
        <th style="text-align: right;">Amount</th>
        <th style="text-align: right;">Credits (AR)</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
      ${topUps.map(t => `
        <tr>
          <td><span class="badge">${escapeHtml(t.provider || 'N/A')}</span></td>
          <td>${makeCopyable(t.address, null, 'address')}</td>
          <td style="text-align: right;">${escapeHtml(String(t.amount))}</td>
          <td style="text-align: right;">${parseFloat(t.credits).toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
          <td>${formatTime(t.timestamp)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

/**
 * Update recent traditional payments table (from payment_service)
 */
function updateRecentTraditionalPayments(payments) {
  const table = document.getElementById('recent-traditional-payments-table');

  if (!payments || payments.length === 0) {
    table.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: var(--text-secondary);">No recent payments</td></tr>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Payment ID</th>
        <th>Network</th>
        <th style="text-align: right;">Amount</th>
        <th>Mode</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
      ${payments.map(p => `
        <tr>
          <td>${makeCopyable(p.paymentId, null, 'payment ID')}</td>
          <td>${formatNetworkName(p.network)}</td>
          <td style="text-align: right;">${p.amount}</td>
          <td><span class="badge">${p.mode ? p.mode.toUpperCase() : 'N/A'}</span></td>
          <td>${formatTime(p.timestamp)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

/**
 * Update recent x402 payments table (from upload_service)
 */
function updateRecentX402Payments(payments) {
  const table = document.getElementById('recent-x402-payments-table');

  if (!payments || payments.length === 0) {
    table.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-secondary);">No recent x402 payments</td></tr>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Payment ID</th>
        <th>TX Hash</th>
        <th>Network</th>
        <th style="text-align: right;">Amount</th>
        <th>Data Size</th>
        <th>Time</th>
      </tr>
    </thead>
    <tbody>
      ${payments.map(p => `
        <tr>
          <td>${makeCopyable(p.paymentId, null, 'payment ID')}</td>
          <td>${makeCopyable(p.txHash, null, 'transaction hash')}</td>
          <td>${formatNetworkName(p.network)}</td>
          <td style="text-align: right;">${p.amount}</td>
          <td>${p.bytesFormatted}</td>
          <td>${formatTime(p.timestamp)}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

/**
 * Update recent bundles table
 */
function updateRecentBundles(bundles) {
  const table = document.getElementById('recent-bundles-table');

  if (!bundles || bundles.length === 0) {
    table.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 40px; color: var(--text-secondary);">No recent bundles</td></tr>';
    return;
  }

  table.innerHTML = `
    <thead>
      <tr>
        <th>Bundle ID</th>
        <th>Status</th>
        <th style="text-align: right;">Size</th>
        <th>Block Height</th>
        <th>Posted</th>
        <th>Verified</th>
      </tr>
    </thead>
    <tbody>
      ${bundles.map(b => `
        <tr>
          <td>${makeCopyable(b.bundleId, null, 'bundle ID')}</td>
          <td><span class="badge ${b.status === 'permanent' ? 'badge-success' : 'badge-info'}">${b.status.toUpperCase()}</span></td>
          <td style="text-align: right;">${b.payloadSizeFormatted}</td>
          <td>${b.blockHeight || 'Pending'}</td>
          <td>${formatTime(b.postedDate)}</td>
          <td>${b.permanentDate ? formatTime(b.permanentDate) : 'Pending'}</td>
        </tr>
      `).join('')}
    </tbody>
  `;
}

/**
 * Update last refresh indicator
 */
function updateLastRefresh(timestamp, cached, cacheAge) {
  const indicator = document.getElementById('last-refresh');
  const now = new Date();
  const time = now.toLocaleTimeString();

  if (cached) {
    indicator.textContent = `${time} (cached ${cacheAge}s ago)`;
  } else {
    indicator.textContent = time;
  }
}

/**
 * Helper: Format service name
 */
function formatServiceName(name) {
  const names = {
    'payment-service': 'Payment API',
    'upload-api': 'Upload API',
    'upload-workers': 'Upload Workers',
    'payment-workers': 'Payment Workers',
    'admin-dashboard': 'Admin Dashboard',
    'postgresUpload': 'PostgreSQL (Upload)',
    'postgresPayment': 'PostgreSQL (Payment)',
    'redisCache': 'Redis Cache',
    'redisQueues': 'Redis Queues',
    'minio': 'MinIO Object Storage'
  };
  return names[name] || name;
}

/**
 * Helper: Format network name
 */
function formatNetworkName(network) {
  const names = {
    'base-mainnet': 'Base Mainnet',
    'base-sepolia': 'Base Sepolia (Testnet)',
    'ethereum-mainnet': 'Ethereum Mainnet',
    'polygon-mainnet': 'Polygon Mainnet'
  };
  return names[network] || network;
}

/**
 * Helper: Truncate address for display
 */
function truncateAddress(address) {
  if (!address || address.length < 16) return address;
  return `${address.substring(0, 8)}...${address.substring(address.length - 6)}`;
}

/**
 * Helper: Truncate ID for display
 */
function truncateId(id) {
  if (!id || id.length < 16) return id;
  return `${id.substring(0, 12)}...`;
}

/**
 * Helper: Create copyable ID element with click-to-copy functionality
 * @param {string} fullId - The full ID to be copied
 * @param {string} displayText - The truncated text to display (optional, will truncate if not provided)
 * @param {string} type - Type of ID for display purposes ('id', 'address', 'hash')
 */
function makeCopyable(fullId, displayText = null, type = 'id') {
  if (!fullId) return fullId;

  // Auto-truncate if no display text provided
  const display = displayText || (type === 'address' ? truncateAddress(fullId) : truncateId(fullId));

  // Generate unique ID for this element
  const uniqueId = 'copy-' + Math.random().toString(36).substr(2, 9);

  return `<span class="copyable-id"
               onclick="copyToClipboard('${escapeHtml(fullId)}', '${uniqueId}')"
               title="Click to copy full ${type}: ${escapeHtml(fullId)}"
               id="${uniqueId}">
            <code>${display}</code>
            <span class="copy-icon">📋</span>
            <span class="copy-feedback">✓ Copied!</span>
          </span>`;
}

/**
 * Copy text to clipboard and show feedback
 */
async function copyToClipboard(text, elementId) {
  try {
    await navigator.clipboard.writeText(text);

    // Show success feedback
    const element = document.getElementById(elementId);
    if (element) {
      element.classList.add('copied');
      setTimeout(() => {
        element.classList.remove('copied');
      }, 2000);
    }
  } catch (err) {
    console.error('Failed to copy:', err);
    // Fallback for older browsers
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);

    const element = document.getElementById(elementId);
    if (element) {
      element.classList.add('copied');
      setTimeout(() => {
        element.classList.remove('copied');
      }, 2000);
    }
  }
}

/**
 * Escape HTML to prevent XSS in title attributes
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Helper: Format timestamp to relative time
 */
function formatTime(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  const diff = now - date;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

/* ---------- recovery actions + lookup + auto-refresh ---------- */

let autoRefreshTimer = null;

function toggleAutoRefresh() {
  const on = document.getElementById('autorefresh-toggle').checked;
  try { localStorage.setItem('adminAutoRefresh', on ? '1' : '0'); } catch (e) {}
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (on) {
    autoRefreshTimer = setInterval(fetchStats, 15000); // 15s (cache is 30s server-side)
  }
}

function restoreAutoRefresh() {
  let on = false;
  try { on = localStorage.getItem('adminAutoRefresh') === '1'; } catch (e) {}
  const cb = document.getElementById('autorefresh-toggle');
  if (cb && on) { cb.checked = true; toggleAutoRefresh(); }
}

/**
 * Look up where a data item / bundle / wallet currently lives.
 */
async function doLookup() {
  const q = document.getElementById('lookup-input').value.trim();
  const out = document.getElementById('lookup-result');
  if (!q) { out.innerHTML = ''; return; }
  out.innerHTML = '<span class="muted">Searching…</span>';
  try {
    const res = await fetch(`/admin/lookup?q=${encodeURIComponent(q)}`, { headers: { 'Accept': 'application/json' } });
    if (res.status === 401) { window.location.href = '/admin/login'; return; }
    const data = await res.json();
    if (!data.found || !data.results || data.results.length === 0) {
      out.innerHTML = `<span class="muted">No match for <code>${escapeHtml(q)}</code></span>`;
      return;
    }
    out.innerHTML = data.results.map(r => `
      <div class="lookup-hit">
        <span class="badge badge-info">${escapeHtml(r.kind)}</span>
        <span class="lookup-state">${escapeHtml(r.state)}</span>
        ${r.detail ? `<span class="muted">${escapeHtml(r.detail)}</span>` : ''}
      </div>`).join('');
  } catch (err) {
    out.innerHTML = `<span class="sev-critical">Lookup failed: ${escapeHtml(err.message)}</span>`;
  }
}

/**
 * Fire a guarded recovery action (trigger plan/redrive/cleanup).
 */
async function triggerAction(action, confirmMsg) {
  if (!confirm(confirmMsg)) return;
  try {
    const res = await fetch(`/admin/actions/trigger`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ action }),
    });
    if (res.status === 401) { window.location.href = '/admin/login'; return; }
    const data = await res.json();
    if (res.ok) { alert(`✅ ${data.message || 'Triggered'}`); fetchStats(); }
    else alert(`❌ ${data.error || 'Failed'}`);
  } catch (err) {
    alert(`❌ ${err.message}`);
  }
}

/**
 * Retry all failed jobs in a queue.
 */
async function retryQueue(queueName) {
  if (!confirm(`Retry all failed jobs in "${queueName}"?`)) return;
  try {
    const res = await fetch(`/admin/actions/retry-failed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ queue: queueName }),
    });
    if (res.status === 401) { window.location.href = '/admin/login'; return; }
    const data = await res.json();
    if (res.ok) {
      const more = data.remaining > 0 ? ` — ${data.remaining} still failed (click Retry again to continue)` : '';
      alert(`✅ Retried ${data.retried} job(s) in ${queueName}${more}`);
      fetchStats();
    } else alert(`❌ ${data.error || 'Failed'}`);
  } catch (err) {
    alert(`❌ ${err.message}`);
  }
}

/**
 * End the admin session and return to the login page.
 */
async function logout() {
  try {
    await fetch('/admin/logout', { method: 'POST' });
  } catch (err) {
    // Even if the request fails, send the user to the login page.
    console.error('Logout request failed:', err);
  }
  window.location.href = '/admin/login';
}

// Initial load
restoreAutoRefresh();
fetchStats();
