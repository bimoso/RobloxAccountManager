import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CreditsPage } from './index';
import { ipc } from '@/lib/ipc';

vi.mock('@/lib/ipc', () => ({
  ipc: {
    getAvatarThumbnails: vi.fn(() => Promise.resolve({ data: [] })),
    openExternal: vi.fn(() => Promise.resolve()),
  },
}));

describe('Credits Discord avatar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the CDN image by Discord id instead of the display name', () => {
    render(<CreditsPage />);

    const avatar = screen.getByAltText('Bimo Discord');
    expect(avatar).toHaveAttribute(
      'src',
      'https://cdn.discordapp.com/avatars/649501821072834580/1bcb4830c974a6935779ace169d055ad.png?size=256',
    );
    expect(screen.queryByText('D')).not.toBeInTheDocument();
    expect(ipc.getAvatarThumbnails).toHaveBeenCalledWith(['9889370526']);
  });

  it('falls back cleanly when the Discord CDN image cannot load', () => {
    render(<CreditsPage />);
    fireEvent.error(screen.getByAltText('Bimo Discord'));

    expect(screen.queryByAltText('Bimo Discord')).not.toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
  });
});
