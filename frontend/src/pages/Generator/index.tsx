import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Check,
  CircleAlert,
  Clock3,
  Copy,
  History,
  KeyRound,
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

/** Chip tone for a step state — colour is signal, and it always carries text. */
const STEP_TONE: Record<StepVisualState, 'neutral' | 'accent' | 'ok' | 'danger'> = {
  pending: 'neutral',
  active: 'accent',
  complete: 'ok',
  error: 'danger',
};

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

/**
 * Short status word shown in each step's chip, so the step strip never encodes
 * its state with colour alone.
 *
 * These reuse existing dictionary entries rather than introducing keys, since
 * `i18n/en.ts` / `i18n/es.ts` are owned elsewhere this pass; the intended
 * `gen.stepState.*` keys are reported alongside the change.
 */
function stepStateLabel(state: StepVisualState, t: Translator): string {
  if (state === 'complete') return t('accounts.drag.done');
  if (state === 'active') return t('accounts.filter.running');
  if (state === 'error') return t('gen.result.failed');
  return t('friends.pending');
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

function stepOrdinal(entry: SafeGenHistoryEntry): string {
  if (entry.step === 'validate') return '02';
  if (entry.step === 'add') return '03';
  return '01';
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

  /**
   * Newest-first audit rows, each carrying a key that is stable for the life of
   * the entry.
   *
   * The key is derived from the entry's index in the append-only `history`
   * array — NOT from its index in this reversed view. A new generation
   * prepends to the reversed list, which shifts every reversed index by one; a
   * reversed-index key therefore remounted every row on each generation,
   * replaying the entrance animation and dropping focus from a focused copy
   * button.
   */
  const newestHistory = useMemo(
    () =>
      history
        .map((entry, index) => ({
          entry,
          key: `${index}|${entry.createdAt}|${entry.username}`,
        }))
        .reverse(),
    [history],
  );

  // `null` means "follow stock": preselect whatever is actually available rather
  // than pinning a type that would fail immediately.
  const effectiveSelection: BloxGenTypeSelection = typeSelection ?? defaultAccountType(stock);
  const selectionOutOfStock = isSelectionOutOfStock(effectiveSelection, stock);
  // Before stock is known every type is listed, so the picker is never empty;
  // once it is known, only the types this role may generate are offered.
  const offeredTypes = stock ? stock.map((entry) => entry.type) : [...BLOXGEN_ACCOUNT_TYPES];
  const stockPending = stockLoading && stock === null;
  const availableCount = stock?.filter((entry) => entry.available).length ?? 0;
  const stockTone = stockPending || !stock ? 'neutral' : availableCount > 0 ? 'ok' : 'warn';

  const handleSelectType = useCallback((next: BloxGenTypeSelection) => {
    setTypeSelection(next);
    setPersisted(PERSISTENCE_KEYS.generatorAccountType, next);
  }, []);

  const persistHistoryEntry = useCallback((entry: SafeGenHistoryEntry) => {
    setHistory((current) => {
      const next = capGenHistory(appendGenHistory(current, entry));
      void ipc.writeGenHistory(next).catch(() => {
        // Keep the session audit visible even if disk persistence fails — but
        // say so, instead of letting the user believe it reached the disk.
        showError(t('generator.historyPersistFailed'));
      });
      return next;
    });
  }, [showError, t]);

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
    <section className="rk-page gen-page" aria-labelledby="gen-title">
      <header className="rk-page__head">
        <div className="rk-page__titles">
          <h1 id="gen-title">{t('gen.title')}</h1>
          <span className="rk-page__sub">{t('gen.subtitle')}</span>
        </div>
        <div className="rk-page__actions">
          <button
            type="button"
            className="gen-key"
            data-state={keyReady ? 'ready' : 'missing'}
            aria-label={keyReady ? t('gen.keyChipReadyAria') : t('gen.keyChipMissingAria')}
            onClick={() => navigate('settings')}
          >
            <KeyRound size={13} aria-hidden="true" />
            <span className="gen-key__text">
              <small>{t('gen.keyChipLabel')}</small>
              <strong className="u-num">
                {keyReady ? maskBloxGenApiKey(apiKey) : t('gen.configureInSettings')}
              </strong>
            </span>
            <Settings2 size={13} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="rk-toolbar gen-toolbar">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={`${phase}-${failure?.failedAt ?? 'none'}`}
            className="gen-status"
            data-state={phase}
            role="status"
            aria-live="polite"
            initial={reducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? undefined : { opacity: 0, y: -3 }}
            transition={{ duration: reducedMotion ? 0 : 0.15 }}
          >
            {phase === 'success' ? (
              <Check size={14} aria-hidden="true" />
            ) : phase === 'error' ? (
              <CircleAlert size={14} aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} aria-hidden="true" />
            )}
            <span>
              {phase === 'success'
                ? t('gen.status.success')
                : phase === 'error'
                  ? failure?.message
                  : keyReady
                    ? t('gen.status.ready')
                    : t('gen.status.needKey')}
            </span>
          </motion.p>
        </AnimatePresence>

        <span className="rk-toolbar__spacer" />

        <Button
          variant="primary"
          className="gen-generate"
          disabled={running}
          onClick={() => void handleGenerate()}
        >
          {running ? (
            <span className="rk-spin" aria-hidden="true" />
          ) : keyReady ? (
            <Sparkles size={15} aria-hidden="true" />
          ) : (
            <Settings2 size={15} aria-hidden="true" />
          )}
          {running ? phaseLabel(phase, t) : keyReady ? t('gen.generateAdd') : t('gen.configure')}
        </Button>
      </div>

      <div className="rk-page__body rk-page__body--pad">
        <div className="gen-stack">
          {/* ── Pipeline ─────────────────────────────────────────────────── */}
          <section className="rk-panel" aria-labelledby="gen-command-title">
            <div className="rk-panel__head">
              <div className="gen-panel__titles">
                <span className="rk-eyebrow">
                  <b>01</b> {t('gen.securePipeline')}
                </span>
                <h2 id="gen-command-title" className="rk-panel__title">
                  {t('gen.commandTitle')}
                </h2>
                <p className="gen-panel__note">{t('gen.commandCopy')}</p>
              </div>
            </div>

            <div className="rk-panel__body">
              <ol className="gen-steps" aria-label={t('gen.progressAria')}>
                {STEPS.map((step, index) => {
                  const state = stepVisualState(index, phase, failure);
                  const Icon = step.Icon;
                  return (
                    <li
                      key={step.id}
                      className="gen-step"
                      data-state={state}
                      aria-current={state === 'active' ? 'step' : undefined}
                    >
                      <span className="gen-step__head">
                        <span className="gen-step__num u-num" aria-hidden="true">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="gen-step__icon" aria-hidden="true">
                          {state === 'complete' ? (
                            <Check size={14} />
                          ) : state === 'error' ? (
                            <CircleAlert size={14} />
                          ) : (
                            <Icon size={14} />
                          )}
                        </span>
                      </span>
                      <span className="gen-step__body">
                        <strong className="gen-step__name">{t(`gen.step.${step.id}`)}</strong>
                        <small className="gen-step__detail">
                          {t(`gen.step.${step.id}Detail`)}
                        </small>
                      </span>
                      <span className="rk-chip rk-chip--sm" data-tone={STEP_TONE[state]}>
                        {stepStateLabel(state, t)}
                      </span>
                      {/* Meter: transform only — never an animated width. */}
                      <span className="gen-step__meter" aria-hidden="true">
                        <span className="gen-step__fill" />
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </section>

          {/* ── Account type picker (BloxGen stock-aware) ────────────────── */}
          <section className="rk-panel">
            <div className="rk-panel__head">
              <span className="gen-panel__icon" aria-hidden="true">
                <PackageSearch size={14} />
              </span>
              <div className="gen-panel__titles">
                <span className="rk-eyebrow" id="gen-types-title">
                  {t('gen.type.eyebrow')}
                </span>
                <h2 className="rk-panel__title">{t('gen.type.title')}</h2>
              </div>
              <span className="rk-chip u-num" data-tone={stockTone}>
                {stockPending ? (
                  <span className="rk-spin" aria-hidden="true" />
                ) : (
                  <span className="rk-dot" data-tone={stockTone} aria-hidden="true" />
                )}
                {stockPending
                  ? t('gen.type.checkingStock')
                  : stock
                    ? t('gen.type.inStockCount', { count: availableCount })
                    : t('gen.type.stockUnknown')}
              </span>
            </div>

            {stockPending ? (
              <div className="gen-types" aria-hidden="true">
                {[0, 1, 2, 3].map((slot) => (
                  <span key={slot} className="rk-row gen-type-skeleton">
                    <span className="rk-row__gutter">
                      <span className="rk-row__tick" />
                    </span>
                    <span className="rk-row__main">
                      <span className="gen-type-skeleton__bar" />
                    </span>
                  </span>
                ))}
              </div>
            ) : (
              <div className="gen-types" role="radiogroup" aria-labelledby="gen-types-title">
                <button
                  type="button"
                  role="radio"
                  aria-checked={effectiveSelection === 'random'}
                  className="rk-row gen-type gen-type--random"
                  data-selected={effectiveSelection === 'random' || undefined}
                  disabled={running}
                  onClick={() => handleSelectType('random')}
                >
                  <span className="rk-row__gutter">
                    <Shuffle size={13} aria-hidden="true" />
                  </span>
                  <span className="rk-row__main">
                    <span className="rk-row__title">{t('gen.type.random')}</span>
                    <span className="rk-row__meta">{t('gen.type.randomHint')}</span>
                  </span>
                </button>
                {offeredTypes.map((type) => {
                  const entry = stock?.find((candidate) => candidate.type === type);
                  const outOfStock = entry !== undefined && !entry.available;
                  const stockState = entry === undefined ? 'unknown' : outOfStock ? 'out' : 'in';
                  return (
                    <button
                      key={type}
                      type="button"
                      role="radio"
                      aria-checked={effectiveSelection === type}
                      className="rk-row gen-type"
                      data-selected={effectiveSelection === type || undefined}
                      data-out-of-stock={outOfStock || undefined}
                      data-stock={stockState}
                      disabled={running || outOfStock}
                      onClick={() => handleSelectType(type)}
                    >
                      <span className="rk-row__gutter">
                        <span className="rk-row__tick" />
                      </span>
                      <span className="rk-row__main">
                        <span className="rk-row__title">{t(BLOXGEN_TYPE_LABEL_KEYS[type])}</span>
                      </span>
                      <span
                        className="rk-chip rk-chip--sm"
                        data-tone={
                          stockState === 'in' ? 'ok' : stockState === 'out' ? 'warn' : 'neutral'
                        }
                      >
                        {entry === undefined
                          ? t('gen.type.stockUnknown')
                          : outOfStock
                            ? t('gen.type.outOfStock')
                            : t('gen.type.inStock')}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {selectionOutOfStock ? (
              <p className="gen-warn" role="status">
                <CircleAlert size={13} aria-hidden="true" /> {t('gen.type.selectionDepleted')}
              </p>
            ) : null}
          </section>

          {/* ── Run options ─────────────────────────────────────────────── */}
          <div className="rk-panel gen-opts">
            <label className="rk-row gen-opt">
              <span className="rk-row__main">
                <span className="rk-row__title">Aceptar cuentas moderadas</span>
                <span className="rk-row__meta">
                  Añade la cuenta aunque Roblox la marque como moderada; se indica el tipo de baneo.
                </span>
              </span>
              <Switch
                checked={acceptModerated}
                onChange={handleToggleModerated}
                aria-label={t('gen.moderatedAria')}
              />
            </label>

            <label className="rk-row gen-opt">
              <span className="rk-row__main">
                <span className="rk-row__title">Reintentar con user y contraseña</span>
                <span className="rk-row__meta">
                  Si la cookie generada falla, inicia sesión con el user:pass de BloxGen para
                  conseguir una cookie válida.
                </span>
              </span>
              <Switch
                checked={retryCredentials}
                onChange={handleToggleRetryCredentials}
                aria-label={t('gen.retryAria')}
              />
            </label>
          </div>

          {/* ── Local audit ─────────────────────────────────────────────── */}
          <section className="rk-panel" aria-labelledby="gen-history-title">
            <div className="rk-panel__head">
              <span className="gen-panel__icon" aria-hidden="true">
                <History size={14} />
              </span>
              <div className="gen-panel__titles">
                <span className="rk-eyebrow">{t('gen.localAudit')}</span>
                <h2 id="gen-history-title" className="rk-panel__title">
                  {t('gen.historyTitle')}
                </h2>
              </div>
              <span className="rk-chip rk-chip--sm u-num">{history.length}</span>
              <Button
                variant="ghost"
                size="sm"
                className="gen-clear"
                disabled={clearing || history.length === 0}
                onClick={() => void handleClear()}
              >
                <Trash2 size={13} aria-hidden="true" />
                {clearing ? t('gen.clearing') : t('gen.clear')}
              </Button>
            </div>

            {newestHistory.length === 0 ? (
              <div className="rk-empty gen-empty">
                <span className="rk-empty__icon" aria-hidden="true">
                  <Sparkles size={18} />
                </span>
                <strong className="rk-empty__title">{t('gen.emptyTitle')}</strong>
                <p className="rk-empty__text">{t('gen.emptyCopy')}</p>
              </div>
            ) : (
              <div className="rk-table gen-table">
                <div className="rk-table__head">
                  <span className="gen-head--gutter" aria-hidden="true" />
                  <span>{t('accounts.edit.eyebrow')}</span>
                  <span className="gen-head--result" aria-hidden="true" />
                  <span className="gen-head--step" aria-hidden="true" />
                  <span className="gen-head--time" aria-hidden="true" />
                  <span className="gen-head--actions" aria-hidden="true" />
                </div>

                <ul className="gen-table__rows">
                  {newestHistory.map(({ entry, key }, index) => {
                    const successful = entry.result === 'added' || !entry.result;
                    return (
                      <motion.li
                        key={key}
                        className="rk-row gen-row"
                        data-result={entry.result ?? 'added'}
                        initial={reducedMotion ? false : { opacity: 0, y: 3 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: reducedMotion ? 0 : 0.15,
                          delay: reducedMotion ? 0 : Math.min(index, 6) * 0.04,
                        }}
                      >
                        <span className="rk-row__gutter">
                          <span className="rk-row__tick" />
                        </span>
                        <span className="rk-row__main">
                          <span className="rk-row__title">
                            {entry.username || t('gen.attemptNoAccount')}
                          </span>
                          <span className="rk-row__meta">{resultDescription(entry, t)}</span>
                        </span>
                        <span className="rk-table__cell gen-cell--result">
                          <span
                            className="rk-chip rk-chip--sm"
                            data-tone={successful ? 'ok' : 'danger'}
                          >
                            {resultLabel(entry, t)}
                          </span>
                        </span>
                        <span className="rk-table__cell rk-table__cell--num gen-cell--step">
                          {t('gen.stepBadge', { num: stepOrdinal(entry) })}
                        </span>
                        <time
                          className="rk-table__cell rk-table__cell--num u-num"
                          dateTime={entry.createdAt}
                        >
                          <Clock3 size={11} aria-hidden="true" />
                          {new Date(entry.createdAt).toLocaleString(undefined, {
                            month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit',
                          })}
                        </time>
                        <span className="rk-row__actions">
                          <button
                            type="button"
                            className="gen-copy"
                            disabled={!successful || !entry.username || !entry.password}
                            aria-label={t('gen.copyAria', {
                              name: entry.username || t('gen.copyFallbackName'),
                            })}
                            title={
                              successful && entry.password
                                ? t('gen.copyTitle')
                                : t('gen.noCredentials')
                            }
                            onClick={() => void handleCopy(entry)}
                          >
                            <Copy size={13} aria-hidden="true" />
                          </button>
                        </span>
                      </motion.li>
                    );
                  })}
                </ul>
              </div>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
