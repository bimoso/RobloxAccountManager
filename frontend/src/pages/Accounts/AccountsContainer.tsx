import { useCallback, useEffect, useState } from 'react';
import { mapWithConcurrency } from '@/lib/concurrency';
import { ipc } from '@/lib/ipc';
import { createKeyedSessionCache } from '@/lib/sessionCache';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import type { Account } from '@/types/models';
import { normalizeCredentialLogin } from './addAccount';
import { reLoginAccount } from './reLogin';
import { Accounts } from './index';
import { AddAccountModal } from './AddAccountModal';
import { EditAccountModal } from './EditAccountModal';
import { QuickLoginModal } from './QuickLoginModal';
import { FriendRequestModal } from './FriendRequestModal';
import { ChangeDisplayNameModal } from './ChangeDisplayNameModal';
import { ChangePasswordModal } from './ChangePasswordModal';
import { BulkNotesModal } from './BulkNotesModal';
import type { EditFormValues } from './editAccount';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';

/**
 * Avatar thumbnail URLs keyed by Roblox userId. Module-level (not a ref) so
 * the resolved thumbnails survive page unmounts: re-entering Accounts paints
 * every known avatar immediately instead of re-fetching the whole set and
 * flashing placeholders on each visit.
 */
const avatarThumbCache = createKeyedSessionCache<string, string>();

/** Ids per `roblox_get_avatar_thumbnails` call — the endpoint's own ceiling. */
const AVATAR_BATCH_SIZE = 100;

/**
 * Batches allowed in flight at once.
 *
 * Deliberately small, and deliberately not `Promise.all`: unlike the rest of the
 * Roblox surface, `roblox_get_avatar_thumbnails` does not go through the
 * backend's retrying sender, so it has **no 429 handling whatsoever**. Releasing
 * every batch at once would trade a slow first paint for rate-limit failures.
 */
const AVATAR_BATCH_CONCURRENCY = 4;

/** Maps each account id to its cached avatar URL (misses are simply absent). */
function cachedAvatarUrls(accounts: Account[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const account of accounts) {
    const url = avatarThumbCache.get(account.userId);
    if (url) map[account.id] = url;
  }
  return map;
}

/**
 * Wires the presentational {@link Accounts} page to the app: it resolves avatar
 * thumbnails in bulk, owns every account-action modal's open state, and hands
 * the page the concrete handlers (add / launch / edit / quick login / friend
 * request / change display name / change password) plus the bulk actions.
 *
 * This is the component the PageRouter mounts, so the migration's decoupled
 * page + modals finally act as one working screen.
 */
