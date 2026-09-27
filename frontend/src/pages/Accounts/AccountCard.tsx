import { useMemo, useState, type MouseEventHandler } from 'react';
import { motion, useReducedMotion, type Transition } from 'framer-motion';
import { Check, MoreHorizontal, Play, RefreshCw, StickyNote } from 'lucide-react';
import { Button } from '@/components/Button';
import { accountBadges, displayName } from '@/lib/filters';
import { identityStyle } from '../../lib/identity';
import { useTranslation } from '@/i18n/useTranslation';
import type { Language, Translator } from '@/i18n';
import type { Account, PresenceType } from '@/types/models';
import { selectPresence, usePresenceStore } from '@/stores/presenceStore';
import { useInspectorStore } from '@/stores/inspectorStore';
import './accounts.css';

/**
 * Props shared by the two account presentations: the roster row
 * ({@link AccountRow}, the default view) and the profile card
 * ({@link AccountCard}, behind the view toggle) — Requirement 8.1, 8.5, 8.7.
 */
export interface AccountCardProps {
  /** The account to render. */
  account: Account;
  /** Avatar thumbnail URL; falls back to initials when missing or on error. */
  avatarUrl?: string;
  /** Whether the entry is part of the current multi-selection. */
  selected?: boolean;
  /**
   * Invoked when the user toggles this entry's selection. When provided the
   * entry is in selection mode: a checkbox appears and clicking the entry
   * toggles it.
   */
  onSelectToggle?: () => void;
  /** Invoked when the user activates the entry outside of selection mode. */
  onClick?: MouseEventHandler<HTMLDivElement>;
  /** Native context-menu (right-click) gesture over the entry. */
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  /** Activate the accessible "more actions" button. */
  onOpenMenu?: () => void;
  /** Launch/relaunch this account. */
  onLaunch?: () => void;
  /**
   * Whether this presentation owns the account's shared identity tile — the
   * element the inspector's large avatar flies out of. A layoutId may only be
   * carried by one mounted element, so the floating drag clone passes false.
   *
   * @defaultValue true
   */
  sharedIdentity?: boolean;
}

/**
 * The shared-element id tying an account's row tile to the inspector's large
 * avatar. Exported so both sides derive the exact same string.
 *
 * @param accountId - The account's stable id.
 */
export function identityLayoutId(accountId: string): string {
  return 'acc-identity-' + accountId;
}

/**
 * The spring the identity tile flies on: stiff and damped, so it carries the
 * eye from the row that was clicked to the panel that answers it.
 */
export const IDENTITY_TRANSITION: Transition = {
  type: 'spring',
  stiffness: 620,
  damping: 42,
  mass: 0.5,
};

/** Read the free-form notes attached to an account (legacy note fallback). */
export function accountNotes(account: Account): string {
  const raw = (account.notes ?? account.note ?? '') as unknown;
  return String(raw).replace(/\s+/g, ' ').trim();
}

