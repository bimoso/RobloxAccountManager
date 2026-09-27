import { motion, useReducedMotion } from 'framer-motion';
import {
  ChevronDown,
  ChevronUp,
  Copy,
  KeyRound,
  LockKeyhole,
  PencilLine,
  Play,
  RefreshCw,
  UserPen,
  UserPlus,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { displayName } from '@/lib/filters';
import { identityStyle } from '@/lib/identity';
import { useTranslation } from '@/i18n/useTranslation';
import { useToastStore } from '@/stores/toastStore';
import type { Account } from '@/types/models';
import {
  AccountAvatar,
  AccountStatusPill,
  accountNotes,
  accountStatus,
  identityLayoutId,
  IDENTITY_TRANSITION,
  lastActivity,
  relativeActivity,
} from './AccountCard';
import type { AccountCardMenuActions } from './AccountCardMenu';
import './accounts.css';

/** Props for {@link AccountInspector}. */
export interface AccountInspectorProps {
  /**
   * The account the panel is answering about, or null when the panel is open
   * but nothing is focused (the empty state). Always the live record from the
   * Account_Store, so edits land here on the next store tick.
   */
  account: Account | null;
  /** Avatar thumbnail URL for {@link account}; falls back to initials. */
  avatarUrl?: string;
  /** Close the panel. */
  onClose: () => void;
  /**
   * Focus the previous / next account in the roster's visible order. Omitted
   * at either end of the list, which disables the control.
   */
  onPrev?: () => void;
  onNext?: () => void;
  /** The page's existing per-account handlers. */
  actions?: AccountCardMenuActions;
  /**
   * How the panel is hosted: a column beside the roster (split) or a floating
   * sheet over it (overlay, when the window is too narrow to split).
   *
   * @defaultValue 'split'
   */
  mode?: 'split' | 'overlay';
}

/** One button in the panel's secondary action list. */
interface InspectorVerb {
  id: string;
  label: string;
  Icon: LucideIcon;
  run: () => void;
}

/** Best-effort clipboard write; resolves false when access is denied. */
async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard?.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The roster's detail panel: everything about one account at a size worth
 * reading — identity, status, stamps, note and every verb its menu offers —
 * with the launch button as the one prominent action.
 *
 * The panel is its own scroll port (the rk-page__body primitive), so a long
 * note never scrolls the roster and the hover rail stays inside the panel.
 */
export function AccountInspector({
  account,
  avatarUrl,
  onClose,
  onPrev,
  onNext,
  actions = {},
  mode = 'split',
}: AccountInspectorProps): JSX.Element {
  const { t, language } = useTranslation();
  const reducedMotion = useReducedMotion();
  const showSuccess = useToastStore((state) => state.showSuccess);

  const closeButton = (
    <Button
      variant="ghost"
      size="sm"
      iconOnly
      aria-label={t('inspector.close')}
      title={t('inspector.close') + ' · Esc'}
      onClick={onClose}
    >
      <X size={16} aria-hidden="true" />
    </Button>
  );

  if (account === null) {
    return (
      <aside className="rk-page__body acc-inspector" data-mode={mode} aria-label={t('inspector.aria')}>
        <div className="acc-inspector__bar">
          <span className="acc-inspector__kicker">{t('inspector.identity')}</span>
          <span className="rk-toolbar__spacer" />
          {closeButton}
        </div>
        <div className="rk-empty">
          <p className="rk-empty__title">{t('inspector.empty')}</p>
          <p className="rk-empty__text">{t('inspector.emptyHint')}</p>
        </div>
      </aside>
    );
  }

  const label = displayName(account);
  const status = accountStatus(account, t);
  const note = accountNotes(account);
  const handle = account.username ? '@' + account.username : 'UID ' + account.userId;
  const activity = relativeActivity(account.lastUsed, language, t);
  // createdAt is always written for new accounts, but legacy records predate
  // it. An em dash reads as "not recorded" in every language.
  const added = account.createdAt ? lastActivity(account.createdAt, language, t) : '—';

  const verbs: InspectorVerb[] = [];
  const push = (
    id: string,
    text: string,
    Icon: LucideIcon,
    handler: ((target: Account) => void) | undefined,
  ): void => {
    if (!handler) return;
    verbs.push({ id, label: text, Icon, run: () => handler(account) });
  };
  push('quickLogin', t('accounts.menu.quickLogin'), KeyRound, actions.onQuickLogin);
  push('reLogin', t('accounts.menu.reLogin'), RefreshCw, actions.onReLogin);
  push('friendRequest', t('accounts.menu.friendRequest'), UserPlus, actions.onFriendRequest);
  push('changeDisplayName', t('accounts.menu.changeDisplayName'), UserPen, actions.onChangeDisplayName);
  push('changePassword', t('accounts.menu.changePassword'), LockKeyhole, actions.onChangePassword);

  const launchLabel = status.launched ? t('accounts.menu.relaunch') : t('accounts.menu.launch');

  const handleCopyUid = (): void => {
    void copyText(account.userId).then((ok) => {
      if (ok) showSuccess(t('inspector.copied', { value: account.userId }));
    });
  };

  return (
    <aside
      className="rk-page__body acc-inspector"
      data-mode={mode}
      aria-label={t('inspector.aria')}
      style={identityStyle(account.userId || account.id)}
    >
      <header className="acc-inspector__hero">
        <div className="acc-inspector__banner" aria-hidden="true" />
        <div className="acc-inspector__bar">
          <span className="acc-inspector__kicker">{t('inspector.identity')}</span>
          <span className="rk-toolbar__spacer" />
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('inspector.prev')}
            title={t('inspector.prev') + ' · ↑'}
            disabled={onPrev === undefined}
            onClick={onPrev}
          >
            <ChevronUp size={16} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={t('inspector.next')}
            title={t('inspector.next') + ' · ↓'}
            disabled={onNext === undefined}
            onClick={onNext}
          >
            <ChevronDown size={16} aria-hidden="true" />
          </Button>
          {closeButton}
        </div>

        <div className="acc-inspector__identity">
          <span className="acc-identity acc-inspector__socket">
            {/* The other half of the shared element. The key makes the tile a
                new element whenever the focus moves, so stepping to the next
                account never keeps morphing the first one. */}
            <motion.span
              key={account.id}
              className="acc-identity__tile"
              layoutId={identityLayoutId(account.id)}
              transition={reducedMotion ? { duration: 0 } : IDENTITY_TRANSITION}
            >
              <AccountAvatar account={account} avatarUrl={avatarUrl} label={label} />
            </motion.span>
          </span>
          <h2 className="acc-inspector__name" title={label}>
            {label}
          </h2>
          <span className="acc-inspector__handle" title={handle}>
            {handle}
          </span>
          <AccountStatusPill status={status} />
        </div>

        <div className="acc-inspector__primary">
          {actions.onLaunch ? (
            <Button
              variant="primary"
              className="acc-inspector__launch"
              onClick={() => actions.onLaunch?.(account)}
              title={launchLabel + ' · Enter'}
            >
              {status.launched ? (
                <RefreshCw size={15} aria-hidden="true" />
              ) : (
                <Play size={14} fill="currentColor" aria-hidden="true" />
              )}
              {launchLabel}
            </Button>
          ) : null}
          {actions.onEdit ? (
            <Button variant="secondary" onClick={() => actions.onEdit?.(account)}>
              <PencilLine size={15} aria-hidden="true" />
              {t('accounts.menu.edit')}
            </Button>
          ) : null}
        </div>
      </header>

      <dl className="acc-inspector__facts">
        <div className="acc-inspector__fact">
          <dt>UID</dt>
          <dd>
            <code className="u-num" title={t('accounts.card.uidTitle', { id: account.userId })}>
              {account.userId}
            </code>
            <button
              type="button"
              className="acc-inspector__copy"
              aria-label={t('inspector.copyUid')}
              title={t('inspector.copyUid')}
              onClick={handleCopyUid}
            >
              <Copy size={13} aria-hidden="true" />
            </button>
          </dd>
        </div>
        <div className="acc-inspector__fact">
          <dt>{t('accounts.col.activity')}</dt>
          <dd title={activity.absolute}>{activity.relative}</dd>
        </div>
        <div className="acc-inspector__fact">
          <dt>{t('inspector.session')}</dt>
          <dd>
            {status.session}
            {status.instances > 0 ? (
              <span className="acc-inspector__muted u-num">
                {' · '}
                {status.label}
              </span>
            ) : null}
          </dd>
        </div>
        <div className="acc-inspector__fact">
          <dt>{t('inspector.created')}</dt>
          <dd className="u-num">{added}</dd>
        </div>
      </dl>

      <section className="acc-inspector__section" aria-label={t('inspector.note')}>
        <span className="acc-inspector__label">{t('inspector.note')}</span>
        <p className={'acc-inspector__note' + (note ? '' : ' is-empty')}>
          {note || t('inspector.noNote')}
        </p>
      </section>

      {verbs.length > 0 && (
        <section className="acc-inspector__section" aria-label={t('inspector.actions')}>
          <span className="acc-inspector__label">{t('inspector.more')}</span>
          <div className="acc-inspector__actions">
            {verbs.map(({ id, label: verbLabel, Icon, run }) => (
              <button key={id} type="button" className="acc-inspector__verb" onClick={run}>
                <Icon size={15} aria-hidden="true" />
                <span>{verbLabel}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </aside>
  );
}

export default AccountInspector;

