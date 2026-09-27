// pages/Logs/index.tsx
//
// Operational session console. The store remains the single source of truth;
// this page only derives filters, search matches, and presentation state.
//
// RACKLINE: the page is the mandatory `.rk-page` frame (head / stats / toolbar
// / one scroll port / status bar) and the stream is a real `.rk-table` — a
// severity tick in the gutter, a mono timestamp, the source category, and the
// message — instead of a bespoke console panel.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from 'framer-motion';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  FolderOpen,
  Filter,
  Radio,
  RotateCcw,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import { MAX_LOG_ENTRIES, useLogStore } from '@/stores/logStore';
import { ipc } from '@/lib/ipc';
import { findMatches } from '@/lib/logSearch';
import { useHotkey } from '@/hooks/useHotkey';
import { Button } from '@/components/Button';
import { usePageActive } from '@/components/PageRouter/pageActivity';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { useTranslation } from '@/i18n/useTranslation';
import {
  LOG_SEVERITY_CODE,
  formatLogLine,
  logLineParts,
  logTone,
  type LogLineParts,
  type LogTone,
} from './presentation';
import './Logs.css';

type LogFilter = 'all' | LogTone;

/** One filtered entry, pre-split into the cells the table renders. */
interface LogRow {
  readonly tone: LogTone;
  readonly sourceIndex: number;
  readonly key: string;
  readonly parts: LogLineParts;
  /** Flat line kept for "copy visible logs". */
  readonly line: string;
}

