import { useEffect, useMemo, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  ArrowUpRight,
  Boxes,
  FolderPlus,
  Link2,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { ipc } from '@/lib/ipc';
import { displayPackage, upsertPackage } from '@/lib/packages';
import { useAccountStore } from '@/stores/accountStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account, Package } from '@/types/models';
import { PackageEditModal } from './PackageEditModal';
import './Packages.css';

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

/** Account-group workspace backed by the existing packages IPC contract. */
export function PackagesPage({
  onCreatePackage,
  onEditPackage,
}: PackagesPageProps): JSX.Element {
  const [packages, setPackages] = useState<Package[]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Package | null>(null);
  const accounts = useAccountStore((state) => state.accounts);
  const loadAccounts = useAccountStore((state) => state.load);
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await ipc.loadPackages();
        if (!cancelled) setPackages(loaded);
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

  const handleCreate = (): void => {
    setEditing(null);
    setModalOpen(true);
    onCreatePackage?.();
  };

  const handleEdit = (pkg: Package): void => {
    setEditing(pkg);
    setModalOpen(true);
    onEditPackage?.(pkg);
  };

  const handleSavePackage = async (pkg: Package): Promise<void> => {
    const merged = upsertPackage(packages, pkg);
    await ipc.savePackages(merged);
    setPackages(merged);
    setModalOpen(false);
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

  return (
    <section className="packages-page" aria-labelledby="packages-title">
      <header className="packages-header">
        <div className="packages-heading">
          <span className="packages-eyebrow">{t('packages.eyebrow')}</span>
          <h1 id="packages-title">{t('packages.title')}</h1>
          <p>
            {t('packages.subtitle')}
          </p>
        </div>
        {packages.length > 0 ? (
          <Button variant="primary" className="packages-create" onClick={handleCreate}>
            <Plus size={16} aria-hidden="true" />
            {t('packages.create')}
          </Button>
        ) : null}
      </header>

      <div className="packages-context" aria-label={t('packages.summaryAria')}>
        <div className="packages-context__item">
          <Boxes size={16} aria-hidden="true" />
          <span>{t('packages.groups')}</span>
          <strong>{packages.length}</strong>
        </div>
        <div className="packages-context__item">
          <UsersRound size={16} aria-hidden="true" />
          <span>{t('packages.assignments')}</span>
          <strong>{totalAssignments}</strong>
        </div>
        <div className="packages-context__item">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>{t('packages.organized')}</span>
          <strong>{groupedAccountCount}/{accounts.length}</strong>
        </div>
        <div className="packages-context__privacy">
          <LockKeyhole size={14} aria-hidden="true" />
          {t('packages.localSave')}
        </div>
      </div>

      {packages.length === 0 ? (
        <motion.div
          className="packages-empty"
          role="status"
          initial={{ opacity: 0, y: reducedMotion ? 0 : 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.24, ease: 'easeOut' }}
        >
          <div className="packages-empty__visual" aria-hidden="true">
            <div className="packages-empty__halo" />
            <div className="packages-empty__node packages-empty__node--a"><UserRound size={14} /></div>
            <div className="packages-empty__node packages-empty__node--b"><UserRound size={14} /></div>
            <div className="packages-empty__node packages-empty__node--c"><UserRound size={14} /></div>
            <div className="packages-empty__core"><FolderPlus size={27} /></div>
          </div>
          <span className="packages-empty__eyebrow">{t('packages.emptyEyebrow')}</span>
          <h2>{t('packages.emptyTitle')}</h2>
          <p className="packages-empty__legacy">{t('packages.emptyLegacy')}</p>
          <p className="packages-empty__copy">
            {t('packages.emptyCopy')}
          </p>
          <Button variant="primary" className="packages-empty__action" onClick={handleCreate}>
            <Plus size={16} aria-hidden="true" />
            {t('packages.create')}
          </Button>
          <div className="packages-empty__benefits" aria-hidden="true">
            <span><Sparkles size={13} /> {t('packages.flexibleMembership')}</span>
            <span><LockKeyhole size={13} /> {t('packages.localData')}</span>
          </div>
        </motion.div>
      ) : (
        <div className="packages-grid">
          {packages.map((pkg, index) => {
            const view = displayPackage(pkg);
            const members = view.accountIds.map((id) => accountById.get(id));
            const shownMembers = members.slice(0, 4);
            const extraMembers = Math.max(0, members.length - shownMembers.length);
            const accountLabelText =
              view.accountCount === 1
                ? t('packages.oneAccount')
                : t('packages.manyAccounts', { count: view.accountCount });
            const hasLink = typeof pkg.link === 'string' && pkg.link.trim().length > 0;

            return (
              <motion.article
                className="package-card"
                key={view.id}
                aria-label={t('packages.groupAria', { name: view.name })}
                initial={{ opacity: 0, y: reducedMotion ? 0 : 10 }}
                animate={{ opacity: 1, y: 0 }}
                whileHover={reducedMotion ? undefined : { y: -3 }}
                transition={{
                  duration: reducedMotion ? 0 : 0.22,
                  delay: reducedMotion ? 0 : Math.min(index * 0.035, 0.18),
                  ease: 'easeOut',
                }}
              >
                <div className="package-card__signal" aria-hidden="true" />
                <div className="package-card__topline">
                  <div className="package-card__icon" aria-hidden="true">
                    <UsersRound size={19} />
                  </div>
                  <span className="package-card__kind">{t('packages.kind')}</span>
                </div>

                <h2>{view.name}</h2>
                <p className="package-card__meta">
                  {view.accountCount === 0
                    ? t('packages.readyForAccounts')
                    : t('packages.membersSynced')}
                </p>

                <div className="package-card__members">
                  <div className="package-card__avatars" aria-hidden="true">
                    {shownMembers.length > 0 ? (
                      shownMembers.map((account, memberIndex) => (
                        <span
                          key={view.accountIds[memberIndex]}
                          title={account ? accountLabel(account) : t('packages.accountUnavailable')}
                        >
                          {accountInitial(account)}
                        </span>
                      ))
                    ) : (
                      <span className="is-empty"><UserRound size={13} /></span>
                    )}
                    {extraMembers > 0 ? <span>+{extraMembers}</span> : null}
                  </div>
                  <strong>{accountLabelText}</strong>
                </div>

                <footer className="package-card__footer">
                  <span className={hasLink ? 'has-link' : undefined}>
                    <Link2 size={13} aria-hidden="true" />
                    {hasLink ? t('packages.linkedServer') : t('packages.noPrivateLink')}
                  </span>
                  <Button
                    variant="ghost"
                    className="package-card__edit"
                    onClick={() => handleEdit(pkg)}
                  >
                    {t('packages.edit')} <ArrowUpRight size={14} aria-hidden="true" />
                  </Button>
                </footer>
              </motion.article>
            );
          })}
        </div>
      )}

      {editModal}
    </section>
  );
}
