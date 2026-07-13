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
          <span className="packages-eyebrow">Account orchestration</span>
          <h1 id="packages-title">Grupos</h1>
          <p>
            Reúne cuentas por juego, servidor o rutina sin duplicar configuración.
          </p>
        </div>
        {packages.length > 0 ? (
          <Button variant="primary" className="packages-create" onClick={handleCreate}>
            <Plus size={16} aria-hidden="true" />
            Crear grupo
          </Button>
        ) : null}
      </header>

      <div className="packages-context" aria-label="Resumen de grupos">
        <div className="packages-context__item">
          <Boxes size={16} aria-hidden="true" />
          <span>Grupos</span>
          <strong>{packages.length}</strong>
        </div>
        <div className="packages-context__item">
          <UsersRound size={16} aria-hidden="true" />
          <span>Asignaciones</span>
          <strong>{totalAssignments}</strong>
        </div>
        <div className="packages-context__item">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Cuentas organizadas</span>
          <strong>{groupedAccountCount}/{accounts.length}</strong>
        </div>
        <div className="packages-context__privacy">
          <LockKeyhole size={14} aria-hidden="true" />
          Guardado local
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
          <span className="packages-empty__eyebrow">Your first workspace</span>
          <h2>Orquesta cuentas sin perder contexto</h2>
          <p className="packages-empty__legacy">No tienes ningún grupo guardado todavía.</p>
          <p className="packages-empty__copy">
            Crea un grupo, elige sus miembros y vuelve a editarlo cuando cambie tu rutina.
          </p>
          <Button variant="primary" className="packages-empty__action" onClick={handleCreate}>
            <Plus size={16} aria-hidden="true" />
            Crear grupo
          </Button>
          <div className="packages-empty__benefits" aria-hidden="true">
            <span><Sparkles size={13} /> Membresía flexible</span>
            <span><LockKeyhole size={13} /> Datos locales</span>
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
              view.accountCount === 1 ? '1 cuenta' : `${view.accountCount} cuentas`;
            const hasLink = typeof pkg.link === 'string' && pkg.link.trim().length > 0;

            return (
              <motion.article
                className="package-card"
                key={view.id}
                aria-label={`Grupo ${view.name}`}
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
                  <span className="package-card__kind">Account group</span>
                </div>

                <h2>{view.name}</h2>
                <p className="package-card__meta">
                  {view.accountCount === 0
                    ? 'Listo para recibir cuentas'
                    : 'Miembros sincronizados con tu biblioteca local'}
                </p>

                <div className="package-card__members">
                  <div className="package-card__avatars" aria-hidden="true">
                    {shownMembers.length > 0 ? (
                      shownMembers.map((account, memberIndex) => (
                        <span
                          key={view.accountIds[memberIndex]}
                          title={account ? accountLabel(account) : 'Cuenta no disponible'}
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
                    {hasLink ? 'Servidor enlazado' : 'Sin enlace privado'}
                  </span>
                  <Button
                    variant="ghost"
                    className="package-card__edit"
                    onClick={() => handleEdit(pkg)}
                  >
                    Editar <ArrowUpRight size={14} aria-hidden="true" />
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
