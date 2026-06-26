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
 * Tests for the queue-failure severity split in computeHealthRollup:
 * best-effort queues (optical-post, archive-copy) cap at DEGRADED, while
 * core-pipeline queues keep the CRITICAL path. Regression for a CRITICAL page
 * fired by a benign optical-post circuit-breaker burst (no data loss).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeHealthRollup } = require('../admin/healthRollup');

const rollup = (byQueue) => computeHealthRollup({ system: { queues: { byQueue } } });
const queueIssues = (res) => res.issues.filter((i) => i.area === 'queues');

test('optical-post breaker burst → DEGRADED, never CRITICAL', () => {
  const res = rollup([{ name: 'upload-optical-post', recentFailed: 50 }]);
  const qi = queueIssues(res);
  assert.equal(qi.length, 1);
  assert.equal(qi[0].severity, 'degraded');
  assert.equal(qi.some((i) => i.severity === 'critical'), false);
  assert.match(qi[0].message, /best-effort/);
  assert.match(qi[0].message, /upload-optical-post/);
});

test('archive-copy is also best-effort → DEGRADED', () => {
  const res = rollup([{ name: 'upload-archive-copy', recentFailed: 50 }]);
  const qi = queueIssues(res);
  assert.equal(qi.length, 1);
  assert.equal(qi[0].severity, 'degraded');
});

test('core-pipeline failures at/over crit threshold → CRITICAL', () => {
  const res = rollup([{ name: 'upload-post-bundle', recentFailed: 50 }]);
  const qi = queueIssues(res);
  assert.equal(qi.length, 1);
  assert.equal(qi[0].severity, 'critical');
  assert.match(qi[0].message, /core-pipeline/);
  assert.match(qi[0].message, /upload-post-bundle/);
});

test('core-pipeline failures between warn and crit → DEGRADED', () => {
  const res = rollup([{ name: 'upload-verify-bundle', recentFailed: 15 }]);
  const qi = queueIssues(res);
  assert.equal(qi.length, 1);
  assert.equal(qi[0].severity, 'degraded');
  assert.match(qi[0].message, /core-pipeline/);
});

test('best-effort below its warn threshold → no queue alert', () => {
  const res = rollup([{ name: 'upload-optical-post', recentFailed: 24 }]);
  assert.equal(queueIssues(res).length, 0);
});

test('mixed: core CRITICAL + best-effort DEGRADED both surface', () => {
  const res = rollup([
    { name: 'upload-post-bundle', recentFailed: 50 },
    { name: 'upload-optical-post', recentFailed: 50 },
  ]);
  const qi = queueIssues(res);
  assert.equal(qi.length, 2);
  assert.equal(qi.some((i) => i.severity === 'critical'), true);
  assert.equal(qi.some((i) => i.severity === 'degraded'), true);
  // best-effort failures must not inflate the core count (no double-counting)
  const core = qi.find((i) => /core-pipeline/.test(i.message));
  assert.match(core.message, /^50\+ core-pipeline/);
});
