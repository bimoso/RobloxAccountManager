import {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import {
  AtSign,
  Check,
  CircleAlert,
  Info,
  KeyRound,
  LogIn,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { Switch } from '@/components/Switch';
import { ipc } from '@/lib/ipc';
import { getPersisted, PERSISTENCE_KEYS, setPersisted } from '@/lib/persistence';
import type { Account } from '@/types/models';
import type { WayfernProgress } from '@/types/models';
import type { ChromeDownloadProgress, UnlistenFn } from '@/types/window';
import {
  buildAccountToAdd,
  findAccountByIdentity,
  findAccountByUsername,
  normalizeCredentialLogin,
  normalizeValidation,
  parseCookieLines,
  parseCredentialLines,
  processBatchCookies,
  processCredentials,
  type BatchProgressEvent,
  type BatchSummary,
  type CredentialEntry,
  type CredentialOutcome,
  type CredentialProgressEvent,
  type CredentialSummary,
} from './addAccount';
import './AddAccountModal.css';

/**
 * The three add-account methods offered by the modal: signing in with Roblox,
 * pasting one or many cookies, or bulk `user:pass` combos driven through a
 * humanized auto-login.
 */
type AddMode = 'login' | 'cookies' | 'combo';

/**
 * Shape the `roblox_open_login` / `roblox_login_credentials` commands resolve
 * with once the CDP cookie capture completes. The shared IPC surface types these
 * loosely, so the modal narrows the resolved value locally.
 */
interface LoginResult {
  success?: boolean;
  cookie?: string;
  username?: string;
  userId?: string;
  error?: string;
}

/** Narrowed view of a `chrome://download-progress` event payload. */
interface DownloadProgress {
  status?: string;
  percent?: number;
}

/**
 * Progress phase of the "Iniciar sesión con Roblox" flow, driving what the
 * login tab shows: idle (not started), downloading (browser download in
 * progress), waiting (download done, waiting for the user to sign in).
 */
type LoginPhase = 'idle' | 'downloading' | 'waiting';

/**
 * Props for {@link AddAccountModal}.
 */
export interface AddAccountModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Called when the user dismisses the modal. */
  onClose: () => void;
  /**
   * Adds a validated account to the store. Receives the account payload built
   * from a validated cookie; may reject (the caller/store surfaces the error
   * toast and the modal keeps the relevant flow's inline message).
   */
  onAdd: (account: Account) => Promise<void>;
  /**
   * The current accounts, used by the `user:pass` flow to upsert: an entry whose
   * username matches an existing account attaches its credentials instead of
   * adding a duplicate.
   */
  accounts?: Account[];
  /**
   * Updates an existing account (e.g. attaching credentials or refreshing a
   * cookie during the `user:pass` upsert). Required for the upsert path; when
   * omitted, matching entries fall back to adding a new account.
   */
  onUpdate?: (id: string, changed: Partial<Account>) => Promise<void>;
}

const TABS: ReadonlyArray<{ id: AddMode; label: string; Icon: typeof LogIn }> = [
  { id: 'login', label: 'Iniciar sesión', Icon: LogIn },
  { id: 'cookies', label: 'Cookie(s)', Icon: KeyRound },
  { id: 'combo', label: 'User : Pass', Icon: AtSign },
];

function batchTone(summary: BatchSummary | CredentialSummary): 'clean' | 'mixed' {
  return summary.failures.length === 0 ? 'clean' : 'mixed';
}

/**
 * Modal for adding an account through one of three methods:
 *
 * - **Iniciar sesión con Roblox** — invokes `roblox_open_login`, shows the
 *   browser-download progress reported by `chrome://download-progress`, and can
 *   be cancelled via `login_cancel`.
 * - **Cookie(s)** — accepts one or many lines through the same input and
 *   processes each cookie sequentially. A failed line never stops the rest
 *   (delegated to {@link processBatchCookies}).
 * - **User : Pass** — bulk `username:password` combos, each driven through the
 *   humanized auto-login (`roblox_login_credentials`) sequentially, with per-combo
 *   progress and a cancel that stops cleanly between combos (delegated to
 *   {@link processCombos}).
 */
export function AddAccountModal({
  open,
  onClose,
  onAdd,
  accounts = [],
  onUpdate,
}: AddAccountModalProps): JSX.Element {
  const titleId = useId();
  const [mode, setMode] = useState<AddMode>('login');
  const [acceptModerated, setAcceptModerated] = useState(
    () => getPersisted<boolean>(PERSISTENCE_KEYS.acceptModerated) === true,
  );
  const toggleModerated = (next: boolean): void => {
    setAcceptModerated(next);
    setPersisted(PERSISTENCE_KEYS.acceptModerated, next);
  };

  // ── Login tab state ──
  const [loginStarted, setLoginStarted] = useState(false);
  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle');
  const [progressPercent, setProgressPercent] = useState(0);
  const [loginError, setLoginError] = useState<string | null>(null);

  // ── Unified cookie tab state (one line or many) ──
  const [cookieText, setCookieText] = useState('');
  const [cookiesRunning, setCookiesRunning] = useState(false);
  const [cookiesProgress, setCookiesProgress] = useState<BatchProgressEvent | null>(null);
  const [cookiesSummary, setCookiesSummary] = useState<BatchSummary | null>(null);

  // ── Combo (user:pass[:cookie]) tab state ──
  const [comboText, setComboText] = useState('');
  const [comboRunning, setComboRunning] = useState(false);
  const [comboProgress, setComboProgress] = useState<CredentialProgressEvent | null>(null);
  const [comboSummary, setComboSummary] = useState<CredentialSummary | null>(null);
  // Set true by "Cancelar" so the sequential loop stops between entries.
  const comboAbort = useRef(false);

  // Reset every flow's state each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setMode('login');
    setLoginStarted(false);
    setLoginPhase('idle');
    setProgressPercent(0);
    setLoginError(null);
    setCookieText('');
    setCookiesRunning(false);
    setCookiesProgress(null);
    setCookiesSummary(null);
    setComboText('');
    setComboRunning(false);
    setComboProgress(null);
    setComboSummary(null);
    comboAbort.current = false;
  }, [open]);

  // Subscribe to browser-download progress while the modal is open.
  useEffect(() => {
    if (!open) return;
    let active = true;
    let unlisten: UnlistenFn | undefined;
    let unlistenWayfern: UnlistenFn | undefined;
    void ipc
      .onChromeProgress((payload: ChromeDownloadProgress) => {
        const data = payload as DownloadProgress;
        if (data.status === 'downloading') {
          setLoginPhase('downloading');
          if (typeof data.percent === 'number') {
            setProgressPercent(data.percent);
          }
        } else if (data.status === 'done') {
          setLoginPhase('waiting');
        }
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => {
        // Subscription failures are non-fatal; the login flow still completes.
      });
    void ipc
      .onWayfernProgress((payload: WayfernProgress) => {
        if (!active) return;
        if (payload.stage === 'ready') {
          setProgressPercent(100);
          setLoginPhase('waiting');
          return;
        }
        setLoginPhase('downloading');
        if (typeof payload.percent === 'number') setProgressPercent(payload.percent);
      })
      .then((fn) => {
        if (active) unlistenWayfern = fn;
        else fn();
      })
      .catch(() => {
        // Wayfern may already be installed; login can proceed without progress.
      });
    return () => {
      active = false;
      unlisten?.();
      unlistenWayfern?.();
    };
  }, [open]);

  const startLogin = async (): Promise<void> => {
    setLoginError(null);
    setLoginStarted(true);
    setLoginPhase('downloading');
    setProgressPercent(0);
    try {
      const res = (await ipc.openLogin()) as unknown as LoginResult | undefined;
      if (!open) return;
      if (!res || !res.success || !res.cookie || !res.username) {
        setLoginStarted(false);
        setLoginPhase('idle');
        if (res?.error) setLoginError(res.error);
        return;
      }
      await onAdd(
        buildAccountToAdd({ ok: true, username: res.username, userId: res.userId }, res.cookie),
      );
      onClose();
    } catch {
      setLoginStarted(false);
      setLoginPhase('idle');
      setLoginError('No se pudo completar el inicio de sesión.');
    }
  };

  const cancelLogin = (): void => {
    void ipc.cancelLogin().catch(() => {
      // Ignore: cancelling a login that already ended is harmless.
    });
    setLoginStarted(false);
    setLoginPhase('idle');
    onClose();
  };

  const submitCookies = async (): Promise<void> => {
    const cookies = parseCookieLines(cookieText);
    setCookiesSummary(null);
    if (cookies.length === 0) {
      setCookiesProgress(null);
      return;
    }
    setCookiesRunning(true);
    setCookiesProgress({ index: 0, total: cookies.length, cookie: cookies[0], phase: 'validating' });
    const summary = await processBatchCookies(cookies, {
      validate: async (cookie) => normalizeValidation(await ipc.validateCookie(cookie)),
      add: async (validation, cookie) => {
        await onAdd(buildAccountToAdd(validation, cookie, { moderated: validation.moderated }));
      },
      onProgress: (event) => setCookiesProgress(event),
      acceptModerated,
    });
    setCookiesProgress(null);
    setCookiesRunning(false);

    // Preserve the fast one-cookie path: a single successful line closes the
    // modal immediately. Multi-line and failed runs stay open with a summary.
    if (cookies.length === 1 && summary.added === 1 && summary.failures.length === 0) {
      setCookieText('');
      onClose();
      return;
    }
    setCookiesSummary(summary);
  };

  // Resolve one entry to a valid session. Inline cookies are validated directly;
  // every plain user:pass entry opens the visible credential-login browser.
  // Reusing an existing cookie here made the UI look successful without ever
  // proving the supplied password or exercising the requested login flow.
  const resolveCredential = async (entry: CredentialEntry): Promise<CredentialOutcome> => {
    if (entry.cookie) {
      const validation = normalizeValidation(await ipc.validateCookie(entry.cookie));
      if (validation.ok && validation.username) {
        return { ok: true, cookie: entry.cookie, username: validation.username, userId: validation.userId };
      }
      // Moderated cookie: valid but no username of its own — accept it (when the
      // toggle is on) using the entry's typed username, and mark it moderated.
      if (validation.moderated && acceptModerated) {
        return { ok: true, cookie: entry.cookie, username: entry.username, moderated: true };
      }
      return { ok: false, error: validation.reason?.trim() || 'La cookie no es válida.' };
    }
    const login = normalizeCredentialLogin(await ipc.loginCredentials(entry.username, entry.password));
    if (!login.success || !login.cookie || !login.username) {
      return { ok: false, error: login.error };
    }
    return { ok: true, cookie: login.cookie, username: login.username, userId: login.userId };
  };

  // Persist a resolved entry: update the matching account (attach credentials /
  // refresh cookie) or add a new one, upserting by the resolved username.
  const saveCredential = async (entry: CredentialEntry, outcome: CredentialOutcome): Promise<void> => {
    const existing =
      findAccountByIdentity(accounts, {
        userId: outcome.userId,
        username: outcome.username ?? entry.username,
      }) ?? findAccountByUsername(accounts, entry.username);
    if (existing && onUpdate) {
      await onUpdate(existing.id, {
        cookie: outcome.cookie,
        userId: outcome.userId ?? existing.userId,
        password: entry.password,
        loginUsername: entry.username,
        ...(outcome.moderated ? { moderated: true } : {}),
      });
      return;
    }
    await onAdd(
      buildAccountToAdd(
        { ok: true, username: outcome.username, userId: outcome.userId },
        outcome.cookie ?? '',
        { loginUsername: entry.username, password: entry.password, moderated: outcome.moderated },
      ),
    );
  };

  const submitCombo = async (): Promise<void> => {
    const entries = parseCredentialLines(comboText);
    setComboSummary(null);
    if (entries.length === 0) {
      setComboProgress(null);
      return;
    }
    comboAbort.current = false;
    setComboRunning(true);
    setComboProgress({ index: 0, total: entries.length, username: entries[0].username, phase: 'resolving' });
    const summary = await processCredentials(entries, {
      resolve: resolveCredential,
      save: saveCredential,
      onProgress: (event) => setComboProgress(event),
      shouldAbort: () => comboAbort.current,
    });
    setComboProgress(null);
    setComboSummary(summary);
    setComboRunning(false);
  };

  const cancelCombo = (): void => {
    // Stop the loop between combos AND close the currently-open login window.
    comboAbort.current = true;
    void ipc.cancelLogin().catch(() => {
      // Ignore: no window open, or it already ended.
    });
  };

  return (
    <Modal open={open} onClose={onClose} titleId={titleId}>
      <div className="addacc">
        <div className="addacc__head">
          <span className="addacc__eyebrow">Provisioning / Accounts</span>
          <h2 id={titleId} className="addacc__title">
            Añadir cuenta
          </h2>
          <p className="addacc__subtitle">
            Elige cómo quieres importar la cuenta: sesión, cookie o credenciales.
          </p>
        </div>

        <div className="addacc__tabs" role="tablist" aria-label="Método para añadir cuenta">
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              className="addacc__tab"
              onClick={() => setMode(id)}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </div>

        {mode !== 'login' && (
          <label className="addacc__moderated">
            <Switch
              checked={acceptModerated}
              onChange={toggleModerated}
              aria-label="Aceptar cuentas moderadas"
            />
            <span>
              <strong>Aceptar cuentas moderadas</strong>
              <small>Añade la cuenta aunque Roblox la marque como moderada.</small>
            </span>
          </label>
        )}

        {mode === 'login' && (
          <div className="addacc__panel">
            <p className="addacc__hint">
              <Info size={15} aria-hidden="true" />
              Inicia sesión con Roblox en una ventana de navegador; la cookie se captura
              automáticamente.
            </p>
            {loginStarted && (
              <div className="addacc__progress">
                <div className="addacc__track" aria-hidden="true">
                  <div className="addacc__fill" style={{ width: `${Math.max(0, Math.min(100, progressPercent))}%` }} />
                </div>
                <p className="addacc__progress-label">
                  {loginPhase === 'downloading'
                    ? `Descargando navegador… ${Math.round(progressPercent)}%`
                    : 'Esperando a que inicies sesión…'}
                </p>
              </div>
            )}
            {loginError && (
              <p className="addacc__error">
                <CircleAlert size={15} aria-hidden="true" />
                {loginError}
              </p>
            )}
            <div className="addacc__footer">
              {loginStarted ? (
                <Button variant="secondary" onClick={cancelLogin}>
                  Cancelar
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={onClose}>
                    Cerrar
                  </Button>
                  <Button variant="primary" onClick={() => void startLogin()}>
                    Iniciar sesión con Roblox
                  </Button>
                </>
              )}
            </div>
          </div>
        )}

        {mode === 'cookies' && (
          <div className="addacc__panel">
            <label className="addacc__field">
              Cookie(s) de Roblox
              <textarea
                className="addacc__textarea"
                value={cookieText}
                placeholder={'Pega una cookie, o varias separadas por línea…'}
                onChange={(event) => setCookieText(event.target.value)}
                disabled={cookiesRunning}
              />
            </label>

            {!cookiesRunning && !cookiesSummary && parseCookieLines(cookieText).length > 0 && (
              <p className="addacc__progress-label">
                <span className="addacc__count">{parseCookieLines(cookieText).length}</span>{' '}
                {parseCookieLines(cookieText).length === 1 ? 'cookie detectada.' : 'cookies detectadas.'}
              </p>
            )}

            {cookiesRunning && cookiesProgress && (
              <div className="addacc__progress">
                <div className="addacc__track" aria-hidden="true">
                  <div
                    className="addacc__fill"
                    style={{
                      width: `${cookiesProgress.total > 0 ? (cookiesProgress.index / cookiesProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="addacc__progress-label">
                  Procesando cookie <strong>{cookiesProgress.index + 1}</strong> de {cookiesProgress.total} (
                  {cookiesProgress.phase === 'validating' ? 'validando' : 'añadiendo'})…
                </p>
              </div>
            )}

            {cookiesSummary && (
              <div className="addacc__summary" data-tone={batchTone(cookiesSummary)}>
                <div className="addacc__summary-head">
                  {cookiesSummary.failures.length === 0 ? <Check size={16} /> : <CircleAlert size={16} />}
                  Se añadieron {cookiesSummary.added} de {cookiesSummary.total} cuentas.
                </div>
                {cookiesSummary.failures.length > 0 && (
                  <ul className="addacc__failures">
                    {cookiesSummary.failures.map((failure) => (
                      <li key={failure.index}>{failure.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="addacc__footer">
              <Button variant="secondary" onClick={onClose} disabled={cookiesRunning}>
                {cookiesSummary ? 'Cerrar' : 'Cancelar'}
              </Button>
              <Button
                variant="primary"
                onClick={() => void submitCookies()}
                disabled={cookiesRunning || parseCookieLines(cookieText).length === 0}
              >
                {cookiesRunning
                  ? 'Procesando…'
                  : parseCookieLines(cookieText).length === 1
                    ? 'Añadir cuenta'
                    : 'Añadir cuentas'}
              </Button>
            </div>
          </div>
        )}

        {mode === 'combo' && (
          <div className="addacc__panel">
            <label className="addacc__field">
              Credenciales (user:pass o user:pass:cookie, una por línea)
              <textarea
                className="addacc__textarea"
                value={comboText}
                placeholder={'usuario1:contraseña1\nusuario2:contraseña2:_|WARNING:-DO-NOT-SHARE…'}
                onChange={(event) => setComboText(event.target.value)}
                disabled={comboRunning}
              />
            </label>

            <p className="addacc__hint">
              <Info size={15} aria-hidden="true" />
              Sin cookie: se abrirá una ventana por cuenta y las credenciales se escribirán con un
              ritmo humanizado (resuelve el captcha/2FA si aparece), aunque la cuenta ya exista.
              Con cookie, se valida y se actualiza o añade directo.
            </p>

            {!comboRunning && !comboSummary && parseCredentialLines(comboText).length > 0 && (
              <p className="addacc__progress-label">
                <span className="addacc__count">{parseCredentialLines(comboText).length}</span>{' '}
                cuenta(s) detectada(s).
              </p>
            )}

            {comboRunning && comboProgress && (
              <div className="addacc__progress">
                <div className="addacc__track" aria-hidden="true">
                  <div
                    className="addacc__fill"
                    style={{
                      width: `${comboProgress.total > 0 ? (comboProgress.index / comboProgress.total) * 100 : 0}%`,
                    }}
                  />
                </div>
                <p className="addacc__progress-label">
                  Cuenta <strong>{comboProgress.index + 1}</strong> de {comboProgress.total} —{' '}
                  <strong>{comboProgress.username}</strong> (
                  {comboProgress.phase === 'resolving' ? 'verificando' : 'guardando'})…
                </p>
              </div>
            )}

            {comboSummary && (
              <div className="addacc__summary" data-tone={batchTone(comboSummary)}>
                <div className="addacc__summary-head">
                  {comboSummary.failures.length === 0 ? <Check size={16} /> : <CircleAlert size={16} />}
                  Se procesaron {comboSummary.saved} de {comboSummary.total} cuentas.
                </div>
                {comboSummary.failures.length > 0 && (
                  <ul className="addacc__failures">
                    {comboSummary.failures.map((failure) => (
                      <li key={failure.index}>{failure.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div className="addacc__footer">
              {comboRunning ? (
                <Button variant="secondary" onClick={cancelCombo}>
                  Cancelar
                </Button>
              ) : (
                <>
                  <Button variant="secondary" onClick={onClose}>
                    {comboSummary ? 'Cerrar' : 'Cancelar'}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void submitCombo()}
                    disabled={parseCredentialLines(comboText).length === 0}
                  >
                    Procesar credenciales
                  </Button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
