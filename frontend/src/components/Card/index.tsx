import type { HTMLAttributes, ReactNode } from 'react';
import { useTranslation } from '../../i18n/useTranslation';
import './Card.css';

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

/**
 * Base card surface: the shared `.rk-panel` primitive plus a positioning
 * context and an optional selection control. Selection state is conveyed
 * through both the accent border and the checkable control so it never depends
 * on color alone.
 *
 * The component no longer carries an inline style object. Everything visual
 * lives in real classes, so a page can restyle its own cards (including their
 * transitions) without fighting element-level styles that always win.
 */
export function Card({
  selected = false,
  onSelectToggle,
  draggable = false,
  children,
  className,
  ...rest
}: CardProps) {
  const { t } = useTranslation();
  const classes = ['rk-panel', 'rk-panel__body', 'rk-card', className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      draggable={draggable}
      data-selected={selected ? 'true' : undefined}
      {...rest}
    >
      {onSelectToggle ? (
        <button
          type="button"
          className="card-check"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? t('accounts.card.deselect') : t('accounts.card.select')}
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