/** Initials fallback for the avatar when no thumbnail is available. */
function initials(label: string): string {
  const trimmed = label.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

/** Presence tone per Roblox userPresenceType (0 offline … 3 studio). */
const PRESENCE_TONE: Record<PresenceType, string> = {
  0: 'offline',
  1: 'online',
  2: 'in-game',
  3: 'in-studio',
};

/** Tooltip key per Roblox userPresenceType. */
const PRESENCE_LABEL: Record<PresenceType, Parameters<Translator>[0]> = {
  0: 'presence.offline',
  1: 'presence.online',
  2: 'presence.inGame',
  3: 'presence.inStudio',
};

/**
 * The single status axis for an account. One derivation feeds the status pill
 * in every presentation, and the pill always carries words, so the state is
 * never colour-only.
 */
export type AccountTone = 'neutral' | 'ok' | 'warn' | 'danger';

/** Everything the presentations need to describe an account's state. */
export interface AccountStatusInfo {
  /** Tone of the status pill. */
  tone: AccountTone;
  /** Language-neutral code (RDY / LIVE / EXP / MOD), kept for data hooks. */
  code: string;
  /** Short, translated pill text ("Running", "Cookie expired", …). */
  short: string;
  /** Translated long form used as the pill's tooltip + a11y text. */
  label: string;
  /** Running Roblox instances for this account (0 when idle). */
  instances: number;
  /** Translated session availability sentence. */
  session: string;
  /** Whether the account currently has a launched instance. */
  launched: boolean;
}

/**
 * Derive the one status an account is in, most severe first: a moderated
 * account outranks an expired cookie, which outranks a live session.
 */
export function accountStatus(account: Account, t: Translator): AccountStatusInfo {
  const badges = accountBadges(account);
  const instances = badges.launched
    ? Math.max(1, Number(account.launchedInstanceCount ?? 1))
    : 0;
  const session = badges.launched
    ? t('accounts.card.inProgress')
    : badges.expired
      ? t('accounts.card.needsAccess')
      : t('accounts.card.available');

  if (account.moderated === true) {
    return {
      tone: 'danger',
      code: 'MOD',
      short: t('accounts.status.moderated'),
      label: t('accounts.add.moderatedAria'),
      instances,
      session,
      launched: badges.launched,
    };
  }
  if (badges.expired) {
    return {
      tone: 'warn',
      code: 'EXP',
      short: t('accounts.status.expired'),
      label: t('accounts.card.expired'),
      instances,
      session,
      launched: badges.launched,
    };
  }
  if (badges.launched) {
    return {
      tone: 'ok',
      code: 'LIVE',
      short:
        instances > 1
          ? t('accounts.status.runningMany', { count: instances })
          : t('accounts.status.running'),
      label:
        instances === 1
          ? t('accounts.card.activeOne')
          : t('accounts.card.activeMany', { count: instances }),
      instances,
      session,
      launched: true,
    };
  }
  return {
    tone: 'neutral',
    code: 'RDY',
    short: t('accounts.status.ready'),
    label: t('accounts.card.ready'),
    instances,
    session,
    launched: false,
  };
}

/** Compact, locale-aware absolute timestamp for the operational metadata. */
export function lastActivity(
  value: string | null,
  language: Language,
  t: Translator,
): string {
  if (!value) return t('accounts.card.noActivity');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return t('accounts.card.recentActivity');
  return new Intl.DateTimeFormat(language === 'es' ? 'es-MX' : 'en-US', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
}

/**
 * Relative activity ("3 days ago") plus the absolute stamp for its tooltip.
 * People think about accounts in "how long ago", but still need the exact
 * time one hover away.
 */
export function relativeActivity(
  value: string | null,
  language: Language,
  t: Translator,
  now: number = Date.now(),
): { relative: string; absolute: string } {
  if (!value) {
    const none = t('accounts.card.noActivity');
    return { relative: none, absolute: none };
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const recent = t('accounts.card.recentActivity');
    return { relative: recent, absolute: recent };
  }
  const locale = language === 'es' ? 'es-MX' : 'en-US';
  const absolute = new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(parsed);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = (parsed.getTime() - now) / 1000;
  const magnitude = Math.abs(seconds);
  let relative: string;
  if (magnitude < 45) relative = format.format(0, 'second');
  else if (magnitude < 3600) relative = format.format(Math.round(seconds / 60), 'minute');
  else if (magnitude < 86_400) relative = format.format(Math.round(seconds / 3600), 'hour');
  else if (magnitude < 86_400 * 30) relative = format.format(Math.round(seconds / 86_400), 'day');
  else if (magnitude < 86_400 * 365)
    relative = format.format(Math.round(seconds / (86_400 * 30)), 'month');
  else relative = format.format(Math.round(seconds / (86_400 * 365)), 'year');
  return { relative, absolute };
}

/**
 * Avatar plate with an initials fallback and the presence dot. Shared by every
 * presentation so the leaf-level presence subscription (Requirement 26.2)
 * exists exactly once.
 */
export function AccountAvatar({
  account,
  avatarUrl,
  label,
}: {
  account: Account;
  avatarUrl?: string;
  label: string;
}): JSX.Element {
  const [avatarFailed, setAvatarFailed] = useState(false);
  const { t } = useTranslation();
  const presence = usePresenceStore(selectPresence(account.userId));
  const showAvatar = Boolean(avatarUrl) && !avatarFailed;

  return (
    <span className="acc-avatar" aria-hidden={showAvatar ? undefined : 'true'}>
      {showAvatar ? (
        <img
          src={avatarUrl}
          alt={t('accounts.card.avatarAlt', { name: label })}
          onError={() => setAvatarFailed(true)}
        />
      ) : (
        <span className="acc-avatar__initial">{initials(label)}</span>
      )}
      {presence && (
        <span
          className="acc-avatar__presence"
          data-presence={PRESENCE_TONE[presence.type]}
          title={t(PRESENCE_LABEL[presence.type])}
        />
      )}
    </span>
  );
}

/**
 * The account's identity tile: the avatar in a fixed-size socket. The socket
 * holds the row's box while the avatar itself is free to fly into (and back
 * out of) the inspector on one shared layoutId.
 *
 * @param shared - Whether this tile carries the account's layoutId. Exactly
 *   one mounted element may, so the drag clone passes false.
 */
export function AccountIdentity({
  account,
  avatarUrl,
  label,
  shared = true,
}: {
  account: Account;
  avatarUrl?: string;
  label: string;
  shared?: boolean;
}): JSX.Element {
  const reducedMotion = useReducedMotion();
  const avatar = <AccountAvatar account={account} avatarUrl={avatarUrl} label={label} />;

  if (!shared) {
    return <span className="acc-identity">{avatar}</span>;
  }

  return (
    <span className="acc-identity">
      <motion.span
        className="acc-identity__tile"
        layoutId={identityLayoutId(account.id)}
        transition={reducedMotion ? { duration: 0 } : IDENTITY_TRANSITION}
      >
        {avatar}
      </motion.span>
    </span>
  );
}

/** The selection checkbox shown while the roster is in selection mode. */
function SelectionCheck({
  selected,
  onSelectToggle,
}: {
  selected: boolean;
  onSelectToggle?: () => void;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="acc-check"
      role="checkbox"
      aria-checked={selected}
      aria-label={selected ? t('accounts.card.deselect') : t('accounts.card.select')}
      onClick={(event) => {
        event.stopPropagation();
        onSelectToggle?.();
      }}
    >
      <Check size={12} strokeWidth={3.2} aria-hidden="true" />
    </button>
  );
}

/** The status pill: a dot plus words, in the account's single tone. */
export function AccountStatusPill({
  status,
  className,
}: {
  status: AccountStatusInfo;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={['acc-status', className].filter(Boolean).join(' ')}
      data-tone={status.tone}
      title={status.label}
    >
      <span
        className="acc-status__dot"
        data-live={status.launched ? 'true' : undefined}
        aria-hidden="true"
      />
      <span className="acc-status__text">{status.short}</span>
    </span>
  );
}

/** The launch control, shared by the row, the card and the inspector. */
function LaunchButton({
  launched,
  label,
  onLaunch,
  size = 'sm',
  className,
}: {
  launched: boolean;
  label: string;
  onLaunch?: () => void;
  size?: 'sm' | 'md';
  className?: string;
}): JSX.Element {
  return (
    <Button
      variant="secondary"
      size={size}
      className={['acc-launch', className].filter(Boolean).join(' ')}
      data-launched={launched ? 'true' : undefined}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onLaunch?.();
      }}
    >
      {launched ? (
        <RefreshCw size={14} aria-hidden="true" />
      ) : (
        <Play size={13} fill="currentColor" aria-hidden="true" />
      )}
      <span className="acc-launch__label">{label}</span>
    </Button>
  );
}

