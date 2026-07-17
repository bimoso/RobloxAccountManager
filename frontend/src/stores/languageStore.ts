// stores/languageStore.ts
//
// Language_System store — mirrors the Theme_System store's shape
// (`themeStore.ts`): the active language selection lives in memory, is applied
// to the DOM (`<html lang>`), and is persisted through `lib/persistence.ts`.
//
// Switching languages is wrapped in a document view transition
// (`lib/viewTransition.ts`) so every visible string cross-fades to its
// translation instead of popping. The store state itself is flushed
// synchronously inside the transition callback (via `react-dom`'s `flushSync`)
// so the browser snapshot pair actually brackets the re-render.

import { create } from 'zustand';
import { flushSync } from 'react-dom';
import {
  DEFAULT_LANGUAGE,
  isValidLanguage,
  type Language,
} from '../i18n';
import { withViewTransition } from '../lib/viewTransition';
import { getPersisted, setPersisted, PERSISTENCE_KEYS } from '../lib/persistence';

/**
 * Resolve the language to apply on startup: the persisted `ui-language` value
 * when valid, otherwise the OS/browser language when it is Spanish, otherwise
 * English. Never throws.
 */
export function resolveInitialLanguage(): Language {
  const stored = getPersisted<unknown>(PERSISTENCE_KEYS.language);
  if (isValidLanguage(stored)) {
    return stored;
  }
  try {
    const detected =
      typeof navigator !== 'undefined' ? navigator.language : undefined;
    if (detected?.toLowerCase().startsWith('es')) {
      return 'es';
    }
  } catch {
    // Detection is best-effort only.
  }
  return DEFAULT_LANGUAGE;
}

/**
 * Reflect `language` on `<html lang>` so assistive tech and the OS spellcheck
 * pick the right locale. No-op without a DOM (tests).
 *
 * @param language - The language to apply.
 */
function applyDocumentLanguage(language: Language): void {
  if (typeof document === 'undefined' || !document.documentElement) {
    return;
  }
  document.documentElement.lang = language;
}

/** Public shape of the language store. */
export interface LanguageState {
  /** The active interface language. */
  language: Language;
  /**
   * Select `language`: cross-fade the interface to the new translations (view
   * transition when supported), reflect it on `<html lang>`, and persist the
   * choice. Persistence never throws; a storage failure leaves the in-memory
   * selection active for the session.
   */
  setLanguage: (language: Language) => void;
}

export const useLanguageStore = create<LanguageState>((set, get) => ({
  language: resolveInitialLanguage(),
  setLanguage: (language) => {
    if (!isValidLanguage(language) || language === get().language) {
      return;
    }
    withViewTransition(() => {
      // Flush the store update synchronously so subscribed components re-render
      // inside the view-transition callback (the API snapshots before/after it).
      flushSync(() => {
        set({ language });
      });
      applyDocumentLanguage(language);
    });
    setPersisted(PERSISTENCE_KEYS.language, language);
  },
}));

/**
 * Apply the resolved startup language to the DOM. Call once during app
 * bootstrap so `<html lang>` matches the restored preference.
 */
export function initLanguage(): void {
  applyDocumentLanguage(useLanguageStore.getState().language);
}
