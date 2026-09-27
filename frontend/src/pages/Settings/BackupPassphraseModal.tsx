import { useEffect, useId, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { useAccountStore } from '@/stores/accountStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import './BackupPassphraseModal.css';

/** Which backup direction the passphrase modal drives. */
export type BackupMode = 'export' | 'import';

export interface BackupPassphraseModalProps {
  /** Which operation the submitted passphrase runs. */
  mode: BackupMode;
  /** Close the modal (also used after a cancelled native dialog). */
  onClose: () => void;
}

/**
 * Passphrase prompt for the encrypted `.rambak` backup flow (Settings →
 * General). Collects the passphrase twice, warns that a decrypted backup
 * contains PLAIN-TEXT cookies, then delegates to the typed IPC bridge.
 * Success surfaces a toast carrying the file path / counts; an import also
 * reloads the account store so new accounts appear without a restart. A
 * rejected passphrase surfaces inline via the shared `.fm-error` style.
 */
export function BackupPassphraseModal({
  mode,
  onClose,
}: BackupPassphraseModalProps): JSX.Element {
  const titleId = useId();
  const { t } = useTranslation();
  const showSuccess = useToastStore((state) => state.showSuccess);

  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fresh form on every mount (the modal mounts only while open).
  useEffect(() => {
    setPassphrase('');
    setConfirm('');
    setBusy(false);
    setError(null);
  }, []);

  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const canSubmit = !busy && !mismatch && passphrase.length > 0;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'export') {
        const exported = await ipc.exportAccountsEncrypted(passphrase);
        if (exported === null) {
          onClose(); // native dialog cancelled
          return;
        }
        showSuccess(
          t('settings.backup.exportDone', { count: exported.count, path: exported.path }),
        );
        onClose();
        return;
      }

      const imported = await ipc.importAccountsEncrypted(passphrase);
      if (imported === null) {
        onClose(); // native dialog cancelled
        return;
      }
      showSuccess(
        t('settings.backup.importDone', {
          added: imported.added,
          skipped: imported.skipped,
        }),
      );
      // Reload so freshly imported accounts appear without a restart.
      await useAccountStore.getState().load();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message.trim() ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} titleId={titleId} size="md">
      <div className="fm-root bkpass">
        <div className="fm-head">
          <span className="fm-eyebrow">{t('settings.backup.eyebrow')}</span>
          <h2 id={titleId} className="fm-title">
            {mode === 'export'
              ? t('settings.backup.exportTitle')
              : t('settings.backup.importTitle')}
          </h2>
        </div>

        <p className="fm-hint">{t('settings.backup.hint')}</p>

        {mode === 'export' && (
          <p className="bkpass__warning">
            <CircleAlert size={15} aria-hidden="true" />
            {t('settings.backup.warning')}
          </p>
        )}

        <label className="fm-field">
          {t('settings.backup.passLabel')}
          <input
            className="fm-input"
            type="password"
            autoComplete="new-password"
            value={passphrase}
            placeholder={t('settings.backup.passPlaceholder')}
            onChange={(event) => setPassphrase(event.target.value)}
            disabled={busy}
          />
        </label>

        <label className="fm-field">
          {t('settings.backup.confirmLabel')}
          <input
            className="fm-input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            placeholder={t('settings.backup.confirmLabel')}
            data-invalid={mismatch || undefined}
            onChange={(event) => setConfirm(event.target.value)}
            disabled={busy}
          />
        </label>

        {mismatch && <p className="fm-error">{t('settings.backup.mismatch')}</p>}

        {error && (
          <p className="fm-error">
            <CircleAlert size={15} aria-hidden="true" />
            {error}
          </p>
        )}

        <div className="fm-footer">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!canSubmit}>
            {busy
              ? t('settings.backup.busy')
              : mode === 'export'
                ? t('settings.backup.confirmExport')
                : t('settings.backup.confirmImport')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
