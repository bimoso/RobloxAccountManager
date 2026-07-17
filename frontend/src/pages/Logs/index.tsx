// pages/Logs/index.tsx
//
// Operational session console. The store remains the single source of truth;
// this page only derives filters, search matches, and presentation state.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Filter,
  Radio,
  RotateCcw,
  Search,
  TerminalSquare,
  X,
} from 'lucide-react';
import {
  MAX_LOG_ENTRIES,
  useLogStore,
  type LogEntry,
} from '@/stores/logStore';
import { findMatches } from '@/lib/logSearch';
import { useHotkey } from '@/hooks/useHotkey';
import { Dropdown, type DropdownOption } from '@/components/Dropdown';
import { useTranslation } from '@/i18n/useTranslation';
import { formatLogLine } from './presentation';
import './Logs.css';

type LogTone = 'info' | 'success' | 'warning' | 'error';
type LogFilter = 'all' | LogTone;


function logTone(entry: LogEntry): LogTone {
  const level = entry.level.toLowerCase();
  const category = entry.category.toLowerCase();
  if (
    level.includes('err') ||
    level.includes('fatal') ||
    category === 'crash' ||
    category === 'kill'
  ) {
    return 'error';
  }
  if (level.includes('warn')) return 'warning';
  if (level === 'ok' || level.includes('success') || category === 'launch') {
    return 'success';
  }
  return 'info';
}

