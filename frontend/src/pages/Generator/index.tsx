import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  History,
  KeyRound,
  LoaderCircle,
  PackageSearch,
  Settings2,
  ShieldCheck,
  Shuffle,
  Sparkles,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { Switch } from '@/components/Switch';
import {
  BLOXGEN_ACCOUNT_TYPES,
  BLOXGEN_KEY_CHANGED_EVENT,
  BLOXGEN_TYPE_LABEL_KEYS,
  defaultAccountType,
  isSelectionOutOfStock,
  isValidBloxGenApiKey,
  maskBloxGenApiKey,
  normalizeBloxGenStock,
  resolveAccountType,
  type BloxGenStockEntry,
  type BloxGenTypeSelection,
} from '@/lib/bloxgen';
import { moderationLabel, normalizeModerationInfo } from '@/lib/moderation';
import {
  appendGenHistory,
  capGenHistory,
  clearGenHistory,
  sanitizeGenHistory,
  type GenerationStep,
  type SafeGenHistoryEntry,
} from '@/lib/genHistory';
import { ipc } from '@/lib/ipc';
import { getPersisted, PERSISTENCE_KEYS, setPersisted } from '@/lib/persistence';
import { createSessionCache } from '@/lib/sessionCache';
import { useAccountStore } from '@/stores/accountStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Translator } from '@/i18n';
import {
  normalizeBloxGenResponse,
  normalizeCredentialLoginOutcome,
  runGeneratorPipeline,
  type GeneratorPhase,
  type GeneratorPipelineFailure,
} from './generatorPipeline';
import './Generator.css';

const STEPS: ReadonlyArray<{
  id: GenerationStep;
  Icon: typeof Sparkles;
}> = [
  { id: 'generate', Icon: Sparkles },
  { id: 'validate', Icon: ShieldCheck },
  { id: 'add', Icon: UserPlus },
];

type StepVisualState = 'pending' | 'active' | 'complete' | 'error';

function readApiKey(): string {
  const value = getPersisted<string>(PERSISTENCE_KEYS.bloxgenApiKey);
  return typeof value === 'string' ? value : '';
}

/**
 * Last known generation history, kept across unmounts so re-entering the page
 * paints the audit list immediately (no empty-state flash) while the mount
 * load silently re-reads the on-disk history.
 */
const historyCache = createSessionCache<SafeGenHistoryEntry[]>();

/**
 * Last known BloxGen stock, kept across unmounts so re-entering the page paints
 * the type picker immediately instead of flashing placeholders. Availability
 * moves on the order of minutes, so a short revalidation window is enough.
 */
const stockCache = createSessionCache<BloxGenStockEntry[]>();
const STOCK_CACHE_MAX_AGE_MS = 60 * 1000;

/**
 * The persisted type selection, or `null` when the user has never picked one.
 *
 * `null` is meaningful: it means "follow stock", so the picker preselects
 * whatever is actually available instead of pinning a type that would fail with
 * "No accounts available". An explicit pick is honoured even if it later goes
 * out of stock — the UI warns rather than silently changing it.
 */
function readTypeSelection(): BloxGenTypeSelection | null {
  const value = getPersisted<string>(PERSISTENCE_KEYS.generatorAccountType);
  if (value === 'random') return 'random';
  return (BLOXGEN_ACCOUNT_TYPES as readonly string[]).includes(value ?? '')
    ? (value as BloxGenTypeSelection)
    : null;
}

function phaseStepIndex(phase: GeneratorPhase): number {
  if (phase === 'generating') return 0;
  if (phase === 'validating') return 1;
  if (phase === 'adding') return 2;
  if (phase === 'success') return STEPS.length;
  return -1;
}

function stepVisualState(
  index: number,
  phase: GeneratorPhase,
  failure: GeneratorPipelineFailure | null,
): StepVisualState {
  if (phase === 'error' && failure) {
    const failedIndex = STEPS.findIndex((step) => step.id === failure.failedAt);
    if (index < failedIndex) return 'complete';
    return index === failedIndex ? 'error' : 'pending';
  }
  const activeIndex = phaseStepIndex(phase);
  if (index < activeIndex) return 'complete';
  if (index === activeIndex) return 'active';
  return 'pending';
}

function phaseLabel(phase: GeneratorPhase, t: Translator): string {
  if (phase === 'generating') return t('gen.phase.generating');
  if (phase === 'validating') return t('gen.phase.validating');
  if (phase === 'adding') return t('gen.phase.adding');
  return t('gen.phase.idle');
}

