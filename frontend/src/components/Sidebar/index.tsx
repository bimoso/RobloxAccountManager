import {
  NAV_PAGES,
  useNavigationStore,
  type PageId,
} from '../../stores/navigationStore';
import {
  BarChart3,
  Boxes,
  HeartHandshake,
  Radar,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Switch } from '../Switch';
import { useTranslation } from '../../i18n/useTranslation';
import type { MessageKey } from '../../i18n';

const NAV_ICONS: Record<PageId, LucideIcon> = {
  accounts: UsersRound,
  packages: Boxes,
  charts: BarChart3,
  weao: Radar,
  generator: Sparkles,
  settings: Settings2,
  logs: ScrollText,
  credits: HeartHandshake,
};

/**
 * Sidebar sections: purely presentational grouping of {@link NAV_PAGES} into
 * labelled clusters (Manage / Discover / System). The flattened page order is
 * identical to `NAV_PAGES`, so ordinal indices — and therefore the
 * `PageRouter`'s navigation direction — are unaffected.
 */
const NAV_SECTIONS: ReadonlyArray<{
  /** Stable section identifier (used as the React key). */
  readonly id: string;
  /** Message key of the small section heading shown above the group. */
  readonly labelKey: MessageKey;
  /** The pages in this section, preserving their `NAV_PAGES` relative order. */
  readonly pages: readonly PageId[];
}> = [
  { id: 'manage', labelKey: 'sidebar.sectionManage', pages: ['accounts', 'packages'] },
  // Membership here is not compiler-checked: a page missing from every section
  // simply never renders, with nothing failing to say so.
  { id: 'discover', labelKey: 'sidebar.sectionDiscover', pages: ['charts', 'weao', 'generator'] },
  { id: 'system', labelKey: 'sidebar.sectionSystem', pages: ['settings', 'logs', 'credits'] },
];

/**
 * Props for {@link Sidebar}.
 *
 * The sidebar owns page navigation (via the `navigationStore`) but only exposes
 * a *seam* for the Anti-AFK toggle — its actual wiring lives elsewhere
 * (Requirement 25). When the seam props are omitted the Anti-AFK control is not
 * rendered.
 */
export interface SidebarProps {
  /** Whether the Anti-AFK toggle is currently on. */
  antiAfkEnabled?: boolean;
  /** Called with the next Anti-AFK checked value when toggled. */
  onAntiAfkChange?: (enabled: boolean) => void;
}

/**
 * Application sidebar rendered as a floating frosted-glass dock. Renders the
 * navigation entries in {@link NAV_PAGES} order — visually clustered into the
 * {@link NAV_SECTIONS} groups — highlights the active page from the
 * `navigationStore` (gradient chip + accent bar), and routes clicks through the
 * store's `navigate` action (Requirement 4). All visible labels resolve
 * through the Language_System (`useTranslation`). Styling lives in
 * `styles/liquid-glass.css`.
 */
export function Sidebar({
  antiAfkEnabled,
  onAntiAfkChange,
}: SidebarProps): JSX.Element {
  const activePage = useNavigationStore((state) => state.activePage);
  const navigate = useNavigationStore((state) => state.navigate);
  const { t } = useTranslation();

  const showAntiAfk =
    antiAfkEnabled !== undefined && onAntiAfkChange !== undefined;

  const handleNavigate = (pageId: PageId) => {
    navigate(pageId);
  };

  return (
    <nav id="sidebar" className="ram-nav" aria-label={t('sidebar.primaryAria')}>
      <div className="ram-nav__heading" aria-hidden="true">
        <span>{t('sidebar.workspace')}</span>
        <span>{String(NAV_PAGES.length).padStart(2, '0')}</span>
      </div>

      <div className="ram-nav__links">
        {NAV_SECTIONS.map((section) => (
          <div key={section.id} className="ram-nav__section">
            <span className="ram-nav__section-label" aria-hidden="true">
              {t(section.labelKey)}
            </span>
            {section.pages.map((pageId) => {
              const page = NAV_PAGES.find((entry) => entry.id === pageId);
              if (!page) return null;
              const index = NAV_PAGES.indexOf(page);
              const isActive = page.id === activePage;
              const Icon = NAV_ICONS[page.id];
              return (
                <button
                  key={page.id}
                  type="button"
                  className={`ram-nav__item${isActive ? ' active' : ''}`}
                  aria-current={isActive ? 'page' : undefined}
                  data-order={String(index + 1).padStart(2, '0')}
                  onClick={() => handleNavigate(page.id)}
                >
                  <span aria-hidden="true" className="sr-only">{page.icon}</span>
                  <span aria-hidden="true" className="ram-nav__icon">
                    <Icon size={17} strokeWidth={1.8} />
                  </span>
                  <span className="ram-nav__label">{t(`nav.${page.id}`)}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="ram-nav__spacer" aria-hidden="true" />

      {showAntiAfk ? (
        <div className="ram-nav__afk" title={t('sidebar.antiAfkTitle')}>
            <span className="ram-nav__afk-label">
            <Zap aria-hidden="true" size={16} strokeWidth={1.9} />
            {t('sidebar.antiAfk')}
          </span>
          <Switch
            checked={antiAfkEnabled}
            onChange={onAntiAfkChange}
            aria-label={t('sidebar.antiAfk')}
          />
        </div>
      ) : null}

      <div className="ram-nav__status" aria-label={t('sidebar.statusAria')}>
        <span className="ram-nav__status-icon" aria-hidden="true">
          <ShieldCheck size={16} strokeWidth={1.9} />
        </span>
        <span>
          <strong>{t('sidebar.localControl')}</strong>
          <small>{t('sidebar.encryptedWorkspace')}</small>
        </span>
        <i aria-hidden="true" />
      </div>
    </nav>
  );
}
