import {
  useEffect,
  useId,
  useState,
  type CSSProperties,
} from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import type { Account } from '@/types/models';
import type { ChromeDownloadProgress, UnlistenFn } from '@/types/window';
import {
  buildAccountToAdd,
  normalizeValidation,
  parseCookieLines,
  processBatchCookies,
  type BatchProgressEvent,
  type BatchSummary,
} from './addAccount';

/**
 * The three add-account methods offered by the modal (Requirement 13.1):
 * signing in with Roblox, pasting a single cookie, or pasting many cookies.
 */
type AddMode = 'login' | 'single' | 'batch';

/**
 * Shape the `roblox_open_login` command resolves with once the CDP cookie
 * capture completes. `ipc.openLogin()` is typed `Promise<void>` on the shared
 * IPC surface, so the modal narrows the resolved value locally to read the
 * captured cookie (mirroring the legacy renderer's `finishLogin`).
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
 *
 * The modal owns the three add flows and their IPC orchestration; the only
 * effect it delegates is the actual insert, handed to {@link onAdd} so the
 * Account_Store (and its list/toast side effects) stays the single owner of the
 * account list. `onAdd` builds on `accountStore.add` in the Accounts page.
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
}

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
  minWidth: '360px',
  maxWidth: '440px',
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: '17px',
  color: 'var(--t1)',
};

const tabsStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
};

const tabStyle = (active: boolean): CSSProperties => ({
  flex: 1,
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  background: active ? 'var(--accent, #5b8def)' : 'var(--bg2)',
  color: active ? '#fff' : 'var(--t2)',
  fontSize: '13px',
  cursor: 'pointer',
});

const labelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '13px',
  color: 'var(--t2)',
};

const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  background: 'var(--bg2)',
  color: 'var(--t1)',
  fontSize: '14px',
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: '120px',
  resize: 'vertical',
  fontFamily: 'monospace',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '4px',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  color: 'var(--danger, #e5484d)',
};

const hintStyle: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  color: 'var(--t2)',
};

const progressTrackStyle: CSSProperties = {
  height: '8px',
  borderRadius: '999px',
  background: 'var(--bg2)',
  overflow: 'hidden',
};

const progressFillStyle = (percent: number): CSSProperties => ({
  height: '100%',
  width: `${Math.max(0, Math.min(100, percent))}%`,
  background: 'var(--accent, #5b8def)',
  transition: 'width 120ms linear',
});

const failureListStyle: CSSProperties = {
  margin: 0,
  paddingLeft: '18px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  fontSize: '13px',
  color: 'var(--danger, #e5484d)',
  maxHeight: '160px',
  overflowY: 'auto',
};

/**
 * Modal for adding an account through one of three methods (Requirement 13):
 *
 * - **Iniciar sesión con Roblox** — invokes `roblox_open_login`, shows the
 *   browser-download progress reported by `chrome://download-progress`
 *   (Requirement 13.2), and can be cancelled via `login_cancel`.
 * - **Pegar una cookie** — validates the cookie via the validation command
 *   before adding the account (Requirement 13.3).
 * - **Pegar múltiples cookies** — processes each pasted cookie sequentially,
 *   showing per-cookie progress (Requirement 13.4) and, for any invalid cookie,
 *   an error identifying which one failed without stopping the rest
 *   (Requirement 13.5). The sequential loop is delegated to the pure
 *   {@link processBatchCookies} (Property 25).
 */
