import { motion, useReducedMotion } from 'framer-motion';
import {
  BarChart3,
  Boxes,
  Gamepad2,
  HeartHandshake,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { NAV_PAGES, useNavigationStore, type PageId } from '../../stores/navigationStore';
import { useAccountStore } from '../../stores/accountStore';
import { useEncryptionGateStore } from '../../stores/encryptionGateStore';
import { useShellStore } from '../../stores/shellStore';
import { Switch } from '../Switch';
import { useTranslation } from '../../i18n/useTranslation';
import type { MessageKey } from '../../i18n';
import './Sidebar.css';

const NAV_ICONS: Record<PageId, LucideIcon> = {
  accounts: UsersRound,
  packages: Boxes,
  games: Gamepad2,
  charts: BarChart3,
  weao: Radar,
  generator: Sparkles,
  settings: Settings2,
  logs: ScrollText,
  credits: HeartHandshake,
};

/**
 * Sidebar sections: presentational grouping of {@link NAV_PAGES}. The flattened
 * order is identical to NAV_PAGES, so ordinal indices — and therefore the
 * PageRouter's navigation direction and the Ctrl+<n> shortcuts — are unchanged.
 */
const NAV_SECTIONS: ReadonlyArray<{
  /** Stable section identifier (used as the React key). */
  readonly id: string;
  /** Message key of the small section heading shown above the group. */
  readonly labelKey: MessageKey;
  /** The pages in this section, preserving their NAV_PAGES relative order. */
  readonly pages: readonly PageId[];
}> = [
  { id: 'manage', labelKey: 'sidebar.sectionManage', pages: ['accounts', 'packages', 'games'] },
  { id: 'discover', labelKey: 'sidebar.sectionDiscover', pages: ['charts', 'weao', 'generator'] },
  { id: 'system', labelKey: 'sidebar.sectionSystem', pages: ['settings', 'logs', 'credits'] },
];

/**
 * Props for {@link Sidebar}. The Anti-AFK toggle is only a seam here — its
 * wiring lives elsewhere — and is not rendered when the props are omitted.
 */
export interface SidebarProps {
  /** Whether the Anti-AFK toggle is currently on. */
  antiAfkEnabled?: boolean;
  /** Called with the next Anti-AFK checked value when toggled. */
  onAntiAfkChange?: (enabled: boolean) => void;
}

/**
 * The navigation rail.
 *
 * The active page is marked by one pill that slides between entries
 * (framer-motion layoutId), so moving between pages reads as the same marker
 * travelling rather than one highlight blinking off and another on. The rail
 * collapses to icons (Ctrl+B or the footer button); labels stay in the DOM for
 * assistive technology and surface as tooltips while collapsed.
 *
 * The footer answers "is my vault safe, and what is running?" from the real
 * Encryption_Gate mode and the Account_Store, on every page.
 */
export function Sidebar({ antiAfkEnabled, onAntiAfkChange }: SidebarProps): JSX.Element {
  const activePage = useNavigationStore((state) => state.activePage);
  const navigate = useNavigationStore((state) => state.navigate);
  const collapsed = useShellStore((state) => state.railCollapsed);
  const toggleRail = useShellStore((state) => state.toggleRail);
  const accounts = useAccountStore((state) => state.accounts);
  const mode = useEncryptionGateStore((state) => state.mode);
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();

  const showAntiAfk = antiAfkEnabled !== undefined && onAntiAfkChange !== undefined;

  const total = accounts.length;
  const live = accounts.filter((account) => (account.launchedInstanceCount ?? 0) > 0).length;
  const expired = accounts.filter((account) => account.cookieExpired === true).length;

  // "bypassed" means enc_status itself failed: the app is usable but the
  // stored cookies are not behind a verified key, so it gets its own verdict.
  const vault: 'encrypted' | 'unverified' | 'locked' =
    mode === 'unlocked' ? 'encrypted' : mode === 'bypassed' ? 'unverified' : 'locked';
  const vaultLabel =
    vault === 'encrypted'
      ? t('sidebar.vaultEncrypted')
      : vault === 'unverified'
        ? t('sidebar.vaultUnverified')
        : t('sidebar.vaultLocked');
  const census = [
    total + ' ' + t('status.accounts'),
    live + ' ' + t('status.live'),
    ...(expired > 0 ? [expired + ' ' + t('status.expired')] : []),
  ].join(' · ');
  const VaultIcon = vault === 'encrypted' ? ShieldCheck : ShieldAlert;

  return (
    <nav
      id="sidebar"
      className="ram-nav"
      data-collapsed={collapsed ? 'true' : undefined}
      aria-label={t('sidebar.primaryAria')}
    >
      <div className="ram-nav__links">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="ram-nav__section">
            <span className="ram-nav__section-label" aria-hidden="true">
              <span>{t(section.labelKey)}</span>
            </span>
            {section.pages.map((pageId) => {
              const page = NAV_PAGES.find((entry) => entry.id === pageId);
              if (!page) return null;
              const index = NAV_PAGES.indexOf(page);
              const isActive = page.id === activePage;
              const Icon = NAV_ICONS[page.id];
              const label = t(('nav.' + page.id) as MessageKey);
              const shortcut = index < 8 ? 'Ctrl+' + (index + 1) : null;
              const badge = page.id === 'accounts' && live > 0 ? live : null;
              return (
                <button
                  key={page.id}
                  type="button"
                  className={'ram-nav__item' + (isActive ? ' active' : '')}
                  aria-current={isActive ? 'page' : undefined}
                  aria-keyshortcuts={shortcut ? shortcut.replace('Ctrl', 'Control') : undefined}
                  title={shortcut ? label + ' · ' + shortcut : label}
                  onClick={() => navigate(page.id)}
                >
                  {isActive ? (
                    <motion.span
                      className="ram-nav__pill"
                      layoutId="ram-nav-active"
                      aria-hidden="true"
                      transition={
                        reducedMotion
                          ? { duration: 0 }
                          : { type: 'spring', stiffness: 520, damping: 42, mass: 0.7 }
                      }
                    />
                  ) : null}
                  <span aria-hidden="true" className="ram-nav__icon">
                    <Icon size={18} strokeWidth={1.9} />
                  </span>
                  <span className="ram-nav__label">{label}</span>
                  {badge !== null ? (
                    <span
                      className="ram-nav__badge u-num"
                      title={t('sidebar.liveBadge', { count: badge })}
                    >
                      {badge}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {showAntiAfk ? (
        <div className="ram-nav__afk" title={t('sidebar.antiAfkTitle')}>
          <span className="ram-nav__afk-label">
            <Zap aria-hidden="true" size={16} strokeWidth={1.9} />
            <span className="ram-nav__label">{t('sidebar.antiAfk')}</span>
          </span>
          <Switch
            checked={antiAfkEnabled}
            onChange={onAntiAfkChange}
            aria-label={t('sidebar.antiAfk')}
          />
        </div>
      ) : null}

      <div className="ram-nav__footer">
        <div
          className="ram-nav__vault"
          data-state={vault}
          aria-label={t('sidebar.statusAria')}
          title={vaultLabel + ' — ' + census}
        >
          <span className="ram-nav__vault-icon" aria-hidden="true">
            <VaultIcon size={16} strokeWidth={2} />
          </span>
          <span className="ram-nav__vault-text">
            <strong>{vaultLabel}</strong>
            <small className="u-num">{census}</small>
          </span>
        </div>
        <button
          type="button"
          className="ram-nav__collapse"
          onClick={toggleRail}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          aria-keyshortcuts="Control+B"
          aria-expanded={!collapsed}
          title={(collapsed ? t('sidebar.expand') : t('sidebar.collapse')) + ' · Ctrl+B'}
        >
          {collapsed ? (
            <PanelLeftOpen size={17} strokeWidth={1.9} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={17} strokeWidth={1.9} aria-hidden="true" />
          )}
          <span className="ram-nav__label">{t('sidebar.collapse')}</span>
        </button>
      </div>
    </nav>
  );
}
