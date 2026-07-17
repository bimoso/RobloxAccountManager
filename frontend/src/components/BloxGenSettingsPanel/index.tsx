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
      className={['bloxgen-settings', className].filter(Boolean).join(' ')}
      aria-labelledby={`${inputId}-title`}
    >
      <div className="bloxgen-settings__heading">
        <span className="bloxgen-settings__icon" aria-hidden="true">
          <KeyRound size={17} strokeWidth={1.8} />
        </span>
        <div>
          <span className="bloxgen-settings__eyebrow">{t('bloxgen.eyebrow')}</span>
          <h3 id={`${inputId}-title`}>{t('bloxgen.title')}</h3>
        </div>
        <span
          className="bloxgen-settings__status"
          data-state={isValidBloxGenApiKey(savedKey) ? 'ready' : 'missing'}
        >
          {isValidBloxGenApiKey(savedKey) ? <Check size={13} /> : <KeyRound size={13} />}
          {isValidBloxGenApiKey(savedKey) ? t('bloxgen.configured') : t('bloxgen.notConfigured')}
        </span>
      </div>

      <p className="bloxgen-settings__copy">
        {t('bloxgen.copy')}
      </p>

      <label className="bloxgen-settings__label" htmlFor={inputId}>
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
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </div>

      <div className="bloxgen-settings__footer">
        <p id={`${inputId}-help`} data-invalid={showError || undefined}>
          {showError
            ? t('bloxgen.invalid')
            : isValidBloxGenApiKey(savedKey)
              ? maskBloxGenApiKey(savedKey)
              : t('bloxgen.format')}
        </p>
        <Button
          variant="secondary"
          className="bloxgen-settings__save"
          disabled={!dirty || !valid}
          onClick={save}
        >
          <Save size={15} aria-hidden="true" />
          {t('bloxgen.save')}
        </Button>
      </div>
    </section>
  );
}

export default BloxGenSettingsPanel;