/** Session activity rendered as a searchable, filterable operational console. */
export function LogsPage(): JSX.Element {
  const entries = useLogStore((state) => state.entries);
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();
  const pageActive = usePageActive();

  // Two derived transitions for the whole page. framer animates in JS, so it
  // still needs the reduced-motion value — but it is read once here instead of
  // being re-branched at every call site (global.css owns the CSS side).
  const fade = useMemo<Transition>(
    () => ({ duration: reducedMotion ? 0 : 0.15, ease: 'easeOut' }),
    [reducedMotion],
  );
  const glide = useMemo<Transition>(
    () =>
      reducedMotion
        ? { duration: 0 }
        : { type: 'spring', stiffness: 500, damping: 38, mass: 0.56 },
    [reducedMotion],
  );

  // `t` is rebound per language, so the options re-derive on language change.
  const logFilterOptions = useMemo<ReadonlyArray<DropdownOption<LogFilter>>>(() => [
    { value: 'all', label: t('logs.filter.all') },
    { value: 'success', label: t('logs.filter.success') },
    { value: 'info', label: t('logs.filter.info') },
    { value: 'warning', label: t('logs.filter.warning') },
    { value: 'error', label: t('logs.filter.error') },
  ], [t]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [followTail, setFollowTail] = useState(true);
  const [copied, setCopied] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const activeMatchRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const rows = useMemo<ReadonlyArray<LogRow>>(
    () =>
      entries
        .map((entry, sourceIndex) => ({ entry, sourceIndex, tone: logTone(entry) }))
        .filter(({ tone }) => filter === 'all' || tone === filter)
        .map(({ entry, sourceIndex, tone }) => ({
          tone,
          sourceIndex,
          key: `${entry.ts}-${sourceIndex}`,
          parts: logLineParts(entry),
          line: formatLogLine(entry),
        })),
    [entries, filter],
  );

  const effectiveQuery = searchOpen ? query : '';
  const totalMatches = useMemo(() => {
    if (effectiveQuery.length === 0) return 0;
    return rows.reduce(
      (sum, row) =>
        sum +
        findMatches(row.parts.timestamp, effectiveQuery).length +
        findMatches(row.parts.source, effectiveQuery).length +
        findMatches(row.parts.message, effectiveQuery).length,
      0,
    );
  }, [rows, effectiveQuery]);

  const attentionCount = useMemo(
    () => entries.filter((entry) => logTone(entry) === 'error').length,
    [entries],
  );

  useEffect(() => {
    setActiveMatch((current) => {
      if (totalMatches === 0) return 0;
      return current % totalMatches;
    });
  }, [totalMatches]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);
  // Logs stays mounted after the user leaves it, so its shortcuts only answer
  // while it is the page on screen.
  useHotkey({ key: 'f', ctrlOrMeta: true }, openSearch, { enabled: pageActive });
  useHotkey(
    { key: 'Escape' },
    () => setSearchOpen(false),
    { enabled: searchOpen && pageActive },
  );

  useEffect(() => {
    activeMatchRef.current?.scrollIntoView({ block: 'center' });
  }, [activeMatch, effectiveQuery]);

  useEffect(() => {
    if (!followTail || !listRef.current) return;
    const stage = listRef.current;
    if (typeof stage.scrollTo === 'function') {
      stage.scrollTo({
        top: stage.scrollHeight,
        behavior: reducedMotion ? 'auto' : 'smooth',
      });
    } else {
      // Lightweight DOM environments (including jsdom) do not expose
      // Element.scrollTo; assigning scrollTop preserves the same end state.
      stage.scrollTop = stage.scrollHeight;
    }
  }, [entries.length, filter, followTail, reducedMotion]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const gotoMatch = (delta: number): void => {
    if (totalMatches === 0) return;
    setActiveMatch((current) => (current + delta + totalMatches) % totalMatches);
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      gotoMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSearchOpen(false);
    }
  };

  const copyVisible = async (): Promise<void> => {
    if (rows.length === 0 || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(rows.map((row) => row.line).join('\n'));
      setCopied(true);
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard access may be unavailable in an untrusted preview context.
    }
  };

  // Match numbering runs left-to-right, cell by cell, in render order — the
  // same order the eye reads the table.
  let matchCounter = 0;
  const renderCell = (text: string, keyPrefix: string): ReactNode => {
    if (effectiveQuery.length === 0) return text;
    const matches = findMatches(text, effectiveQuery);
    if (matches.length === 0) return text;

    const parts: ReactNode[] = [];
    let cursor = 0;
    matches.forEach((match, index) => {
      if (match.start > cursor) {
        parts.push(
          <span key={`${keyPrefix}-text-${index}`}>
            {text.slice(cursor, match.start)}
          </span>,
        );
      }
      const globalIndex = matchCounter;
      matchCounter += 1;
      const isActive = globalIndex === activeMatch;
      parts.push(
        <mark
          key={`${keyPrefix}-match-${index}`}
          className={isActive ? 'log-hl log-hl-active' : 'log-hl'}
          ref={isActive ? activeMatchRef : undefined}
        >
          {text.slice(match.start, match.end)}
        </mark>,
      );
      cursor = match.end;
    });
    if (cursor < text.length) {
      parts.push(<span key={`${keyPrefix}-tail`}>{text.slice(cursor)}</span>);
    }
    return parts;
  };

  const renderRow = (row: LogRow): JSX.Element => (
    <motion.div
      className="rk-row logs-row"
      data-tone={row.tone}
      key={row.key}
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={fade}
    >
      <span className="rk-row__gutter" aria-hidden="true">
        <span className="rk-row__tick" />
      </span>
      <span className="rk-table__cell rk-table__cell--num u-num logs-row__ts">
        {renderCell(row.parts.timestamp, `${row.key}-ts`)}
      </span>
      <span className="rk-table__cell logs-row__src">
        {renderCell(row.parts.source, `${row.key}-src`)}
      </span>
      <code className="logs-row__msg">
        <span className="logs-row__sev">{LOG_SEVERITY_CODE[row.tone]}</span>
        {renderCell(row.parts.message, `${row.key}-msg`) || ' '}
      </code>
    </motion.div>
  );

  const hasFilteredOutEntries = entries.length > 0 && rows.length === 0;
  const bufferPercent = Math.round((entries.length / MAX_LOG_ENTRIES) * 100);

  return (
    <section className="rk-page logs-page" aria-labelledby="logs-title">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1 id="logs-title">{t('logs.title')}</h1>
          <span className="rk-page__sub">{t('logs.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <span className="rk-chip" data-tone="ok" aria-label={t('logs.liveAria')}>
            <span className="rk-dot rk-dot--live" data-tone="ok" aria-hidden="true" />
            {t('logs.liveCapture')}
          </span>
        </div>
      </header>

      <div className="rk-stats" aria-label={t('logs.summaryAria')}>
        <div className="rk-stat">
          <span className="rk-stat__label">{t('logs.sessionEvents')}</span>
          <span className="rk-stat__value u-num">{entries.length}</span>
        </div>
        <div
          className="rk-stat logs-stat"
          data-tone={attentionCount > 0 ? 'error' : 'quiet'}
        >
          <span className="rk-stat__label logs-stat__label">
            <AlertTriangle size={11} aria-hidden="true" />
            {t('logs.needsAttention')}
          </span>
          <span className="rk-stat__value u-num">{attentionCount}</span>
        </div>
        <div className="rk-stat logs-stat--buffer">
          <span className="rk-stat__label">{t('logs.buffer')}</span>
          <span className="rk-stat__value u-num">{bufferPercent}%</span>
        </div>
      </div>

      <div className="rk-toolbar">
        <div className="logs-filter">
          <Dropdown
            options={logFilterOptions}
            value={filter}
            onChange={setFilter}
            aria-label={t('logs.filterAria')}
            icon={<Filter size={15} />}
          />
        </div>

        <Button
          variant="secondary"
          className="logs-follow"
          aria-pressed={followTail}
          onClick={() => setFollowTail((current) => !current)}
        >
          <Radio size={15} aria-hidden="true" />
          {followTail ? t('logs.following') : t('logs.paused')}
        </Button>

        <Button
          variant="secondary"
          title={t('logs.openFolder')}
          aria-label={t('logs.openFolder')}
          onClick={() => void ipc.openLogsFolder()}
        >
          <FolderOpen size={15} aria-hidden="true" />
          {t('logs.openFolder')}
        </Button>

        <div className="rk-toolbar__spacer" />

        <span className="logs-hint">{t('logs.shortcut')}</span>

        <AnimatePresence initial={false} mode="popLayout">
          {searchOpen ? (
            <motion.div
              className="log-find"
              role="search"
              key="find"
              layoutId="logs-search-control"
              initial={{ opacity: 0, x: 8, scale: 0.985 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 5, scale: 0.985 }}
              transition={glide}
            >
              <Search size={15} aria-hidden="true" />
              <input
                ref={inputRef}
                className="log-find-input"
                type="text"
                placeholder={t('logs.findPlaceholder')}
                aria-label={t('logs.findAria')}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActiveMatch(0);
                }}
                onKeyDown={onSearchKeyDown}
              />
              <span className="log-find-count u-num">
                {totalMatches === 0
                  ? query.length === 0
                    ? ''
                    : t('logs.noResults')
                  : `${activeMatch + 1}/${totalMatches}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('logs.prevMatch')}
                disabled={totalMatches === 0}
                onClick={() => gotoMatch(-1)}
              >
                <ChevronUp size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('logs.nextMatch')}
                disabled={totalMatches === 0}
                onClick={() => gotoMatch(1)}
              >
                <ChevronDown size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                aria-label={t('logs.closeSearch')}
                onClick={() => setSearchOpen(false)}
              >
                <X size={14} />
              </Button>
            </motion.div>
          ) : (
            // The shared `layoutId` makes the button and the find field one
            // travelling object, so this stays a raw motion element and borrows
            // the Button primitive's classes rather than the component.
            <motion.button
              className="ram-btn ram-btn--secondary"
              type="button"
              key="open-find"
              layoutId="logs-search-control"
              onClick={openSearch}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={fade}
            >
              <Search size={15} aria-hidden="true" />
              {t('logs.search')}
            </motion.button>
          )}
        </AnimatePresence>

        <Button
          variant="secondary"
          iconOnly
          aria-label={t('logs.copyVisible')}
          title={t('logs.copyVisible')}
          disabled={rows.length === 0}
          onClick={() => void copyVisible()}
        >
          {copied ? <Check size={15} /> : <Clipboard size={15} />}
        </Button>
      </div>

      <div className="rk-page__body" ref={listRef}>
        {entries.length === 0 ? (
          <motion.div
            className="rk-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={fade}
            role="status"
          >
            <div className="rk-empty__icon" aria-hidden="true">
              <TerminalSquare size={20} />
            </div>
            <p className="rk-empty__title">{t('logs.emptyTitle')}</p>
            <p className="rk-empty__text">{t('logs.emptyCopy')}</p>
            <div className="logs-hints">
              <span className="rk-keys">
                <kbd className="rk-key">Ctrl</kbd>
                <kbd className="rk-key">F</kbd>
              </span>
              <span>{t('logs.search')}</span>
              <span className="rk-keys">
                <kbd className="rk-key">Esc</kbd>
              </span>
              <span>{t('logs.closeSearch')}</span>
            </div>
          </motion.div>
        ) : hasFilteredOutEntries ? (
          <div className="rk-empty" role="status">
            <div className="rk-empty__icon" aria-hidden="true">
              <Filter size={20} />
            </div>
            <p className="rk-empty__title">{t('logs.noMatchTitle')}</p>
            <p className="rk-empty__text">{t('logs.noMatchCopy')}</p>
            <Button variant="secondary" onClick={() => setFilter('all')}>
              <RotateCcw size={14} aria-hidden="true" />
              {t('logs.resetFilter')}
            </Button>
          </div>
        ) : (
          <div className="rk-table logs-table">
            {/* Column codes, not table semantics: the stream is a live region,
                so the head is presentational and stays out of it. */}
            <div className="rk-table__head" aria-hidden="true">
              <span className="logs-table__sev" />
              <span>{t('logs.col.time')}</span>
              <span>{t('logs.col.source')}</span>
              <span>{t('logs.col.message')}</span>
            </div>
            <div
              className="logs-table__rows"
              role="log"
              aria-label={t('logs.logAria')}
            >
              <AnimatePresence initial={false}>
                {rows.map((row) => renderRow(row))}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>

      <footer className="logs-status">
        <span className="logs-status__id">{t('logs.console')}</span>
        <span className="rk-toolbar__spacer" />
        <span className="u-num">{t('logs.visible', { count: rows.length })}</span>
        <span className="u-num">
          {t('logs.buffered', { count: entries.length, max: MAX_LOG_ENTRIES })}
        </span>
        <span className="logs-status__tail">
          <span
            className="rk-dot"
            data-tone={followTail ? 'ok' : 'neutral'}
            aria-hidden="true"
          />
          {followTail ? t('logs.tailLinked') : t('logs.tailPaused')}
        </span>
      </footer>
    </section>
  );
}

export default LogsPage;
