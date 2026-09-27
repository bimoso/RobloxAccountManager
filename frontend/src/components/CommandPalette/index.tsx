/**
 * CommandPalette — one keystroke to everything in the app.
 *
 * The app already bound `/`, `Ctrl+A`, `Enter`, `Delete` and `Ctrl+1..8` on day
 * one and surfaced none of them. Meanwhile reaching an account meant: find the
 * page, find the row, open a menu. This is the single entry point that collapses
 * all of it — pages, accounts, themes and app-level actions in one list, filtered
 * by an in-order subsequence match so "gnr" finds Generator.
 *
 * How it stays honest about layering: `components/` may not import from
 * `pages/`, so the palette never reaches into a page. It drives shared stores
 * instead — `navigationStore` to move, `launchIntentStore` to open the launch
 * flow, `inspectorStore` to point the roster's detail panel at an account,
 * `themeStore`/`languageStore` for appearance. Every label resolves through the
 * existing message keys, so the whole catalog costs a handful of new strings
 * rather than one per command.
 *
 * Rendered into a portal on `document.body` so it is never clipped by the
 * shell's `overflow: clip`, and it sits above every other layer.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ChevronRight,
  CornerDownLeft,
  Languages,
  Palette,
  Play,
  Search,
  SunMoon,
  UserSearch,
} from 'lucide-react';
import { NAV_PAGES, useNavigationStore, type PageId } from '../../stores/navigationStore';
import { useAccountStore } from '../../stores/accountStore';
import { useLaunchIntentStore } from '../../stores/launchIntentStore';
import { useInspectorStore } from '../../stores/inspectorStore';
import { THEME_NAMES, useThemeStore } from '../../stores/themeStore';
import type { ThemeName } from '../../types/models';
import { LANGUAGES } from '../../i18n';
import { useTranslation } from '../../i18n/useTranslation';
import { fuzzyScore } from '../../lib/fuzzy';
import { identityStyle } from '../../lib/identity';
import './CommandPalette.css';

/** One runnable entry in the palette. */
interface Command {
  /** Stable key, also used as the React key and the active-descendant id. */
  readonly id: string;
  /** The group heading this entry sorts under. */
  readonly group: 'pages' | 'accounts' | 'themes' | 'actions';
  /** The visible, already-translated label. */
  readonly label: string;
  /** Optional right-aligned detail (a UID, a shortcut, a status). */
  readonly detail?: string;
  /** Extra text that should match a query without being displayed. */
  readonly keywords?: string;
  /** Identity hue seed, for entries that represent an account. */
  readonly seed?: string;
  /** The icon rendered in the row's gutter. */
  readonly icon: JSX.Element;
  /** What running this entry does. The palette closes itself afterwards. */
  readonly run: () => void;
}

/** Group headings, in display order. */
const GROUP_ORDER = ['accounts', 'pages', 'actions', 'themes'] as const;

const GROUP_LABEL = {
  accounts: 'cmdk.groupAccounts',
  pages: 'cmdk.groupPages',
  actions: 'cmdk.groupActions',
  themes: 'cmdk.groupThemes',
} as const;

/** One command and the score it earned against the current query. */
interface ScoredCommand {
  /** The entry that matched. */
  readonly command: Command;
  /** Match quality; only comparable between results for the same query. */
  readonly score: number;
}

/**
 * Type guard dropping the `null`s left by commands that did not match.
 *
 * Named rather than inline so the narrowing is stated once and the filter reads
 * as what it is.
 *
 * @param entry - A scoring result, or `null` for a command that did not match.
 */
function isScored(entry: ScoredCommand | null): entry is ScoredCommand {
  return entry !== null;
}

/** Props for {@link CommandPalette}. */
export interface CommandPaletteProps {
  /** Whether the palette is open. */
  open: boolean;
  /** Called when the palette should close (Escape, backdrop, or after a run). */
  onClose: () => void;
}

/**
 * The command palette overlay. Renders nothing when closed.
 */
