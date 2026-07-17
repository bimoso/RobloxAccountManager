import { useId, useState, type FormEvent } from 'react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { useEncryptionGateStore } from '../../stores/encryptionGateStore';
import { useTranslation } from '../../i18n/useTranslation';
import './EncryptionGate.css';

/**
 * Setup modal body: lets the user submit an encryption key (`enc_set_key`) or
 * skip encryption entirely by submitting an empty key (Requirement 7.2). On a
 * failed submission the modal stays open and shows the error message the store
 * placed in `errorMessage` (Requirement 7.5).
 *
 * The key is held in local component state and only forwarded verbatim to
 * {@link useEncryptionGateStore}'s `submitSetup`; skipping calls
 * `submitSetup('')`.
 */
function SetupModalBody(): JSX.Element {
  const submitSetup = useEncryptionGateStore((s) => s.submitSetup);
  const errorMessage = useEncryptionGateStore((s) => s.errorMessage);
  const [key, setKey] = useState('');
  const titleId = useId();
  const { t } = useTranslation();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitSetup(key);
  };

  return (
    <div className="enc-gate">
      <h2 id={titleId} className="enc-gate__title">
        {t('encgate.setupTitle')}
      </h2>
      <p className="enc-gate__desc">
        {t('encgate.setupDesc')}
      </p>
      <form className="enc-gate__form" onSubmit={onSubmit}>
        <label className="enc-gate__label" htmlFor={`${titleId}-input`}>
          {t('encgate.keyLabel')}
        </label>
        <input
          id={`${titleId}-input`}
          className="enc-gate__input"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="new-password"
          autoFocus
          spellCheck={false}
        />
        {errorMessage ? (
          <p className="enc-gate__error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <div className="enc-gate__actions">
          <Button type="button" variant="secondary" onClick={() => void submitSetup('')}>
            {t('encgate.skip')}
          </Button>
          <Button type="submit" variant="primary">
            {t('encgate.setKey')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Unlock modal body: lets the user submit the existing encryption key via
 * `enc_unlock` (Requirement 7.3). On a failed submission the modal stays open
 * and shows the error message (Requirement 7.5). Unlike setup, there is no skip
 * action — a locked store can only be opened with a valid key.
 */
function UnlockModalBody(): JSX.Element {
  const submitUnlock = useEncryptionGateStore((s) => s.submitUnlock);
  const errorMessage = useEncryptionGateStore((s) => s.errorMessage);
  const [key, setKey] = useState('');
  const titleId = useId();
  const { t } = useTranslation();

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitUnlock(key);
  };

  return (
    <div className="enc-gate">
      <h2 id={titleId} className="enc-gate__title">
        {t('encgate.unlockTitle')}
      </h2>
      <p className="enc-gate__desc">
        {t('encgate.unlockDesc')}
      </p>
      <form className="enc-gate__form" onSubmit={onSubmit}>
        <label className="enc-gate__label" htmlFor={`${titleId}-input`}>
          {t('encgate.keyLabel')}
        </label>
        <input
          id={`${titleId}-input`}
          className="enc-gate__input"
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="current-password"
          autoFocus
          spellCheck={false}
        />
        {errorMessage ? (
          <p className="enc-gate__error" role="alert">
            {errorMessage}
          </p>
        ) : null}
        <div className="enc-gate__actions">
          <Button type="submit" variant="primary">
            {t('encgate.unlock')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Encryption_Gate: renders whichever gate modal the {@link useEncryptionGateStore}
 * says is open (setup or unlock) and blocks the rest of the app while it is
 * (Requirements 7.2, 7.3).
 *
 * Blocking is achieved two ways, both driven purely by store state:
 * 1. The shared {@link Modal} renders a fixed, full-viewport backdrop
 *    (`position: fixed; inset: 0; z-index: 1000`) that intercepts every pointer
 *    event, so nothing behind it is clickable while a gate modal is open.
 * 2. The gate modal is non-dismissible: `onClose` is a no-op, so pressing
 *    `Escape` or clicking the backdrop cannot close it. The only way past the
 *    gate is a successful submission, which the store reflects by clearing the
 *    `setupModalOpen`/`unlockModalOpen` flags. (The App shell additionally gates
 *    page rendering on `accessGranted` — wired in task 29.6.)
 *
 * This component renders nothing when neither modal is open, so it is safe to
 * mount unconditionally at the top of the app shell.
 */
export function EncryptionGate(): JSX.Element | null {
  const setupModalOpen = useEncryptionGateStore((s) => s.setupModalOpen);
  const unlockModalOpen = useEncryptionGateStore((s) => s.unlockModalOpen);

  // Non-dismissible: the gate can only be cleared by a successful submission,
  // never by the user backing out (Requirements 7.2, 7.3, 7.5).
  const noop = () => {};

  if (setupModalOpen) {
    return (
      <Modal open onClose={noop}>
        <SetupModalBody />
      </Modal>
    );
  }

  if (unlockModalOpen) {
    return (
      <Modal open onClose={noop}>
        <UnlockModalBody />
      </Modal>
    );
  }

  return null;
}