export function AddAccountModal({
  open,
  onClose,
  onAdd,
}: AddAccountModalProps): JSX.Element {
  const titleId = useId();
  const [mode, setMode] = useState<AddMode>('login');

  // ── Login tab state ──
  const [loginStarted, setLoginStarted] = useState(false);
  const [loginPhase, setLoginPhase] = useState<LoginPhase>('idle');
  const [progressPercent, setProgressPercent] = useState(0);
  const [loginError, setLoginError] = useState<string | null>(null);

  // ── Single-cookie tab state ──
  const [singleCookie, setSingleCookie] = useState('');
  const [singleBusy, setSingleBusy] = useState(false);
  const [singleError, setSingleError] = useState<string | null>(null);

  // ── Batch tab state ──
  const [batchText, setBatchText] = useState('');
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressEvent | null>(
    null,
  );
  const [batchSummary, setBatchSummary] = useState<BatchSummary | null>(null);

  // Reset every flow's state each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setMode('login');
    setLoginStarted(false);
    setLoginPhase('idle');
    setProgressPercent(0);
    setLoginError(null);
    setSingleCookie('');
    setSingleBusy(false);
    setSingleError(null);
    setBatchText('');
    setBatchRunning(false);
    setBatchProgress(null);
    setBatchSummary(null);
  }, [open]);

  // Subscribe to browser-download progress while the modal is open (Req 13.2).
  useEffect(() => {
    if (!open) return;
    let active = true;
    let unlisten: UnlistenFn | undefined;
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
        // Subscription failures are non-fatal for the modal; the login flow can
        // still complete without a live progress bar.
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [open]);

  const startLogin = async (): Promise<void> => {
    setLoginError(null);
    setLoginStarted(true);
    setLoginPhase('downloading');
    setProgressPercent(0);
    try {
      // `ipc.openLogin()` resolves once the CDP flow captures a cookie; the
      // shared surface types it as `void`, so narrow the resolved value here.
      const res = (await ipc.openLogin()) as unknown as LoginResult | undefined;
      if (!open) return;
      if (!res || !res.success || !res.cookie || !res.username) {
        setLoginStarted(false);
        setLoginPhase('idle');
        if (res?.error) setLoginError(res.error);
        return;
      }
      await onAdd(
        buildAccountToAdd(
          { ok: true, username: res.username, userId: res.userId },
          res.cookie,
        ),
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

  const submitSingle = async (): Promise<void> => {
    const cookie = singleCookie.trim();
    if (!cookie) return;
    setSingleBusy(true);
    setSingleError(null);
    try {
      const validation = normalizeValidation(await ipc.validateCookie(cookie));
      if (!validation.ok || !validation.username) {
        setSingleError(validation.reason?.trim() || 'La cookie no es válida.');
        setSingleBusy(false);
        return;
      }
      await onAdd(buildAccountToAdd(validation, cookie));
      setSingleCookie('');
      setSingleBusy(false);
      onClose();
    } catch {
      // The IPC layer already surfaced a toast; keep the modal open with a hint.
      setSingleError('No se pudo validar o añadir la cookie.');
      setSingleBusy(false);
    }
  };

  const submitBatch = async (): Promise<void> => {
    const cookies = parseCookieLines(batchText);
    setBatchSummary(null);
    if (cookies.length === 0) {
      setBatchProgress(null);
      return;
    }
    setBatchRunning(true);
    setBatchProgress({ index: 0, total: cookies.length, cookie: cookies[0], phase: 'validating' });
    const summary = await processBatchCookies(cookies, {
      validate: async (cookie) =>
        normalizeValidation(await ipc.validateCookie(cookie)),
      add: async (validation, cookie) => {
        await onAdd(buildAccountToAdd(validation, cookie));
      },
      onProgress: (event) => setBatchProgress(event),
    });
    setBatchProgress(null);
    setBatchSummary(summary);
    setBatchRunning(false);
  };

  return (
    <Modal open={open} onClose={onClose} titleId={titleId}>
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          Añadir cuenta
        </h2>

        <div style={tabsStyle} role="tablist" aria-label="Método para añadir cuenta">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'login'}
            style={tabStyle(mode === 'login')}
            onClick={() => setMode('login')}
          >
            Iniciar sesión
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            style={tabStyle(mode === 'single')}
            onClick={() => setMode('single')}
          >
            Una cookie
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'batch'}
            style={tabStyle(mode === 'batch')}
            onClick={() => setMode('batch')}
          >
            Varias cookies
          </button>
        </div>

        {mode === 'login' && (
          <div style={labelStyle}>
            <p style={hintStyle}>
              Inicia sesión con Roblox en una ventana de navegador; la cookie se
              capturará automáticamente.
            </p>
            {loginStarted && (
              <>
                <div style={progressTrackStyle} aria-hidden="true">
                  <div style={progressFillStyle(progressPercent)} />
                </div>
                <p style={hintStyle}>
                  {loginPhase === 'downloading'
                    ? `Descargando navegador… ${Math.round(progressPercent)}%`
                    : 'Esperando a que inicies sesión…'}
                </p>
              </>
            )}
            {loginError && <p style={errorStyle}>{loginError}</p>}
            <div style={footerStyle}>
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

        {mode === 'single' && (
          <div style={labelStyle}>
            <label style={labelStyle}>
              Cookie (.ROBLOSECURITY)
              <input
                style={inputStyle}
                type="password"
                value={singleCookie}
                placeholder="Pega la cookie aquí"
                onChange={(event) => setSingleCookie(event.target.value)}
              />
            </label>
            {singleError && <p style={errorStyle}>{singleError}</p>}
            <div style={footerStyle}>
              <Button variant="secondary" onClick={onClose} disabled={singleBusy}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={() => void submitSingle()}
                disabled={singleBusy || singleCookie.trim().length === 0}
              >
                {singleBusy ? 'Validando…' : 'Añadir cuenta'}
              </Button>
            </div>
          </div>
        )}

        {mode === 'batch' && (
          <div style={labelStyle}>
            <label style={labelStyle}>
              Cookies (una por línea)
              <textarea
                style={textareaStyle}
                value={batchText}
                placeholder={'Pega una cookie por línea…'}
                onChange={(event) => setBatchText(event.target.value)}
                disabled={batchRunning}
              />
            </label>

            {batchRunning && batchProgress && (
              <>
                <div style={progressTrackStyle} aria-hidden="true">
                  <div
                    style={progressFillStyle(
                      batchProgress.total > 0
                        ? (batchProgress.index / batchProgress.total) * 100
                        : 0,
                    )}
                  />
                </div>
                <p style={hintStyle}>
                  {`Procesando cookie ${batchProgress.index + 1} de ${batchProgress.total} (${
                    batchProgress.phase === 'validating' ? 'validando' : 'añadiendo'
                  })…`}
                </p>
              </>
            )}

            {batchSummary && (
              <div style={labelStyle}>
                <p style={hintStyle}>
                  {`Se añadieron ${batchSummary.added} de ${batchSummary.total} cuentas.`}
                </p>
                {batchSummary.failures.length > 0 && (
                  <ul style={failureListStyle}>
                    {batchSummary.failures.map((failure) => (
                      <li key={failure.index}>{failure.reason}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <div style={footerStyle}>
              <Button variant="secondary" onClick={onClose} disabled={batchRunning}>
                {batchSummary ? 'Cerrar' : 'Cancelar'}
              </Button>
              <Button
                variant="primary"
                onClick={() => void submitBatch()}
                disabled={batchRunning || parseCookieLines(batchText).length === 0}
              >
                {batchRunning ? 'Procesando…' : 'Añadir cuentas'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
