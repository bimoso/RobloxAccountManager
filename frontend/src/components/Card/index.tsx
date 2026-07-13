import type { CSSProperties, HTMLAttributes, ReactNode } from 'react';

/**
 * Props for {@link Card}, the base surface reused by the Accounts, Packages and
 * Charts pages (design.md → Component_Library).
 *
 * `CardProps` extends the intrinsic `<div>` attributes, so any standard DOM
 * prop (`className`, `style`, `onClick`, `data-*`, drag handlers, ARIA
 * attributes, …) is accepted and forwarded to the underlying element.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /**
   * Whether the card is currently part of a multi-selection. When `true` the
   * card renders a highlighted accent border so the selected state is
   * distinguishable without relying on color alone.
   *
   * @defaultValue false
   */
  selected?: boolean;
  /**
   * Invoked when the user toggles this card's selection via the built-in
   * selection control. When omitted, no selection affordance is rendered and
   * the card behaves as a plain surface.
   */
  onSelectToggle?: () => void;
  /**
   * Whether the card can be dragged, used by drag-to-reorder on the Accounts
   * page. Maps directly to the DOM `draggable` attribute.
   *
   * @defaultValue false
   */
  draggable?: boolean;
  /** Content rendered inside the card. */
  children?: ReactNode;
}

const baseStyle: CSSProperties = {
  position: 'relative',
  background: 'var(--glass-2, var(--s2))',
  border: '1px solid var(--bd)',
  borderRadius: 'var(--r, 12px)',
  padding: '14px',
  color: 'var(--t1)',
  boxSizing: 'border-box',
  transition: 'border-color var(--dur, 180ms) var(--ease), box-shadow var(--dur, 180ms) var(--ease)',
};

const selectedStyle: CSSProperties = {
  borderColor: 'var(--ac)',
  boxShadow: '0 0 0 1px var(--ac), 0 0 0 4px var(--ac2)',
};

const toggleStyle: CSSProperties = {
  position: 'absolute',
  top: '8px',
  right: '8px',
  width: '20px',
  height: '20px',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 0,
  borderRadius: '6px',
  border: '1px solid var(--bd2)',
  background: 'var(--s3)',
  color: 'var(--t1)',
  cursor: 'pointer',
  lineHeight: 1,
  fontSize: '13px',
};

/**
 * Base card surface. Provides consistent padding, radius and border styling and
 * an optional selection control. Selection state is conveyed through both the
 * accent border and the checkable control so it never depends on color alone.
 */
export function Card({
  selected = false,
  onSelectToggle,
  draggable = false,
  children,
  className,
  style,
  ...rest
}: CardProps) {
  return (
    <div
      className={className}
      draggable={draggable}
      data-selected={selected ? 'true' : undefined}
      style={{ ...baseStyle, ...(selected ? selectedStyle : null), ...style }}
      {...rest}
    >
      {onSelectToggle ? (
        <button
          type="button"
          className="card-check"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? 'Deselect' : 'Select'}
          style={{
            ...toggleStyle,
            ...(selected ? { background: 'var(--ac)', borderColor: 'var(--ac)', color: '#fff' } : null),
          }}
          onClick={(event) => {
            // The toggle control owns selection; don't let the click bubble to
            // a card-level onClick handler (e.g. "open details").
            event.stopPropagation();
            onSelectToggle();
          }}
        >
          {selected ? '✓' : ''}
        </button>
      ) : null}
      {children}
    </div>
  );
}
