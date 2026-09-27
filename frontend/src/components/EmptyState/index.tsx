import type { ReactNode } from 'react';
import { Button } from '../Button';

/**
 * Props for {@link EmptyState}, the placeholder shown when a list has nothing to
 * display — both the truly-empty case (Requirement 8.6) and the search/filter
 * "no results" case (Requirement 9.6).
 */
export interface EmptyStateProps {
  /** The message explaining why nothing is shown and what to do next. */
  message: string;
  /** Optional headline above the message. */
  title?: string;
  /**
   * Label for an optional call-to-action button. Only rendered when both this
   * and {@link EmptyStateProps.onAction} are provided.
   */
  actionLabel?: string;
  /** Handler invoked when the action button is clicked. */
  onAction?: () => void;
  /**
   * Visual weight of the call to action: primary when it is the one thing to
   * do on an empty page, secondary for a recovery action like clearing filters.
   *
   * @defaultValue 'secondary'
   */
  actionVariant?: 'primary' | 'secondary';
  /** Optional decorative icon rendered above the message. */
  icon?: ReactNode;
}

/**
 * Renders a centered empty/no-results placeholder with an optional icon,
 * headline and call to action, on the shared .rk-empty recipe.
 */
export function EmptyState({
  message,
  title,
  actionLabel,
  onAction,
  actionVariant = 'secondary',
  icon,
}: EmptyStateProps) {
  const showAction = Boolean(actionLabel && onAction);
  return (
    <div className="rk-empty" role="status">
      {icon ? (
        <div className="rk-empty__icon" aria-hidden="true">
          {icon}
        </div>
      ) : null}
      {title ? <h2 className="rk-empty__title">{title}</h2> : null}
      <p className="rk-empty__text">{message}</p>
      {showAction ? (
        <Button variant={actionVariant} onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </div>
  );
}

