import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { BookmarkPlus, KeyRound, MapPin } from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import { parsePrivateServerLink, placeIdFromInput } from '@/lib/privateServers';
import { useTranslation } from '@/i18n/useTranslation';
import { usePlaceLibraryStore } from '@/stores/placeLibraryStore';
import type { Account } from '@/types/models';
import type { GameDetails } from '@/types/window';

export interface AddGameModalProps {
  open: boolean;
  /** Any account cookie lets the details lookup succeed more reliably. */
  accounts: Account[];
  onClose: () => void;
  /** Called once the Place (and, when pasted, its private server) is saved. */
  onSaved?: (placeId: string, withServer: boolean) => void;
  fetchGameDetails?: (placeId: string, cookie: string) => Promise<GameDetails>;
}

const PREVIEW_DEBOUNCE_MS = 450;

/**
 * "Add game" dialog. One field accepts every shape the user may have on the
 * clipboard: a bare Place ID, a `/games/<id>` link, or a private-server link
 * (which saves the game AND files the server under it in one go).
 */
export function AddGameModal({
  open,
  accounts,
  onClose,
  onSaved,
  fetchGameDetails,
}: AddGameModalProps): JSX.Element {
  const titleId = useId();
  const { t } = useTranslation();
  const entries = usePlaceLibraryStore((state) => state.entries);
  const favorite = usePlaceLibraryStore((state) => state.favorite);
  const addPrivateServer = usePlaceLibraryStore((state) => state.addPrivateServer);
  const [input, setInput] = useState('');
  const [serverName, setServerName] = useState('');
  const [preview, setPreview] = useState<GameDetails | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getDetails = fetchGameDetails ?? ipc.getGameDetails;
  const cookie = useMemo(
    () => accounts.find((account) => account.cookie)?.cookie ?? '',
    [accounts],
  );

  const trimmed = input.trim();
  const privateLink = parsePrivateServerLink(trimmed);
  const placeId =
    privateLink?.kind === 'private' ? privateLink.placeId : placeIdFromInput(trimmed);
  const isShareLink = privateLink?.kind === 'share';
  const alreadySaved = Boolean(placeId && entries.some((entry) => entry.placeId === placeId));

  useEffect(() => {
    if (!open) return;
    setInput('');
    setServerName('');
    setPreview(null);
    setPreviewLoading(false);
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open || !placeId) {
      setPreview(null);
      setPreviewLoading(false);
      return;
    }
    let cancelled = false;
    setPreview(null);
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const details = await getDetails(placeId, cookie);
          if (!cancelled) setPreview(details?.ok ? details : null);
        } catch {
          if (!cancelled) setPreview(null);
        } finally {
          if (!cancelled) setPreviewLoading(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, placeId, cookie, getDetails]);

  const canSave = Boolean(placeId) && !previewLoading;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!placeId) {
      setError(isShareLink ? t('games.addModal.shareHint') : t('games.addModal.invalid'));
      return;
    }
    const seed = {
      placeId,
      name: preview?.name || undefined,
      iconUrl: preview?.iconUrl || undefined,
      creator: preview?.creator || undefined,
    };
    favorite(seed);
    let withServer = false;
    if (privateLink?.kind === 'private') {
      const result = addPrivateServer(seed, { name: serverName, link: privateLink.url });
      withServer = result.ok;
    }
    onSaved?.(placeId, withServer);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} titleId={titleId} size="md">
      <form className="fm-root gm-modal" onSubmit={submit}>
        <header className="fm-head">
          <span className="fm-eyebrow">{t('games.addModal.eyebrow')}</span>
          <h2 id={titleId} className="fm-title">{t('games.addModal.title')}</h2>
          <p className="fm-hint">{t('games.addModal.desc')}</p>
        </header>

        <div className="fm-field">
          <label htmlFor={`${titleId}-input`}>{t('launch.placeLabel')}</label>
          <input
            id={`${titleId}-input`}
            className="fm-input"
            type="text"
            value={input}
            placeholder={t('games.addModal.placeholder')}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setError(null);
              setInput(event.target.value);
            }}
          />
          {isShareLink ? (
            <small className="gm-modal__hint">{t('games.addModal.shareHint')}</small>
          ) : null}
        </div>

        {previewLoading ? (
          <div className="rk-panel gm-preview" aria-live="polite">
            <span className="rk-spin" aria-hidden="true" />
            <span>{t('launch.locating')}</span>
          </div>
        ) : null}

        {!previewLoading && placeId ? (
          <div className="rk-panel gm-preview">
            {preview?.iconUrl ? (
              <img className="gm-preview__thumb" src={preview.iconUrl} alt="" />
            ) : (
              <span className="gm-preview__thumb">
                <MapPin size={15} aria-hidden="true" />
              </span>
            )}
            <div className="gm-preview__copy">
              <small>{preview ? t('launch.detected') : t('games.detailsFailed')}</small>
              <strong>{preview?.name || `Place ${placeId}`}</strong>
              <span>
                {preview?.creator
                  ? t('launch.byCreator', { name: preview.creator })
                  : t('launch.creatorMissing')}
                {' · '}
                <span className="u-num">{placeId}</span>
              </span>
            </div>
            {alreadySaved ? (
              <span className="rk-chip rk-chip--sm" data-tone="ok">
                {t('games.addModal.exists')}
              </span>
            ) : null}
          </div>
        ) : null}

        {privateLink?.kind === 'private' ? (
          <div className="fm-field gm-modal__server">
            <label htmlFor={`${titleId}-server`}>
              <span className="rk-chip rk-chip--sm" data-tone="accent">
                <KeyRound size={11} aria-hidden="true" /> {t('games.addModal.privateDetected')}
              </span>
              <span>{t('games.addModal.serverName')}</span>
            </label>
            <input
              id={`${titleId}-server`}
              className="fm-input"
              type="text"
              value={serverName}
              placeholder={t('games.addModal.serverNamePlaceholder')}
              autoComplete="off"
              onChange={(event) => setServerName(event.target.value)}
            />
          </div>
        ) : null}

        {error ? (
          <p className="fm-error" role="alert">{error}</p>
        ) : null}

        <footer className="fm-footer">
          <Button variant="secondary" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={!canSave}>
            <BookmarkPlus size={15} aria-hidden="true" />
            {privateLink?.kind === 'private'
              ? t('games.addModal.submitWithServer')
              : t('games.addModal.submit')}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
