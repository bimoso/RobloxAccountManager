// stores/inspectorStore.ts
//
// Which account the roster's detail panel ("the inspector") is showing.
//
// This is deliberately a store rather than local state inside the Accounts
// page, because two very different surfaces need to drive it and neither may
// import the other:
//
//   - the Accounts page itself, when a row is clicked or arrowed to;
//   - the Command_Palette (`components/CommandPalette`), which can jump
//     straight to an account from anywhere in the app.
//
// `components/` may not import from `pages/`, and one page may not import from
// another, so a shared store is the only seam that lets the palette say "show
// me this account" without either side knowing the other exists.
//
// It holds an id, never an Account: the Account_Store stays the single source
// of truth for account data, so an account edited or removed elsewhere can
// never leave a stale copy rendered in the panel.

import { create } from 'zustand';

/** The inspector's state. */
export interface InspectorState {
  /** The account currently shown in the detail panel, or `null` for none. */
  focusedAccountId: string | null;
  /**
   * Whether the panel is open. Kept separate from `focusedAccountId` so closing
   * the panel does not forget which account was being looked at — reopening
   * returns to it.
   */
  open: boolean;
  /** Show `accountId` in the panel, opening it if it was closed. */
  inspect: (accountId: string) => void;
  /** Close the panel, remembering the focused account. */
  close: () => void;
  /** Open or close the panel without changing the focused account. */
  toggle: () => void;
  /**
   * Drop the focus if it points at an account that no longer exists.
   *
   * Called by the roster after a delete or a reload: without it the panel would
   * keep an id the Account_Store can no longer resolve and render empty.
   *
   * @param existingIds - Ids currently present in the Account_Store.
   */
  reconcile: (existingIds: readonly string[]) => void;
}

export const useInspectorStore = create<InspectorState>((set, get) => ({
  focusedAccountId: null,
  open: false,

  inspect: (accountId) => set({ focusedAccountId: accountId, open: true }),

  close: () => set({ open: false }),

  toggle: () => set({ open: !get().open }),

  reconcile: (existingIds) => {
    const focused = get().focusedAccountId;
    if (focused === null || existingIds.includes(focused)) {
      return;
    }
    set({ focusedAccountId: null, open: false });
  },
}));
