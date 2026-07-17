/**
 * i18n/useTranslation.ts — React binding for the Language_System.
 *
 * `useTranslation()` subscribes the component to the language store and
 * returns a `t` function bound to the active language, so any component that
 * renders text re-renders when the user switches languages.
 */
import { useCallback } from 'react';
import { translate, type Language, type MessageKey, type TranslateParams, type Translator } from './index';
import { useLanguageStore } from '../stores/languageStore';

/** Value returned by {@link useTranslation}. */
export interface Translation {
  /** Translate a message key in the active language. */
  t: Translator;
  /** The active interface language. */
  language: Language;
  /** Select a new interface language (cross-fades the UI). */
  setLanguage: (language: Language) => void;
}

/**
 * Subscribe to the active language and get a bound translator.
 *
 * @returns The bound `t` function, the active `language`, and `setLanguage`.
 */
export function useTranslation(): Translation {
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const t = useCallback(
    (key: MessageKey, params?: TranslateParams) => translate(language, key, params),
    [language],
  );
  return { t, language, setLanguage };
}