/**
 * The roster row — the page's default presentation.
 *
 * Identity (avatar, display name, handle and note), the status pill, the
 * relative last activity and the actions: an always-visible launch button and
 * the "more" menu. Entering selection mode slides a checkbox in front of the
 * avatar; the status stays on screen.
 */
export function AccountRow({
  account,
  avatarUrl,
  selected = false,
  onSelectToggle,
  onClick,
  onContextMenu,
  onOpenMenu,
  onLaunch,
  sharedIdentity = true,
}: AccountCardProps): JSX.Element {
  const { t, language } = useTranslation();
  const inspected = useInspectorStore(
    (state) => state.open && state.focusedAccountId === account.id,
  );

  const label = displayName(account);
  const status = accountStatus(account, t);
  const note = accountNotes(account);
  const selectionMode = onSelectToggle !== undefined;
  const activity = useMemo(
    () => relativeActivity(account.lastUsed, language, t),
    [account.lastUsed, language, t],
  );
  const accountHandle = account.username ? '@' + account.username : 'UID ' + account.userId;
  const launchLabel = status.launched ? t('accounts.card.relaunch') : t('accounts.card.launch');

  const handleClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (selectionMode) {
      onSelectToggle?.();
      return;
    }
    onClick?.(event);
  };

  return (
    <div
      className="rk-row acc-row"
      style={identityStyle(account.userId || account.id)}
      data-tone={status.tone}
      data-selected={selected ? 'true' : undefined}
      data-inspected={inspected ? 'true' : undefined}
      onClick={handleClick}
      onContextMenu={onContextMenu}
    >
      <div className="acc-row__identity">
        {selectionMode ? (
          <SelectionCheck selected={selected} onSelectToggle={onSelectToggle} />
        ) : null}
        <AccountIdentity
          account={account}
          avatarUrl={avatarUrl}
          label={label}
          shared={sharedIdentity}
        />
        <div className="acc-row__names">
          <h3 className="acc-row__name" title={label}>
            {label}
          </h3>
          <span className="acc-row__sub">
            <span className="acc-row__handle" title={accountHandle}>
              {accountHandle}
            </span>
            {note ? (
              <span className="acc-row__note" title={note}>
                <StickyNote size={11} aria-hidden="true" />
                <span>{note}</span>
              </span>
            ) : null}
          </span>
        </div>
      </div>

      <AccountStatusPill status={status} />

      <span
        className="acc-row__activity"
        title={t('accounts.card.lastActivityTitle', { value: activity.absolute })}
      >
        {activity.relative}
      </span>

      <div className="acc-row__actions">
        <LaunchButton launched={status.launched} label={launchLabel} onLaunch={onLaunch} />
        {onOpenMenu && (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            className="acc-row__more"
            aria-label={t('accounts.card.moreActions')}
            title={t('accounts.card.moreActions')}
            onClick={(event) => {
              event.stopPropagation();
              onOpenMenu();
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The profile card, behind the page's view toggle: an identity-tinted banner,
 * a large avatar, the same status pill as the row and a full-width launch.
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
  sharedIdentity = true,
}: AccountCardProps): JSX.Element {
  const { t, language } = useTranslation();
  const inspected = useInspectorStore(
    (state) => state.open && state.focusedAccountId === account.id,
  );

  const label = displayName(account);
  const status = accountStatus(account, t);
  const note = accountNotes(account);
  const selectionMode = onSelectToggle !== undefined;
  const activity = useMemo(
    () => relativeActivity(account.lastUsed, language, t),
    [account.lastUsed, language, t],
  );
  const accountHandle = account.username ? '@' + account.username : 'UID ' + account.userId;
  const launchLabel = status.launched ? t('accounts.card.relaunch') : t('accounts.card.launch');

  const handleCardClick: MouseEventHandler<HTMLDivElement> = (event) => {
    if (selectionMode) {
      onSelectToggle?.();
      return;
    }
    onClick?.(event);
  };

  return (
    <div
      className="acc-card"
      style={identityStyle(account.userId || account.id)}
      data-tone={status.tone}
      data-selected={selected ? 'true' : undefined}
      data-inspected={inspected ? 'true' : undefined}
      onClick={handleCardClick}
      onContextMenu={onContextMenu}
    >
      <div className="acc-card__banner" aria-hidden="true" />
      <div className="acc-card__top">
        {selectionMode ? (
          <SelectionCheck selected={selected} onSelectToggle={onSelectToggle} />
        ) : null}
        <AccountStatusPill status={status} className="acc-card__status" />
        {onOpenMenu && (
          <Button
            className="acc-card__menu"
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('accounts.card.moreActions')}
            title={t('accounts.card.moreActions')}
            onClick={(event) => {
              event.stopPropagation();
              onOpenMenu();
            }}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </Button>
        )}
      </div>

      <div className="acc-card__identity">
        <AccountIdentity
          account={account}
          avatarUrl={avatarUrl}
          label={label}
          shared={sharedIdentity}
        />
        <h3 className="acc-card__name" title={label}>
          {label}
        </h3>
        <p className="acc-card__handle" title={accountHandle}>
          {accountHandle}
        </p>
      </div>

      <dl className="acc-card__facts" aria-label={t('accounts.card.metaAria')}>
        <div title={t('accounts.card.lastActivityTitle', { value: activity.absolute })}>
          <dt>{t('accounts.col.activity')}</dt>
          <dd>{activity.relative}</dd>
        </div>
        <div title={t('accounts.card.uidTitle', { id: account.userId })}>
          <dt>UID</dt>
          <dd className="u-num">{account.userId}</dd>
        </div>
      </dl>

      {note ? (
        <p className="acc-card__note" title={note}>
          <StickyNote size={12} aria-hidden="true" />
          <span>{note}</span>
        </p>
      ) : null}

      <LaunchButton
        launched={status.launched}
        label={launchLabel}
        onLaunch={onLaunch}
        size="md"
        className="acc-card__launch"
      />
    </div>
  );
}
