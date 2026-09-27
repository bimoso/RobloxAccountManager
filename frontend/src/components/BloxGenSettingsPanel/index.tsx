import { useEffect, useId, useState } from 'react';
import { Check, Eye, EyeOff, KeyRound, Save } from 'lucide-react';
import { Button } from '@/components/Button';
import {
  getPersisted,
  PERSISTENCE_KEYS,
  setPersisted,
} from '@/lib/persistence';
import {
  BLOXGEN_KEY_CHANGED_EVENT,
  isValidBloxGenApiKey,
  maskBloxGenApiKey,
} from '@/lib/bloxgen';
import { useToastStore } from '@/stores/toastStore';
import { useTranslation } from '@/i18n/useTranslation';
import './BloxGenSettingsPanel.css';

export { BLOXGEN_KEY_CHANGED_EVENT } from '@/lib/bloxgen';

/** Optional integration hooks for the BloxGen settings editor. */
export interface BloxGenSettingsPanelProps {
  /** Optional class appended to the component root. */
  className?: string;
  /** Called after a valid credential is persisted. */
  onSaved?: (apiKey: string) => void;
}

/**
 * Settings-owned editor for the local BloxGen credential.
 *
 * The key stays masked by default and is persisted only after explicit save.
 * Generator consumes the same persistence key but never renders an editor.
 *
 * RACKLINE: the surface is the shared `.rk-panel` (one hairline, one surface,
 * no shadow — it rests on the rack rather than floating above it), the
 * configured/not-configured badge is the shared `.rk-chip` with a data tone,
 * and the credential field uses the one field recipe.
 */
export function BloxGenSettingsPanel({
  className,
  onSaved,
}: BloxGenSettingsPanelProps): JSX.Element {
  const inputId = useId();
  const [savedKey, setSavedKey] = useState('');
  const [draft, setDraft] = useState('');
  const [visible, setVisible] = useState(false);
  const [touched, setTouched] = useState(false);
  const showSuccess = useToastStore((state) => state.showSuccess);
  const { t } = useTranslation();

  useEffect(() => {
    const persisted = getPersisted<string>(PERSISTENCE_KEYS.bloxgenApiKey);
    const value = typeof persisted === 'string' ? persisted : '';
    setSavedKey(value);
    setDraft(value);
  }, []);

  const trimmed = draft.trim();
  const valid = isValidBloxGenApiKey(trimmed);
  const dirty = trimmed !== savedKey.trim();
  const showError = touched && !valid;
  const configured = isValidBloxGenApiKey(savedKey);

  const save = (): void => {
    setTouched(true);
    if (!valid) return;
    setPersisted(PERSISTENCE_KEYS.bloxgenApiKey, trimmed);
    setSavedKey(trimmed);
    setDraft(trimmed);
    window.dispatchEvent(new Event(BLOXGEN_KEY_CHANGED_EVENT));
    onSaved?.(trimmed);
    showSuccess(t('bloxgen.saved'));
  };

  return (
    <section
      className={['bloxgen-settings', 'rk-panel', className].filter(Boolean).join(' ')}
      aria-labelledby={`${inputId}-title`}
    >
      <div className="rk-panel__head bloxgen-settings__head">
        <span className="bloxgen-settings__icon" aria-hidden="true">
          <KeyRound size={15} />
        </span>
        <div className="bloxgen-settings__titles">
          <span className="rk-eyebrow">{t('bloxgen.eyebrow')}</span>
          <h3 id={`${inputId}-title`} className="rk-panel__title">
            {t('bloxgen.title')}
          </h3>
        </div>
        <span className="rk-chip" data-tone={configured ? 'ok' : 'neutral'}>
          {configured ? <Check size={11} aria-hidden="true" /> : <KeyRound size={11} aria-hidden="true" />}
          {configured ? t('bloxgen.configured') : t('bloxgen.notConfigured')}
        </span>
      </div>

      <div className="rk-panel__body bloxgen-settings__body">
        <p className="bloxgen-settings__copy">
          {t('bloxgen.copy')}
        </p>

        <label className="fm-label bloxgen-settings__label" htmlFor={inputId}>
          {t('bloxgen.keyLabel')}
        </label>
        <div className="bloxgen-settings__field" data-invalid={showError || undefined}>
          <input
            id={inputId}
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            placeholder="BLOX-…"
            aria-invalid={showError}
            aria-describedby={`${inputId}-help`}
            onBlur={() => setTouched(true)}
            onChange={(event) => {
              setDraft(event.target.value);
              if (touched) setTouched(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') save();
            }}
          />
          <button
            type="button"
            className="bloxgen-settings__reveal"
            aria-label={visible ? t('bloxgen.hide') : t('bloxgen.show')}
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>

        <div className="bloxgen-settings__footer">
          <p
            id={`${inputId}-help`}
            className="bloxgen-settings__help"
            data-invalid={showError || undefined}
          >
            {showError
              ? t('bloxgen.invalid')
              : configured
                ? maskBloxGenApiKey(savedKey)
                : t('bloxgen.format')}
          </p>
          <Button
            variant="secondary"
            size="lg"
            className="bloxgen-settings__save"
            disabled={!dirty || !valid}
            onClick={save}
          >
            <Save size={14} aria-hidden="true" />
            {t('bloxgen.save')}
          </Button>
        </div>
      </div>
    </section>
  );
}

export default BloxGenSettingsPanel;
