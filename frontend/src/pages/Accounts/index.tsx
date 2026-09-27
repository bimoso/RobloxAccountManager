import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  animate,
  AnimatePresence,
  motion,
  useMotionValue,
  useReducedMotion,
} from 'framer-motion';
import {
  CheckSquare2,
  CirclePlay,
  Cookie,
  ArrowDownUp,
  Globe2,
  GripVertical,
  Grid2X2,
  ListChecks,
  ListFilter,
  Plus,
  Rows3,
  Rows4,
  Search,
  Square,
  StickyNote,
  Trash2,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { usePageActive } from '@/components/PageRouter/pageActivity';
import {
  ACCOUNT_SORTS,
  displayName,
  filterAccounts,
  listState,
  resolveInitialFilter,
  resolveInitialSort,
  searchAccounts,
  setFilter as persistFilter,
  setSort as persistSort,
  setView as persistView,
  sortAccounts,
} from '@/lib/filters';
import { getPersisted, PERSISTENCE_KEYS } from '@/lib/persistence';
import { bulkBarVisible, selectAll, toggleSelection } from '@/lib/selection';
import { identityStyle } from '@/lib/identity';
import { useAccountStore } from '@/stores/accountStore';
import { useInspectorStore } from '@/stores/inspectorStore';
import { useShellStore } from '@/stores/shellStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account, AccountFilter, AccountSort, AccountsView } from '@/types/models';
import { AccountCard, AccountRow } from './AccountCard';
import { AccountCardMenu, type AccountCardMenuActions } from './AccountCardMenu';
import { AccountInspector } from './AccountInspector';
import './accounts.css';

/**
 * Bulk actions offered by the selection bar. Each receives the concrete list of
 * selected accounts so the surrounding container can open the matching flow.
 */
export interface AccountsBulkActions {
  /** Launch every selected account (opens the launch modal for the batch). */
  onLaunchSelected?: (accounts: Account[]) => void;
  /** Kill/stop the running instances of every selected account. */
  onKillSelected?: (accounts: Account[]) => void;
  /** Send a friend request from every selected account. */
  onFriendRequestSelected?: (accounts: Account[]) => void;
  /** Edit notes for every selected account (bulk notes modal). */
  onNotesSelected?: (accounts: Account[]) => void;
  /** Copy the cookies of every selected account to the clipboard. */
  onCopyCookiesSelected?: (accounts: Account[]) => void;
  /** Open a browser session for every selected account. */
  onOpenBrowsersSelected?: (accounts: Account[]) => void;
}

export interface AccountsPageProps extends AccountCardMenuActions, AccountsBulkActions {
  /** Start the add-account flow (empty-state CTA + header button). */
  onAddAccount?: () => void;
  /** Optional override for the base account list. */
  baseAccounts?: Account[];
  /** Avatar thumbnail URLs keyed by account id. */
  avatarUrls?: Record<string, string>;
}

const FILTER_IDS: readonly AccountFilter[] = [
  'all',
  'running',
  'idle',
  'valid-first',
  'invalid-first',
];

const DRAG_THRESHOLD_PX = 8;
const DRAG_GRAB_Y = 24;

/**
 * Page width, in px, below which the detail panel stops splitting the page.
 *
 * The panel is worth about 340–400px; taking that out of a narrower page would
 * squeeze the roster below the width of its own rows. Below the threshold the
 * panel floats over the roster as a sheet instead, so clicking a row always
 * answers — at the app's default window size included.
 */
const INSPECTOR_MIN_PAGE_WIDTH = 1120;

/**
 * Resolve the startup view.
 *
 * The dense rack (`'list'`) is now the default: at the app's own 900×680
 * minimum the card grid showed four accounts, the table shows eighteen. The
 * card grid is not gone — it stays behind the page's view toggle, and a user
 * who picked it keeps it, because an explicitly persisted choice still wins.
 */
function resolveStartupView(): AccountsView {
  const stored = getPersisted<unknown>(PERSISTENCE_KEYS.view);
  return stored === 'grid' || stored === 'list' ? stored : 'list';
}

/**
 * Return an element's final layout position in viewport coordinates without
 * including Framer Motion's temporary FLIP transform. Reading
 * getBoundingClientRect() while neighbours are reordering returns the visual
 * in-between frame, which makes the clone settle short and then jump.
 */
function layoutViewportPosition(element: HTMLElement): { left: number; top: number } {
  // Framer writes the FLIP projection to this wrapper's inline transform.
  // Neutralise only that transform for one synchronous geometry read, then put
  // it back before the browser can paint. Unlike offsetTop/Left arithmetic,
  // this keeps every intermediate scroll container and transformed ancestor in
  // the viewport calculation.
  const projectedTransform = element.style.transform;
  if (projectedTransform) element.style.transform = 'none';
  try {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, top: rect.top };
  } finally {
    if (projectedTransform) element.style.transform = projectedTransform;
  }
}

/** Strip the duplicate-disambiguation suffix (`#n`) from a selection key. */
function baseId(selKey: string): string {
  const hash = selKey.indexOf('#');
  return hash === -1 ? selKey : selKey.slice(0, hash);
}

/**
 * The Accounts page: the app's flagship rack.
 *
 * The default presentation is a dense `.rk-table` — one hairline-ruled row per
 * account, sharing a single `--cols` declaration with its sticky header — with
 * search, filtering, multi-selection + bulk actions, and drag-to-reorder. The
 * card grid stays available behind the view toggle and drag-reorder works
 * identically in both.
 */