export function AccountsContainer(): JSX.Element {
  const accounts = useAccountStore((state) => state.accounts);
  const add = useAccountStore((state) => state.add);
  const update = useAccountStore((state) => state.update);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);

  // ── Avatar resolution (batched, cached by userId across mounts) ──
  const [avatarUrls, setAvatarUrls] = useState<Record<string, string>>(() =>
    cachedAvatarUrls(accounts),
  );

  useEffect(() => {
    let cancelled = false;

    // Collect the userIds we do not have a thumbnail for yet.
    const need: string[] = [];
    const seen = new Set<string>();
    for (const account of accounts) {
      const uid = account.userId;
      if (!uid || avatarThumbCache.get(uid) || seen.has(uid)) continue;
      seen.add(uid);
      need.push(uid);
    }

    const rebuild = (): void => {
      if (!cancelled) setAvatarUrls(cachedAvatarUrls(accounts));
    };

    if (need.length === 0) {
      rebuild();
      return () => {
        cancelled = true;
      };
    }

    const batches: string[][] = [];
    for (let i = 0; i < need.length; i += AVATAR_BATCH_SIZE) {
      batches.push(need.slice(i, i + AVATAR_BATCH_SIZE));
    }

    void (async () => {
      // Up to 100 accounts fit in a single batch, so for most libraries this is
      // exactly as fast as the serial loop it replaces; the win only shows up
      // once there are hundreds of accounts to resolve.
      await mapWithConcurrency(batches, AVATAR_BATCH_CONCURRENCY, async (batch) => {
        // The guard sits inside the worker rather than between batches: with
        // several in flight, the batches still queued behind a torn-down effect
        // must never reach the network at all.
        if (cancelled) return;
        const res = await ipc.getAvatarThumbnails(batch);
        for (const item of res?.data ?? []) {
          if (item && item.imageUrl) {
            avatarThumbCache.set(String(item.targetId), item.imageUrl);
          }
        }
      });
      // `mapWithConcurrency` settles every batch instead of rejecting, which is
      // what the per-batch try/catch used to buy: one failed batch leaves the
      // others' thumbnails cached and its own accounts on placeholders, for a
      // later render to retry.
      rebuild();
    })();

    return () => {
      cancelled = true;
    };
  }, [accounts]);

  // ── Modal state ──
  const [addOpen, setAddOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<Account | null>(null);
  const [quickLoginAccount, setQuickLoginAccount] = useState<Account | null>(null);
  const [displayNameAccount, setDisplayNameAccount] = useState<Account | null>(null);
  const [passwordAccount, setPasswordAccount] = useState<Account | null>(null);
  const [friendAccounts, setFriendAccounts] = useState<Account[]>([]);
  const [notesAccounts, setNotesAccounts] = useState<Account[]>([]);

  const handleSaveEdit = useCallback(
    (id: string, changedFields: Partial<EditFormValues>) => update(id, changedFields),
    [update],
  );

  const handleSaveNotes = useCallback(
    (id: string, notes: string) => update(id, { notes }),
    [update],
  );

  const handleCopyCookies = useCallback((selected: Account[]): void => {
    selected.forEach((account) => void ipc.copyAccountCookie(account.id));
  }, []);

  const handleKillSelected = useCallback((selected: Account[]): void => {
    selected.forEach((account) => void ipc.killOneRoblox(account.id));
  }, []);

  const handleOpenBrowsers = useCallback((selected: Account[]): void => {
    void (async () => {
      try {
        const result = await ipc.openAccountBrowsers(selected.map((account) => account.id));
        if (result.opened === result.total) {
          showSuccess(
            result.total === 1
              ? 'Navegador de cuenta abierto.'
              : `${result.opened} navegadores de cuenta abiertos.`,
          );
          return;
        }

        const firstFailure = result.results.find((item) => !item.ok);
        const account = firstFailure
          ? selected.find((candidate) => candidate.id === firstFailure.accountId)
          : undefined;
        const who = account?.nickname?.trim() || account?.username;
        const detail = firstFailure?.error?.trim();
        showError(
          `${result.opened}/${result.total} navegadores abiertos${
            detail ? ` · ${who ? `${who}: ` : ''}${detail}` : '.'
          }`,
        );
      } catch {
        // The centralized IPC layer already surfaced rejected commands.
      }
    })();
  }, [showSuccess, showError]);

  // Re-login is explicit: always open the credential-login browser and refresh
  // the cookie instead of short-circuiting merely because the old cookie works.
  const handleReLogin = useCallback(
    async (account: Account): Promise<void> => {
      const result = await reLoginAccount(account, {
        login: async (username, password) =>
          normalizeCredentialLogin(await ipc.loginCredentials(username, password)),
        update,
      });
      if (result.status === 'refreshed') {
        showSuccess(result.message);
      } else {
        showError(result.message);
      }
    },
    [update, showSuccess, showError],
  );

  return (
    <>
      <Accounts
        avatarUrls={avatarUrls}
        onAddAccount={() => setAddOpen(true)}
        onLaunch={(account) => useLaunchIntentStore.getState().open({ accountIds: [account.id] })}
        onEdit={(account) => setEditAccount(account)}
        onQuickLogin={(account) => setQuickLoginAccount(account)}
        onReLogin={(account) => void handleReLogin(account)}
        onFriendRequest={(account) => setFriendAccounts([account])}
        onChangeDisplayName={(account) => setDisplayNameAccount(account)}
        onChangePassword={(account) => setPasswordAccount(account)}
        onLaunchSelected={(selected) => useLaunchIntentStore.getState().open({ accountIds: selected.map((account) => account.id) })}
        onKillSelected={handleKillSelected}
        onFriendRequestSelected={(selected) => setFriendAccounts(selected)}
        onNotesSelected={(selected) => setNotesAccounts(selected)}
        onCopyCookiesSelected={handleCopyCookies}
        onOpenBrowsersSelected={handleOpenBrowsers}
      />

      <AddAccountModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdd={add}
        accounts={accounts}
        onUpdate={update}
      />

      <EditAccountModal
        open={editAccount !== null}
        account={editAccount}
        onClose={() => setEditAccount(null)}
        onSave={handleSaveEdit}
      />

      <QuickLoginModal
        open={quickLoginAccount !== null}
        account={quickLoginAccount}
        onClose={() => setQuickLoginAccount(null)}
      />

      <FriendRequestModal
        open={friendAccounts.length > 0}
        accounts={friendAccounts}
        onClose={() => setFriendAccounts([])}
      />

      <ChangeDisplayNameModal
        open={displayNameAccount !== null}
        account={displayNameAccount}
        onClose={() => setDisplayNameAccount(null)}
      />

      <ChangePasswordModal
        open={passwordAccount !== null}
        account={passwordAccount}
        onClose={() => setPasswordAccount(null)}
      />

      <BulkNotesModal
        open={notesAccounts.length > 0}
        accounts={notesAccounts}
        onClose={() => setNotesAccounts([])}
        onSave={handleSaveNotes}
      />
    </>
  );
}

export default AccountsContainer;
