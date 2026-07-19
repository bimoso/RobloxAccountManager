/**
 * Vitest global setup. Runs once per test file before the suite.
 *
 * - Registers @testing-library/jest-dom matchers (e.g. toBeInTheDocument).
 * - Unmounts React trees rendered by @testing-library/react after each test to
 *   keep tests isolated.
 * - Resets every session cache (`lib/sessionCache.ts`) after each test so a
 *   page rendered by one test never hydrates from data another test cached.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { resetSessionCaches } from '../lib/sessionCache';

afterEach(() => {
  cleanup();
  resetSessionCaches();
});
