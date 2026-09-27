// stores/shellStore.ts
//
// Window-chrome preferences that more than one shell surface reads: whether the
// navigation rail is collapsed to icons (the title bar's brand cell follows the
// rail's width) and how dense the account roster is drawn. Both persist through
// lib/persistence, so a restart keeps the layout the user left.

import { create } from 'zustand';
import { getPersisted, PERSISTENCE_KEYS, setPersisted } from '../lib/persistence';

/** How tightly the account roster is packed. */
export type RosterDensity = 'comfortable' | 'compact';

/** Public shape of the shell store. */
export interface ShellState {
  /** Whether the navigation rail shows icons only. */
  railCollapsed: boolean;
  /** Collapse or expand the rail, persisting the choice. */
  setRailCollapsed: (collapsed: boolean) => void;
  /** Flip the rail between collapsed and expanded. */
  toggleRail: () => void;
  /** Row density of the account roster. */
  density: RosterDensity;
  /** Change the roster density, persisting the choice. */
  setDensity: (density: RosterDensity) => void;
}

function initialRailCollapsed(): boolean {
  return getPersisted<unknown>(PERSISTENCE_KEYS.railCollapsed) === true;
}

function initialDensity(): RosterDensity {
  return getPersisted<unknown>(PERSISTENCE_KEYS.accountsDensity) === 'compact'
    ? 'compact'
    : 'comfortable';
}

export const useShellStore = create<ShellState>((set, get) => ({
  railCollapsed: initialRailCollapsed(),
  setRailCollapsed: (collapsed) => {
    setPersisted(PERSISTENCE_KEYS.railCollapsed, collapsed);
    set({ railCollapsed: collapsed });
  },
  toggleRail: () => get().setRailCollapsed(!get().railCollapsed),
  density: initialDensity(),
  setDensity: (density) => {
    setPersisted(PERSISTENCE_KEYS.accountsDensity, density);
    set({ density });
  },
}));

