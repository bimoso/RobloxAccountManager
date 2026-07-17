/**
 * i18n/index.ts — Language_System core.
 *
 * A deliberately small, dependency-free translation layer:
 * - Two dictionaries (`en.ts`, `es.ts`) share a compile-checked key union.
 * - `translate()` is a pure function (language, key, params) → string, so it
 *   can be unit-tested without React or the DOM.
 * - React components consume it through the `useTranslation()` hook, which
 *   re-renders on language change (see `i18n/useTranslation.ts`).
 */
import { en, type MessageKey } from './en';
import { es } from './es';

export type { MessageKey } from './en';

/** The selectable interface languages. */
export type Language = 'en' | 'es';

/** Every selectable language, in switcher order. */
export const LANGUAGES: readonly Language[] = ['en', 'es'] as const;

/** The language applied when nothing valid is persisted or detectable. */
export const DEFAULT_LANGUAGE: Language = 'en';

/** Values that may be interpolated into a message template. */
export type TranslateParams = Record<string, string | number>;

const DICTIONARIES: Record<Language, Record<MessageKey, string>> = { en, es };

/**
 * Type guard: `true` iff `value` names a selectable language.
 *
 * @param value - Any value read from storage or user input.
 */
export function isValidLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

/**
 * Resolve `key` in `language`, interpolating `{name}` placeholders from
 * `params`. Missing keys fall back to English, then to the key itself, so a
 * translation gap can never crash rendering.
 *
 * @param language - Target language.
 * @param key - Message key (see `en.ts`).
 * @param params - Optional `{placeholder: value}` interpolations.
 */
export function translate(
  language: Language,
  key: MessageKey,
  params?: TranslateParams,
): string {
  const template = DICTIONARIES[language][key] ?? en[key] ?? key;
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Signature of a bound translation function (as returned by `useTranslation`). */
export type Translator = (key: MessageKey, params?: TranslateParams) => string;
