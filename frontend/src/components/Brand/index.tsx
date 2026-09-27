import { useId } from 'react';
import './Brand.css';

/** Props for {@link RamLogo}. */
export interface RamLogoProps {
  /** Rendered edge length in px. @defaultValue 28 */
  size?: number;
  /** Extra class names for the outer svg. */
  className?: string;
}

/**
 * The RAM mark: a memory module (the name's own pun) on an accent tile.
 *
 * The tile is painted from the live theme tokens, so the mark follows every
 * palette instead of shipping one fixed colour. Gradient ids come from
 * {@link useId} because the mark can be on screen more than once.
 */
export function RamLogo({ size = 28, className }: RamLogoProps): JSX.Element {
  const id = useId().replace(/:/g, '');
  const tile = 'ram-logo-tile-' + id;
  const shine = 'ram-logo-shine-' + id;
  return (
    <svg
      className={['ram-logo', className].filter(Boolean).join(' ')}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={tile} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--ac)' }} />
          <stop offset="1" style={{ stopColor: 'var(--acC)' }} />
        </linearGradient>
        <linearGradient id={shine} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={'url(#' + tile + ')'} />
      <rect width="32" height="32" rx="9" fill={'url(#' + shine + ')'} />
      {/* The module: a board with three chips and a row of contacts. */}
      <rect x="5.5" y="8.5" width="21" height="11.5" rx="2.6" fill="#fff" />
      <rect x="8.25" y="11.25" width="4.25" height="6" rx="1.1" fill={'url(#' + tile + ')'} />
      <rect x="13.9" y="11.25" width="4.25" height="6" rx="1.1" fill={'url(#' + tile + ')'} />
      <rect x="19.5" y="11.25" width="4.25" height="6" rx="1.1" fill={'url(#' + tile + ')'} />
      <path
        d="M8.6 22.6v2.2M11.2 22.6v2.2M13.8 22.6v2.2M18.2 22.6v2.2M20.8 22.6v2.2M23.4 22.6v2.2"
        stroke="#fff"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.9"
      />
    </svg>
  );
}

/** Props for {@link RamWordmark}. */
export interface RamWordmarkProps {
  /** Extra class names. */
  className?: string;
}

/** The "RAM" wordmark, set in the display face. */
export function RamWordmark({ className }: RamWordmarkProps): JSX.Element {
  return <span className={['ram-wordmark', className].filter(Boolean).join(' ')}>RAM</span>;
}

