import { create } from 'zustand';
import type { PlaceSeed } from './placeLibraryStore';

export interface LaunchIntent {
  accountIds: string[];
  seed?: PlaceSeed;
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
