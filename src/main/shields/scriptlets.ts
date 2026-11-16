import type { AdblockResource } from 'adblock-rs';

function encodeB64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

const TRANSPARENT_1X1_GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const TRANSPARENT_2X2_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVQI12NgwAcAABQAAe8L1/IAAAAASUVORK5CYII=';

const VETTED_SCRIPTLETS: Array<{ name: string; aliases: string[]; kind: 'template' | { mime: string }; code: string }> = [
  {
    name: 'nobab.js',
    aliases: ['nobab', 'bab-defuser.js'],
    kind: { mime: 'application/javascript' },
    code: `(() => {
      const trap = () => {};
      try { Object.defineProperty(window, 'BlockAdBlock', { value: trap, configurable: true }); } catch {}
      try { Object.defineProperty(window, 'FuckAdBlock', { value: trap, configurable: true }); } catch {}
      window.blockAdBlock = { onDetected: trap, onNotDetected: (cb) => { if (typeof cb === 'function') cb(); return window.blockAdBlock; }, on: trap, clearEvent: trap };
      window.fuckAdBlock = window.blockAdBlock;
    })();`,
  },
  {
    name: 'abort-on-property-read.js',
    aliases: ['aopr.js', 'abort-on-property-read', 'ubo-aopr.js'],
    kind: 'template',
    code: `(() => {
      const chain = {{1}};
      if (typeof chain !== 'string' || !/^[A-Za-z0-9_$.]+$/.test(chain)) return;
      const parts = chain.split('.');
      let owner = window;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!owner || typeof owner !== 'object') return;
        owner = owner[parts[i]];
      }
      const prop = parts[parts.length - 1];
      if (!owner || !prop) return;
      try {
        Object.defineProperty(owner, prop, {
          get() { throw new ReferenceError('Kinex Shields aborted property read'); },
          set() {},
          configurable: true,
        });
      } catch {}
    })();`,
  },
  {
    name: 'abort-on-property-write.js',
    aliases: ['aopw.js', 'abort-on-property-write', 'ubo-aopw.js'],
    kind: 'template',
    code: `(() => {
      const chain = {{1}};
      if (typeof chain !== 'string' || !/^[A-Za-z0-9_$.]+$/.test(chain)) return;
      const parts = chain.split('.');
      let owner = window;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!owner || typeof owner !== 'object') return;
        owner = owner[parts[i]];
      }
      const prop = parts[parts.length - 1];
      if (!owner || !prop) return;
      try {
        Object.defineProperty(owner, prop, {
          set() { throw new ReferenceError('Kinex Shields aborted property write'); },
          configurable: true,
        });
      } catch {}
    })();`,
  },
  {
    name: 'set-constant.js',
    aliases: ['set.js', 'set-constant', 'ubo-set-constant.js'],
    kind: 'template',
    code: `(() => {
      const chain = {{1}};
      const rawVal = {{2}};
      if (typeof chain !== 'string' || !/^[A-Za-z0-9_$.]+$/.test(chain)) return;
      let val = undefined;
      if (rawVal === 'true') val = true;
      else if (rawVal === 'false') val = false;
      else if (rawVal === 'null') val = null;
      else if (rawVal === 'undefined') val = undefined;
      else if (rawVal === 'noopFunc') val = () => {};
      else if (rawVal === 'trueFunc') val = () => true;
      else if (rawVal === 'falseFunc') val = () => false;
      else if (rawVal === 'emptyObj') val = {};
      else if (rawVal === 'emptyArr') val = [];
      else if (/^-?\\d+$/.test(String(rawVal))) val = Number(rawVal);
      else return;
      const parts = chain.split('.');
      let owner = window;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!owner || typeof owner !== 'object') return;
        if (!(parts[i] in owner)) owner[parts[i]] = {};
        owner = owner[parts[i]];
      }
      const prop = parts[parts.length - 1];
      try {
        Object.defineProperty(owner, prop, { value: val, writable: false, configurable: true });
      } catch {
        try { owner[prop] = val; } catch {}
      }
    })();`,
  },
  {
    name: 'no-setTimeout-if.js',
    aliases: ['nostif.js', 'no-setTimeout-if', 'setTimeout-defuser.js'],
    kind: 'template',
    code: `(() => {
      const needle = {{1}};
      const delayMatch = {{2}};
      if (typeof needle !== 'string' || !needle || needle.length > 120) return;
      const orig = window.setTimeout;
      window.setTimeout = function (fn, delay, ...args) {
        const src = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn ?? '');
        const delayOk = !delayMatch || Number(delayMatch) === Number(delay);
        if (delayOk && src.includes(needle)) return 0;
        return orig.call(this, fn, delay, ...args);
      };
    })();`,
  },
  {
    name: 'no-setInterval-if.js',
    aliases: ['nosiif.js', 'no-setInterval-if', 'setInterval-defuser.js'],
    kind: 'template',
    code: `(() => {
      const needle = {{1}};
      if (typeof needle !== 'string' || !needle || needle.length > 120) return;
      const orig = window.setInterval;
      window.setInterval = function (fn, delay, ...args) {
        const src = typeof fn === 'function' ? Function.prototype.toString.call(fn) : String(fn ?? '');
        if (src.includes(needle)) return 0;
        return orig.call(this, fn, delay, ...args);
      };
    })();`,
  },
  {
    name: 'nowebrtc.js',
    aliases: ['nowebrtc', 'ubo-nowebrtc.js'],
    kind: { mime: 'application/javascript' },
    code: `(() => {
      const noop = () => { throw new Error('WebRTC disabled by Kinex Shields rule'); };
      try { Object.defineProperty(window, 'RTCPeerConnection', { value: noop, configurable: true }); } catch {}
      try { Object.defineProperty(window, 'webkitRTCPeerConnection', { value: noop, configurable: true }); } catch {}
    })();`,
  },
  {
    name: 'no-fetch-if.js',
    aliases: ['no-fetch-if', 'noop-fetch.js'],
    kind: 'template',
    code: `(() => {
      const needle = {{1}};
      if (typeof needle !== 'string' || !needle || needle.length > 120) return;
      const origFetch = window.fetch;
      if (typeof origFetch !== 'function') return;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input ?? '');
        if (url.includes(needle)) {
          return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        return origFetch.call(this, input, init);
      };
    })();`,
  },
];

