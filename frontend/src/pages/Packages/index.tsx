import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowUpRight,
  Boxes,
  FolderPlus,
  Link2,
  LockKeyhole,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { usePageActive } from '@/components/PageRouter/pageActivity';
import { ipc } from '@/lib/ipc';
import { displayPackage, upsertPackage } from '@/lib/packages';
import { identityStyle } from '@/lib/identity';
import { createSessionCache } from '@/lib/sessionCache';
import { useAccountStore } from '@/stores/accountStore';
import { useLaunchIntentStore } from '@/stores/launchIntentStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account, Package } from '@/types/models';
import { PackageEditModal } from './PackageEditModal';
import './Packages.css';

/**
 * Last loaded package list, kept across unmounts so re-entering the page
 * paints the saved groups immediately (no 0-count/empty-state flash) while the
 * mount load silently re-reads the backing store.
 */
const packagesCache = createSessionCache<Package[]>();

/** Members shown in the compact avatar stack before it collapses to a `+n`. */
const AVATAR_STACK_LIMIT = 4;

/** Optional observers for the create/edit flows owned by this page. */
export interface PackagesPageProps {
  onCreatePackage?: () => void;
  onEditPackage?: (pkg: Package) => void;
}

function accountLabel(account: Account): string {
  return account.nickname?.trim() || account.username;
}

function accountInitial(account: Account | undefined): string {
  if (!account) return '?';
  const label = accountLabel(account).trim();
  return label.slice(0, 1).toUpperCase() || '?';
}

/**
 * True when a keystroke arrived while the user was typing, so the page-level
 * "N" shortcut can never steal a character from a field.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Account-group workspace backed by the existing packages IPC contract. */
