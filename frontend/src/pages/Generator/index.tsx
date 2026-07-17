import { useCallback, useEffect, useMemo, useState } from 'react';
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
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { Button } from '@/components/Button';
import { BLOXGEN_KEY_CHANGED_EVENT, isValidBloxGenApiKey, maskBloxGenApiKey } from '@/lib/bloxgen';
import {
  appendGenHistory,
  capGenHistory,
  clearGenHistory,
  sanitizeGenHistory,
  type GenerationStep,
  type SafeGenHistoryEntry,
} from '@/lib/genHistory';
import { ipc } from '@/lib/ipc';
import { getPersisted, PERSISTENCE_KEYS } from '@/lib/persistence';
import { useAccountStore } from '@/stores/accountStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import type { Translator } from '@/i18n';
import {
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
  const [history, setHistory] = useState<SafeGenHistoryEntry[]>([]);
  const [phase, setPhase] = useState<GeneratorPhase>('idle');
  const [failure, setFailure] = useState<GeneratorPipelineFailure | null>(null);
  const [clearing, setClearing] = useState(false);

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
        if (!cancelled) setHistory(sanitizeGenHistory(loaded));
      })
      .catch(() => {
        // The IPC layer already surfaced the read failure. The empty state is usable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const newestHistory = useMemo(() => [...history].reverse(), [history]);

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
      validate: (cookie) => ipc.validateCookie(cookie),
      add: addAccount,
      onPhase: setPhase,
    });
    persistHistoryEntry(outcome.historyEntry);

    if (outcome.ok) {
      setPhase('success');
      showSuccess(t('gen.addedToAccounts', { name: outcome.validation.username }));
    } else {
      setFailure(outcome);
      setPhase('error');
      showError(outcome.message);
    }
  }, [addAccount, navigate, persistHistoryEntry, showError, showSuccess, t]);

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
