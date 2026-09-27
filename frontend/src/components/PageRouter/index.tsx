import {
  createElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  motion,
  useAnimationControls,
  useReducedMotion,
  type Transition,
} from 'framer-motion';
import { motionDuration, navDirection, type NavDirection } from '@/lib/animation';
import { useNavigationStore, type PageId } from '@/stores/navigationStore';
import { useTranslation } from '@/i18n/useTranslation';
import { AccountsContainer } from '@/pages/Accounts/AccountsContainer';
import { PackagesPage } from '@/pages/Packages';
import { GamesPage } from '@/pages/Games';
import ChartsPage from '@/pages/Charts';
import WeaoPage from '@/pages/Weao';
import Generator from '@/pages/Generator';
import { Settings } from '@/pages/Settings';
import { LogsPage } from '@/pages/Logs';
import { CreditsPage } from '@/pages/Credits';
import { PageActivityContext } from './pageActivity';

/**
 * Base duration (ms) of a page transition. Sits inside the 200–320ms range
 * required by Requirement 4.1. Collapsed to 0ms under reduced motion
 * (Requirement 6.2) via {@link motionDuration}.
 */
const PAGE_DURATION_MS = 240;

/**
 * The concrete page component rendered for each {@link PageId}, in the same
 * order as the sidebar. This is the single place that binds navigation ids to
 * their page implementations; callers can override any entry through
 * {@link PageRouterProps.pages} (a test/composition seam).
 */
const PAGE_COMPONENTS: Record<PageId, ComponentType> = {
  accounts: AccountsContainer,
  packages: PackagesPage,
  games: GamesPage,
  charts: ChartsPage,
  weao: WeaoPage,
  generator: Generator,
  settings: Settings,
  logs: LogsPage,
  credits: CreditsPage,
};

/** The resting pose every page settles into. */
const CENTER_POSE = { x: 0, y: 0, opacity: 1 };

/**
 * Where an incoming page starts. The previous full-viewport sweep made a
 * desktop tool feel like a slow carousel. A short directional drift keeps
 * spatial continuity without making the user's eyes cross the whole window.
 * Only transforms and opacity animate, so the compositor can keep the motion
 * responsive while the destination page paints.
 *
 * The incoming page never fades. Both layers occupy the same box during a
 * transition, so a semi-transparent arrival lets the outgoing page's headings
 * and rows read straight through it. Entering fully opaque, on top, it simply
 * slides over the page it replaces, which is both cleaner and cheaper.
 */
function enterPose(direction: NavDirection) {
  return {
    x: direction === 'from-left' ? -26 : direction === 'from-right' ? 26 : 0,
    y: 4,
    opacity: 1,
  };
}

/** Where an outgoing page drifts to while it dissolves, underneath. */
function exitPose(direction: NavDirection) {
  return {
    x: direction === 'from-left' ? 14 : direction === 'from-right' ? -14 : 0,
    y: -2,
    opacity: 0,
  };
}

/** The transition area fills the available content region and clips the small
 * directional drift so no transient scrollbars appear. */
const routerStyle: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'hidden',
};

/** Each page is absolutely positioned to fill the transition area so outgoing
 * and incoming content can crossfade without reflowing the shell.
 *
 * The opaque background is load-bearing, not decoration: both layers are
 * stacked in the same box during a transition, and with transparent backgrounds
 * you read the outgoing page's text straight through the incoming one — two
 * headings and two toolbars overlapping for the length of the animation. An
 * opaque surface makes the crossfade read as one page replacing another. */
const pageStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'auto',
  background: 'var(--canvas)',
};

/**
 * Props for {@link PageRouter}.
 */
export interface PageRouterProps {
  /**
   * Optional override of the content rendered for each page id. Any id present
   * here is rendered verbatim instead of its default page component; ids left
   * out fall back to {@link PAGE_COMPONENTS}. This is primarily a
   * test/composition seam and is not required in normal use.
   */
  pages?: Partial<Record<PageId, ReactNode>>;
}

/**
 * One kept-alive page layer.
 *
 * A layer is mounted the first time its page is visited and never unmounted
 * again: leaving a page only animates it out and parks it with
 * `visibility: hidden` (which keeps its scroll position, unlike
 * `display: none`), so coming back restores exactly what the user left. While
 * parked the layer is inert and `aria-hidden`, so a hidden page can neither
 * receive a ghost click nor retain keyboard focus, and it tells its content it
 * is inactive through {@link PageActivityContext}.
 */
