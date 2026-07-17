import { useEffect, useId, useMemo, useState } from 'react';
import { Check, FolderPen, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { useTranslation } from '@/i18n/useTranslation';
import type { Account, Package } from '@/types/models';
import './Packages.css';

export interface PackageEditModalProps {
  open: boolean;
  pkg: Package | null;
  accounts: Account[];
  onClose: () => void;
  onSave: (pkg: Package) => Promise<void>;
}

function newPackageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `pkg_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function displayAccount(account: Account): string {
  return account.nickname?.trim() || account.username;
}

/** Create/edit modal for a saved account group. */
export function PackageEditModal({
  open,
  pkg,
  accounts,
  onClose,
  onSave,
}: PackageEditModalProps): JSX.Element {
  const titleId = useId();
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(pkg?.name ?? '');
    setSelectedIds(pkg ? [...pkg.accountIds] : []);
    setSaving(false);
    setError(null);
  }, [open, pkg]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggleAccount = (id: string): void => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((accountId) => accountId !== id)
        : [...current, id],
    );
  };

  const handleSave = async (): Promise<void> => {
    const merged: Package = pkg
      ? { ...pkg, name: name.trim(), accountIds: [...selectedIds] }
      : {
          id: newPackageId(),
          name: name.trim(),
          accountIds: [...selectedIds],
          link: '',
        };
    setSaving(true);
    setError(null);
    try {
      await onSave(merged);
    } catch {
      setError(t('packages.modal.saveFailed'));
      setSaving(false);
    }
  };

  const isEditing = pkg !== null;

  return (
    <Modal open={open} onClose={onClose} titleId={titleId}>
      <div className="package-modal">
        <header className="package-modal__header">
          <div className="package-modal__header-icon" aria-hidden="true">
            <FolderPen size={19} />
          </div>
          <div>
            <h2 id={titleId}>{isEditing ? t('packages.modal.editTitle') : t('packages.create')}</h2>
            <p>
              {isEditing
                ? t('packages.modal.editDesc')
                : t('packages.modal.createDesc')}
            </p>
          </div>
        </header>

        <label className="package-modal__field">
          <span>{t('packages.modal.name')}</span>
          <input
            type="text"
            value={name}
            placeholder={t('packages.modal.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <section className="package-modal__members" aria-labelledby={`${titleId}-members`}>
          <div className="package-modal__members-head">
            <span id={`${titleId}-members`}>{t('packages.modal.accounts')}</span>
            <span>{t('packages.modal.selectedCount', { count: selectedIds.length })}</span>
          </div>

          {accounts.length === 0 ? (
            <p className="package-modal__no-accounts">
              {t('packages.modal.noAccounts')}
            </p>
          ) : (
            <div className="package-modal__list">
              {accounts.map((account) => {
                const label = displayAccount(account);
                const isSelected = selected.has(account.id);
                return (
                  <label
                    key={account.id}
                    className={`package-modal__account${isSelected ? ' is-selected' : ''}`}
                  >
                    <span className="package-modal__account-avatar" aria-hidden="true">
                      {label.slice(0, 1).toUpperCase() || '?'}
                    </span>
                    <span className="package-modal__account-copy">
                      <strong>{label}</strong>
                      <small>@{account.username}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleAccount(account.id)}
                    />
                  </label>
                );
              })}
            </div>
          )}
        </section>

        {error ? <p className="package-modal__error" role="alert">{error}</p> : null}

        <footer className="package-modal__footer">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving || name.trim().length === 0}
          >
            {saving ? (
              <LoaderCircle className="package-modal__saving" size={15} aria-hidden="true" />
            ) : (
              <Check size={15} aria-hidden="true" />
            )}
            {t('common.save')}
          </Button>
        </footer>
      </div>
    </Modal>
  );
}