function resultLabel(entry: SafeGenHistoryEntry, t: Translator): string {
  if (entry.result === 'added' || !entry.result) return t('gen.result.added');
  if (entry.result === 'rejected') return t('gen.result.rejected');
  return t('gen.result.failed');
}

function resultDescription(entry: SafeGenHistoryEntry, t: Translator): string {
  if (entry.result === 'added' || !entry.result) return t('gen.resultDesc.added');
  if (entry.step === 'validate') return t('gen.resultDesc.validate');
  if (entry.step === 'add') return t('gen.resultDesc.add');
  return t('gen.resultDesc.generate');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function Generator(): JSX.Element {
  const reducedMotion = useReducedMotion() ?? false;
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState(readApiKey);
  const [history, setHistory] = useState<SafeGenHistoryEntry[]>(() => historyCache.get() ?? []);
  const [phase, setPhase] = useState<GeneratorPhase>('idle');
  const [failure, setFailure] = useState<GeneratorPipelineFailure | null>(null);
  const [clearing, setClearing] = useState(false);
  const [acceptModerated, setAcceptModerated] = useState(
    () => getPersisted<boolean>(PERSISTENCE_KEYS.acceptModerated) === true,
  );
  const [retryCredentials, setRetryCredentials] = useState(
    () => getPersisted<boolean>(PERSISTENCE_KEYS.generatorRetryCredentials) === true,
  );
  const [stock, setStock] = useState<BloxGenStockEntry[] | null>(() => stockCache.get() ?? null);
  const [stockLoading, setStockLoading] = useState(stockCache.get() === undefined);
  const [typeSelection, setTypeSelection] = useState<BloxGenTypeSelection | null>(readTypeSelection);

  const addAccount = useAccountStore((state) => state.add);
  const navigate = useNavigationStore((state) => state.navigate);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);
  const keyReady = isValidBloxGenApiKey(apiKey);
  const running = phase === 'generating' || phase === 'validating' || phase === 'adding';

  useEffect(() => {
    const refreshKey = (): void => setApiKey(readApiKey());
    window.addEventListener(BLOXGEN_KEY_CHANGED_EVENT, refreshKey);
    window.addEventListener('storage', refreshKey);
    return () => {
      window.removeEventListener(BLOXGEN_KEY_CHANGED_EVENT, refreshKey);
      window.removeEventListener('storage', refreshKey);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void ipc
      .readGenHistory()
      .then((loaded) => {
        if (!cancelled) {
          const sanitized = sanitizeGenHistory(loaded);
          historyCache.set(sanitized);
          setHistory(sanitized);
        }
      })
      .catch(() => {
        // The IPC layer already surfaced the read failure. The empty state is usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the session snapshot in step with in-page mutations (new generation
  // outcomes, history clear) so the next mount hydrates the same list.
  useEffect(() => {
    historyCache.set(history);
  }, [history]);

  // Stock decides which types the picker offers and which one it preselects, so
  // it is re-read whenever the key changes: availability is per-role, and a
  // different key can unlock (or lose) types.
  const refreshStock = useCallback(async (key: string): Promise<void> => {
    if (!isValidBloxGenApiKey(key)) {
      setStock(null);
      setStockLoading(false);
      return;
    }
    setStockLoading(true);
    try {
      const entries = normalizeBloxGenStock(await ipc.bloxgenStock(key));
      // A failed lookup keeps the last known availability rather than blanking
      // the picker; generation still works, and the API reports the
      // authoritative reason if the type turns out to be depleted.
      if (entries) {
        stockCache.set(entries);
        setStock(entries);
      }
    } catch {
      // Availability is advisory only.
    } finally {
      setStockLoading(false);
    }
  }, []);

  const lastStockKey = useRef<string | null>(null);

  useEffect(() => {
    if (lastStockKey.current === apiKey && stockCache.isFresh(STOCK_CACHE_MAX_AGE_MS)) return;
    lastStockKey.current = apiKey;
    void refreshStock(apiKey);
  }, [apiKey, refreshStock]);

  const newestHistory = useMemo(() => [...history].reverse(), [history]);

  // `null` means "follow stock": preselect whatever is actually available rather
  // than pinning a type that would fail immediately.
  const effectiveSelection: BloxGenTypeSelection = typeSelection ?? defaultAccountType(stock);
  const selectionOutOfStock = isSelectionOutOfStock(effectiveSelection, stock);
  // Before stock is known every type is listed, so the picker is never empty;
  // once it is known, only the types this role may generate are offered.
  const offeredTypes = stock ? stock.map((entry) => entry.type) : [...BLOXGEN_ACCOUNT_TYPES];
  const stockPending = stockLoading && stock === null;
  const availableCount = stock?.filter((entry) => entry.available).length ?? 0;

  const handleSelectType = useCallback((next: BloxGenTypeSelection) => {
    setTypeSelection(next);
    setPersisted(PERSISTENCE_KEYS.generatorAccountType, next);
  }, []);

  const persistHistoryEntry = useCallback((entry: SafeGenHistoryEntry) => {
    setHistory((current) => {
      const next = capGenHistory(appendGenHistory(current, entry));
      void ipc.writeGenHistory(next).catch(() => {
        // Keep the session audit visible even if disk persistence fails.
      });
      return next;
    });
  }, []);

  const handleGenerate = useCallback(async () => {
    const currentKey = readApiKey();
    setApiKey(currentKey);
    if (!isValidBloxGenApiKey(currentKey)) {
      navigate('settings');
      return;
    }

    setFailure(null);
    setPhase('generating');
    const outcome = await runGeneratorPipeline(currentKey, {
      // Runs through the backend: a direct in-page fetch to core.bloxgen.net is
      // blocked by the webview's CORS enforcement ("Failed to fetch").
      generate: async (key, accountType) =>
        normalizeBloxGenResponse(await ipc.bloxgenGenerate(key, accountType)),
      // 'random' resolves here, against current stock, so it can only ever pick
      // a type that is actually available.
      accountType: resolveAccountType(effectiveSelection, stock),
      validate: (cookie) => ipc.validateCookie(cookie),
      add: addAccount,
      onPhase: setPhase,
      acceptModerated,
      retryWithCredentials: retryCredentials,
      loginWithCredentials: async (username, password) =>
        normalizeCredentialLoginOutcome(await ipc.loginCredentials(username, password)),
    });
    persistHistoryEntry(outcome.historyEntry);
    // A generation consumes stock and can deplete a type, so re-read it rather
    // than leaving the picker advertising availability that is now gone.
    void refreshStock(currentKey);

    if (outcome.ok) {
      setPhase('success');
      if (outcome.usedCredentials) {
        showSuccess(
          t('gen.addedToAccounts', { name: outcome.validation.username }) +
            ' (con user/contraseña)',
        );
      } else if (outcome.moderated) {
        // Resolve the moderation type (permanent vs temporary) for the toast.
        const info = normalizeModerationInfo(
          await ipc.moderationInfo(outcome.generated.username).catch(() => null),
        );
        showSuccess(
          `${outcome.validation.username} añadida (moderada — ${moderationLabel(info)}).`,
        );
      } else {
        showSuccess(t('gen.addedToAccounts', { name: outcome.validation.username }));
      }
    } else {
      setFailure(outcome);
      setPhase('error');
      showError(outcome.message);
    }
  }, [acceptModerated, retryCredentials, addAccount, effectiveSelection, stock, refreshStock, navigate, persistHistoryEntry, showError, showSuccess, t]);

  const handleToggleModerated = useCallback((next: boolean) => {
    setAcceptModerated(next);
    setPersisted(PERSISTENCE_KEYS.acceptModerated, next);
  }, []);

  const handleToggleRetryCredentials = useCallback((next: boolean) => {
    setRetryCredentials(next);
    setPersisted(PERSISTENCE_KEYS.generatorRetryCredentials, next);
  }, []);

  const handleClear = useCallback(async () => {
    if (history.length === 0) return;
    setClearing(true);
    try {
      await ipc.clearGenHistory();
      setHistory(clearGenHistory<SafeGenHistoryEntry>());
      showSuccess(t('gen.historyCleared'));
    } finally {
      setClearing(false);
    }
  }, [history.length, showSuccess, t]);

  const handleCopy = useCallback(
    async (entry: SafeGenHistoryEntry) => {
      if (!entry.username || !entry.password) return;
      const copied = await copyToClipboard(`${entry.username}:${entry.password}`);
      if (copied) showSuccess(t('gen.credsCopied', { name: entry.username }));
      else showError(t('gen.credsCopyFailed'));
    },
    [showError, showSuccess, t],
  );

  return (
    <section className="gen-page" aria-labelledby="gen-title">
      <header className="gen-header">
        <div>
          <span className="gen-eyebrow">{t('gen.eyebrow')}</span>
          <h1 id="gen-title">{t('gen.title')}</h1>
          <p>{t('gen.subtitle')}</p>
        </div>
        <button
          type="button"
          className="gen-key-chip"
          data-state={keyReady ? 'ready' : 'missing'}
          aria-label={keyReady ? t('gen.keyChipReadyAria') : t('gen.keyChipMissingAria')}
          onClick={() => navigate('settings')}
        >
          <KeyRound size={14} />
          <span>
            <small>{t('gen.keyChipLabel')}</small>
            <strong>{keyReady ? maskBloxGenApiKey(apiKey) : t('gen.configureInSettings')}</strong>
          </span>
          <Settings2 size={14} />
        </button>
      </header>

      <section className="gen-command" aria-labelledby="gen-command-title">
        <div className="gen-command__intro">
          <span className="gen-command__index" aria-hidden="true">01</span>
          <div>
            <span className="gen-command__kicker">{t('gen.securePipeline')}</span>
            <h2 id="gen-command-title">{t('gen.commandTitle')}</h2>
            <p>{t('gen.commandCopy')}</p>
          </div>
        </div>

        <ol className="gen-pipeline" aria-label={t('gen.progressAria')}>
          {STEPS.map((step, index) => {
            const state = stepVisualState(index, phase, failure);
            const Icon = step.Icon;
            return (
              <li key={step.id} data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
                <span className="gen-pipeline__node">
                  {state === 'complete' ? <Check size={16} /> : state === 'error' ? <CircleAlert size={16} /> : <Icon size={16} />}
                </span>
                <span className="gen-pipeline__copy">
                  <strong>{t(`gen.step.${step.id}`)}</strong>
                  <small>{t(`gen.step.${step.id}Detail`)}</small>
                </span>
                {state === 'active' && !reducedMotion && (
                  <motion.span
                    className="gen-pipeline__signal"
                    initial={{ opacity: 0, scaleX: 0.25 }}
                    animate={{ opacity: 1, scaleX: 1 }}
                    transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                  />
                )}
                {index < STEPS.length - 1 && <ArrowRight className="gen-pipeline__arrow" size={14} aria-hidden="true" />}
              </li>
            );
          })}
        </ol>

        <div className="gen-types">
          <div className="gen-types__head">
            <span className="gen-types__icon" aria-hidden="true"><PackageSearch size={16} /></span>
            <div>
              <span className="gen-command__kicker" id="gen-types-title">{t('gen.type.eyebrow')}</span>
              <strong>{t('gen.type.title')}</strong>
            </div>
            <span
              className="gen-types__stock"
              data-state={stockPending ? 'loading' : !stock ? 'unknown' : availableCount > 0 ? 'ok' : 'empty'}
            >
              {stockPending
                ? t('gen.type.checkingStock')
                : stock
                  ? t('gen.type.inStockCount', { count: availableCount })
                  : t('gen.type.stockUnknown')}
            </span>
          </div>

          {stockPending ? (
            <div className="gen-types__grid" aria-hidden="true">
              {[0, 1, 2, 3].map((slot) => <span key={slot} className="gen-type-skeleton" />)}
            </div>
          ) : (
            <div className="gen-types__grid" role="radiogroup" aria-labelledby="gen-types-title">
              <button
                type="button"
                role="radio"
                aria-checked={effectiveSelection === 'random'}
                className="gen-type"
                data-selected={effectiveSelection === 'random' || undefined}
                disabled={running}
                onClick={() => handleSelectType('random')}
              >
                <Shuffle size={14} aria-hidden="true" />
                <span>
                  <strong>{t('gen.type.random')}</strong>
                  <small>{t('gen.type.randomHint')}</small>
                </span>
              </button>
              {offeredTypes.map((type) => {
                const entry = stock?.find((candidate) => candidate.type === type);
                const outOfStock = entry !== undefined && !entry.available;
                return (
                  <button
                    key={type}
                    type="button"
                    role="radio"
                    aria-checked={effectiveSelection === type}
                    className="gen-type"
                    data-selected={effectiveSelection === type || undefined}
                    data-out-of-stock={outOfStock || undefined}
                    disabled={running || outOfStock}
                    onClick={() => handleSelectType(type)}
                  >
                    <span className="gen-type__dot" aria-hidden="true" />
                    <span>
                      <strong>{t(BLOXGEN_TYPE_LABEL_KEYS[type])}</strong>
                      <small>
                        {entry === undefined
                          ? t('gen.type.stockUnknown')
                          : outOfStock
                            ? t('gen.type.outOfStock')
                            : t('gen.type.inStock')}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {selectionOutOfStock ? (
            <p className="gen-types__warn" role="status">
              <CircleAlert size={13} /> {t('gen.type.selectionDepleted')}
            </p>
          ) : null}
        </div>

        <label className="gen-moderated">
          <Switch
            checked={acceptModerated}
            onChange={handleToggleModerated}
            aria-label="Aceptar cuentas moderadas"
          />
          <span>
            <strong>Aceptar cuentas moderadas</strong>
            <small>Añade la cuenta aunque Roblox la marque como moderada; se indica el tipo de baneo.</small>
          </span>
        </label>

        <label className="gen-moderated">
          <Switch
            checked={retryCredentials}
            onChange={handleToggleRetryCredentials}
            aria-label="Reintentar con user y contraseña"
          />
          <span>
            <strong>Reintentar con user y contraseña</strong>
            <small>Si la cookie generada falla, inicia sesión con el user:pass de BloxGen para conseguir una cookie válida.</small>
          </span>
        </label>

        <div className="gen-command__action">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={`${phase}-${failure?.failedAt ?? 'none'}`}
              className="gen-status"
              data-state={phase}
              role="status"
              aria-live="polite"
              initial={reducedMotion ? false : { opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reducedMotion ? undefined : { opacity: 0, y: -3 }}
              transition={{ duration: reducedMotion ? 0 : 0.18 }}
            >
              {phase === 'success' ? <Check size={15} /> : phase === 'error' ? <CircleAlert size={15} /> : <ShieldCheck size={15} />}
              <span>
                {phase === 'success'
                  ? t('gen.status.success')
                  : phase === 'error'
                    ? failure?.message
                    : keyReady
                      ? t('gen.status.ready')
                      : t('gen.status.needKey')}
              </span>
            </motion.div>
          </AnimatePresence>

          <Button
            variant="primary"
            className="gen-generate"
            disabled={running}
            onClick={() => void handleGenerate()}
          >
            {running ? <LoaderCircle className="gen-spinner" size={17} /> : keyReady ? <Sparkles size={17} /> : <Settings2 size={17} />}
            {running ? phaseLabel(phase, t) : keyReady ? t('gen.generateAdd') : t('gen.configure')}
          </Button>
        </div>
      </section>

      <section className="gen-history" aria-labelledby="gen-history-title">
        <header className="gen-history__header">
          <div>
            <History size={17} aria-hidden="true" />
            <span>
              <small>{t('gen.localAudit')}</small>
              <h2 id="gen-history-title">{t('gen.historyTitle')}</h2>
            </span>
            <span className="gen-history__count">{history.length}</span>
          </div>
          <Button variant="ghost" className="gen-clear" disabled={clearing || history.length === 0} onClick={() => void handleClear()}>
            <Trash2 size={14} />
            {clearing ? t('gen.clearing') : t('gen.clear')}
          </Button>
        </header>

        {newestHistory.length === 0 ? (
          <div className="gen-empty">
            <span className="gen-empty__mark" aria-hidden="true"><Sparkles size={20} /></span>
            <div>
              <strong>{t('gen.emptyTitle')}</strong>
              <p>{t('gen.emptyCopy')}</p>
            </div>
          </div>
        ) : (
          <ul className="gen-history__list">
            {newestHistory.map((entry, index) => {
              const successful = entry.result === 'added' || !entry.result;
              return (
                <motion.li
                  key={`${entry.createdAt}-${entry.username}-${index}`}
                  data-result={entry.result ?? 'added'}
                  initial={reducedMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: reducedMotion ? 0 : 0.2, delay: reducedMotion ? 0 : Math.min(index, 5) * 0.025 }}
                >
                  <span className="gen-history__result-icon">
                    {successful ? <Check size={15} /> : <CircleAlert size={15} />}
                  </span>
                  <span className="gen-history__identity">
                    <strong>{entry.username || t('gen.attemptNoAccount')}</strong>
                    <small>{resultDescription(entry, t)}</small>
                  </span>
                  <span className="gen-history__result">
                    <strong>{resultLabel(entry, t)}</strong>
                    <small>{t('gen.stepBadge', { num: entry.step === 'validate' ? '02' : entry.step === 'add' ? '03' : '01' })}</small>
                  </span>
                  <time dateTime={entry.createdAt}>
                    <Clock3 size={13} />
                    {new Date(entry.createdAt).toLocaleString(undefined, {
                      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
                    })}
                  </time>
                  <button
                    type="button"
                    className="gen-history__copy"
                    disabled={!successful || !entry.username || !entry.password}
                    aria-label={t('gen.copyAria', { name: entry.username || t('gen.copyFallbackName') })}
                    title={successful && entry.password ? t('gen.copyTitle') : t('gen.noCredentials')}
                    onClick={() => void handleCopy(entry)}
                  >
                    <Copy size={14} />
                  </button>
                </motion.li>
              );
            })}
          </ul>
        )}
      </section>
    </section>
  );
}