function PageLayer({
  active,
  direction,
  content,
  transition,
  pageLabel,
}: {
  /** Whether this layer's page is the one on screen. */
  active: boolean;
  /** Direction of the navigation that changed `active` (`'none'` at mount). */
  direction: NavDirection;
  /** Concrete page content rendered inside the layer. */
  content: ReactNode;
  /** Motion transition shared with the router. */
  transition: Transition;
  /** Human-readable page label. */
  pageLabel: string;
}): JSX.Element {
  const controls = useAnimationControls();
  const layerRef = useRef<HTMLDivElement>(null);
  // Parked layers keep their box (and scroll offset) but are not painted.
  const [parked, setParked] = useState(!active);
  const activeRef = useRef(active);
  activeRef.current = active;
  const animatedOnceRef = useRef(false);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (active) layer.removeAttribute('inert');
    else layer.setAttribute('inert', '');
  }, [active]);

  // Before paint: an arriving page is posed at its entry offset and slid to
  // rest; a leaving page drifts out and is parked once the drift finishes.
  useLayoutEffect(() => {
    if (active) {
      setParked(false);
      const firstShow = !animatedOnceRef.current;
      animatedOnceRef.current = true;
      if (firstShow && direction === 'none') {
        controls.set(CENTER_POSE);
        return;
      }
      controls.set(enterPose(direction));
      void controls.start(CENTER_POSE, transition);
      return;
    }
    animatedOnceRef.current = true;
    void controls.start(exitPose(direction), transition).then(() => {
      // The page may have been re-activated mid-exit; never park it then.
      if (!activeRef.current) setParked(true);
    });
    // Only an activity change starts a transition; `direction` and
    // `transition` describe that same navigation and must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(() => {
    if (!active || direction === 'none') return;
    const frame = window.requestAnimationFrame(() => {
      layerRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
    // Focus follows a genuine navigation into this page, not later re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <PageActivityContext.Provider value={active}>
      <motion.div
        ref={layerRef}
        style={{
          ...pageStyle,
          visibility: parked ? 'hidden' : 'visible',
          pointerEvents: active ? 'auto' : 'none',
          zIndex: active ? 1 : 0,
          outline: 'none',
        }}
        initial={false}
        animate={controls}
        role="main"
        aria-label={pageLabel}
        aria-hidden={active ? undefined : true}
        data-page-active={active ? 'true' : 'false'}
        tabIndex={-1}
      >
        {content}
      </motion.div>
    </PageActivityContext.Provider>
  );
}

/**
 * Renders the navigation pages and animates transitions between them.
 *
 * Pages are kept alive: the first visit mounts a page's layer and later
 * navigations only toggle which layer is active, so a page's scroll position,
 * filters, selection and in-flight work all survive a round trip. Pages never
 * visited are never mounted, so startup cost does not grow with the sidebar.
 *
 * The active page and its 1-based ordinal index come from the
 * `navigationStore`. The previous ordinal is retained across renders in a ref
 * so the transition direction can be computed with the pure
 * {@link navDirection} without the store having to track history: on the render
 * where the active page changes, the ref still holds the previous ordinal, and
 * an effect advances it afterwards.
 *
 * Navigating again mid-transition does not queue: the outgoing layer keeps
 * drifting out from its current pose while the new layer arrives, and a layer
 * re-activated before its exit finished is simply slid back in (Requirement
 * 4.6). Every transition animates only transform and opacity over a short
 * spring, collapsing to 0ms when the user prefers reduced motion so the
 * destination appears immediately (Requirement 6.2).
 */
export function PageRouter({ pages }: PageRouterProps): JSX.Element {
  const activePage = useNavigationStore((state) => state.activePage);
  const activeIndex = useNavigationStore((state) => state.activeIndex);
  const { t } = useTranslation();

  // Retain the previous ordinal across renders. On the render where the page
  // changes this still holds the prior index, so `navDirection` sees the real
  // (from, to) pair; the effect below advances it for the next navigation.
  const previousIndexRef = useRef(activeIndex);
  const direction = navDirection(previousIndexRef.current, activeIndex);
  useEffect(() => {
    previousIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Every page visited so far, in first-visit order. Appended during render so
  // the destination paints in the same commit as the navigation; the list is
  // append-only, which keeps this write idempotent across re-renders.
  const visitedRef = useRef<PageId[]>([activePage]);
  if (!visitedRef.current.includes(activePage)) {
    visitedRef.current = [...visitedRef.current, activePage];
  }
  const visited = visitedRef.current;

  const reducedMotion = useReducedMotion() ?? false;
  const duration = motionDuration(PAGE_DURATION_MS, reducedMotion) / 1000;
  const transition: Transition = reducedMotion
    ? { duration: 0 }
    : {
        x: { type: 'spring', stiffness: 430, damping: 38, mass: 0.72 },
        y: { type: 'spring', stiffness: 430, damping: 40, mass: 0.72 },
        opacity: { duration: Math.min(duration, 0.16), ease: [0.2, 0, 0, 1] },
      };

  return (
    <div style={routerStyle}>
      {visited.map((pageId) => (
        <PageLayer
          key={pageId}
          active={pageId === activePage}
          direction={direction}
          content={pages?.[pageId] ?? createElement(PAGE_COMPONENTS[pageId])}
          transition={transition}
          pageLabel={t('router.pageAria', { page: t(`nav.${pageId}`) })}
        />
      ))}
    </div>
  );
}

export default PageRouter;

