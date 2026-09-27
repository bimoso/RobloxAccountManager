import { create } from 'zustand';
import type { PlaceSeed } from './placeLibraryStore';

/** A saved private server handed to the launcher alongside its Place. */
export interface PrivateServerSeed {
  id: string;
  name: string;
  link: string;
}

/**
 * Destination handed off to the launcher. A bare Place opens the "Place" tab;
 * a Place carrying `privateServer` opens the "Private" tab with that link.
 */
export interface LaunchSeed extends PlaceSeed {
  privateServer?: PrivateServerSeed;
}

export interface LaunchIntent {
  accountIds: string[];
  seed?: LaunchSeed;
}

interface LaunchIntentState {
  intent: LaunchIntent | null;
  open: (intent: LaunchIntent) => void;
  close: () => void;
}

export const useLaunchIntentStore = create<LaunchIntentState>((set) => ({
  intent: null,
  open: (intent) => set({ intent: { ...intent, accountIds: [...intent.accountIds] } }),
  close: () => set({ intent: null }),
}));
