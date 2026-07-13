import { useMemo, useState, type MouseEventHandler } from 'react';
import {
  Check,
  CirclePlay,
  Clock3,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  StickyNote,
} from 'lucide-react';
import { accountBadges, displayName } from '@/lib/filters';
import type { Account } from '@/types/models';
import './accounts.css';

/**
 * Props for {@link AccountCard}, the presentational card shown for a single
 * account on the Accounts page (Requirement 8.1, 8.5, 8.7).
 */
export interface AccountCardProps {
  /** The account to render. */
  account: Account;
  /** Avatar thumbnail URL; falls back to initials when missing or on error. */
  avatarUrl?: string;
  /** Whether the card is part of the current multi-selection. */
  selected?: boolean;
  /**
   * Invoked when the user toggles this card's selection. When provided the card
   * is in selection mode: the selection checkbox is shown and clicking anywhere
   * on the card toggles the selection.
   */
  onSelectToggle?: () => void;
  /** Invoked when the user activates the card outside of selection mode. */
  onClick?: MouseEventHandler<HTMLDivElement>;
  /** Native context-menu (right-click) gesture over the card. */
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  /** Activate the accessible "more actions" button. */
  onOpenMenu?: () => void;
  /** Launch/relaunch this account (the prominent card button). */
  onLaunch?: () => void;
}

/** Read the free-form notes attached to an account (legacy `note` fallback). */
function accountNotes(account: Account): string {
  const raw = (account.notes ?? account.note ?? '') as unknown;
  return String(raw).replace(/\s+/g, ' ').trim();
}

/** Initials fallback for the avatar when no thumbnail is available. */
function initials(label: string): string {
  const trimmed = label.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

/** Compact, locale-aware activity label for the operational metadata row. */
function lastActivity(value: string | null): string {
  if (!value) return 'Sin actividad';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Actividad reciente';
  return new Intl.DateTimeFormat('es-MX', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

/**
 * Presentational card for a single account with liquid-glass styling: avatar
 * (with initials fallback), label + userId, a notes preview, status badges
 * (expired / launched), and a launch button + more-actions button.
 */
export function AccountCard({
  account,
  avatarUrl,
  selected = false,
  onSelectToggle,
  onClick,
  onContextMenu,
  onOpenMenu,
  onLaunch,
}: AccountCardProps): JSX.Element {
  const [avatarFailed, setAvatarFailed] = useState(false);

  const label = displayName(account);
  const badges = accountBadges(account);
  const note = accountNotes(account);
  const selectionMode = onSelectToggle !== undefined;
  const showAvatar = avatarUrl && !avatarFailed;
  const activity = useMemo(() => lastActivity(account.lastUsed), [account.lastUsed]);
  const accountHandle = account.username ? `@${account.username}` : `UID ${account.userId}`;
  const status = badges.expired ? 'expired' : badges.launched ? 'live' : 'ready';
  const statusLabel = badges.expired
    ? 'Credencial caducada'
    : badges.launched
      ? `${Math.max(1, Number(account.launchedInstanceCount ?? 1))} activa${Number(account.launchedInstanceCount ?? 1) === 1 ? '' : 's'}`
      : 'Lista';

  const classes = [
    'acc-card',
    badges.launched ? 'is-live' : '',
    badges.expired ? 'is-expired' : '',
    selected ? 'selected' : '',
    selectionMode ? 'selectable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const handleCardClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (selectionMode) {
      onSelectToggle?.();
      return;
    }
    onClick?.(event);
  };

  return (
    <div
      className={classes}
      onClick={handleCardClick}
      onContextMenu={onContextMenu}
      data-selected={selected ? 'true' : undefined}
    >
      <div className={`acc-card__statusline acc-card__statusline--${status}`} aria-hidden="true" />

      {selectionMode && (
        <button
          type="button"
          className="acc-check"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? 'Deselect' : 'Select'}
          onClick={(event) => {
            event.stopPropagation();
            onSelectToggle?.();
          }}
        >
          <Check size={14} strokeWidth={2.8} aria-hidden="true" />
        </button>
      )}

      <div className="acc-card__head">
        <div className="acc-card__identity">
          <div className="acc-card__avatar" aria-hidden={showAvatar ? undefined : 'true'}>
            {showAvatar ? (
              <img
                src={avatarUrl}
                alt={`Avatar de ${label}`}
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              initials(label)
            )}
            <span className={`acc-card__presence acc-card__presence--${status}`} />
          </div>
          <div className="acc-card__id">
            <h3 className="acc-card__name" title={label}>
              {label}
            </h3>
            <p className="acc-card__handle" title={accountHandle}>
              {accountHandle}
            </p>
          </div>
        </div>

        <div className="acc-card__head-actions">
          <span className={`acc-status acc-status--${status}`} title={statusLabel}>
            <span className="acc-status__dot" aria-hidden="true" />
            {statusLabel}
          </span>
          {onOpenMenu && (
            <button
              type="button"
              className="acc-iconbtn acc-iconbtn--menu"
              aria-label="Más acciones"
              onClick={(event) => {
                event.stopPropagation();
                onOpenMenu();
              }}
            >
              <MoreHorizontal size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="acc-card__meta" aria-label="Datos operativos de la cuenta">
        <span title={`Roblox user ID ${account.userId}`}>
          <ShieldCheck size={14} aria-hidden="true" />
          <span className="acc-card__meta-label">UID</span>
          <code>{account.userId}</code>
        </span>
        <span title={`Última actividad: ${activity}`}>
          <Clock3 size={14} aria-hidden="true" />
          <span className="acc-card__meta-label">Última</span>
          <strong>{activity}</strong>
        </span>
      </div>

      <div className={`acc-card__note${note ? '' : ' is-empty'}`} title={note || undefined}>
        <StickyNote size={14} aria-hidden="true" />
        <span>{note || 'Sin notas de operación'}</span>
      </div>

      <div className="acc-card__footer">
        <div className="acc-card__session">
          <span className={`acc-card__session-icon acc-card__session-icon--${status}`}>
            {badges.launched ? (
              <RefreshCw size={14} aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
          </span>
          <span>
            <small>Sesión</small>
            <strong>{badges.launched ? 'En curso' : badges.expired ? 'Requiere acceso' : 'Disponible'}</strong>
          </span>
        </div>
        <button
          type="button"
          className="acc-launch"
          onClick={(event) => {
            event.stopPropagation();
            onLaunch?.();
          }}
        >
          {badges.launched ? (
            <RefreshCw size={15} aria-hidden="true" />
          ) : (
            <CirclePlay size={16} aria-hidden="true" />
          )}
          {badges.launched ? 'Relanzar' : 'Lanzar'}
        </button>
      </div>
    </div>
  );
}
