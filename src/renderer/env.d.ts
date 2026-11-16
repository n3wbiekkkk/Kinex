/// <reference types="vite/client" />
import type { KinexAPI } from '../shared/types';

declare global {
  interface Window {
    kinexAPI: KinexAPI;
  }
}
