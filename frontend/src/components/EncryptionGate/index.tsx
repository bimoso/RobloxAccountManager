import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Modal } from '../Modal';
import { Button } from '../Button';
import { RamLogo } from '../Brand';
import { useEncryptionGateStore } from '../../stores/encryptionGateStore';
import { useTranslation } from '../../i18n/useTranslation';
import './EncryptionGate.css';

/**
 * Everything inside the gate that can take keyboard focus. Used by
 * {@link useFocusTrap} to work out the two ends of the tab ring.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Keep keyboard focus inside a blocking dialog.
 *
 * The encryption gate is the one dialog in the app the user genuinely cannot
 * back out of — `onClose` is a no-op, so `Escape` and backdrop clicks do
 * nothing. Without a trap, `Tab` still walks straight out of it into the
 * (visually blocked, pointer-inert) app behind, which strands keyboard and
 * screen-reader users on controls they can neither see nor activate.
 *
 * Two guards, because either one alone leaks:
 * 1. `Tab` / `Shift+Tab` wrap around the ends of the ring.
 * 2. Any focus landing outside the container is pulled back to its first
 *    focusable, which covers programmatic focus and browser-chrome round trips.
 *
 * @returns A ref to attach to the dialog's root element.
 */
function useFocusTrap<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const focusable = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || node.contains(target)) return;
      focusable()[0]?.focus();
    };

    node.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);

    // Land on the passphrase field, never on the dialog container.
    if (!node.contains(document.activeElement)) focusable()[0]?.focus();

    return () => {
      node.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  return ref;
}

/** Longest run of dots the readback draws before it elides. */
const READBACK_MAX_DOTS = 24;

/**
 * A disclosure-safe echo of what has been typed: shape and length, never the
 * characters. Pure symbols, so it carries no translatable text.
 */
function maskPassphrase(value: string): string {
  if (value.length === 0) return '';
  const dots = '•'.repeat(Math.min(value.length, READBACK_MAX_DOTS));
  return value.length > READBACK_MAX_DOTS ? `${dots}…` : dots;
}

/** Which gate the shared body is rendering. */
type GateVariant = 'setup' | 'unlock';

/** Props for {@link GateBody}. */
interface GateBodyProps {
  /** Setup mints a new key (and may be skipped); unlock opens an existing one. */
  variant: GateVariant;
  /** Id the surrounding {@link Modal} wires to `aria-labelledby`. */
  titleId: string;
}

/**
 * The gate's body: one flat panel, one passphrase field with a reveal toggle
 * and a masked readback, one error slot and one action row.
 *
 * Setup submits `enc_set_key` and additionally offers "skip", which submits an
 * empty key (Requirement 7.2). Unlock submits `enc_unlock` and has no skip — a
 * locked store can only be opened with a valid key (Requirement 7.3). Either
 * way a failed submission leaves the dialog open and renders the message the
 * store placed in `errorMessage` (Requirement 7.5).
 *
 * The key is held in local component state and forwarded verbatim to the
 * store; it is never persisted or logged here.
 */
