import {
  createElement,
  useEffect,
  useRef,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from 'react';
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type Transition,
} from 'framer-motion';
import { motionDuration, navDirection, type NavDirection } from '@/lib/animation';
import { useNavigationStore, type PageId } from '@/stores/navigationStore';
import { useTranslation } from '@/i18n/useTranslation';
import { AccountsContainer } from '@/pages/Accounts/AccountsContainer';
import { PackagesPage } from '@/pages/Packages';
import ChartsPage from '@/pages/Charts';
import Generator from '@/pages/Generator';
import { Settings } from '@/pages/Settings';
import { LogsPage } from '@/pages/Logs';
import { CreditsPage } from '@/pages/Credits';

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
  charts: ChartsPage,
  generator: Generator,
  settings: Settings,
  logs: LogsPage,
  credits: CreditsPage,
};

/**
 * Motion variants for a page transition. The previous full-viewport sweep made
 * a desktop tool feel like a slow carousel. A short directional drift keeps
 * spatial continuity without making the user's eyes cross the whole window.
 * Only transforms and opacity animate, so the compositor can keep the motion
 * responsive while the destination page mounts.
 *
 * Direction (from {@link navDirection}) decides which side the incoming page
 * enters from and, symmetrically, which side the outgoing page leaves toward:
 * - `'from-left'` (forward) enters from a small negative offset.
 * - `'from-right'` (backward) enters from a small positive offset.
 */
const pageVariants = {
  enter: (direction: NavDirection) => ({
    x: direction === 'from-left' ? -26 : direction === 'from-right' ? 26 : 0,
    y: 4,
    opacity: 0,
  }),
  center: {
    x: 0,
    y: 0,
    opacity: 1,
  },
  exit: (direction: NavDirection) => ({
    x: direction === 'from-left' ? 14 : direction === 'from-right' ? -14 : 0,
    y: -2,
    opacity: 0,
  }),
};

/** The transition area fills the available content region and clips the small
 * directional drift so no transient scrollbars appear. */
const routerStyle: CSSProperties = {
  position: 'relative',
  flex: '1 1 auto',
  minHeight: 0,
  overflow: 'hidden',
};

/** Each page is absolutely positioned to fill the transition area so outgoing
 * and incoming content can crossfade without reflowing the shell. */
const pageStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'auto',
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
 * One presence-aware page layer. Exiting content becomes inert immediately so
 * a fading page cannot receive a ghost click or retain keyboard focus.
 */
function TransitionPage({
  content,
  transition,
  shouldFocus,
  pageLabel,
}: {
  /** Concrete page content rendered inside the animated layer. */
  content: ReactNode;
  /** Motion transition shared with the router. */
  transition: Transition;
  /** Moves focus into the destination after a genuine navigation. */
  shouldFocus: boolean;
  /** Human-readable active-page label. */
  pageLabel: string;
}): JSX.Element {
  const isPresent = useIsPresent();
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    if (isPresent) layer.removeAttribute('inert');
    else layer.setAttribute('inert', '');
  }, [isPresent]);

  useEffect(() => {
    if (!isPresent || !shouldFocus) return;
    const frame = window.requestAnimationFrame(() => {
      layerRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [isPresent, shouldFocus]);

  return (
    <motion.div
      ref={layerRef}
      style={{ ...pageStyle, pointerEvents: isPresent ? 'auto' : 'none', outline: 'none' }}
      variants={pageVariants}
      initial="enter"
      animate="center"
      exit="exit"
      transition={transition}
      role="main"
      aria-label={pageLabel}
      aria-hidden={isPresent ? undefined : true}
      tabIndex={-1}
    >
      {content}
    </motion.div>
  );
}

/**
 * Renders the active navigation page and animates transitions between pages.
 *
 * The active page and its 1-based ordinal index come from the
 * `navigationStore`. The previous ordinal is retained across renders in a ref
 * so the transition direction can be computed with the pure
 * {@link navDirection} without the store having to track history: on the render
 * where the active page changes, the ref still holds the previous ordinal, and
 * an effect advances it afterwards.
 *
 * Transitions run through framer-motion's `AnimatePresence` in its default
 * (synchronous) mode, so navigating again mid-transition does not queue behind
 * the in-flight one — the outgoing page keeps animating out from its current
 * position while the new page animates in, and `AnimatePresence` removes each
 * page from the DOM only once its exit completes, never leaving a page stuck
 * (Requirement 4.6). `initial={false}` suppresses any animation on the very
 * first mount so only genuine navigations animate.
 *
 * Every transition animates only transform and opacity over a short spring,
 * collapsing to 0ms when the user prefers reduced motion so the destination
 * appears immediately (Requirement 6.2).
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

  const reducedMotion = useReducedMotion() ?? false;
  const duration = motionDuration(PAGE_DURATION_MS, reducedMotion) / 1000;
  const transition: Transition = reducedMotion
    ? { duration: 0 }
    : {
        x: { type: 'spring', stiffness: 430, damping: 38, mass: 0.72 },
        y: { type: 'spring', stiffness: 430, damping: 40, mass: 0.72 },
        opacity: { duration: Math.min(duration, 0.16), ease: [0.2, 0, 0, 1] },
      };

  const content =
    pages?.[activePage] ?? createElement(PAGE_COMPONENTS[activePage]);
  const pageLabel = t('router.pageAria', { page: t(`nav.${activePage}`) });

  return (
    <div style={routerStyle}>
      {/*
        `mode` is left at its default ("sync"): the outgoing page keeps
        animating while the incoming one enters, which is what makes an
        interrupted navigation resume from the current position (Requirement
        4.6). `custom` feeds the current direction to the exit variant of the
        page currently leaving.
      */}
      <AnimatePresence initial={false} custom={direction}>
        <TransitionPage
          key={activePage}
          content={content}
          transition={transition}
          shouldFocus={direction !== 'none'}
          pageLabel={pageLabel}
        />
      </AnimatePresence>
    </div>
  );
}

export default PageRouter;