export function Accounts({
  onAddAccount,
  baseAccounts,
  avatarUrls,
  onLaunchSelected,
  onKillSelected,
  onFriendRequestSelected,
  onNotesSelected,
  onCopyCookiesSelected,
  onOpenBrowsersSelected,
  ...cardActions
}: AccountsPageProps): JSX.Element {
  const accounts = useAccountStore((state) => state.accounts);
  const load = useAccountStore((state) => state.load);
  const confirmBulkDelete = useAccountStore((state) => state.confirmBulkDelete);
  const applyReorderedIds = useAccountStore((state) => state.applyReorderedIds);
  // The inspector's focus lives in a store rather than here because the command
  // palette can also jump straight to an account, and neither surface may
  // import the other.
  const inspectorOpen = useInspectorStore((state) => state.open);
  const focusedAccountId = useInspectorStore((state) => state.focusedAccountId);
  const inspect = useInspectorStore((state) => state.inspect);
  const closeInspector = useInspectorStore((state) => state.close);
  const reconcileInspector = useInspectorStore((state) => state.reconcile);
  const density = useShellStore((state) => state.density);
  const setDensity = useShellStore((state) => state.setDensity);
  const { t } = useTranslation();
  const pageActive = usePageActive();

  // `t` is rebound per language, so the options re-derive on language change.
  const filterOptions = useMemo<ReadonlyArray<DropdownOption<AccountFilter>>>(
    () => FILTER_IDS.map((value) => ({ value, label: t(`accounts.filter.${value}`) })),
    [t],
  );

  // `t` is rebound per language, so the options re-derive on language change.
  const sortOptions = useMemo<ReadonlyArray<DropdownOption<AccountSort>>>(
    () => ACCOUNT_SORTS.map((value) => ({ value, label: t(`accounts.sort.${value}`) })),
    [t],
  );

  const [view, setViewState] = useState<AccountsView>(() => resolveStartupView());
  const [filter, setFilterState] = useState<AccountFilter>(() => resolveInitialFilter());
  const [sort, setSortState] = useState<AccountSort>(() => resolveInitialSort());
  const [query, setQuery] = useState('');

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());

  // Pointer-based drag reorder. The floating card is rendered on compositor
  // motion values so pointer tracking never waits for a React render.
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragPending, setDragPending] = useState(false);
  const [dragSettling, setDragSettling] = useState(false);
  const [dragSize, setDragSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [orderKeys, setOrderKeys] = useState<string[] | null>(null);
  const cloneX = useMotionValue(0);
  const cloneY = useMotionValue(0);
  const reducedMotion = useReducedMotion();
  const orderKeysRef = useRef<string[] | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const dragRef = useRef<{
    key: string;
    pointerId: number;
    startX: number;
    startY: number;
    latestX: number;
    latestY: number;
    width: number;
    height: number;
    active: boolean;
    overKey: string | null;
  } | null>(null);

  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; message: string }>({
    open: false,
    message: '',
  });
  const confirmResolverRef = useRef<((value: boolean) => void) | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // A completed drag ends with a `click` on whatever the pointer was released
  // over. Without this the gesture that reorders a row would also inspect it.
  const draggedRef = useRef(false);

  // ── Room for the detail panel ──
  // Measured off the page itself, not the window: the shell's rail and the
  // status line mean the viewport is a poor proxy for how much width the roster
  // actually has. jsdom has no ResizeObserver, so the default keeps the panel
  // available under test.
  // The first guess comes from the window so the very first click already
  // opens the right kind of panel; the observer below then keeps it exact.
  const [pageWideEnough, setPageWideEnough] = useState(() =>
    typeof window === 'undefined' || typeof ResizeObserver === 'undefined'
      ? true
      : window.innerWidth - 240 >= INSPECTOR_MIN_PAGE_WIDTH,
  );
  const pageObserverRef = useRef<ResizeObserver | null>(null);
  // The observer lives and dies with the element: the callback ref receives
  // null on unmount and disconnects it. (A separate unmount effect would also
  // run during StrictMode's simulated remount, killing the observer for good
  // while the ref never re-attaches.)
  const measurePage = useCallback((node: HTMLDivElement | null): void => {
    pageObserverRef.current?.disconnect();
    pageObserverRef.current = null;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[entries.length - 1]?.contentRect.width ?? 0;
      if (width > 0) setPageWideEnough(width >= INSPECTOR_MIN_PAGE_WIDTH);
    });
    observer.observe(node);
    pageObserverRef.current = observer;
  }, []);

  useEffect(() => {
    if (accounts.length === 0) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sourceAccounts = baseAccounts ?? accounts;

  // A deleted account must not leave the panel rendering a ghost: the store
  // drops a focus it can no longer resolve as soon as the list changes.
  useEffect(() => {
    reconcileInspector(sourceAccounts.map((account) => account.id));
  }, [sourceAccounts, reconcileInspector]);

  // Stable, unique selection key per account. `Account.id` is unique for new
  // writes, but legacy/corrupt stores can still contain repeated ids; keying
  // selection purely on that field would cross-select every duplicate. We
  // disambiguate repeated ids with a `#n` suffix so selecting one card never
  // selects another.
  const selKeyOf = useMemo(() => {
    const map = new Map<Account, string>();
    const seen = new Map<string, number>();
    for (const account of sourceAccounts) {
      const n = seen.get(account.id) ?? 0;
      seen.set(account.id, n + 1);
      map.set(account, n === 0 ? account.id : `${account.id}#${n}`);
    }
    return map;
  }, [sourceAccounts]);

  const keyFor = useCallback(
    (account: Account): string => selKeyOf.get(account) ?? account.id,
    [selKeyOf],
  );

  const visibleAccounts = useMemo(
    () => sortAccounts(searchAccounts(filterAccounts(sourceAccounts, filter), query), sort),
    [sourceAccounts, filter, query, sort],
  );
  const state = useMemo(
    () => listState(sourceAccounts.length, visibleAccounts.length),
    [sourceAccounts.length, visibleAccounts.length],
  );

  // During a drag, render the cards in the live-reordered order; otherwise use
  // the normal filtered/searched list.
  const displayAccounts = useMemo(() => {
    if (!orderKeys) return visibleAccounts;
    const byKey = new Map(visibleAccounts.map((account) => [keyFor(account), account]));
    const ordered = orderKeys
      .map((key) => byKey.get(key))
      .filter((account): account is Account => account !== undefined);
    // Append any visible account missing from the live order (defensive).
    for (const account of visibleAccounts) {
      if (!orderKeys.includes(keyFor(account))) ordered.push(account);
    }
    return ordered;
  }, [orderKeys, visibleAccounts, keyFor]);

  const draggedAccount = useMemo(
    () =>
      dragKey === null
        ? null
        : visibleAccounts.find((account) => keyFor(account) === dragKey) ?? null,
    [dragKey, visibleAccounts, keyFor],
  );

  // ── The inspector's subject ──
  // Resolved from the live list on every render rather than copied into state,
  // so an edit made in a modal (or a cookie expiring under the poller) is
  // reflected in the panel immediately.
  const focusedAccount = useMemo(
    () =>
      focusedAccountId === null
        ? null
        : sourceAccounts.find((account) => account.id === focusedAccountId) ?? null,
    [sourceAccounts, focusedAccountId],
  );

  // Previous/next walk the CURRENTLY FILTERED, CURRENTLY SORTED list, so
  // stepping through the panel follows the order the user is looking at.
  const focusedIndex = useMemo(
    () =>
      focusedAccountId === null
        ? -1
        : visibleAccounts.findIndex((account) => account.id === focusedAccountId),
    [visibleAccounts, focusedAccountId],
  );
  const previousAccount = focusedIndex > 0 ? visibleAccounts[focusedIndex - 1] : null;
  const nextAccount =
    focusedIndex >= 0 && focusedIndex + 1 < visibleAccounts.length
      ? visibleAccounts[focusedIndex + 1]
      : null;

  // Wide pages split the roster and the panel; narrower ones float the panel
  // over the roster as a sheet.
  const inspectorSplit = inspectorOpen && pageWideEnough;
  const inspectorOverlay = inspectorOpen && !pageWideEnough;
  const launchOne = cardActions.onLaunch;

  /** Plain-click activation: inspect the row, unless the click ended a drag. */
  const handleInspect = useCallback(
    (account: Account) => (): void => {
      if (draggedRef.current) {
        draggedRef.current = false;
        return;
      }
      inspect(account.id);
    },
    [inspect],
  );

  const handleSelectView = (next: AccountsView): void => {
    setViewState(next);
    persistView(next);
  };
  const handleSelectFilter = (next: AccountFilter): void => {
    setFilterState(next);
    persistFilter(next);
  };

  const handleSelectSort = (next: AccountSort): void => {
    setSortState(next);
    persistSort(next);
  };

  const exitSelectionMode = useCallback((): void => {
    setSelectionMode(false);
    setSelectedIds(new Set<string>());
  }, []);

  const handleToggleSelectionMode = useCallback((): void => {
    setSelectionMode((mode) => {
      if (mode) {
        setSelectedIds(new Set<string>());
        return false;
      }
      return true;
    });
  }, []);

  const handleToggleCard = useCallback((selKey: string): void => {
    setSelectedIds((current) => {
      const next = toggleSelection(current, selKey);
      if (!bulkBarVisible(next)) {
        setSelectionMode(false);
      }
      return next;
    });
  }, []);

  const handleClearSelection = useCallback((): void => {
    exitSelectionMode();
  }, [exitSelectionMode]);

  const handleSelectAll = useCallback((): void => {
    const visibleKeys = visibleAccounts.map((account) => keyFor(account));
    setSelectedIds((current) => selectAll(visibleKeys, current));
  }, [visibleAccounts, keyFor]);

  /** The concrete accounts behind the current selection (order preserved). */
  const selectedAccounts = useMemo(
    () => sourceAccounts.filter((account) => selectedIds.has(keyFor(account))),
    [sourceAccounts, selectedIds, keyFor],
  );

  const settleConfirm = useCallback((value: boolean): void => {
    setConfirmDialog((prev) => ({ ...prev, open: false }));
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    resolve?.(value);
  }, []);

  const handleDeleteSelected = useCallback(async (): Promise<void> => {
    // Map selection keys to unique backend ids (duplicates collapse to one).
    const ids = [...new Set([...selectedIds].map(baseId))];
    const result = await confirmBulkDelete(ids, (message) => {
      setConfirmDialog({ open: true, message });
      return new Promise<boolean>((resolve) => {
        confirmResolverRef.current = resolve;
      });
    });
    if (result) {
      exitSelectionMode();
    }
  }, [selectedIds, confirmBulkDelete, exitSelectionMode]);

  const runBulk = useCallback(
    (action?: (accounts: Account[]) => void): void => {
      if (!action || selectedAccounts.length === 0) return;
      action(selectedAccounts);
    },
    [selectedAccounts],
  );

  // ── Accounts hotkeys ──
  // One listener with focus guards (useHotkey's contract is a single combo
  // with no input guards, so it does not fit): `/` focuses search; Ctrl+A
  // selects every filtered account; Enter opens the launch handoff for the
  // selection (or, with no selection, launches the account in the detail
  // panel); Delete runs the bulk delete flow (same ConfirmDialog as the dock);
  // Esc closes the panel, then clears the selection; ↑/↓ walk the panel through
  // the visible roster.
  useEffect(() => {
    // The router keeps this page mounted after the user leaves it; a parked
    // roster must not answer keys meant for the page on screen.
    if (!pageActive) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      // Keys aimed at an open dropdown, menu or dialog belong to it.
      if (
        target?.closest?.('[role="combobox"], [role="listbox"], [role="menu"], [role="dialog"]') ||
        document.querySelector('.modal-backdrop, .command-menu, .rk-cmdk__scrim')
      ) {
        return;
      }

      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === 'Escape') {
        if (inspectorOpen) {
          event.preventDefault();
          closeInspector();
        } else if (selectionMode) {
          event.preventDefault();
          exitSelectionMode();
        }
        return;
      }

      if (inspectorOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        const step = event.key === 'ArrowDown' ? nextAccount : previousAccount;
        event.preventDefault();
        if (step) inspect(step.id);
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        handleSelectAll();
        return;
      }

      if (selectedAccounts.length === 0) {
        if (event.key === 'Enter' && inspectorOpen && focusedAccount && launchOne) {
          event.preventDefault();
          launchOne(focusedAccount);
        }
        return;
      }

      if (event.key === 'Enter' && onLaunchSelected) {
        event.preventDefault();
        onLaunchSelected(selectedAccounts);
        return;
      }

      if (event.key === 'Delete') {
        event.preventDefault();
        void handleDeleteSelected();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    pageActive,
    handleSelectAll,
    selectedAccounts,
    onLaunchSelected,
    handleDeleteSelected,
    inspectorOpen,
    closeInspector,
    selectionMode,
    exitSelectionMode,
    nextAccount,
    previousAccount,
    inspect,
    focusedAccount,
    launchOne,
  ]);

  // ── Pointer-based drag reorder ──
  // Free "pick up and drop anywhere" reordering: the grabbed entry follows the
  // cursor (a floating clone) while the others live-reorder around it, and the
  // new order is persisted on release. Works identically for a table row and a
  // grid tile. Disabled during selection mode so the two gestures never
  // conflict.
  // The two validity modes are stable *sorts*, not simple filters. Allowing a
  // manual cross-group reorder while one is active would make the clone land
  // and then snap back as the sort is reapplied, so keep those views explicitly
  // read-only until the user returns to an unsorted filter.
  const reorderLockedByFilter = filter === 'valid-first' || filter === 'invalid-first';
  const dragEnabled =
    !selectionMode && !reorderLockedByFilter && dragKey === null && !dragSettling;

  const setOrder = useCallback((next: string[] | null): void => {
    orderKeysRef.current = next;
    setOrderKeys(next);
  }, []);

  // Begin a *potential* drag. We do NOT use setPointerCapture: live reordering
  // moves DOM nodes, and moving a captured element releases the capture, which
  // would strand the drag. Instead pointermove/up are handled on `window` while
  // a drag is pending/active (see the effect below), which is immune to DOM
  // reordering. A press never becomes a drag until the pointer passes the
  // movement threshold, so plain clicks / right-clicks / button presses are
  // untouched.
  const handlePointerDown = useCallback(
    (account: Account) => (event: ReactPointerEvent<HTMLDivElement>): void => {
      // A fresh press starts a fresh gesture: whatever the last one was, the
      // click that follows this one is the user's, not the drag's.
      draggedRef.current = false;
      if (!dragEnabled || event.button !== 0) return;
      const target = event.target as HTMLElement;
      // Never hijack a press on an interactive control (launch, menu, checkbox).
      if (target.closest('button, a, input, textarea, [role="checkbox"], [role="menu"]')) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      dragRef.current = {
        key: keyFor(account),
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        latestX: event.clientX,
        latestY: event.clientY,
        width: rect.width,
        height: rect.height,
        active: false,
        overKey: null,
      };
      setDragSize({ w: rect.width, h: rect.height });
      setDragPending(true);
    },
    [dragEnabled, keyFor],
  );

  const commitOrder = useCallback(
    (finalOrder: string[]): void => {
      const originalKeys = visibleAccounts.map((account) => keyFor(account));
      if (!finalOrder.some((key, index) => key !== originalKeys[index])) return;

      // Map the reordered *occurrences* back to the complete store order. IDs
      // are not sufficient here: legacy data may contain distinct records with
      // the same id, and an id Set would accidentally treat a hidden duplicate
      // as visible. Object identity is stable across filter/search derivation,
      // so only the exact visible records have their slots replaced.
      const visibleByKey = new Map(
        visibleAccounts.map((account) => [keyFor(account), account] as const),
      );
      const visibleSet = new Set(visibleAccounts);
      const queue = finalOrder
        .map((key) => visibleByKey.get(key))
        .filter((account): account is Account => account !== undefined);
      let queueIndex = 0;
      const newIds = accounts.map((account) => {
        if (!visibleSet.has(account)) return account.id;
        return (queue[queueIndex++] ?? account).id;
      });
      const currentIds = accounts.map((account) => account.id);
      if (newIds.every((id, index) => id === currentIds[index])) return;
      void applyReorderedIds(newIds).catch(() => {
        /* The optimistic store rolls back; the global toast owns the error. */
      });
    },
    [accounts, applyReorderedIds, keyFor, visibleAccounts],
  );

  useEffect(
    () => () => {
      if (dragFrameRef.current !== null) window.cancelAnimationFrame(dragFrameRef.current);
      document.body.classList.remove('acc-dragging');
    },
    [],
  );

  // While a drag is pending/active, track the pointer on `window`. Pointer
  // events only update refs; one compositor write is scheduled per animation
  // frame, so a 500/1000 Hz mouse cannot force React through hundreds of
  // renders. React is involved only when the hovered slot actually changes.
  useEffect(() => {
    if (!dragPending) return;

    const paintPointerFrame = (): void => {
      dragFrameRef.current = null;
      const d = dragRef.current;
      if (!d?.active) return;

      // `clientX/Y` are viewport coordinates. The clone is portaled directly
      // to document.body and is `position: fixed`, keeping both in one space.
      cloneX.set(d.latestX - d.width / 2);
      cloneY.set(d.latestY - DRAG_GRAB_Y);

      const hit =
        typeof document.elementFromPoint === 'function'
          ? (document.elementFromPoint(d.latestX, d.latestY) as HTMLElement | null)
          : null;
      const overKey = hit?.closest<HTMLElement>('[data-selkey]')?.dataset.selkey ?? null;
      if (!overKey || overKey === d.key || overKey === d.overKey) return;

      d.overKey = overKey;
      const previous = orderKeysRef.current;
      if (!previous) return;
      const from = previous.indexOf(d.key);
      const to = previous.indexOf(overKey);
      if (from < 0 || to < 0 || from === to) return;
      const nextOrder = [...previous];
      nextOrder.splice(from, 1);
      nextOrder.splice(to, 0, d.key);

      // The legacy reorder IPC transports ids, not per-record keys. It can
      // safely consume duplicate ids by occurrence, but cannot encode an
      // inversion between two records that share the same id. Preserve their
      // relative order so every accepted visual destination is persistable and
      // the dragged card never lands in a slot the backend cannot reproduce.
      const duplicateId = baseId(d.key);
      const duplicateOrder = previous.filter((key) => baseId(key) === duplicateId);
      const proposedDuplicateOrder = nextOrder.filter((key) => baseId(key) === duplicateId);
      if (duplicateOrder.some((key, index) => key !== proposedDuplicateOrder[index])) return;

      setOrder(nextOrder);
    };

    const schedulePointerFrame = (): void => {
      if (dragFrameRef.current !== null) return;
      dragFrameRef.current = window.requestAnimationFrame(paintPointerFrame);
    };

    const flushPointerFrame = (): void => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      paintPointerFrame();
    };

    const cancel = (): void => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      dragRef.current = null;
      document.body.classList.remove('acc-dragging');
      setDragPending(false);
      setDragSettling(false);
      setDragKey(null);
      setOrder(null);
    };

    const finish = (): void => {
      // pointermove and pointerup can arrive within the same display frame.
      // Flush the final hit-test and its order update before measuring the
      // destination; otherwise React still exposes the previous slot here.
      flushSync(flushPointerFrame);
      const d = dragRef.current;
      const finalOrder = orderKeysRef.current;
      const wasActive = d?.active ?? false;
      // Swallow the click this release is about to synthesise, so dropping a
      // row into a new slot does not also open the panel on it.
      draggedRef.current = wasActive;
      dragRef.current = null;
      document.body.classList.remove('acc-dragging');
      setDragPending(false);

      // A press without a real drag (or with no order change) never reorders and
      // never touches the backend (Requirement 11.3).
      if (!wasActive || !finalOrder || !d) {
        setDragKey(null);
        setOrder(null);
        return;
      }

      // Resolve the target while the live placeholder is still mounted. Store
      // persistence waits until the visual has landed, avoiding a synchronous
      // account-list render in the middle of the settle animation.
      const placeholder = Array.from(
        document.querySelectorAll<HTMLElement>('[data-selkey]'),
      ).find((element) => element.dataset.selkey === d.key);
      const destination = placeholder ? layoutViewportPosition(placeholder) : null;
      let completed = false;

      const complete = (): void => {
        if (completed) return;
        completed = true;
        commitOrder(finalOrder);
        setDragSettling(false);
        setDragKey(null);
        setOrder(null);
      };

      if (!destination || reducedMotion) {
        if (destination) {
          cloneX.set(destination.left);
          cloneY.set(destination.top);
        }
        complete();
        return;
      }

      setDragSettling(true);
      const settleX = animate(cloneX, destination.left, {
        type: 'spring',
        duration: 0.28,
        bounce: 0,
      });
      const settleY = animate(cloneY, destination.top, {
        type: 'spring',
        duration: 0.28,
        bounce: 0,
      });
      // Both axes must finish before the clone unmounts. Completing from only
      // Y could cut off a longer horizontal trip after one or two frames.
      void Promise.all([settleX, settleY]).then(complete);
    };

    const onMove = (event: PointerEvent): void => {
      const d = dragRef.current;
      if (!d || event.pointerId !== d.pointerId) return;

      // If the pointer was released outside WebView2, Windows can return with
      // no pointerup event. A zero-button move is the reliable recovery path.
      if (d.active && event.buttons === 0) {
        cancel();
        return;
      }

      d.latestX = event.clientX;
      d.latestY = event.clientY;

      if (!d.active) {
        if (
          Math.hypot(event.clientX - d.startX, event.clientY - d.startY) <
          DRAG_THRESHOLD_PX
        ) {
          return;
        }
        d.active = true;
        // Paint synchronously on lift so the first visible clone already sits
        // under the pointer; subsequent movement is coalesced through rAF.
        cloneX.set(event.clientX - d.width / 2);
        cloneY.set(event.clientY - DRAG_GRAB_Y);
        setDragKey(d.key);
        setOrder(visibleAccounts.map((account) => keyFor(account)));
        document.body.classList.add('acc-dragging');
      }

      event.preventDefault();
      schedulePointerFrame();
    };

    const onUp = (event: PointerEvent): void => {
      const d = dragRef.current;
      if (d && event.pointerId !== d.pointerId) return;
      if (d) {
        d.latestX = event.clientX;
        d.latestY = event.clientY;
      }
      finish();
    };

    const onCancel = (event: PointerEvent): void => {
      const d = dragRef.current;
      if (d && event.pointerId !== d.pointerId) return;
      cancel();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') cancel();
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') cancel();
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', cancel);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [
    cloneX,
    cloneY,
    commitOrder,
    dragPending,
    keyFor,
    reducedMotion,
    setOrder,
    visibleAccounts,
  ]);

  const header = (
    <header className="rk-page__head">
      <div className="rk-page__titles">
        <h1>
          {t('accounts.title')}
          {sourceAccounts.length > 0 && (
            <span className="acc-title__count u-num">{sourceAccounts.length}</span>
          )}
        </h1>
        <span className="rk-page__sub">{t('accounts.subtitle')}</span>
      </div>
      <div className="rk-page__actions">
        {state === 'has-items' && (
          <Button
            variant={selectionMode ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={selectionMode}
            title={selectionMode ? undefined : t('accounts.selectHint')}
            onClick={handleToggleSelectionMode}
          >
            {selectionMode ? (
              <X size={15} aria-hidden="true" />
            ) : (
              <CheckSquare2 size={15} aria-hidden="true" />
            )}
            {selectionMode ? t('accounts.cancelSelection') : t('accounts.select')}
          </Button>
        )}
        {onAddAccount && (
          <Button variant="primary" size="sm" onClick={onAddAccount}>
            <Plus size={16} strokeWidth={2.4} aria-hidden="true" />
            {t('accounts.add')}
          </Button>
        )}
      </div>
    </header>
  );

  /** An icon-only bulk action; the accessible name comes from `aria-label`. */
  const iconAction = (
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
  ): JSX.Element => (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={15} aria-hidden="true" />
    </Button>
  );

  /**
   * A bulk action whose tooltip names the keyboard binding it already has.
   * `aria-label` supplies the whole accessible name, so "Select all" stays
   * "Select all".
   */
  const boundAction = (
    label: string,
    Icon: LucideIcon,
    cap: string,
    onClick: () => void,
    variant: 'ghost' | 'danger' = 'ghost',
  ): JSX.Element => (
    <Button
      variant={variant}
      size="sm"
      iconOnly
      aria-label={label}
      title={`${label} · ${cap}`}
      onClick={onClick}
    >
      <Icon size={15} aria-hidden="true" />
    </Button>
  );

  // The selection dock floats over the bottom of the roster: stacked faces of
  // what is selected, the count, and every bulk verb. It only animates in —
  // removal is immediate, so clearing a selection never leaves a ghost toolbar
  // around for a frame of exit animation.
  const dockVisible = bulkBarVisible(selectedIds);
  const dockFaces = selectedAccounts.slice(0, 4);
  const bulkBar = dockVisible ? (
    <motion.div
      className="acc-dock"
      role="toolbar"
      aria-label={t('accounts.bulkAria')}
      initial={reducedMotion ? false : { opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 36, mass: 0.7 }
      }
    >
      <span className="acc-dock__faces" aria-hidden="true">
        {dockFaces.map((account) => {
          const url = avatarUrls?.[account.id];
          return (
            <span
              key={keyFor(account)}
              className="acc-dock__face acc-avatar"
              style={identityStyle(account.userId || account.id)}
            >
              {url ? <img src={url} alt="" /> : (displayName(account)[0] ?? '?').toUpperCase()}
            </span>
          );
        })}
        {selectedAccounts.length > dockFaces.length ? (
          <span className="acc-dock__face acc-dock__face--more u-num">
            +{selectedAccounts.length - dockFaces.length}
          </span>
        ) : null}
      </span>
      <span className="acc-dock__count">
        {selectedIds.size === 1
          ? t('accounts.oneSelected')
          : t('accounts.manySelected', { count: selectedIds.size })}
      </span>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('accounts.clearSelection')}
        title={`${t('accounts.clearSelection')} · Esc`}
        onClick={handleClearSelection}
      >
        <X size={14} aria-hidden="true" />
      </Button>

      <span className="acc-dock__div" aria-hidden="true" />

      {onLaunchSelected && (
        <Button
          variant="primary"
          size="sm"
          aria-label={t('accounts.launch')}
          title={`${t('accounts.launch')} · Enter`}
          onClick={() => runBulk(onLaunchSelected)}
        >
          <CirclePlay size={15} aria-hidden="true" />
          {t('accounts.launch')}
        </Button>
      )}
      {onKillSelected && iconAction(t('accounts.stop'), Square, () => runBulk(onKillSelected))}
      {onFriendRequestSelected &&
        iconAction(t('accounts.sendFriendRequest'), UserPlus, () =>
          runBulk(onFriendRequestSelected),
        )}
      {onNotesSelected &&
        iconAction(t('accounts.addNotes'), StickyNote, () => runBulk(onNotesSelected))}
      {onCopyCookiesSelected &&
        iconAction(t('accounts.copyCookies'), Cookie, () => runBulk(onCopyCookiesSelected))}
      {onOpenBrowsersSelected &&
        iconAction(t('accounts.openBrowsers'), Globe2, () => runBulk(onOpenBrowsersSelected))}

      <span className="acc-dock__div" aria-hidden="true" />

      {boundAction(t('accounts.selectAll'), ListChecks, 'Ctrl+A', handleSelectAll)}
      {boundAction(
        t('accounts.deleteSelected'),
        Trash2,
        t('accounts.keyDelete'),
        () => void handleDeleteSelected(),
        'danger',
      )}
    </motion.div>
  ) : null;

  const confirmDialogElement = (
    <ConfirmDialog
      open={confirmDialog.open}
      title={t('accounts.deleteTitle')}
      message={confirmDialog.message}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => settleConfirm(true)}
      onCancel={() => settleConfirm(false)}
    />
  );

  const toolbar = (
    <div className="rk-toolbar acc-toolbar">
      <div className="rk-search acc-search">
        <Search className="acc-search__icon" size={15} aria-hidden="true" />
        <input
          ref={searchInputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('accounts.searchPlaceholder')}
          aria-label={t('accounts.searchAria')}
        />
        {/* The clear button and the `/` keycap share one box, so revealing one
            never nudges the field's contents. */}
        <span className="acc-search__tail">
          <AnimatePresence initial={false}>
            {query ? (
              <motion.button
                key="clear-account-query"
                type="button"
                className="acc-search__clear"
                aria-label={t('accounts.clearSearch')}
                title={t('accounts.clearSearch')}
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.08 }}
                onClick={() => setQuery('')}
                whileTap={{ opacity: 0.82 }}
              >
                <X size={12} strokeWidth={2.35} aria-hidden="true" />
              </motion.button>
            ) : null}
          </AnimatePresence>
          {query ? null : (
            <kbd className="rk-key" aria-hidden="true" title={t('accounts.searchAria')}>
              /
            </kbd>
          )}
        </span>
        <motion.span
          className="acc-search__count u-num"
          aria-hidden="true"
          title={t('accounts.visibleOf', {
            visible: visibleAccounts.length,
            total: sourceAccounts.length,
          })}
          key={`${visibleAccounts.length}-${sourceAccounts.length}`}
          initial={reducedMotion ? false : { opacity: 0.55, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.15 }}
        >
          {visibleAccounts.length}/{sourceAccounts.length}
        </motion.span>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {t('accounts.visibleOf', {
            visible: visibleAccounts.length,
            total: sourceAccounts.length,
          })}
        </span>
      </div>
      <Dropdown
        options={filterOptions}
        value={filter}
        onChange={handleSelectFilter}
        aria-label={t('accounts.filterAria')}
        icon={<ListFilter size={15} />}
      />
      <Dropdown
        options={sortOptions}
        value={sort}
        onChange={handleSelectSort}
        aria-label={t('accounts.sortAria')}
        icon={<ArrowDownUp size={15} />}
      />
      <span className="rk-toolbar__spacer" />
      {view === 'list' ? (
        <button
          type="button"
          className="acc-density"
          aria-pressed={density === 'compact'}
          aria-label={t('accounts.density.compact')}
          title={t('accounts.density.compact')}
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        >
          <Rows4 size={16} aria-hidden="true" />
        </button>
      ) : null}
      <div className="rk-seg acc-viewtoggle" role="group" aria-label={t('accounts.viewAria')}>
        <button
          type="button"
          className={view === 'list' ? 'active' : ''}
          aria-pressed={view === 'list'}
          onClick={() => handleSelectView('list')}
          title={t('accounts.list')}
        >
          <Rows3 size={14} aria-hidden="true" />
          <span className="acc-viewtoggle__label">{t('accounts.list')}</span>
        </button>
        <button
          type="button"
          className={view === 'grid' ? 'active' : ''}
          aria-pressed={view === 'grid'}
          onClick={() => handleSelectView('grid')}
          title={t('accounts.grid')}
        >
          <Grid2X2 size={14} aria-hidden="true" />
          <span className="acc-viewtoggle__label">{t('accounts.grid')}</span>
        </button>
      </div>
    </div>
  );

  if (state === 'empty') {
    return (
      <div className="rk-page acc-page acc-page--flat">
        {header}
        <div className="rk-page__body">
          <EmptyState
            icon={<UserPlus size={22} />}
            title={t('accounts.emptyTitle')}
            message={t('accounts.emptyMessage')}
            actionLabel={onAddAccount ? t('accounts.addAccount') : undefined}
            actionVariant="primary"
            onAction={onAddAccount}
          />
        </div>
      </div>
    );
  }

  if (state === 'no-results') {
    return (
      <div className="rk-page acc-page">
        {header}
        <div className="acc-toolstack">{toolbar}</div>
        <div className="rk-page__body">
          <EmptyState
            icon={<Search size={22} />}
            message={t('accounts.noResults')}
            actionLabel={t('accounts.clearFilters')}
            onAction={() => {
              setQuery('');
              handleSelectFilter('all');
            }}
          />
        </div>
      </div>
    );
  }

  const entries = (
    <AnimatePresence initial={false} mode="popLayout">
      {displayAccounts.map((account) => {
        const selKey = keyFor(account);
        const isDragging = dragKey === selKey;
        const wrapClasses = [
          'acc-cardwrap',
          view === 'list' ? 'acc-cardwrap--row' : '',
          dragEnabled ? 'draggable' : '',
          reorderLockedByFilter ? 'sort-locked' : '',
          isDragging ? 'dragging' : '',
          dragSettling && isDragging ? 'settling' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <motion.div
            layout={reducedMotion ? false : 'position'}
            layoutId={`account-${selKey}`}
            initial={reducedMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              layout: reducedMotion
                ? { duration: 0 }
                : { type: 'spring', stiffness: 430, damping: 38, mass: 0.72 },
              opacity: { duration: reducedMotion ? 0 : 0.15 },
              y: reducedMotion ? { duration: 0 } : { duration: 0.15 },
            }}
            key={selKey}
            data-selkey={selKey}
            className={wrapClasses}
            role="listitem"
            aria-roledescription={
              reorderLockedByFilter
                ? t('accounts.drag.autoOrder')
                : t('accounts.drag.reorderable')
            }
            title={reorderLockedByFilter ? t('accounts.drag.lockedTitle') : undefined}
            style={{
              ...(isDragging && dragSize.h > 0 ? { height: dragSize.h } : {}),
            }}
            draggable={false}
            onPointerDown={dragEnabled ? handlePointerDown(account) : undefined}
            onClickCapture={(event) => {
              // Ctrl/⌘+click starts (or extends) a selection straight from the
              // roster, the way file lists work, without hunting for "Select".
              if (selectionMode || !(event.ctrlKey || event.metaKey)) return;
              if ((event.target as HTMLElement).closest('button, a, input')) return;
              event.preventDefault();
              event.stopPropagation();
              setSelectionMode(true);
              setSelectedIds((current) => toggleSelection(current, selKey));
            }}
          >
            {isDragging ? (
              <motion.div
                className="acc-drop-slot"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: reducedMotion ? 0 : 0.15 }}
              >
                <span className="acc-drop-slot__icon">
                  <GripVertical size={14} aria-hidden="true" />
                </span>
                <span>
                  <strong>
                    {dragSettling
                      ? t('accounts.drag.settling')
                      : t('accounts.drag.newPosition')}
                  </strong>
                  <small>
                    {dragSettling ? t('accounts.drag.done') : t('accounts.drag.release')}
                  </small>
                </span>
              </motion.div>
            ) : (
              <AccountCardMenu
                account={account}
                avatarUrl={avatarUrls?.[account.id]}
                view={view}
                selected={selectionMode ? selectedIds.has(selKey) : undefined}
                onSelectToggle={selectionMode ? () => handleToggleCard(selKey) : undefined}
                /* In selection mode a plain click toggles the checkbox (the
                   presentation handles that); outside it, it inspects. */
                onClick={handleInspect(account)}
                {...cardActions}
              />
            )}
          </motion.div>
        );
      })}
    </AnimatePresence>
  );

  return (
    <div
      className="rk-page acc-page"
      ref={measurePage}
      data-density={view === 'list' ? density : undefined}
      data-docked={dockVisible ? 'true' : undefined}
    >
      {header}
      <div className="acc-toolstack">{toolbar}</div>

      {/*
       * The split. With the panel closed this is the page's single scroll port
       * exactly as before; with it open the port stops scrolling and hands the
       * job to the two columns, so a long note never drags the roster with it.
       */}
      <div className="rk-page__body acc-body" data-split={inspectorSplit ? 'true' : undefined}>
        <div className="acc-roster">
          {view === 'list' ? (
            <div className="rk-table acc-table">
              <div className="rk-table__head">
                <span>{t('accounts.col.account')}</span>
                <span>{t('accounts.col.status')}</span>
                <span>{t('accounts.col.activity')}</span>
                <span className="acc-table__head-actions">{t('contextmenu.actions')}</span>
              </div>
              <div className="acc-table__rows" role="list">
                {entries}
              </div>
            </div>
          ) : (
            <div className="rk-grid acc-grid" role="list">
              {entries}
            </div>
          )}
        </div>

        {inspectorSplit && (
          <AccountInspector
            mode="split"
            account={focusedAccount}
            avatarUrl={focusedAccount ? avatarUrls?.[focusedAccount.id] : undefined}
            onClose={closeInspector}
            onPrev={previousAccount ? () => inspect(previousAccount.id) : undefined}
            onNext={nextAccount ? () => inspect(nextAccount.id) : undefined}
            actions={cardActions}
          />
        )}
      </div>

      {bulkBar}

      {/* Narrow pages float the panel over the roster as a sheet. */}
      <AnimatePresence>
        {inspectorOverlay ? (
          <motion.div
            key="acc-sheet"
            className="acc-sheet"
            initial={reducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reducedMotion ? 0 : 0.16 } }}
            transition={{ duration: reducedMotion ? 0 : 0.18 }}
          >
            <div className="acc-sheet__scrim" onClick={closeInspector} aria-hidden="true" />
            <motion.div
              className="acc-sheet__panel"
              initial={reducedMotion ? false : { x: 36 }}
              animate={{ x: 0 }}
              exit={reducedMotion ? undefined : { x: 28 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 460, damping: 40, mass: 0.8 }
              }
            >
              <AccountInspector
                mode="overlay"
                account={focusedAccount}
                avatarUrl={focusedAccount ? avatarUrls?.[focusedAccount.id] : undefined}
                onClose={closeInspector}
                onPrev={previousAccount ? () => inspect(previousAccount.id) : undefined}
                onNext={nextAccount ? () => inspect(nextAccount.id) : undefined}
                actions={cardActions}
              />
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/*
       * Keep the floating card outside every transformed page/layout ancestor.
       * A fixed element inside a transform uses that ancestor as its containing
       * block, which offsets viewport clientX/Y by the page-panel position.
       */}
      {typeof document !== 'undefined' &&
        createPortal(
          <AnimatePresence>
            {draggedAccount && (
              <motion.div
                key={`drag-${dragKey}`}
                className={`acc-drag-clone${view === 'list' ? ' acc-drag-clone--row' : ''}${
                  dragSettling ? ' settling' : ''
                }`}
                aria-hidden="true"
                initial={reducedMotion ? false : { opacity: 0 }}
                animate={{ opacity: dragSettling ? 0.9 : 1 }}
                exit={
                  reducedMotion
                    ? undefined
                    : { opacity: 0, transition: { duration: 0.12, ease: [0.4, 0, 1, 1] } }
                }
                transition={{ duration: reducedMotion ? 0 : 0.15 }}
                style={{
                  x: cloneX,
                  y: cloneY,
                  width: dragSize.w,
                  height: dragSize.h,
                }}
              >
                <span className="acc-drag-grip" aria-hidden="true">
                  <GripVertical size={13} />
                  {dragSettling ? t('accounts.drag.settling') : null}
                </span>
                {/*
                 * The clone is a second rendering of an entry the roster is
                 * already showing, so it must not claim the account's shared
                 * identity tile — two elements carrying one `layoutId` fight
                 * over it, and the clone would drag the panel's avatar with it.
                 */}
                {view === 'list' ? (
                  <AccountRow
                    account={draggedAccount}
                    avatarUrl={avatarUrls?.[draggedAccount.id]}
                    sharedIdentity={false}
                  />
                ) : (
                  <AccountCard
                    account={draggedAccount}
                    avatarUrl={avatarUrls?.[draggedAccount.id]}
                    sharedIdentity={false}
                  />
                )}
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}

      {confirmDialogElement}
    </div>
  );
}

export default Accounts;