function GateBody({ variant, titleId }: GateBodyProps): JSX.Element {
  const submitSetup = useEncryptionGateStore((s) => s.submitSetup);
  const submitUnlock = useEncryptionGateStore((s) => s.submitUnlock);
  const errorMessage = useEncryptionGateStore((s) => s.errorMessage);
  const [key, setKey] = useState('');
  const [revealed, setRevealed] = useState(false);
  const inputId = useId();
  const { t } = useTranslation();
  const trapRef = useFocusTrap<HTMLDivElement>();

  const isSetup = variant === 'setup';

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSetup) void submitSetup(key);
    else void submitUnlock(key);
  };

  return (
    <div className="fm-root enc-gate" ref={trapRef}>
      <header className="fm-head enc-gate__head">
        <RamLogo size={44} className="enc-gate__logo" />
        <h2 id={titleId} className="fm-title enc-gate__title">
          {isSetup ? t('encgate.setupTitle') : t('encgate.unlockTitle')}
        </h2>
      </header>
      <p className="fm-hint">{isSetup ? t('encgate.setupDesc') : t('encgate.unlockDesc')}</p>

      <form className="enc-gate__form" onSubmit={onSubmit}>
        <label className="fm-label" htmlFor={inputId}>
          {t('encgate.keyLabel')}
        </label>

        <div className="enc-gate__field" data-invalid={errorMessage ? true : undefined}>
          <input
            id={inputId}
            className="enc-gate__input"
            type={revealed ? 'text' : 'password'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            autoFocus
            spellCheck={false}
            aria-invalid={errorMessage ? true : undefined}
          />
          <button
            type="button"
            className="enc-gate__reveal"
            aria-label={t('encgate.keyLabel')}
            aria-pressed={revealed}
            onClick={() => setRevealed((current) => !current)}
          >
            {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>

        {/* Shape-and-length echo of the field. Hidden from assistive tech: the
            input already exposes its own value, and a live run of bullets would
            only add noise. */}
        <p className="enc-gate__readback" aria-hidden="true">
          <span className="enc-gate__dots">{maskPassphrase(key)}</span>
          <span className="enc-gate__count u-num">{key.length}</span>
        </p>

        {errorMessage ? (
          <p className="fm-error enc-gate__error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className="fm-footer">
          {isSetup ? (
            <Button type="button" variant="secondary" onClick={() => void submitSetup('')}>
              {t('encgate.skip')}
            </Button>
          ) : null}
          <Button type="submit" variant="primary">
            {isSetup ? t('encgate.setKey') : t('encgate.unlock')}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Encryption_Gate: renders whichever gate dialog the
 * {@link useEncryptionGateStore} says is open (setup or unlock) and blocks the
 * rest of the app while it is (Requirements 7.2, 7.3).
 *
 * Blocking is achieved three ways, all driven purely by store state:
 * 1. The shared {@link Modal} renders a fixed, full-viewport backdrop on
 *    `var(--scrim)` that intercepts every pointer event, so nothing behind it
 *    is clickable while a gate dialog is open.
 * 2. Keyboard focus is trapped inside the dialog (see {@link useFocusTrap}), so
 *    `Tab` cannot walk out into the blocked app behind it.
 * 3. The gate is non-dismissible: `onClose` is a no-op, so `Escape` and
 *    backdrop clicks cannot close it. The only way past is a successful
 *    submission, which the store reflects by clearing the
 *    `setupModalOpen` / `unlockModalOpen` flags. (The App shell additionally
 *    gates page rendering on `accessGranted`.)
 *
 * The dialog is labelled by its own `<h2>` through `aria-labelledby`, so it
 * announces as "Set an encryption key" / "Unlock your accounts" instead of as
 * an unnamed dialog — the id used to be minted and then never wired.
 *
 * Renders nothing when neither gate is open, so it is safe to mount
 * unconditionally at the top of the app shell.
 */
export function EncryptionGate(): JSX.Element | null {
  const setupModalOpen = useEncryptionGateStore((s) => s.setupModalOpen);
  const unlockModalOpen = useEncryptionGateStore((s) => s.unlockModalOpen);
  const titleId = useId();

  // Non-dismissible: the gate can only be cleared by a successful submission,
  // never by the user backing out (Requirements 7.2, 7.3, 7.5).
  const noop = () => {};

  if (setupModalOpen) {
    return (
      <Modal open onClose={noop} titleId={titleId} size="sm">
        <GateBody variant="setup" titleId={titleId} />
      </Modal>
    );
  }

  if (unlockModalOpen) {
    return (
      <Modal open onClose={noop} titleId={titleId} size="sm">
        <GateBody variant="unlock" titleId={titleId} />
      </Modal>
    );
  }

  return null;
}
