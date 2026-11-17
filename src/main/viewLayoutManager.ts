import type { BrowserWindow, WebContentsView } from 'electron';

export interface ViewBoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutComputeInput {
  windowWidth: number;
  windowHeight: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  paneCount: number;
  splitRatio: number;
  toolbarVisible?: boolean;
  htmlFullscreenPaneIndex?: number;
}

export interface ComputedLayoutRects {
  shell: ViewBoundsRect;
  panes: ViewBoundsRect[];
  overlay: ViewBoundsRect;
}

export function computeViewRects(input: LayoutComputeInput): ComputedLayoutRects {
  const width = Math.max(400, Math.round(input.windowWidth));
  const height = Math.max(300, Math.round(input.windowHeight));
  const full: ViewBoundsRect = { x: 0, y: 0, width, height };
  const paneCount = Math.min(2, Math.max(0, input.paneCount));

  if (
    typeof input.htmlFullscreenPaneIndex === 'number' &&
    input.htmlFullscreenPaneIndex >= 0 &&
    input.htmlFullscreenPaneIndex < paneCount
  ) {
    const panes = Array.from({ length: paneCount }, (_item, index) =>
      index === input.htmlFullscreenPaneIndex
        ? full
        : { x: -10000, y: -10000, width: 100, height: 100 }
    );
    return { shell: full, panes, overlay: full };
  }

  const clampedSidebarWidth = Math.min(380, Math.max(200, Math.round(input.sidebarWidth)));
  const sw = input.sidebarOpen ? clampedSidebarWidth : 0;
  const topBarH = !input.sidebarOpen || paneCount > 1 || input.toolbarVisible ? 40 : 10;

  const areaX = input.sidebarOpen ? sw : 10;
  const areaY = topBarH;
  const areaW = Math.max(200, width - areaX - 10);
  const areaH = Math.max(200, height - areaY - 10);

  const panes: ViewBoundsRect[] = [];
  if (paneCount === 1) {
    panes.push({ x: areaX, y: areaY, width: areaW, height: areaH });
  } else if (paneCount === 2) {
    const gap = 8;
    const ratio = Math.min(0.78, Math.max(0.22, input.splitRatio || 0.5));
    const leftW = Math.floor((areaW - gap) * ratio);
    const rightW = areaW - gap - leftW;
    panes.push(
      { x: areaX, y: areaY, width: leftW, height: areaH },
      { x: areaX + leftW + gap, y: areaY, width: rightW, height: areaH }
    );
  }

  return { shell: full, panes, overlay: full };
}

export class ViewLayoutManager {
  applyLayout(params: {
    mainWindow: BrowserWindow | null;
    shellView: WebContentsView | null;
    overlayView: WebContentsView | null;
    allTabViews: Map<string, WebContentsView>;
    activeTabIds: string[];
    sidebarOpen: boolean;
    sidebarWidth: number;
    splitRatio: number;
    toolbarVisible?: boolean;
    hasOverlay: boolean;
    htmlFullscreenTabId?: string | null;
    extensionPopupView?: WebContentsView | null;
    extensionPopupBounds?: ViewBoundsRect | null;
  }): void {
    const { mainWindow, shellView, overlayView, allTabViews, activeTabIds } = params;
    if (!mainWindow || mainWindow.isDestroyed() || !shellView) return;

    const { width, height } = mainWindow.getContentBounds();
    const visibleIds = activeTabIds.slice(0, 2);
    const htmlFullscreenPaneIndex =
      params.htmlFullscreenTabId ? visibleIds.indexOf(params.htmlFullscreenTabId) : -1;
    const isHtmlFullscreen = htmlFullscreenPaneIndex >= 0;

    const rects = computeViewRects({
      windowWidth: width,
      windowHeight: height,
      sidebarOpen: params.sidebarOpen,
      sidebarWidth: params.sidebarWidth,
      paneCount: visibleIds.length,
      splitRatio: params.splitRatio,
      toolbarVisible: params.toolbarVisible,
      htmlFullscreenPaneIndex,
    });

    shellView.setVisible(!isHtmlFullscreen);
    shellView.setBounds(rects.shell);

    const visiblePaneIds = isHtmlFullscreen
      ? [visibleIds[htmlFullscreenPaneIndex]]
      : visibleIds;
    const visibleSet = new Set(visiblePaneIds);

    for (const [id, view] of allTabViews) {
      if (!visibleSet.has(id)) {
        view.setVisible(false);
        view.setBounds({ x: -10000, y: -10000, width: 100, height: 100 });
      }
    }

    visibleIds.forEach((tabId, idx) => {
      if (isHtmlFullscreen && idx !== htmlFullscreenPaneIndex) return;
      const view = allTabViews.get(tabId);
      const rect = rects.panes[idx];
      if (!view || !rect) return;
      view.setVisible(true);
      view.setBounds(rect);
    });

    if (overlayView) {
      if (params.hasOverlay) {
        overlayView.setVisible(true);
        overlayView.setBounds(rects.overlay);
      } else {
        overlayView.setVisible(false);
        overlayView.setBounds({ x: -10000, y: -10000, width: 100, height: 100 });
      }
    }

    const popupVisible = Boolean(params.extensionPopupView && params.extensionPopupBounds);
    if (params.extensionPopupView) {
      if (params.extensionPopupBounds) {
        params.extensionPopupView.setVisible(true);
        params.extensionPopupView.setBounds(params.extensionPopupBounds);
      } else {
        params.extensionPopupView.setVisible(false);
        params.extensionPopupView.setBounds({ x: -10000, y: -10000, width: 100, height: 100 });
      }
    }

    const desired = visiblePaneIds
      .map((id) => allTabViews.get(id))
      .filter((view): view is WebContentsView => Boolean(view));
    if (overlayView && params.hasOverlay) desired.push(overlayView);
    if (popupVisible && params.extensionPopupView) desired.push(params.extensionPopupView);
    const current = mainWindow.contentView.children.filter((view) => desired.includes(view as WebContentsView));
    if (desired.some((view, index) => current[index] !== view)) {
      for (const view of desired) {
        mainWindow.contentView.removeChildView(view);
        mainWindow.contentView.addChildView(view);
      }
    }
  }
}
