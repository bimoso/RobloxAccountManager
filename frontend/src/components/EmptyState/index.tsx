import type { CSSProperties, ReactNode } from 'react';

/**
 * Props for {@link EmptyState}, the placeholder shown when a list has nothing to
 * display — both the truly-empty case (Requirement 8.6) and the
 * search/filter "no results" case (Requirement 9.6) (design.md →
 * Component_Library).
 */
export interface EmptyStateProps {
  /** The primary message explaining why nothing is shown. */
  message: string;
  /**
   * Label for an optional call-to-action button (e.g. "Add account", "Clear
   * filters"). The action button is only rendered when both this and
   * {@link EmptyStateProps.onAction} are provided.
   */
  actionLabel?: string;
  /**
   * Handler invoked when the action button is clicked. Only rendered together
   * with {@link EmptyStateProps.actionLabel}.
   */
  onAction?: () => void;
  /** Optional decorative icon/illustration rendered above the message. */
  icon?: ReactNode;
}

const containerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '12px',
  padding: '48px 24px',
  textAlign: 'center',
  color: 'var(--t2)',
};

const messageStyle: CSSProperties = {
  margin: 0,
  fontSize: '15px',
  color: 'var(--t2)',
};

const actionStyle: CSSProperties = {
  padding: '8px 16px',
  border: '1px solid var(--ac)',
  borderRadius: 'var(--r2, 8px)',
  background: 'var(--ac)',
  color: '#fff',
  font: 'inherit',
  cursor: 'pointer',
};

/**
 * Renders a centered empty/no-results placeholder with an optional icon and an
 * optional call-to-action button.
 */
export function EmptyState({ message, actionLabel, onAction, icon }: EmptyStateProps) {
  const showAction = Boolean(actionLabel && onAction);
  return (
    <div style={containerStyle} role="status">
      {icon ? <div aria-hidden="true">{icon}</div> : null}
      <p style={messageStyle}>{message}</p>
      {showAction ? (
        <button type="button" style={actionStyle} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
