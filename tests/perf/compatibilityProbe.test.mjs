import assert from 'node:assert/strict';
import { test } from 'vitest';
import vm from 'node:vm';
import { findScrollSurface, publicPageInfo, readProbeVisibility, selectProbeTarget, summarizeScroll, waitForPaint } from './compatibilityProbe.mjs';

test('binds a new page across Gmail redirects without matching the requested hostname', () => {
  const previous = new Set(['shell', 'old-google']);
  const targets = [
    { id: 'shell', type: 'page', url: 'file:///app/index.html?view=shell' },
    { id: 'old-google', type: 'page', url: 'https://accounts.google.com/' },
    { id: 'gmail', type: 'page', url: 'https://accounts.google.com/v3/signin/identifier' },
  ];
  assert.equal(selectProbeTarget(targets, previous, 'https://mail.google.com/').id, 'gmail');
  targets[2].url = 'https://workspace.google.com/intl/en/gmail/';
  assert.equal(selectProbeTarget(targets, previous, targets[2].url, 'gmail').id, 'gmail');
});

test('does not confuse existing tabs or guess when new page targets are ambiguous', () => {
  const targets = [
    { id: 'existing', type: 'page', url: 'https://github.com/' },
    { id: 'new', type: 'page', url: 'about:blank' },
    { id: 'popup', type: 'page', url: 'about:blank' },
    { id: 'frame', type: 'iframe', url: 'https://github.com/' },
  ];
  assert.equal(selectProbeTarget(targets, new Set(['existing']), 'https://github.com/'), null);
  assert.equal(selectProbeTarget(targets, new Set(['existing']), 'about:blank'), null);
  assert.equal(selectProbeTarget(targets, new Set(['existing']), '', 'missing'), null);
  targets[1].url = 'https://github.com/';
  assert.equal(selectProbeTarget(targets, new Set(['existing']), 'https://github.com/').id, 'new');
});

test('requires observed movement and does not label a short page as a scrolling pass', () => {
  assert.deepEqual(summarizeScroll({ top: 0, maxScroll: 800 }, { top: 240 }), { status: 'passed', ok: true });
  assert.deepEqual(summarizeScroll({ top: 800, maxScroll: 800 }, { top: 560 }), { status: 'passed', ok: true });
  assert.deepEqual(summarizeScroll({ top: 0, maxScroll: 800 }, { top: 0 }), { status: 'failed', ok: false });
  assert.deepEqual(summarizeScroll({ top: 0, maxScroll: 0 }, { top: 0 }), { status: 'not-scrollable', ok: null });
  assert.deepEqual(summarizeScroll(null, null), { status: 'inconclusive', ok: null });
});

test('uses the document scroller or a visible overflowing nested scroll container', () => {
  const root = { scrollHeight: 700, clientHeight: 700 };
  const hidden = {
    scrollHeight: 900, clientHeight: 100, overflow: 'auto',
    getBoundingClientRect: () => ({ left: 0, right: 100, top: -1000, bottom: -900, width: 100, height: 100 }),
  };
  const nested = {
    scrollHeight: 1500, clientHeight: 600, overflow: 'auto',
    getBoundingClientRect: () => ({ left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600 }),
  };
  const context = {
    document: { scrollingElement: root, documentElement: root, querySelectorAll: () => [hidden, nested] },
    getComputedStyle: (element) => ({ overflowY: element.overflow }),
    innerWidth: 1000,
    innerHeight: 700,
  };
  assert.equal(vm.runInNewContext(`(${findScrollSurface})()`, context), nested);
  root.scrollHeight = 1400;
  assert.equal(vm.runInNewContext(`(${findScrollSurface})()`, context), root);
  root.scrollHeight = 700;
  nested.overflow = 'hidden';
  assert.equal(vm.runInNewContext(`(${findScrollSurface})()`, context), root);
});

test('paint wait does not resolve until both requested animation frames have run', async () => {
  const original = globalThis.requestAnimationFrame;
  const callbacks = [];
  globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
  try {
    let finished = false;
    const pending = waitForPaint().then(() => { finished = true; });
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    await Promise.resolve();
    assert.equal(finished, false);
    assert.equal(callbacks.length, 1);
    callbacks.shift()();
    await pending;
    assert.equal(finished, true);
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
    else delete globalThis.requestAnimationFrame;
  }
});

test('paint wait reports painted only when frames actually ran', async () => {
  const original = globalThis.requestAnimationFrame;
  const callbacks = [];
  globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
  try {
    const pending = waitForPaint();
    callbacks.shift()();
    callbacks.shift()();
    assert.equal((await pending).painted, true);
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
    else delete globalThis.requestAnimationFrame;
  }
});

// The defect: a hidden tab never fires requestAnimationFrame, so the old unbounded
// wait hung the calling Runtime.evaluate until the CDP timeout and the probe recorded
// a website failure that never happened. The wait must settle and say it did not paint.
test('paint wait settles without painting when animation frames never fire', async () => {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => {};
  try {
    const started = Date.now();
    const result = await waitForPaint(120);
    const elapsed = Date.now() - started;
    assert.equal(result.painted, false, 'must report that no frame was painted');
    assert.ok(elapsed >= 100, `must wait for the bounded timeout, saw ${elapsed}ms`);
    assert.ok(elapsed < 2000, `must not hang past the timeout, saw ${elapsed}ms`);
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
    else delete globalThis.requestAnimationFrame;
  }
});

test('paint wait settles when requestAnimationFrame is unavailable', async () => {
  const original = globalThis.requestAnimationFrame;
  delete globalThis.requestAnimationFrame;
  try {
    const started = Date.now();
    const result = await waitForPaint(5000);
    assert.equal(result.painted, false);
    assert.ok(Date.now() - started < 1000, 'must not wait for the timeout when rAF is missing');
  } finally {
    if (original) globalThis.requestAnimationFrame = original;
  }
});

test('visibility probe reports the state that blocks scroll and paint checks', () => {
  const visible = vm.runInNewContext(`(${readProbeVisibility})()`, { document: { visibilityState: 'visible', hidden: false } });
  assert.equal(visible.visibilityState, 'visible');
  assert.equal(visible.hidden, false);
  const hidden = vm.runInNewContext(`(${readProbeVisibility})()`, { document: { visibilityState: 'hidden', hidden: true } });
  assert.equal(hidden.visibilityState, 'hidden');
  assert.equal(hidden.hidden, true);
});


test('records authentication redirects without treating an account wall as the target application', () => {
  const context = {
    location: { href: 'https://accounts.google.com/signin', hostname: 'accounts.google.com', pathname: '/signin', protocol: 'https:' },
    document: { body: { innerText: 'Sign in', textContent: 'Sign in' }, title: 'Sign in', readyState: 'complete', querySelectorAll: () => [], forms: [] },
  };
  assert.equal(vm.runInNewContext(`(${publicPageInfo})()`, context).authWall, true);
  context.location.hostname = 'discord.com';
  context.location.pathname = '/login';
  assert.equal(vm.runInNewContext(`(${publicPageInfo})()`, context).authWall, true);
  context.location.hostname = 'github.com';
  context.location.pathname = '/n3wbiekkkk/Kinex';
  assert.equal(vm.runInNewContext(`(${publicPageInfo})()`, context).authWall, false);
});
