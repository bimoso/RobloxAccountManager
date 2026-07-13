import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dropdown, type DropdownOption } from './index';

type Filter = 'all' | 'running' | 'idle';

const OPTIONS: ReadonlyArray<DropdownOption<Filter>> = [
  { value: 'all', label: 'Todas' },
  { value: 'running', label: 'En ejecución' },
  { value: 'idle', label: 'Inactivas' },
];

describe('Dropdown command filter', () => {
  it('portals the listbox and reports the chosen typed value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <div style={{ transform: 'translateX(240px)' }}>
        <Dropdown options={OPTIONS} value="all" onChange={onChange} aria-label="Filtrar" />
      </div>,
    );

    await user.click(screen.getByRole('combobox', { name: 'Filtrar' }));
    const listbox = screen.getByRole('listbox', { name: 'Filtrar' });
    expect(listbox.parentElement).toBe(document.body);
    await user.click(screen.getByRole('option', { name: 'Inactivas' }));

    expect(onChange).toHaveBeenCalledWith('idle');
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });
  });

  it('supports Arrow navigation and Enter selection', () => {
    const onChange = vi.fn();
    render(<Dropdown options={OPTIONS} value="all" onChange={onChange} aria-label="Filtrar" />);
    const trigger = screen.getByRole('combobox', { name: 'Filtrar' });

    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const listbox = screen.getByRole('listbox', { name: 'Filtrar' });
    fireEvent.keyDown(listbox, { key: 'ArrowDown' });
    fireEvent.keyDown(listbox, { key: 'Enter' });

    expect(onChange).toHaveBeenCalledWith('running');
  });
});
