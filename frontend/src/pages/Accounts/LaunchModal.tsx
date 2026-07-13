import {
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
} from 'react';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ipc } from '@/lib/ipc';
import type { Account } from '@/types/models';
import type { GameDetails } from '@/types/window';
import {
  EMPTY_LAUNCH_INPUTS,
  buildLaunchTarget,
  launchAccounts,
  type LaunchInputs,
  type LaunchOutcome,
  type LaunchTab,
} from './launch';

/**
 * Props for {@link LaunchModal}.
 *
 * The modal launches one or many accounts toward a chosen destination
 * (Requirement 15). It picks the destination via the Home/Place/Player/Private
 * tabs (Requirement 15.1), previews the game on the Place tab (Requirement
 * 15.3), and on confirm runs the pure launch orchestration for every target
 * account with the built destination (Requirement 15.2).
 */
export interface LaunchModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /**
   * The target accounts to launch. A single account (from a card) or many
   * (from the current selection). When empty the modal renders closed.
   */
  accounts: Account[];
  /** Called when the user dismisses the modal. */
  onClose: () => void;
  /**
   * Called once per account that launched successfully, with its id, so the
   * page can mark it launched (Requirement 15.2 follow-up). Optional.
   */
  onLaunched?: (accountId: string) => void;
  /**
   * Launch effect, injected for testing. Defaults to the real IPC call
   * `ipc.launchRoblox(account.id, account.cookie, target)`.
   */
  launch?: (account: Account, target: string) => Promise<unknown>;
  /**
   * Game-preview fetcher, injected for testing. Defaults to
   * `ipc.getGameDetails`. Receives the raw place input and the cookie to
   * authenticate with.
   */
  fetchGameDetails?: (placeId: string, cookie: string) => Promise<GameDetails>;
}

/** Debounce (ms) before fetching the Place-tab game preview, matching legacy. */
const PREVIEW_DEBOUNCE_MS = 450;

const TABS: ReadonlyArray<{ dest: LaunchTab; label: string }> = [
  { dest: 'home', label: 'Home' },
  { dest: 'place', label: 'Place' },
  { dest: 'player', label: 'Player' },
  { dest: 'private', label: 'Private' },
];

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  minWidth: '360px',
  maxWidth: '420px',
};

const titleStyle: CSSProperties = { margin: 0, fontSize: '17px', color: 'var(--t1)' };

const whoStyle: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--t2)' };

const tabsStyle: CSSProperties = {
  display: 'flex',
  gap: '4px',
  padding: '4px',
  borderRadius: '10px',
  background: 'var(--bg2)',
};

const paneStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  fontSize: '13px',
  color: 'var(--t2)',
  minHeight: '44px',
};

const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: '8px',
  border: '1px solid var(--border)',
  background: 'var(--bg2)',
  color: 'var(--t1)',
  fontSize: '14px',
};

const previewStyle: CSSProperties = {
  display: 'flex',
  gap: '10px',
  alignItems: 'center',
  padding: '10px',
  borderRadius: '10px',
  border: '1px solid var(--border)',
  background: 'var(--bg2)',
};

const previewIconStyle: CSSProperties = {
  width: '48px',
  height: '48px',
  borderRadius: '8px',
  objectFit: 'cover',
  flexShrink: 0,
  background: 'var(--bg3, var(--bg2))',
};

const footerStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '8px',
  marginTop: '4px',
};

const errorStyle: CSSProperties = { margin: 0, fontSize: '13px', color: 'var(--danger, #e5484d)' };

function tabStyle(active: boolean): CSSProperties {
  return {
    flex: 1,
    padding: '7px 0',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '13px',
    background: active ? 'var(--accent, var(--bg3))' : 'transparent',
    color: active ? 'var(--on-accent, #fff)' : 'var(--t2)',
  };
}

/** Cookie used to authenticate the game-preview / launch metadata calls. */
function previewCookie(accounts: Account[]): string {
  return accounts.find((a) => a.cookie)?.cookie ?? '';
}

/**
 * Launch modal for one or many accounts.
 *
 * Offers the Home/Place/Player/Private destination tabs (Requirement 15.1).
 * While the Place tab is active and a place id / game url has been entered, it
 * fetches and shows a game preview — icon, name, creator, current players —
 * via {@link LaunchModalProps.fetchGameDetails} (Requirement 15.3). On confirm
 * it builds the destination with {@link buildLaunchTarget} and runs
 * {@link launchAccounts}, invoking the launch effect exactly once per target
 * account with that single destination (Requirement 15.2, Property 28).
 */