export const ALLOWLISTED_SCRIPTLET_NAMES = new Set<string>(
  VETTED_SCRIPTLETS.flatMap((entry) => [entry.name, ...entry.aliases])
);

export function buildVettedAdblockResources(): AdblockResource[] {
  const redirects: AdblockResource[] = [
    {
      name: 'noopjs',
      aliases: ['noop.js', 'noop.js-0.1s', 'noop-0.1s.js', 'empty'],
      kind: { mime: 'application/javascript' },
      content: encodeB64('(() => {})();'),
    },
    {
      name: 'noopcss',
      aliases: ['noop.css'],
      kind: { mime: 'text/css' },
      content: encodeB64('/* kinex noop css */'),
    },
    {
      name: 'nooptext',
      aliases: ['noop.txt', 'noophtml', 'noop.html'],
      kind: { mime: 'text/plain' },
      content: encodeB64(''),
    },
    {
      name: 'noopjson',
      aliases: ['noop.json'],
      kind: { mime: 'application/json' },
      content: encodeB64('{}'),
    },
    {
      name: 'noop-vmap.xml',
      aliases: ['noop-vast.xml'],
      kind: { mime: 'text/xml' },
      content: encodeB64('<VMAP xmlns:vmap="http://www.iab.net/videosuite/vmap" version="1.0"/>'),
    },
    {
      name: '1x1.gif',
      aliases: ['1x1-transparent.gif', '1x1-pixel.gif'],
      kind: { mime: 'image/gif' },
      content: TRANSPARENT_1X1_GIF_B64,
    },
    {
      name: '2x2.png',
      aliases: ['2x2-transparent.png', '32x32-transparent.png', '32x32.png'],
      kind: { mime: 'image/png' },
      content: TRANSPARENT_2X2_PNG_B64,
    },
    {
      name: 'google-analytics_analytics.js',
      aliases: ['www.google-analytics.com/analytics.js', 'googletagmanager_gtm.js'],
      kind: { mime: 'application/javascript' },
      content: encodeB64(
        '(() => { const ga = (...a) => { const cb = a.find(x => typeof x === "function"); if (cb) try { cb(); } catch {} }; ga.create = () => ({ get: () => "" }); ga.getAll = () => []; ga.getByName = () => null; window.ga = window.ga || ga; window.dataLayer = window.dataLayer || []; })();'
      ),
    },
    {
      name: 'googlesyndication_adsbygoogle.js',
      aliases: ['pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'],
      kind: { mime: 'application/javascript' },
      content: encodeB64(
        '(() => { window.adsbygoogle = window.adsbygoogle || { loaded: true, push() {} }; })();'
      ),
    },
  ];

  const scriptlets: AdblockResource[] = VETTED_SCRIPTLETS.map((s) => ({
    name: s.name,
    aliases: s.aliases,
    kind: s.kind,
    content: encodeB64(s.code),
  }));

  return [...redirects, ...scriptlets];
}
