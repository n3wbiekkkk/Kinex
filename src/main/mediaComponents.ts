export interface ComponentsAdapter {
  whenReady: () => Promise<unknown>;
  status: () => Record<string, unknown>;
  WIDEVINE_CDM_ID?: string;
}

export function summarizeComponentStatus(raw: Record<string, unknown>): Record<string, { status?: string; version?: string; error?: string }> {
  const summary: Record<string, { status?: string; version?: string; error?: string }> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!/^[a-zA-Z0-9._-]+$/.test(id) || !value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    summary[id] = {};
    for (const key of ['status', 'version'] as const) {
      if (typeof entry[key] === 'string') summary[id][key] = entry[key].slice(0, 128);
    }
    const error = entry.error;
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      summary[id].error = error.code.slice(0, 80);
    }
  }
  return summary;
}

export async function initializeMediaComponents(
  components: ComponentsAdapter | undefined,
  log: (message: string) => void
): Promise<boolean> {
  if (!components) {
    log('Widevine components API unavailable; continuing with ordinary playback');
    return false;
  }
  try {
    await components.whenReady();
    log(`Widevine components ${JSON.stringify(summarizeComponentStatus(components.status()))}`);
    return true;
  } catch {
    log('Widevine initialization failed; continuing with ordinary playback');
    return false;
  }
}