export function LaunchModal({
  open,
  accounts,
  onClose,
  onLaunched,
  launch,
  fetchGameDetails,
}: LaunchModalProps): JSX.Element {
  const titleId = useId();
  const [tab, setTab] = useState<LaunchTab>('home');
  const [inputs, setInputs] = useState<LaunchInputs>(EMPTY_LAUNCH_INPUTS);
  const [preview, setPreview] = useState<GameDetails | null>(null);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doLaunch = launch ?? ((account: Account, target: string) =>
    ipc.launchRoblox(account.id, account.cookie, target));
  const getDetails = fetchGameDetails ?? ipc.getGameDetails;

  const cookie = useMemo(() => previewCookie(accounts), [accounts]);
  const target = buildLaunchTarget(tab, inputs);

  // Reset the form each time the modal opens; seed the destination from a
  // single account's saved gameTarget when there is exactly one (mirrors the
  // legacy renderer's openLaunchFor seeding).
  useEffect(() => {
    if (!open) return;
    setLaunching(false);
    setError(null);
    setPreview(null);
    if (accounts.length === 1) {
      const saved =
        typeof accounts[0].gameTarget === 'string' ? accounts[0].gameTarget.trim() : '';
      if (saved) {
        if (/privateServerLinkCode=/.test(saved)) {
          setTab('private');
          setInputs({ ...EMPTY_LAUNCH_INPUTS, privateLink: saved });
          return;
        }
        setTab('place');
        setInputs({ ...EMPTY_LAUNCH_INPUTS, place: saved });
        return;
      }
    }
    setTab('home');
    setInputs(EMPTY_LAUNCH_INPUTS);
  }, [open, accounts]);

  // Load the Place-tab game preview (Req 15.3), debounced. Only runs while the
  // Place tab is active and a place id / url has been entered.
  useEffect(() => {
    if (!open || tab !== 'place') {
      setPreview(null);
      return;
    }
    const place = inputs.place.trim();
    if (!place) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const details = await getDetails(place, cookie);
          if (cancelled) return;
          setPreview(details && details.ok ? details : null);
        } catch {
          if (!cancelled) setPreview(null);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, tab, inputs.place, cookie, getDetails]);

  const setField = (field: keyof LaunchInputs, value: string): void => {
    setInputs((current) => ({ ...current, [field]: value }));
  };

  const n = accounts.length;
  const canLaunch = target !== undefined && !launching && n > 0;

  const handleLaunch = async (): Promise<void> => {
    if (target === undefined || n === 0) return;
    setLaunching(true);
    setError(null);
    let outcomes: LaunchOutcome<unknown>[];
    try {
      outcomes = await launchAccounts(accounts, target, { launch: doLaunch });
    } catch {
      // launchAccounts captures per-account failures, so a throw here is
      // unexpected; keep the modal open for a retry.
      setError('No se pudo lanzar. Inténtalo de nuevo.');
      setLaunching(false);
      return;
    }

    const succeeded = outcomes.filter((o) => o.ok);
    succeeded.forEach((o) => onLaunched?.(o.account.id));

    if (succeeded.length === outcomes.length) {
      onClose();
      return;
    }
    // Some accounts failed: keep the modal open and report how many.
    setError(`Se lanzaron ${succeeded.length}/${outcomes.length} cuentas.`);
    setLaunching(false);
  };

  const who =
    n === 1
      ? accounts[0].nickname?.trim() || accounts[0].username || 'Cuenta'
      : `${n} cuentas seleccionadas`;
  const launchLabel = n <= 1 ? 'Lanzar' : `Lanzar ${n}`;

  return (
    <Modal open={open && n > 0} onClose={onClose} titleId={titleId}>
      <div style={bodyStyle}>
        <h2 id={titleId} style={titleStyle}>
          {n === 1 ? 'Lanzar Roblox' : `Lanzar ${n} cuentas`}
        </h2>
        <p style={whoStyle}>{who}</p>

        <div style={tabsStyle} role="tablist" aria-label="Destino de lanzamiento">
          {TABS.map(({ dest, label }) => (
            <button
              key={dest}
              type="button"
              role="tab"
              aria-selected={tab === dest}
              style={tabStyle(tab === dest)}
              onClick={() => setTab(dest)}
            >
              {label}
            </button>
          ))}
        </div>

        <div style={paneStyle} role="tabpanel">
          {tab === 'home' && <span>Se lanzará directamente al inicio de Roblox.</span>}

          {tab === 'place' && (
            <>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                ID de juego o enlace
                <input
                  style={inputStyle}
                  type="text"
                  value={inputs.place}
                  placeholder="Ej. 920587237 o URL del juego"
                  onChange={(e) => setField('place', e.target.value)}
                />
              </label>
              {preview && (
                <div style={previewStyle}>
                  {preview.iconUrl && (
                    <img style={previewIconStyle} src={preview.iconUrl} alt="" />
                  )}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: 'var(--t1)', fontSize: '14px' }}>
                      {preview.name ?? 'Juego'}
                    </div>
                    {preview.creator && <div>por {preview.creator}</div>}
                    {typeof preview.playing === 'number' && (
                      <div>{preview.playing.toLocaleString()} jugando ahora</div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'player' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              ID de usuario a seguir
              <input
                style={inputStyle}
                type="text"
                value={inputs.followUserId}
                placeholder="ID de usuario del jugador"
                onChange={(e) => setField('followUserId', e.target.value)}
              />
            </label>
          )}

          {tab === 'private' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              Enlace de servidor privado
              <input
                style={inputStyle}
                type="text"
                value={inputs.privateLink}
                placeholder="https://www.roblox.com/games/...privateServerLinkCode=..."
                onChange={(e) => setField('privateLink', e.target.value)}
              />
            </label>
          )}
        </div>

        {error && <p style={errorStyle}>{error}</p>}

        <div style={footerStyle}>
          <Button variant="secondary" onClick={onClose} disabled={launching}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleLaunch()}
            disabled={!canLaunch}
          >
            {launchLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
