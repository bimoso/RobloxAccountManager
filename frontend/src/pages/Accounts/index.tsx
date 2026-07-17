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
  Globe2,
  GripVertical,
  Grid2X2,
  ListChecks,
  ListFilter,
  Plus,
  Rows3,
  Search,
  Square,
  StickyNote,
  Trash2,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { EmptyState } from '@/components/EmptyState';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import {
  filterAccounts,
  listState,
  resolveInitialFilter,
  resolveInitialView,
  searchAccounts,
  setFilter as persistFilter,
  setView as persistView,
} from '@/lib/filters';
import { bulkBarVisible, selectAll, toggleSelection } from '@/lib/selection';
import { useAccountStore } from '@/stores/accountStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account, AccountFilter, AccountsView } from '@/types/models';
import { AccountCard } from './AccountCard';
import { AccountCardMenu, type AccountCardMenuActions } from './AccountCardMenu';
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
 * The Accounts page: a liquid-glass grid/list of account cards with search,
 * filtering, multi-selection + bulk actions, and drag-to-reorder.
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
  const { t } = useTranslation();

  // `t` is rebound per language, so the options re-derive on language change.
  const filterOptions = useMemo<ReadonlyArray<DropdownOption<AccountFilter>>>(
    () => FILTER_IDS.map((value) => ({ value, label: t(`accounts.filter.${value}`) })),
    [t],
  );

  const [view, setViewState] = useState<AccountsView>(() => resolveInitialView());
  const [filter, setFilterState] = useState<AccountFilter>(() => resolveInitialFilter());
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

  useEffect(() => {
    if (accounts.length === 0) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sourceAccounts = baseAccounts ?? accounts;

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
    () => searchAccounts(filterAccounts(sourceAccounts, filter), query),
    [sourceAccounts, filter, query],
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

  const handleSelectView = (next: AccountsView): void => {
    setViewState(next);
    persistView(next);
  };

  const handleSelectFilter = (next: AccountFilter): void => {
    setFilterState(next);
    persistFilter(next);
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

  // ── Pointer-based drag reorder ──
  // Free "pick up and drop anywhere" reordering: the grabbed card follows the
  // cursor (a floating clone) while the other cards live-reorder around it, and
  // the new order is persisted on release. Disabled during selection mode so the
  // two gestures never conflict.
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
    <div className="acc-header">
      <div className="acc-header__copy">
        <span className="acc-eyebrow">{t('accounts.eyebrow')}</span>
        <h2 className="acc-title">
          {t('accounts.title')}
          {sourceAccounts.length > 0 && (
            <span className="acc-title__count">{sourceAccounts.length}</span>
          )}
        </h2>
        <p>{t('accounts.subtitle')}</p>
      </div>
      <div className="acc-header__actions">
        {state === 'has-items' && (
          <button
            type="button"
            className={`acc-btn acc-btn--sm${selectionMode ? ' acc-btn--accent' : ''}`}
            aria-pressed={selectionMode}
            onClick={handleToggleSelectionMode}
          >
            {selectionMode ? (
              <X size={16} aria-hidden="true" />
            ) : (
              <CheckSquare2 size={16} aria-hidden="true" />
            )}
            {selectionMode ? t('accounts.cancelSelection') : t('accounts.select')}
          </button>
        )}
        {onAddAccount && (
          <button type="button" className="acc-btn acc-btn--accent acc-btn--sm" onClick={onAddAccount}>
            <Plus size={16} aria-hidden="true" />
            {t('accounts.add')}
          </button>
        )}
        <div className="acc-viewtoggle" role="group" aria-label={t('accounts.viewAria')}>
          <button
            type="button"
            className={view === 'grid' ? 'active' : ''}
            aria-pressed={view === 'grid'}
            onClick={() => handleSelectView('grid')}
          >
            <Grid2X2 size={15} aria-hidden="true" />
            {t('accounts.grid')}
          </button>
          <button
            type="button"
            className={view === 'list' ? 'active' : ''}
            aria-pressed={view === 'list'}
            onClick={() => handleSelectView('list')}
          >
            <Rows3 size={16} aria-hidden="true" />
            {t('accounts.list')}
          </button>
        </div>
      </div>
    </div>
  );

  const iconAction = (
    label: string,
    Icon: LucideIcon,
    onClick: () => void,
    danger = false,
  ): JSX.Element => (
    <button
      type="button"
      className={`acc-selbar__ico${danger ? ' danger' : ''}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );

  const bulkBar = bulkBarVisible(selectedIds) ? (
    <div className="acc-selbar" role="toolbar" aria-label={t('accounts.bulkAria')}>
      <div className="acc-selbar__chip">
        <span>
          {selectedIds.size === 1
            ? t('accounts.oneSelected')
            : t('accounts.manySelected', { count: selectedIds.size })}
        </span>
        <button
          type="button"
          className="acc-selbar__x"
          aria-label={t('accounts.clearSelection')}
          title={t('accounts.clearSelection')}
          onClick={handleClearSelection}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>

      <span className="acc-selbar__div" aria-hidden="true" />

      {onLaunchSelected && iconAction(t('accounts.launch'), CirclePlay, () => runBulk(onLaunchSelected))}
      {onKillSelected && iconAction(t('accounts.stop'), Square, () => runBulk(onKillSelected))}
      {onFriendRequestSelected &&
        iconAction(t('accounts.sendFriendRequest'), UserPlus, () =>
          runBulk(onFriendRequestSelected),
        )}
      {onNotesSelected && iconAction(t('accounts.addNotes'), StickyNote, () => runBulk(onNotesSelected))}
      {onCopyCookiesSelected &&
        iconAction(t('accounts.copyCookies'), Cookie, () => runBulk(onCopyCookiesSelected))}
      {onOpenBrowsersSelected &&
        iconAction(t('accounts.openBrowsers'), Globe2, () => runBulk(onOpenBrowsersSelected))}

      <span className="acc-selbar__div" aria-hidden="true" />

      {iconAction(t('accounts.selectAll'), ListChecks, handleSelectAll)}
      {iconAction(t('accounts.deleteSelected'), Trash2, () => void handleDeleteSelected(), true)}
    </div>
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
    <div className="acc-toolbar">
      <div className="acc-search">
        <Search className="acc-search__icon" size={17} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('accounts.searchPlaceholder')}
          aria-label={t('accounts.searchAria')}
        />
        <AnimatePresence initial={false}>
          {query ? (
            <motion.button
              key="clear-account-query"
              type="button"
              className="acc-search__clear"
              aria-label={t('accounts.clearSearch')}
              title={t('accounts.clearSearch')}
              initial={reducedMotion ? false : { opacity: 0, scale: 0.72 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: reducedMotion ? 1 : 0.72 }}
              transition={
                reducedMotion
                  ? { duration: 0 }
                  : { type: 'spring', stiffness: 560, damping: 34, mass: 0.44 }
              }
              onClick={() => setQuery('')}
              whileTap={reducedMotion ? undefined : { scale: 0.9 }}
            >
              <X size={12} strokeWidth={2.35} aria-hidden="true" />
            </motion.button>
          ) : null}
        </AnimatePresence>
        <motion.span
          className="acc-search__count"
          aria-hidden="true"
          title={t('accounts.visibleOf', { visible: visibleAccounts.length, total: sourceAccounts.length })}
          key={`${visibleAccounts.length}-${sourceAccounts.length}`}
          initial={reducedMotion ? false : { opacity: 0.55, y: 2 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
        >
          {visibleAccounts.length}/{sourceAccounts.length}
        </motion.span>
        <span className="sr-only" aria-live="polite" aria-atomic="true">
          {t('accounts.visibleOf', { visible: visibleAccounts.length, total: sourceAccounts.length })}
        </span>
      </div>
      <div className="acc-filter">
        <ListFilter className="acc-filter__icon" size={16} aria-hidden="true" />
        <Dropdown
          options={filterOptions}
          value={filter}
          onChange={handleSelectFilter}
          aria-label={t('accounts.filterAria')}
        />
      </div>
    </div>
  );

  if (state === 'empty') {
    return (
      <div className="acc-page">
        {header}
        <EmptyState
          message={t('accounts.emptyMessage')}
          actionLabel={onAddAccount ? t('accounts.addAccount') : undefined}
          onAction={onAddAccount}
        />
      </div>
    );
  }

  if (state === 'no-results') {
    return (
      <div className="acc-page">
        {header}
        {toolbar}
        <EmptyState message={t('accounts.noResults')} />
      </div>
    );
  }

  return (
    <div className="acc-page">
      {header}
      {toolbar}
      {bulkBar}
      <div className="acc-scroll">
        <div className={`acc-grid${view === 'list' ? ' list' : ''}`} role="list">
          <AnimatePresence initial={false} mode="popLayout">
            {displayAccounts.map((account) => {
              const selKey = keyFor(account);
              const isDragging = dragKey === selKey;
              const wrapClasses = [
                'acc-cardwrap',
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
                  initial={reducedMotion ? false : { opacity: 0, y: 7, scale: 0.988 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{
                    layout: reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 430, damping: 38, mass: 0.72 },
                    opacity: { duration: reducedMotion ? 0 : 0.16 },
                    y: reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 500, damping: 38, mass: 0.62 },
                    scale: reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 500, damping: 38, mass: 0.62 },
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
                  title={
                    reorderLockedByFilter
                      ? t('accounts.drag.lockedTitle')
                      : undefined
                  }
                  style={{
                    ...(isDragging && dragSize.h > 0 ? { height: dragSize.h } : {}),
                  }}
                  draggable={false}
                  onPointerDown={dragEnabled ? handlePointerDown(account) : undefined}
                >
                  {isDragging ? (
                    <motion.div
                      className="acc-drop-slot"
                      initial={reducedMotion ? false : { opacity: 0, scale: 0.96 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: reducedMotion ? 0 : 0.16 }}
                    >
                      <span className="acc-drop-slot__icon">
                        <GripVertical size={17} aria-hidden="true" />
                      </span>
                      <span>
                        <strong>{dragSettling ? t('accounts.drag.settling') : t('accounts.drag.newPosition')}</strong>
                        <small>{dragSettling ? t('accounts.drag.done') : t('accounts.drag.release')}</small>
                      </span>
                    </motion.div>
                  ) : (
                    <AccountCardMenu
                      account={account}
                      avatarUrl={avatarUrls?.[account.id]}
                      selected={selectionMode ? selectedIds.has(selKey) : undefined}
                      onSelectToggle={selectionMode ? () => handleToggleCard(selKey) : undefined}
                      {...cardActions}
                    />
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      </div>

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
                className={`acc-drag-clone${dragSettling ? ' settling' : ''}`}
                aria-hidden="true"
                initial={reducedMotion ? false : { opacity: 0, scale: 0.985, rotate: 0 }}
                animate={{
                  opacity: dragSettling ? 0.88 : 1,
                  scale: dragSettling ? 1 : 1.018,
                  rotate: dragSettling ? 0 : 0.35,
                }}
                exit={
                  reducedMotion
                    ? undefined
                    : {
                        opacity: 0,
                        scale: 0.995,
                        rotate: 0,
                        transition: { duration: 0.12, ease: [0.4, 0, 1, 1] },
                      }
                }
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 420, damping: 32, mass: 0.72 }
                }
                style={{
                  x: cloneX,
                  y: cloneY,
                  width: dragSize.w,
                  height: dragSize.h,
                }}
              >
                <div className="acc-drag-grip" aria-hidden="true">
                  <GripVertical size={15} />
                  <span>{dragSettling ? 'Colocando' : 'Moviendo'}</span>
                </div>
                <AccountCard
                  account={draggedAccount}
                  avatarUrl={avatarUrls?.[draggedAccount.id]}
                />
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