export function PackagesPage({
  onCreatePackage,
  onEditPackage,
}: PackagesPageProps): JSX.Element {
  const [packages, setPackages] = useState<Package[]>(() => packagesCache.get() ?? []);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Package | null>(null);
  const accounts = useAccountStore((state) => state.accounts);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const loadAccounts = useAccountStore((state) => state.load);
  const [pendingDelete, setPendingDelete] = useState<Package | null>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();
  const pageActive = usePageActive();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await ipc.loadPackages();
        if (!cancelled) {
          packagesCache.set(loaded);
          setPackages(loaded);
        }
      } catch {
        // The IPC layer owns error reporting; retain the last known view.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (accounts.length === 0) void loadAccounts();
  }, [accounts.length, loadAccounts]);

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const totalAssignments = useMemo(
    () => packages.reduce((sum, pkg) => sum + pkg.accountIds.length, 0),
    [packages],
  );
  const groupedAccountCount = useMemo(
    () => new Set(packages.flatMap((pkg) => pkg.accountIds)).size,
    [packages],
  );

  const handleCreate = useCallback((): void => {
    setEditing(null);
    setModalOpen(true);
    onCreatePackage?.();
  }, [onCreatePackage]);

  // The keycap surfaced in the empty state is a real binding, not decoration:
  // "N" creates a group whenever the page is on screen, idle and the user is
  // not typing (the router keeps left pages mounted, so a parked page must
  // not answer).
  useEffect(() => {
    if (!pageActive || modalOpen || pendingDelete !== null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'n' && event.key !== 'N') return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      handleCreate();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleCreate, modalOpen, pendingDelete, pageActive]);

  const handleEdit = (pkg: Package): void => {
    setEditing(pkg);
    setModalOpen(true);
    onEditPackage?.(pkg);
  };

  const handleSavePackage = async (pkg: Package): Promise<void> => {
    const merged = upsertPackage(packages, pkg);
    await ipc.savePackages(merged);
    packagesCache.set(merged);
    setPackages(merged);
    setModalOpen(false);
  };

  // Delete flow: two-step via the shared ConfirmDialog. The backend contract
  // is save-the-whole-array, so deletion is a filtered save.
  const handleDeletePackage = async (): Promise<void> => {
    const target = pendingDelete;
    if (!target) return;
    const next = packages.filter((pkg) => pkg.id !== target.id);
    await ipc.savePackages(next);
    packagesCache.set(next);
    setPackages(next);
    setPendingDelete(null);
    showSuccess(t('packages.deleted'));
  };

  // Launch handoff: same bridge the Accounts bulk bar and Charts use. Dead
  // member ids are filtered out; the action disables when nothing remains.
  const liveMemberIds = (pkg: Package): string[] =>
    pkg.accountIds.filter((id) => accountById.has(id));

  const handleLaunchPackage = (pkg: Package): void => {
    useLaunchIntentStore.getState().open({ accountIds: liveMemberIds(pkg) });
  };

  const editModal = (
    <PackageEditModal
      open={modalOpen}
      pkg={editing}
      accounts={accounts}
      onClose={() => setModalOpen(false)}
      onSave={handleSavePackage}
    />
  );

  const deleteDialog = (
    <ConfirmDialog
      open={pendingDelete !== null}
      title={t('packages.delete.title')}
      message={t('packages.delete.confirm', { name: pendingDelete?.name ?? '' })}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      onConfirm={() => void handleDeletePackage()}
      onCancel={() => setPendingDelete(null)}
    />
  );

  return (
    <section className="rk-page packages-page" aria-labelledby="packages-title">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1 id="packages-title">
            {t('packages.title')}
            {packages.length > 0 ? (
              <span className="acc-title__count u-num">{packages.length}</span>
            ) : null}
          </h1>
          <span className="rk-page__sub">{t('packages.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <span className="rk-chip pkg-privacy" data-tone="ok" title={t('packages.localData')}>
            <LockKeyhole size={12} aria-hidden="true" />
            {t('packages.localSave')}
          </span>
          {packages.length > 0 ? (
            <Button variant="primary" onClick={handleCreate}>
              <Plus size={15} aria-hidden="true" />
              {t('packages.create')}
            </Button>
          ) : null}
        </div>
      </header>

      {packages.length > 0 ? (
        <div className="rk-stats pkg-stats" role="group" aria-label={t('packages.summaryAria')}>
          <div className="rk-stat">
            <span className="rk-stat__label">
              <Boxes size={13} aria-hidden="true" />
              {t('packages.groups')}
            </span>
            <span className="rk-stat__value u-num">{packages.length}</span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">
              <UsersRound size={13} aria-hidden="true" />
              {t('packages.assignments')}
            </span>
            <span className="rk-stat__value u-num">{totalAssignments}</span>
          </div>
          <div className="rk-stat">
            <span className="rk-stat__label">
              <ShieldCheck size={13} aria-hidden="true" />
              {t('packages.organized')}
            </span>
            <span className="rk-stat__value u-num">
              {groupedAccountCount}
              <small>/{accounts.length}</small>
            </span>
            <span className="pkg-stats__meter" aria-hidden="true">
              <span
                style={{
                  transform: `scaleX(${accounts.length > 0 ? Math.min(1, groupedAccountCount / accounts.length) : 0})`,
                }}
              />
            </span>
          </div>
        </div>
      ) : null}

      <div className="rk-page__body">
        {packages.length === 0 ? (
          <motion.div
            className="rk-empty pkg-empty"
            role="status"
            initial={{ opacity: 0, y: reducedMotion ? 0 : 3 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reducedMotion ? 0 : 0.15, ease: 'easeOut' }}
          >
            <div className="rk-empty__icon" aria-hidden="true">
              <FolderPlus size={20} />
            </div>
            <h2 className="rk-empty__title">{t('packages.emptyTitle')}</h2>
            <p className="rk-empty__text">{t('packages.emptyLegacy')}</p>
            <p className="rk-empty__text">{t('packages.emptyCopy')}</p>
            <Button variant="primary" onClick={handleCreate}>
              <Plus size={15} aria-hidden="true" />
              {t('packages.create')}
            </Button>
            <p className="pkg-empty__hint">
              <span className="rk-keys">
                <kbd className="rk-key">N</kbd>
              </span>
              {t('packages.create')}
            </p>
            <div className="pkg-empty__benefits" aria-hidden="true">
              <span>
                <Sparkles size={12} /> {t('packages.flexibleMembership')}
              </span>
              <span>
                <LockKeyhole size={12} /> {t('packages.localData')}
              </span>
            </div>
          </motion.div>
        ) : (
          <div className="pkg-grid">
            {packages.map((pkg, index) => {
              const view = displayPackage(pkg);
              const members = view.accountIds.map((id) => accountById.get(id));
              const shownMembers = members.slice(0, AVATAR_STACK_LIMIT);
              const extraMembers = Math.max(0, members.length - shownMembers.length);
              const accountLabelText =
                view.accountCount === 1
                  ? t('packages.oneAccount')
                  : t('packages.manyAccounts', { count: view.accountCount });
              const hasLink = typeof pkg.link === 'string' && pkg.link.trim().length > 0;
              const launchable = liveMemberIds(pkg).length > 0;

              return (
                <motion.article
                  className="pkg-card"
                  key={view.id}
                  style={identityStyle(view.id)}
                  aria-label={t('packages.groupAria', { name: view.name })}
                  initial={{ opacity: 0, y: reducedMotion ? 0 : 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reducedMotion ? 0 : 0.22,
                    delay: reducedMotion ? 0 : Math.min(index, 6) * 0.04,
                    ease: 'easeOut',
                  }}
                >
                  <div className="pkg-card__head">
                    <span className="pkg-card__icon" aria-hidden="true">
                      <Boxes size={18} />
                    </span>
                    <span className="pkg-card__titles">
                      <h2 className="pkg-card__name" title={view.name}>
                        {view.name}
                      </h2>
                      <span className="pkg-card__meta">
                        {view.accountCount === 0
                          ? t('packages.readyForAccounts')
                          : t('packages.membersSynced')}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      className="pkg-card__delete"
                      aria-label={t('packages.delete.title')}
                      title={t('packages.delete.title')}
                      onClick={() => setPendingDelete(pkg)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  </div>

                  <div className="pkg-card__members">
                    <span className="pkg-avatars" aria-hidden="true">
                      {shownMembers.length > 0 ? (
                        shownMembers.map((account, memberIndex) => (
                          <span
                            key={view.accountIds[memberIndex]}
                            className={account ? 'acc-avatar' : 'is-missing'}
                            style={account ? identityStyle(account.userId || account.id) : undefined}
                            title={
                              account ? accountLabel(account) : t('packages.accountUnavailable')
                            }
                          >
                            {accountInitial(account)}
                          </span>
                        ))
                      ) : (
                        <span className="is-empty">
                          <UserRound size={13} />
                        </span>
                      )}
                      {extraMembers > 0 ? (
                        <span className="pkg-avatars__more u-num">+{extraMembers}</span>
                      ) : null}
                    </span>
                    <strong className="pkg-card__count u-num">{accountLabelText}</strong>
                  </div>

                  <span
                    className="rk-chip rk-chip--sm pkg-card__link"
                    data-tone={hasLink ? 'ok' : undefined}
                  >
                    <Link2 size={11} aria-hidden="true" />
                    {hasLink ? t('packages.linkedServer') : t('packages.noPrivateLink')}
                  </span>

                  <div className="pkg-card__actions">
                    <Button
                      variant="primary"
                      size="sm"
                      className="pkg-card__launch"
                      aria-label={t('packages.launchAria', { name: view.name })}
                      title={launchable ? t('packages.launch') : t('packages.noLiveMembers')}
                      disabled={!launchable}
                      onClick={() => handleLaunchPackage(pkg)}
                    >
                      <Play size={13} fill="currentColor" aria-hidden="true" />
                      {t('packages.launch')}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => handleEdit(pkg)}>
                      {t('packages.edit')}
                      <ArrowUpRight size={13} aria-hidden="true" />
                    </Button>
                  </div>
                </motion.article>
              );
            })}
            <button type="button" className="pkg-card pkg-card--new" onClick={handleCreate}>
              <span className="pkg-card--new__icon" aria-hidden="true">
                <Plus size={20} />
              </span>
              <span>{t('packages.newCard')}</span>
              <kbd className="rk-key" aria-hidden="true">
                N
              </kbd>
            </button>
          </div>
        )}
      </div>

      {editModal}
      {deleteDialog}
    </section>
  );
}
