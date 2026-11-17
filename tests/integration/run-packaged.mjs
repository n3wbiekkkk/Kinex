import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const bundle = path.resolve(process.argv.find((arg) => arg.startsWith('--app='))?.slice(6) || path.join(root, 'release/mac-arm64/Kinex.app'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kinex-packaged-'));
const binary = path.join(bundle, 'Contents/MacOS/Kinex');
const addon = path.join(bundle, 'Contents/Resources/app.asar.unpacked/node_modules/adblock-rs/js/index.node');
assert.ok(fs.existsSync(binary), 'Packaged executable must exist');
assert.ok(fs.existsSync(addon), 'Native Shields addon must be unpacked');
assert.match(execFileSync('file', [binary], { encoding: 'utf8' }), /arm64/);
assert.match(execFileSync('file', [addon], { encoding: 'utf8' }), /arm64/);
const plist = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
assert.equal(plist.CFBundleShortVersionString, expectedVersion);
assert.equal(plist.CFBundleIdentifier, 'com.kinex.browser');
assert.equal(plist.LSMinimumSystemVersion, '13.0');
assert.ok(plist.NSCameraUsageDescription && plist.NSMicrophoneUsageDescription);

const portServer = net.createServer();
await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const fixture = http.createServer((_req, res) => res.end('<!doctype html><title>Packaged Kinex fixture</title><main>Packaged navigation works</main>'));
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}/`;
const child = spawn(binary, [`--remote-debugging-port=${port}`], {
  env: { ...process.env, KINEX_TEST_MODE: '1', KINEX_DISABLE_AUTO_UPDATER: '1', KINEX_USER_DATA_DIR: scratch },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (data) => { logs = (logs + data).slice(-8000); });
child.stderr.on('data', (data) => { logs = (logs + data).slice(-8000); });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sockets = [];
const pending = new Set();
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(ws);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  return (expression) => new Promise((resolve, reject) => {
    const current = ++id;
    const timer = setTimeout(() => { cleanup(); reject(new Error('Packaged CDP evaluation timed out')); }, 5000);
    const cleanup = () => { clearTimeout(timer); ws.removeEventListener('message', listener); pending.delete(timer); };
    pending.add(timer);
    const listener = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== current) return;
      cleanup();
      if (response.error || response.result?.exceptionDetails) reject(new Error(JSON.stringify(response.error || response.result.exceptionDetails)));
      else resolve(response.result?.result?.value);
    };
    ws.addEventListener('message', listener);
    ws.send(JSON.stringify({ id: current, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
async function waitFor(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, `Packaged app exited during ${label}: ${logs}`);
    const result = await check().catch(() => null);
    if (result) return result;
    await pause(80);
  }
  throw new Error(`Timed out: ${label}\n${logs}`);
}
const targets = () => fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
try {
  const shell = await waitFor(async () => (await targets()).find((target) => target.url.includes('?view=shell')), 'packaged shell');
  const evaluate = await connect(shell);
  await waitFor(() => evaluate(`Boolean(window.kinexAPI && document.querySelector('.kinex-shell'))`), 'packaged renderer');
  const shields = await waitFor(() => evaluate(`window.kinexAPI.getState().then(state => (state.shieldsRuntime.engineReady || state.shieldsRuntime.engineError) && state.shieldsRuntime)`), 'packaged native Shields');
  assert.equal(shields.engineReady, true, shields.engineError || 'Packaged Shields must become ready');
  assert.ok(shields.totalRuleCount > 100000);
  assert.equal(shields.engineError, undefined);
  await evaluate(`window.kinexAPI.dispatch({type:'open-url',target:'new-tab',url:${JSON.stringify(url)}})`);
  const page = await waitFor(async () => (await targets()).find((target) => target.url === url), 'packaged website tab');
  const evaluatePage = await connect(page);
  await waitFor(() => evaluatePage(`document.title === 'Packaged Kinex fixture'`), 'packaged page content');
  assert.deepEqual(await evaluatePage(`({api:typeof kinexAPI,node:typeof process,require:typeof require})`), { api: 'undefined', node: 'undefined', require: 'undefined' });
  await evaluate(`window.kinexAPI.dispatch({type:'run-command',commandId:'close-window'})`).catch(() => {});
  await waitFor(() => Promise.resolve(fs.existsSync(path.join(scratch, 'kinex-state.json'))), 'packaged shutdown persistence');
  const state = JSON.parse(fs.readFileSync(path.join(scratch, 'kinex-state.json'), 'utf8'));
  assert.ok(state.tabs.some((tab) => tab.url === url));
  const report = { ok: true, version: plist.CFBundleShortVersionString, arch: 'arm64', minimumMacOS: plist.LSMinimumSystemVersion, nativeRules: shields.totalRuleCount, checks: ['bundle metadata', 'arm64 executable/addon', 'packaged native initialization', 'sandboxed navigation', 'shutdown persistence'], signing: 'Not established by this smoke test' };
  const out = path.resolve(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) || 'artifacts/ci/packaged.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const ws of sockets) ws.close();
  for (const timer of pending) clearTimeout(timer);
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), pause(3000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