/** Session activity rendered as a searchable, filterable operational console. */
export function LogsPage(): JSX.Element {
  const entries = useLogStore((state) => state.entries);
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();

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

  const visibleEntries = useMemo(
    () =>
      entries
        .map((entry, sourceIndex) => ({ entry, sourceIndex }))
        .filter(({ entry }) => filter === 'all' || logTone(entry) === filter),
    [entries, filter],
  );

  const rows = useMemo(
    () =>
      visibleEntries.map(({ entry, sourceIndex }) => ({
        entry,
        sourceIndex,
        line: formatLogLine(entry),
      })),
    [visibleEntries],
  );

  const effectiveQuery = searchOpen ? query : '';
  const totalMatches = useMemo(() => {
    if (effectiveQuery.length === 0) return 0;
    return rows.reduce(
      (sum, row) => sum + findMatches(row.line, effectiveQuery).length,
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
  useHotkey({ key: 'f', ctrlOrMeta: true }, openSearch);
  useHotkey(
    { key: 'Escape' },
    () => setSearchOpen(false),
    { enabled: searchOpen },
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

  let matchCounter = 0;
  const renderLine = (
    row: { entry: LogEntry; sourceIndex: number; line: string },
  ): JSX.Element => {
    const matches =
      effectiveQuery.length > 0 ? findMatches(row.line, effectiveQuery) : [];
    const parts: JSX.Element[] = [];
    let cursor = 0;

    matches.forEach((match, index) => {
      if (match.start > cursor) {
        parts.push(
          <span key={`text-${index}`}>{row.line.slice(cursor, match.start)}</span>,
        );
      }
      const globalIndex = matchCounter;
      matchCounter += 1;
      const isActive = globalIndex === activeMatch;
      parts.push(
        <mark
          key={`match-${index}`}
          className={isActive ? 'log-hl log-hl-active' : 'log-hl'}
          ref={isActive ? activeMatchRef : undefined}
        >
          {row.line.slice(match.start, match.end)}
        </mark>,
      );
      cursor = match.end;
    });
    if (cursor < row.line.length) {
      parts.push(<span key="tail">{row.line.slice(cursor)}</span>);
    }

    return (
      <motion.div
        className="log-line"
        data-tone={logTone(row.entry)}
        key={`${row.entry.ts}-${row.sourceIndex}`}
        initial={{ opacity: 0, y: reducedMotion ? 0 : 5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: reducedMotion ? 0 : 0.18, ease: 'easeOut' }}
      >
        <span className="log-line__signal" aria-hidden="true" />
        <code>{parts.length > 0 ? parts : row.line || '\u00a0'}</code>
      </motion.div>
    );
  };

  const hasFilteredOutEntries = entries.length > 0 && rows.length === 0;

  return (
    <section className="logs-page" aria-labelledby="logs-title">
      <header className="logs-header">
        <div className="logs-heading">
          <span className="logs-eyebrow">{t('logs.eyebrow')}</span>
          <h1 className="logs-title" id="logs-title">{t('logs.title')}</h1>
          <p className="logs-sub">
            {t('logs.subtitle')}
          </p>
        </div>
        <div className="logs-live" aria-label={t('logs.liveAria')}>
          <span className="logs-live__pulse" aria-hidden="true" />
          {t('logs.liveCapture')}
        </div>
      </header>

      <div className="logs-vitals" aria-label={t('logs.summaryAria')}>
        <div className="logs-vital">
          <Activity size={16} aria-hidden="true" />
          <span>{t('logs.sessionEvents')}</span>
          <strong>{entries.length}</strong>
        </div>
        <div className="logs-vital" data-tone={attentionCount > 0 ? 'error' : 'quiet'}>
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{t('logs.needsAttention')}</span>
          <strong>{attentionCount}</strong>
        </div>
        <div className="logs-vital logs-vital--buffer">
          <span>{t('logs.buffer')}</span>
          <strong>{Math.round((entries.length / MAX_LOG_ENTRIES) * 100)}%</strong>
        </div>
      </div>

      <div className="logs-console">
        <div className="logs-console__bar">
          <div className="logs-console__identity">
            <TerminalSquare size={16} aria-hidden="true" />
            <span>{t('logs.console')}</span>
            <span className="logs-console__channel">LOCAL</span>
          </div>
          <span className="logs-console__shortcut">{t('logs.shortcut')}</span>
        </div>

        <div className="logs-toolbar">
          <div className="logs-filter">
            <Filter size={15} aria-hidden="true" />
            <Dropdown
              options={logFilterOptions}
              value={filter}
              onChange={setFilter}
              aria-label={t('logs.filterAria')}
            />
          </div>

          <button
            type="button"
            className={`logs-tool-btn${followTail ? ' is-active' : ''}`}
            aria-pressed={followTail}
            onClick={() => setFollowTail((current) => !current)}
          >
            <Radio size={15} aria-hidden="true" />
            {followTail ? t('logs.following') : t('logs.paused')}
          </button>

          <div className="logs-toolbar__spacer" />

          <AnimatePresence initial={false} mode="popLayout">
            {searchOpen ? (
              <motion.div
                className="log-find"
                role="search"
                key="find"
                layoutId="logs-search-control"
                initial={reducedMotion ? false : { opacity: 0, x: 8, scale: 0.985 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={reducedMotion ? undefined : { opacity: 0, x: 5, scale: 0.985 }}
                transition={
                  reducedMotion
                    ? { duration: 0 }
                    : { type: 'spring', stiffness: 500, damping: 38, mass: 0.56 }
                }
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
                <span className="log-find-count">
                  {totalMatches === 0
                    ? query.length === 0
                      ? ''
                      : t('logs.noResults')
                    : `${activeMatch + 1}/${totalMatches}`}
                </span>
                <button
                  type="button"
                  className="log-find-btn"
                  aria-label={t('logs.prevMatch')}
                  disabled={totalMatches === 0}
                  onClick={() => gotoMatch(-1)}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  type="button"
                  className="log-find-btn"
                  aria-label={t('logs.nextMatch')}
                  disabled={totalMatches === 0}
                  onClick={() => gotoMatch(1)}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  className="log-find-btn"
                  aria-label={t('logs.closeSearch')}
                  onClick={() => setSearchOpen(false)}
                >
                  <X size={14} />
                </button>
              </motion.div>
            ) : (
              <motion.button
                className="logs-tool-btn"
                type="button"
                key="open-find"
                layoutId="logs-search-control"
                onClick={openSearch}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.15 }}
              >
                <Search size={15} aria-hidden="true" />
                {t('logs.search')}
              </motion.button>
            )}
          </AnimatePresence>

          <button
            type="button"
            className="logs-tool-btn logs-tool-btn--icon"
            aria-label={t('logs.copyVisible')}
            title={t('logs.copyVisible')}
            disabled={rows.length === 0}
            onClick={() => void copyVisible()}
          >
            {copied ? <Check size={15} /> : <Clipboard size={15} />}
          </button>
        </div>

        <div className="logs-stage" ref={listRef}>
          {entries.length === 0 ? (
            <motion.div
              className="logs-empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reducedMotion ? 0 : 0.24 }}
              role="status"
            >
              <div className="logs-empty__glyph" aria-hidden="true">
                <TerminalSquare size={28} />
                <span />
              </div>
              <p className="logs-empty__title">{t('logs.emptyTitle')}</p>
              <p className="logs-empty__copy">
                {t('logs.emptyCopy')}
              </p>
              <div className="logs-empty__route" aria-hidden="true">
                <span>ACCOUNT</span><i /><span>RUNTIME</span><i /><span>LOG</span>
              </div>
            </motion.div>
          ) : hasFilteredOutEntries ? (
            <div className="logs-empty logs-empty--compact" role="status">
              <Filter size={25} aria-hidden="true" />
              <p className="logs-empty__title">{t('logs.noMatchTitle')}</p>
              <p className="logs-empty__copy">{t('logs.noMatchCopy')}</p>
              <button type="button" className="logs-reset" onClick={() => setFilter('all')}>
                <RotateCcw size={14} /> {t('logs.resetFilter')}
              </button>
            </div>
          ) : (
            <div className="logs-list" role="log" aria-label={t('logs.logAria')}>
              <AnimatePresence initial={false}>
                {rows.map((row) => renderLine(row))}
              </AnimatePresence>
            </div>
          )}
        </div>

        <footer className="logs-statusbar">
          <span>{t('logs.visible', { count: rows.length })}</span>
          <span>{t('logs.buffered', { count: entries.length, max: MAX_LOG_ENTRIES })}</span>
          <span className={followTail ? 'is-live' : undefined}>
            {followTail ? t('logs.tailLinked') : t('logs.tailPaused')}
          </span>
        </footer>
      </div>
    </section>
  );
}

export default LogsPage;
