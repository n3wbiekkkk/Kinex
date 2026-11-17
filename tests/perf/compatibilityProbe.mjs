export function selectProbeTarget(targets, previousIds, finalUrl, boundId) {
  const pages = targets.filter((target) => target.type === 'page');
  if (boundId) return pages.find((target) => target.id === boundId) ?? null;
  const created = pages.filter((target) => !previousIds.has(target.id));
  if (created.length === 1) return created[0];
  const exact = created.filter((target) => target.url === finalUrl);
  return exact.length === 1 ? exact[0] : null;
}

export function summarizeScroll(before, after) {
  if (!before || !after) return { status: 'inconclusive', ok: null };
  if (before.maxScroll <= 2) return { status: 'not-scrollable', ok: null };
  return Math.abs(after.top - before.top) > 1
    ? { status: 'passed', ok: true }
    : { status: 'failed', ok: false };
}

// Return an element handle so the wheel check observes the same scroller across animation frames.
export function findScrollSurface() {
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollHeight > root.clientHeight + 2) return root;
  return [...document.querySelectorAll('*')].find((element) => {
    const bounds = element.getBoundingClientRect();
    return element.scrollHeight > element.clientHeight + 2 &&
      /auto|scroll/.test(getComputedStyle(element).overflowY) &&
      bounds.width > 80 && bounds.height > 80 &&
      bounds.bottom > 0 && bounds.top < innerHeight &&
      bounds.right > 0 && bounds.left < innerWidth;
  }) ?? root;
}

export function readScrollSurface() {
  const bounds = this.getBoundingClientRect();
  const root = this === document.scrollingElement || this === document.documentElement;
  return {
    top: this.scrollTop,
    maxScroll: Math.max(0, this.scrollHeight - this.clientHeight),
    kind: root ? 'document' : 'nested',
    x: root ? Math.round(innerWidth / 2) : Math.round(Math.max(1, Math.min(innerWidth - 2, bounds.left + bounds.width / 2))),
    y: root ? Math.round(innerHeight / 2) : Math.round(Math.max(1, Math.min(innerHeight - 2, bounds.top + bounds.height / 2))),
  };
}

// Await two animation frames so the wheel/keyboard checks observe the same scroller.
// A hidden tab never fires requestAnimationFrame, so an unbounded wait hangs the
// calling Runtime.evaluate until the CDP timeout and reports a browser failure that
// never happened. Resolve on a timer instead of hanging, and report whether frames
// actually ran so callers can tell "painted" from "could not paint".
export async function waitForPaint(timeoutMs = 1000) {
  const painted = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (typeof requestAnimationFrame !== 'function') {
      finish(false);
      return;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => finish(true)));
  });
  return { painted, visibility: typeof document === 'undefined' ? 'unknown' : document.visibilityState };
}

// A backgrounded tab cannot be scrolled or painted through CDP: the compositor stops
// producing frames and Input.dispatchMouseEvent never acknowledges. Readiness checks
// must name that condition instead of timing out and blaming the website.
export function readProbeVisibility() {
  return {
    visibilityState: typeof document === 'undefined' ? 'unknown' : document.visibilityState,
    hidden: typeof document === 'undefined' ? null : Boolean(document.hidden),
  };
}

export function publicPageInfo() {
  const bodyText = (document.body?.innerText ?? '').slice(0, 3000);
  const blocked = /verify (?:you are|you're) human|unusual traffic|blocked by network security|access denied|robot check/i.test(bodyText);
  return {
    url: location.href,
    title: document.title,
    ready: document.readyState === 'interactive' || document.readyState === 'complete',
    errorPage: location.protocol === 'chrome-error:',
    blocked,
    authWall: /(^|\.)accounts\.google\.com$/.test(location.hostname) || /\/(login|signin)(?:\/|$)/i.test(location.pathname),
    textLength: document.body?.textContent?.trim().length ?? 0,
    links: document.querySelectorAll('a[href]').length,
    forms: document.forms.length,
    fileInputs: document.querySelectorAll('input[type="file"]').length,
    fullscreenSupported: document.fullscreenEnabled,
    pictureInPictureSupported: Boolean(document.pictureInPictureEnabled),
    media: [...document.querySelectorAll('video, audio')].map((media) => ({
      kind: media.tagName.toLowerCase(),
      readyState: media.readyState,
      paused: media.paused,
      currentTime: media.currentTime,
      muted: media.muted,
      errorCode: media.error?.code ?? null,
      videoWidth: media.videoWidth ?? null,
      videoHeight: media.videoHeight ?? null,
      frames: media.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
      droppedFrames: media.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
    })),
  };
}
