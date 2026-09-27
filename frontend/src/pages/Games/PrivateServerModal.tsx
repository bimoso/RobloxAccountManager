import { useEffect, useId, useState, type FormEvent } from 'react';
import { Check, KeyRound, Share2 } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { parsePrivateServerLink } from '@/lib/privateServers';
import { useTranslation } from '@/i18n/useTranslation';
import {
  usePlaceLibraryStore,
  type PlaceLibraryEntry,
  type PrivateServerEntry,
  type PrivateServerResult,
} from '@/stores/placeLibraryStore';

export interface PrivateServerModalProps {
  open: boolean;
  /** The game the server is filed under. */
  entry: PlaceLibraryEntry | null;
  /** The server being edited, or `null` to create one. */
  server: PrivateServerEntry | null;
  onClose: () => void;
  onSaved?: (server: PrivateServerEntry) => void;
}

/** Create / edit dialog for one private server of a saved game. */
export function PrivateServerModal({
  open,
  entry,
  server,
  onClose,
  onSaved,
}: PrivateServerModalProps): JSX.Element {
  const titleId = useId();
  const { t } = useTranslation();
  const addPrivateServer = usePlaceLibraryStore((state) => state.addPrivateServer);
  const updatePrivateServer = usePlaceLibraryStore((state) => state.updatePrivateServer);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(server?.name ?? '');
    setLink(server?.link ?? '');
    setError(null);
  }, [open, server]);

  const parsed = parsePrivateServerLink(link);
  const mismatch =
    parsed?.kind === 'private' && entry && parsed.placeId !== entry.placeId
      ? parsed.placeId
      : null;
  const canSave = Boolean(entry) && parsed !== null && mismatch === null;

  const rejectionMessage = (result: PrivateServerResult): string | null => {
    if (result.ok) return null;
    switch (result.reason) {
      case 'duplicate':
        return t('games.serverModal.duplicate');
      case 'missing':
        return t('games.serverModal.missing');
      default:
        return t('games.serverModal.invalid');
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!entry) return;
    if (mismatch) {
      setError(t('games.serverModal.mismatch', { placeId: mismatch }));
      return;
    }
    if (!parsed) {
      setError(t('games.serverModal.invalid'));
      return;
    }
    const result = server
      ? updatePrivateServer(entry.placeId, server.id, { name, link })
      : addPrivateServer(entry, { name, link });
    const message = rejectionMessage(result);
    if (message || !result.ok) {
      setError(message ?? t('games.serverModal.invalid'));
      return;
    }
    onSaved?.(result.server);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} titleId={titleId} size="md">
      <form className="fm-root gm-modal" onSubmit={submit}>
        <header className="fm-head">
          <span className="fm-eyebrow">{entry?.name ?? ''}</span>
          <h2 id={titleId} className="fm-title">
            {server ? t('games.serverModal.editTitle') : t('games.serverModal.addTitle')}
          </h2>
          <p className="fm-hint">{t('games.serverModal.desc')}</p>
        </header>

        <div className="fm-field">
          <label htmlFor={`${titleId}-name`}>{t('games.serverModal.name')}</label>
          <input
            id={`${titleId}-name`}
            className="fm-input"
            type="text"
            value={name}
            placeholder={t('games.serverModal.namePlaceholder')}
            autoComplete="off"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className="fm-field">
          <label htmlFor={`${titleId}-link`}>{t('games.serverModal.link')}</label>
          <input
            id={`${titleId}-link`}
            className="fm-input"
            type="url"
            value={link}
            placeholder="https://www.roblox.com/games/...?privateServerLinkCode=..."
            autoComplete="off"
            spellCheck={false}
            aria-invalid={Boolean(error) || mismatch !== null}
            onChange={(event) => {
              setError(null);
              setLink(event.target.value);
            }}
          />
          {parsed && !mismatch ? (
            <span className="gm-modal__detected">
              <span className="rk-chip rk-chip--sm" data-tone="ok">
                {parsed.kind === 'private' ? (
                  <KeyRound size={11} aria-hidden="true" />
                ) : (
                  <Share2 size={11} aria-hidden="true" />
                )}
                {t('games.serverModal.detected')}
              </span>
              <small className="gm-modal__hint">
                {parsed.kind === 'private' ? t('games.privateKind') : t('games.shareKind')}
              </small>
            </span>
          ) : null}
          {mismatch ? (
            <small className="gm-modal__hint" data-tone="danger">
              {t('games.serverModal.mismatch', { placeId: mismatch })}
            </small>
          ) : null}
        </div>

        {error ? (
          <p className="fm-error" role="alert">{error}</p>
        ) : null}

        <footer className="fm-footer">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={!canSave}>
            <Check size={15} aria-hidden="true" />
            {t('common.save')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
