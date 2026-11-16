import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { Engine, FilterSet } = require('adblock-rs');

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function loadBundledRules() {
  const dir = path.resolve(import.meta.dirname, '../../resources/filters');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt.gz')).sort();
  const lines = [];
  for (const file of files) {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(dir, file))).toString('utf8');
    for (const l of raw.split(/\r?\n/)) {
      const t = l.trim();
      if (t && !t.startsWith('!') && !t.startsWith('[')) lines.push(t);
    }
  }
  return lines;
}

const fixtures = [
  ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://www.nytimes.com/', 'script'],
  ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'https://www.theverge.com/', 'script'],
  ['https://www.google-analytics.com/analytics.js', 'https://example.org/blog', 'script'],
  ['https://connect.facebook.net/en_US/fbevents.js', 'https://shop.example.com/', 'script'],
  ['https://static.ads-twitter.com/uwt.js', 'https://news.example.com/', 'script'],
  ['https://pixel.quantserve.com/pixel;r=123', 'https://blog.example.com/', 'image'],
  ['https://cdn.taboola.com/libtrc/impl.js', 'https://cnn.com/', 'script'],
  ['https://widgets.outbrain.com/outbrain.js', 'https://example.org/', 'script'],
  ['https://bat.bing.com/bat.js', 'https://shop.example.com/', 'script'],
  ['https://sb.scorecardresearch.com/beacon.js', 'https://example.com/', 'script'],
  ['https://github.githubassets.com/assets/app.js', 'https://github.com/n3wbiekkkk/Kinex', 'script'],
  ['https://www.youtube.com/s/player/base.js', 'https://www.youtube.com/watch?v=123', 'script'],
  ['https://upload.wikimedia.org/wikipedia/commons/thumb/a/a7/React-icon.svg', 'https://en.wikipedia.org/wiki/Electron', 'image'],
  ['https://fonts.gstatic.com/s/inter/v18/inter.woff2', 'https://docs.example.com/', 'font'],
  ['https://api.github.com/repos/n3wbiekkkk/Kinex', 'https://github.com/n3wbiekkkk/Kinex', 'xhr'],
];

const LEGACY_HOSTS = new Set([
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagmanager.com',
  'google-analytics.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'connect.facebook.net', 'analytics.tiktok.com', 'ads-twitter.com', 'bat.bing.com',
  'scorecardresearch.com', 'quantserve.com', 'criteo.com', 'outbrain.com', 'taboola.com',
  'adnxs.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'amazon-adsystem.com',
  'hotjar.com', 'mixpanel.com', 'segment.io', 'sentry.io', 'clarity.ms',
]);

function legacyMatch(rawUrl) {
  let host = new URL(rawUrl).hostname.toLowerCase();
  while (host) {
    if (LEGACY_HOSTS.has(host)) return true;
    const dot = host.indexOf('.');
    if (dot === -1) break;
    host = host.slice(dot + 1);
  }
  return false;
}

const allRules = loadBundledRules();
const results = [];

// Legacy baseline
{
  const lat = [];
  let blocked = 0;
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) {
    const [u] = fixtures[i % fixtures.length];
    const q0 = performance.now();
    if (legacyMatch(u)) blocked++;
    lat.push((performance.now() - q0) * 1000);
  }
  const totalMs = performance.now() - t0;
  lat.sort((a, b) => a - b);
  results.push({
    engine: 'legacy-suffix-list',
    rules: LEGACY_HOSTS.size,
    parseMs: 0,
    deserMs: 0,
    serializedMB: 0,
    match10kMs: +totalMs.toFixed(2),
    meanUs: +((totalMs * 1000) / 10000).toFixed(2),
    medianUs: +percentile(lat, 0.5).toFixed(2),
    p95Us: +percentile(lat, 0.95).toFixed(2),
    blocked,
  });
}

for (const count of [10000, 50000, 100000, allRules.length]) {
  const subset = allRules.slice(0, count).join('\n');
  const rss0 = process.memoryUsage().rss;
  const t0 = performance.now();
  const fsObj = new FilterSet(true);
  fsObj.addFilters(subset);
  const engine = new Engine(fsObj);
  const parseMs = performance.now() - t0;
  const serialized = Buffer.from(engine.serialize());
  const d0 = performance.now();
  const deser = new Engine(new FilterSet(false));
  deser.deserialize(serialized.buffer.slice(serialized.byteOffset, serialized.byteOffset + serialized.byteLength));
  const deserMs = performance.now() - d0;
  const rss1 = process.memoryUsage().rss;

  const lat = [];
  let blocked = 0;
  const m0 = performance.now();
  for (let i = 0; i < 10000; i++) {
    const [u, s, rt] = fixtures[i % fixtures.length];
    const q0 = performance.now();
    const r = engine.check(u, s, rt, '', true);
    lat.push((performance.now() - q0) * 1000);
    if (r.should_block) blocked++;
  }
  const matchTotalMs = performance.now() - m0;
  lat.sort((a, b) => a - b);

  results.push({
    engine: 'kinex-shields-adblock-rs',
    rules: count,
    parseMs: +parseMs.toFixed(2),
    deserMs: +deserMs.toFixed(2),
    serializedMB: +(serialized.byteLength / 1048576).toFixed(2),
    rssDeltaMB: +((rss1 - rss0) / 1048576).toFixed(2),
    match10kMs: +matchTotalMs.toFixed(2),
    meanUs: +((matchTotalMs * 1000) / 10000).toFixed(2),
    medianUs: +percentile(lat, 0.5).toFixed(2),
    p95Us: +percentile(lat, 0.95).toFixed(2),
    blocked,
  });
}

console.log('SHIELDS_BENCHMARK_JSON:' + JSON.stringify(results, null, 2));
