import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLogStore, type LogEntry } from '@/stores/logStore';
import { LogsPage } from './index';
import { EMPTY_LOG_MESSAGE } from './presentation';

const ENTRY: LogEntry = {
  ts: new Date('2026-07-12T18:05:09.125Z').getTime(),
  level: 'err',
  category: 'crash',
  message: 'Roblox client exited unexpectedly',
  meta: { account: 'alpha' },
};

describe('LogsPage operational console', () => {
  beforeEach(() => {
    useLogStore.setState({ entries: [] });
  });

  it('keeps the required empty message and gives the user a next action', () => {
    render(<LogsPage />);

    expect(screen.getByText(EMPTY_LOG_MESSAGE)).toBeInTheDocument();
    expect(screen.getByText(/launch an account or open a browser session/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Session capture is active')).toBeInTheDocument();
  });

  it('filters operational rows and opens the searchable console toolbar', async () => {
    useLogStore.setState({ entries: [ENTRY] });
    const user = userEvent.setup();
    render(<LogsPage />);

    expect(screen.getByRole('log', { name: 'Session log' })).toHaveTextContent(
      'Roblox client exited unexpectedly',
    );

    await user.click(screen.getByRole('combobox', { name: 'Filter log level' }));
    await user.click(screen.getByRole('option', { name: 'Information' }));
    expect(screen.getByText('No events match this view.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reset filter' }));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByRole('textbox', { name: 'Find in log' })).toBeInTheDocument();
  });
});
