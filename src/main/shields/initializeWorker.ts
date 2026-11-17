import { parentPort, workerData } from 'node:worker_threads';
import type { PersistedShieldsSettings } from '../../shared/types';
import { KinexShieldsEngine } from './engine';

const data = workerData as { userDataDir: string; settings: PersistedShieldsSettings };
try {
  const engine = new KinexShieldsEngine(data.userDataDir, data.settings);
  engine.initializeSync();
  parentPort?.postMessage({ ready: engine.isReady(), error: engine.getError() });
} catch (error) {
  parentPort?.postMessage({ ready: false, error: error instanceof Error ? error.message : 'Shields initialization failed' });
}