export function CommandPalette({ open, onClose }: CommandPaletteProps): JSX.Element {
  const { t, language, setLanguage } = useTranslation();
  const reducedMotion = useReducedMotion() ?? false;

  const accounts = useAccountStore((state) => state.accounts);
  const navigate = useNavigationStore((state) => state.navigate);
  const openLaunch = useLaunchIntentStore((state) => state.open);
  const inspect = useInspectorStore((state) => state.inspect);
  const setTheme = useThemeStore((state) => state.setTheme);
  const toggleTheme = useThemeStore((state) => state.toggleTheme);
  const activeTheme = useThemeStore((state) => state.theme);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Opening always starts from a clean slate: a palette that reopens holding
  // the last query is a palette you have to clear before you can use it.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    // The input must take focus after the entrance animation has mounted it.
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];

    // ── Accounts ── the reason the palette exists: reach any account from
    // anywhere, without first navigating to the roster and finding the row.
    for (const account of accounts) {
      const name = account.nickname?.trim() || account.username;
      const seed = account.userId || account.id;
      list.push({
        id: `acct-launch-${account.id}`,
        group: 'accounts',
        label: t('cmdk.launchAccount', { name }),
        detail: account.userId,
        keywords: `${account.username} ${account.nickname ?? ''} ${account.userId}`,
        seed,
        icon: <Play size={14} strokeWidth={2} aria-hidden="true" />,
        run: () => openLaunch({ accountIds: [account.id] }),
      });
      list.push({
        id: `acct-inspect-${account.id}`,
        group: 'accounts',
        label: t('cmdk.inspectAccount', { name }),
        detail: account.userId,
        keywords: `${account.username} ${account.nickname ?? ''} ${account.userId}`,
        seed,
        icon: <UserSearch size={14} strokeWidth={2} aria-hidden="true" />,
        run: () => {
          navigate('accounts');
          inspect(account.id);
        },
      });
    }

    // ── Pages ── each carries the Ctrl+<n> it already answers to, so the
    // palette doubles as the place those bindings are finally documented.
    NAV_PAGES.forEach((page, index) => {
      const name = t(`nav.${page.id}`);
      list.push({
        id: `page-${page.id}`,
        group: 'pages',
        label: t('cmdk.goTo', { name }),
        detail: index < 8 ? `Ctrl ${index + 1}` : undefined,
        keywords: name,
        icon: <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />,
        run: () => navigate(page.id as PageId),
      });
    });

    // ── Actions ──
    list.push({
      id: 'action-toggle-theme',
      group: 'actions',
      label: t('cmdk.toggleTheme'),
      icon: <SunMoon size={14} strokeWidth={2} aria-hidden="true" />,
      run: toggleTheme,
    });
    for (const lang of LANGUAGES) {
      if (lang === language) continue;
      list.push({
        id: `action-lang-${lang}`,
        group: 'actions',
        label: t('cmdk.setLanguage', { name: t(`lang.${lang}`) }),
        icon: <Languages size={14} strokeWidth={2} aria-hidden="true" />,
        run: () => setLanguage(lang),
      });
    }

    // ── Themes ── all twelve, so the picker buried in Settings is one
    // keystroke away.
    for (const theme of THEME_NAMES) {
      list.push({
        id: `theme-${theme}`,
        group: 'themes',
        label: t('cmdk.setTheme', { name: theme }),
        detail: theme === activeTheme ? '●' : undefined,
        keywords: theme,
        icon: <Palette size={14} strokeWidth={2} aria-hidden="true" />,
        run: () => setTheme(theme as ThemeName),
      });
    }

    return list;
  }, [
    accounts,
    activeTheme,
    inspect,
    language,
    navigate,
    openLaunch,
    setLanguage,
    setTheme,
    t,
    toggleTheme,
  ]);

  /** The filtered, ranked, group-ordered result list. */
  const results = useMemo(() => {
    const scored = commands
      .map((command) => {
        // The label is what the user sees, so it scores; keywords only rescue a
        // match the label would have missed (a username behind a nickname).
        const primary = fuzzyScore(query, command.label);
        if (primary.hit) return { command, score: primary.score + 6 };
        const secondary = command.keywords ? fuzzyScore(query, command.keywords) : { hit: false, score: 0 };
        return secondary.hit ? { command, score: secondary.score } : null;
      })
      .filter(isScored);

    scored.sort((a, b) => {
      // With no query there is nothing to rank by, so the catalog keeps its
      // authored order — accounts first, then pages, actions, themes.
      if (query.trim().length === 0) {
        return (
          GROUP_ORDER.indexOf(a.command.group) - GROUP_ORDER.indexOf(b.command.group)
        );
      }
      return b.score - a.score;
    });

    return scored.map((entry) => entry.command);
  }, [commands, query]);

  // A shrinking result list must never leave the cursor pointing past the end.
  useEffect(() => {
    setCursor((current) => (current >= results.length ? 0 : current));
  }, [results.length]);

  const runAt = useCallback(
    (index: number) => {
      const command = results[index];
      if (!command) return;
      // Close first: the action may navigate or open a modal, and a palette
      // still on screen over a freshly opened dialog is a trap.
      onClose();
      command.run();
    },
    [onClose, results],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          setCursor((current) => (results.length === 0 ? 0 : (current + 1) % results.length));
          break;
        case 'ArrowUp':
          event.preventDefault();
          setCursor((current) =>
            results.length === 0 ? 0 : (current - 1 + results.length) % results.length,
          );
          break;
        case 'Home':
          event.preventDefault();
          setCursor(0);
          break;
        case 'End':
          event.preventDefault();
          setCursor(Math.max(0, results.length - 1));
          break;
        case 'Enter':
          event.preventDefault();
          runAt(cursor);
          break;
        case 'Escape':
          event.preventDefault();
          onClose();
          break;
        default:
          break;
      }
    },
    [cursor, onClose, results.length, runAt],
  );

  // Keep the cursor in view as it moves through a long list.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  // Escape closes from anywhere, not just from inside the palette. The
  // component's own `onKeyDown` only sees events that bubble through it, so if
  // focus ever lands outside — a click on the scrim, a browser quirk, an
  // extension stealing focus — Escape would silently stop working and the only
  // way out would be the mouse. A modal you cannot dismiss from the keyboard is
  // a trap, so this listener is the floor.
  useEffect(() => {
    if (!open) return;
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [open, onClose]);

  if (typeof document === 'undefined') {
    return <></>;
  }

  const spring = reducedMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 620, damping: 42, mass: 0.5 };

  // Group headings are emitted inline: the list is a single flat listbox (so
  // arrow keys and `aria-activedescendant` stay simple) with a heading rendered
  // whenever the group changes.
  let lastGroup: Command['group'] | null = null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="rk-cmdk__scrim"
          initial={reducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.15 }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            className="rk-cmdk"
            role="dialog"
            aria-modal="true"
            aria-label={t('cmdk.title')}
            initial={reducedMotion ? false : { opacity: 0, y: -6, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            // Exit is opacity-only: scaling text on the way out reads as a
            // rendering glitch, and the close should feel faster than the open.
            // It also needs its OWN tween rather than inheriting the entrance
            // spring — a spring settling on opacity keeps `AnimatePresence`
            // waiting several hundred milliseconds, which reads as the palette
            // refusing to close after you have already picked something.
            exit={{ opacity: 0, transition: { duration: reducedMotion ? 0 : 0.12 } }}
            transition={spring}
            onKeyDown={onKeyDown}
          >
            <div className="rk-cmdk__input">
              <Search size={15} strokeWidth={2} aria-hidden="true" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                spellCheck={false}
                autoComplete="off"
                placeholder={t('cmdk.placeholder')}
                aria-label={t('cmdk.title')}
                aria-controls="rk-cmdk-list"
                aria-activedescendant={results[cursor] ? `rk-cmdk-${results[cursor].id}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setCursor(0);
                }}
              />
              <kbd className="rk-key">Esc</kbd>
            </div>

            <div
              className="rk-cmdk__list"
              id="rk-cmdk-list"
              role="listbox"
              aria-label={t('cmdk.resultsAria', { count: results.length })}
              ref={listRef}
            >
              {results.length === 0 ? (
                <div className="rk-cmdk__empty">
                  <strong>{t('cmdk.empty')}</strong>
                  <span>{t('cmdk.emptyHint')}</span>
                </div>
              ) : (
                results.map((command, index) => {
                  const heading = command.group !== lastGroup ? command.group : null;
                  lastGroup = command.group;
                  const active = index === cursor;
                  return (
                    <div key={command.id}>
                      {heading ? (
                        <div className="rk-cmdk__group" aria-hidden="true">
                          {t(GROUP_LABEL[heading])}
                        </div>
                      ) : null}
                      <div
                        id={`rk-cmdk-${command.id}`}
                        className="rk-row rk-cmdk__item"
                        role="option"
                        aria-selected={active}
                        data-active={active ? 'true' : undefined}
                        style={command.seed ? identityStyle(command.seed) : undefined}
                        // `onMouseMove` rather than `onMouseEnter`: the cursor
                        // sitting still over a row while the list re-filters
                        // beneath it should not yank the selection.
                        onMouseMove={() => setCursor(index)}
                        onClick={() => runAt(index)}
                      >
                        <span className="rk-cmdk__icon">{command.icon}</span>
                        <span className="rk-cmdk__label">{command.label}</span>
                        {command.detail ? (
                          <span className="rk-cmdk__detail u-num">{command.detail}</span>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="rk-cmdk__foot" aria-hidden="true">
              <span className="rk-cmdk__hint">
                <kbd className="rk-key">↑</kbd>
                <kbd className="rk-key">↓</kbd>
                {t('cmdk.hintNavigate')}
              </span>
              <span className="rk-cmdk__hint">
                <kbd className="rk-key">
                  <CornerDownLeft size={10} strokeWidth={2.4} aria-hidden="true" />
                </kbd>
                {t('cmdk.hintRun')}
              </span>
              <span className="rk-cmdk__hint">
                <kbd className="rk-key">Esc</kbd>
                {t('cmdk.hintClose')}
              </span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export default CommandPalette;
