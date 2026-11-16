/// <reference types="vite/client" />
import type { NookAPI } from '../shared/types';

declare global {
  interface Window {
    nookAPI: NookAPI;
  }
}
