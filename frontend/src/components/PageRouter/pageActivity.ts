// components/PageRouter/pageActivity.ts
//
// Pages stay mounted once visited (the router keeps them alive so scroll,
// filters and half-filled forms survive a round trip), which means a hidden
// page's effects keep running. Anything that listens globally (a window
// keydown shortcut) or polls on a timer must therefore ask whether its page is
// the one on screen. This context answers that; outside the router (tests,
// stray mounts) a page counts as active.

import { createContext, useContext } from 'react';

/** `true` while the page rendered inside is the one the user is looking at. */
export const PageActivityContext = createContext<boolean>(true);

/** Whether the surrounding page is the active one. */
export function usePageActive(): boolean {
  return useContext(PageActivityContext);
}
