// pages/Settings/donutTokenStatus.test.ts
//
// Unit tests for the Donut Browser token status derivation (Requirement 21.4).
// These cover concrete examples and edge cases; the universal masking property
// (Property 40) is exercised separately by the property-based test (task 25.3).

import { describe, expect, it } from 'vitest';
import type { Settings } from '@/types/models';
import { donutTokenStatus, donutTokenStatusLabel } from './donutTokenStatus';

/** Build a minimal settings-like object carrying only `donutApiTokenEnc`. */
function withToken(token: Settings['donutApiTokenEnc']): Pick<Settings, 'donutApiTokenEnc'> {
  return { donutApiTokenEnc: token };
}

describe('donutTokenStatus', () => {
  it('reports "configured" for a non-empty token', () => {
    expect(donutTokenStatus(withToken('enc:abc123'))).toBe('configured');
  });

  it('reports "not-configured" for a null token', () => {
    expect(donutTokenStatus(withToken(null))).toBe('not-configured');
  });

  it('reports "not-configured" for an empty string', () => {
    expect(donutTokenStatus(withToken(''))).toBe('not-configured');
  });

  it('reports "not-configured" for a whitespace-only string', () => {
    expect(donutTokenStatus(withToken('   \t\n'))).toBe('not-configured');
  });

  it('reports "not-configured" for null/undefined settings', () => {
    expect(donutTokenStatus(null)).toBe('not-configured');
    expect(donutTokenStatus(undefined)).toBe('not-configured');
  });

  it('never returns the raw token value', () => {
    const secret = 'super-secret-donut-token';
    const status = donutTokenStatus(withToken(secret));
    expect(status).not.toBe(secret);
    expect([`configured`, `not-configured`]).toContain(status);
  });
});

describe('donutTokenStatusLabel', () => {
  it('maps status to human-readable labels without exposing values', () => {
    expect(donutTokenStatusLabel('configured')).toBe('Configured');
    expect(donutTokenStatusLabel('not-configured')).toBe('Not configured');
  });
});
