import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getPersisted, PERSISTENCE_KEYS } from '@/lib/persistence';
import { BloxGenSettingsPanel } from './index';

function createStorageMock(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    get length() { return values.size; },
  } as Storage;
}

describe('BloxGenSettingsPanel', () => {
  beforeEach(() => vi.stubGlobal('localStorage', createStorageMock()));
  afterEach(() => vi.unstubAllGlobals());

  it('rejects keys without the BLOX- prefix and persists a valid key explicitly', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<BloxGenSettingsPanel onSaved={onSaved} />);

    const input = screen.getByLabelText('Private key');
    await user.type(input, 'not-a-key');
    await user.tab();
    expect(screen.getByText(/must start with BLOX-/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();

    await user.clear(input);
    await user.type(input, 'BLOX-local-test');
    await user.click(screen.getByRole('button', { name: /save key/i }));

    expect(getPersisted(PERSISTENCE_KEYS.bloxgenApiKey)).toBe('BLOX-local-test');
    expect(onSaved).toHaveBeenCalledWith('BLOX-local-test');
    expect(input).toHaveAttribute('type', 'password');
  });
});
