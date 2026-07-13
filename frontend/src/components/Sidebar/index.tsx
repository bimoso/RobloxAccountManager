import {
  NAV_PAGES,
  useNavigationStore,
  type PageId,
} from '../../stores/navigationStore';
import {
  BarChart3,
  Boxes,
  HeartHandshake,
  ScrollText,
  Settings2,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { Switch } from '../Switch';

const NAV_ICONS: Record<PageId, LucideIcon> = {
  accounts: UsersRound,
  packages: Boxes,
  charts: BarChart3,
  generator: Sparkles,
  settings: Settings2,
  logs: ScrollText,
  credits: HeartHandshake,
};

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
 * navigation entries in {@link NAV_PAGES} order as glass icon-chip pills,
 * highlights the active page from the `navigationStore` (gradient chip + accent
 * bar), and routes clicks through the store's `navigate` action (Requirement
 * 4). Styling lives in `styles/liquid-glass.css`.
 */
export function Sidebar({
  antiAfkEnabled,
  onAntiAfkChange,
}: SidebarProps): JSX.Element {
  const activePage = useNavigationStore((state) => state.activePage);
  const navigate = useNavigationStore((state) => state.navigate);

  const showAntiAfk =
    antiAfkEnabled !== undefined && onAntiAfkChange !== undefined;

  const handleNavigate = (pageId: PageId) => {
    navigate(pageId);
  };

  return (
    <nav id="sidebar" className="ram-nav" aria-label="Primary">
      <div className="ram-nav__heading" aria-hidden="true">
        <span>Workspace</span>
        <span>{String(NAV_PAGES.length).padStart(2, '0')}</span>
      </div>

      <div className="ram-nav__links">
      {NAV_PAGES.map((page, index) => {
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
            <span className="ram-nav__label">{page.label}</span>
          </button>
        );
      })}
      </div>

      <div className="ram-nav__spacer" aria-hidden="true" />

      {showAntiAfk ? (
        <div className="ram-nav__afk" title="Keep instances past the 20-minute idle kick">
            <span className="ram-nav__afk-label">
            <Zap aria-hidden="true" size={16} strokeWidth={1.9} />
            Anti-AFK
          </span>
          <Switch checked={antiAfkEnabled} onChange={onAntiAfkChange} aria-label="Anti-AFK" />
        </div>
      ) : null}

      <div className="ram-nav__status" aria-label="Local control layer active">
        <span className="ram-nav__status-icon" aria-hidden="true">
          <ShieldCheck size={16} strokeWidth={1.9} />
        </span>
        <span>
          <strong>Local control</strong>
          <small>Encrypted workspace</small>
        </span>
        <i aria-hidden="true" />
      </div>
    </nav>
  );
}
