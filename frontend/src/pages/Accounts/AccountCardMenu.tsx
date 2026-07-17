import { useCallback, useMemo, useRef, useState, type MouseEventHandler } from 'react';
import { AnimatePresence } from 'framer-motion';
import { ContextMenu, type ContextMenuAnchor } from '@/components/ContextMenu';
import { ipc } from '@/lib/ipc';
import { displayName, isLaunched } from '@/lib/filters';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account } from '@/types/models';
import { AccountCard } from './AccountCard';
import { buildContextMenuItems, type ContextMenuHandlers } from './contextMenu';

/**
 * Optional handlers for the context-menu actions that open a dedicated modal or
 * flow implemented by other tasks (launch/relaunch, edit, quick login, batch
 * friend request, change display name, change password — tasks 17.5, 19.x).
 *
 * These are surfaced as props (rather than wired here) because their UI lives
 * outside this container. Each receives the account the menu was opened for.
 * When a handler is omitted, its row still appears (Requirement 12.1 fixes the
 * item set) but does nothing when chosen.
 */
export interface AccountCardMenuActions {
  /** Launch or relaunch the account (opens the launch modal — task 19.1). */
  onLaunch?: (account: Account) => void;
  /** Open the edit-account modal (task 17.5). */
  onEdit?: (account: Account) => void;
  /** Start the quick-login flow (task 19.3). */
  onQuickLogin?: (account: Account) => void;
  /** Open the batch friend-request modal (task 19.3). */
  onFriendRequest?: (account: Account) => void;
  /** Open the change-display-name modal (task 19.3). */
  onChangeDisplayName?: (account: Account) => void;
  /** Open the change-password modal (task 19.3). */
  onChangePassword?: (account: Account) => void;
}

/** Props for {@link AccountCardMenu}. */
export interface AccountCardMenuProps extends AccountCardMenuActions {
  /** The account to render and act upon. */
  account: Account;
  /** Avatar thumbnail URL (see {@link AccountCard}). */
  avatarUrl?: string;
  /** Whether the card is part of the current multi-selection. @defaultValue false */
  selected?: boolean;
  /** Toggle this card's selection. */
  onSelectToggle?: () => void;
  /** Activate the card (e.g. open account details). */
  onClick?: MouseEventHandler<HTMLDivElement>;
}

/** Menu position plus whether it should keep following the card trigger. */
interface AccountMenuAnchor extends ContextMenuAnchor {
  /** Pointer menus stay at the click point; button menus follow their card. */
  followCard: boolean;
}

/** Best-effort copy to the system clipboard; failures are swallowed. */
function copyToClipboard(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => {
    /* Clipboard access can be denied; nothing else to do here. */
  });
}

/**
 * Stateful container that pairs a presentational {@link AccountCard} with its
 * `ContextMenu` (Requirement 12.1–12.3).
 *
 * The card itself is menu-agnostic: it only surfaces the *intent* to open a menu
 * via `onContextMenu` (right-click) and `onOpenMenu` (the accessible "more
 * actions" button). This container owns the open/anchor state, positions the
 * menu at the pointer (for right-click) or at the card's corner (for the
 * button), and renders the `ContextMenu`, which already closes before running
 * the chosen action (Req 12.2) and closes without acting on an outside click
 * (Req 12.3).
 *
 * The menu item set is produced by the pure {@link buildContextMenuItems} from
 * the account's launch state, so "Matar instancia" appears only while launched
 * (Requirement 12.1). Trivial actions (kill instance, open in browser, copy
 * user id / username / cookie) are wired directly to the IPC bridge / clipboard
 * here; the modal-backed actions are delegated to the {@link
 * AccountCardMenuActions} props.
 */
export function AccountCardMenu({
  account,
  avatarUrl,
  selected = false,
  onSelectToggle,
  onClick,
  onLaunch,
  onEdit,
  onQuickLogin,
  onFriendRequest,
  onChangeDisplayName,
  onChangePassword,
}: AccountCardMenuProps): JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<AccountMenuAnchor | null>(null);
  const { t } = useTranslation();

  const closeMenu = useCallback(() => setAnchor(null), []);

  const resolveCardAnchor = useCallback((): ContextMenuAnchor => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    return rect ? { x: rect.right - 12, y: rect.top + 42 } : { x: 0, y: 0 };
  }, []);

  const handleContextMenu = useCallback<MouseEventHandler<HTMLDivElement>>((event) => {
    // Replace the native browser menu with our own, positioned at the pointer.
    event.preventDefault();
    setAnchor({ x: event.clientX, y: event.clientY, followCard: false });
  }, []);

  const handleOpenMenu = useCallback(() => {
    // The accessible button gives no pointer coordinates. Anchor beside the
    // card's header/ellipsis instead of below the entire card so the compact
    // command palette stays visually attached to its trigger.
    setAnchor({ ...resolveCardAnchor(), followCard: true });
  }, [resolveCardAnchor]);

  const handlers = useMemo<ContextMenuHandlers>(
    () => ({
      kill: () => void ipc.killOneRoblox(account.id),
      launch: () => onLaunch?.(account),
      edit: () => onEdit?.(account),
      openBrowser: () => void ipc.openAccountBrowser(account.id),
      quickLogin: () => onQuickLogin?.(account),
      friendRequest: () => onFriendRequest?.(account),
      changeDisplayName: () => onChangeDisplayName?.(account),
      changePassword: () => onChangePassword?.(account),
      copyUserId: () => copyToClipboard(account.userId),
      copyUsername: () => copyToClipboard(account.username),
      copyCookie: () => void ipc.copyAccountCookie(account.id),
    }),
    [
      account,
      onLaunch,
      onEdit,
      onQuickLogin,
      onFriendRequest,
      onChangeDisplayName,
      onChangePassword,
    ],
  );

  const items = useMemo(
    () => buildContextMenuItems(isLaunched(account), handlers, t),
    [account, handlers, t],
  );

  return (
    <div ref={wrapperRef} className="acc-cardmenu-shell">
      <AccountCard
        account={account}
        avatarUrl={avatarUrl}
        selected={selected}
        onSelectToggle={onSelectToggle}
        onClick={onClick}
        onContextMenu={handleContextMenu}
        onOpenMenu={handleOpenMenu}
        onLaunch={onLaunch ? () => onLaunch(account) : undefined}
      />
      <AnimatePresence initial={false}>
        {anchor && (
          <ContextMenu
            key="account-context-menu"
            anchor={anchor}
            resolveAnchor={anchor.followCard ? resolveCardAnchor : undefined}
            items={items}
            onClose={closeMenu}
            title={displayName(account)}
            subtitle={account.username ? `@${account.username}` : `UID ${account.userId}`}
            eyebrow={t('accounts.menu.eyebrow')}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
