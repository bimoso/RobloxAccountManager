import './Switch.css';

/**
 * Props for {@link Switch}, the reusable on/off toggle used by settings such as
 * Anti-AFK, auto-graphics, multi-instance, etc. (design.md → Component_Library).
 *
 * The component is fully controlled: it renders exactly the state given by
 * {@link SwitchProps.checked} and reports every user toggle through
 * {@link SwitchProps.onChange}; it never holds internal on/off state.
 */
export interface SwitchProps {
  /** Whether the switch is currently on. This is a controlled value. */
  checked: boolean;
  /**
   * Called with the *next* checked value whenever the user toggles the switch.
   * The parent is responsible for applying the change and re-rendering with the
   * updated {@link SwitchProps.checked}.
   */
  onChange: (checked: boolean) => void;
  /**
   * Disables interaction and dims the control. A disabled switch never fires
   * {@link SwitchProps.onChange}.
   *
   * @defaultValue false
   */
  disabled?: boolean;
  /**
   * Accessible label describing what the switch controls. Provide this (or an
   * external `<label>` referencing {@link SwitchProps.id}) so the control is
   * understandable to assistive technology.
   */
  'aria-label'?: string;
  /** Optional DOM id, useful when an external `<label htmlFor>` targets it. */
  id?: string;
}

/**
 * Accessible switch control implemented as a `role="switch"` button. Toggling
 * (click or Enter/Space) invokes {@link SwitchProps.onChange} with the negation
 * of the current {@link SwitchProps.checked} value.
 */
export function Switch({
  checked,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`ram-switch${checked ? ' is-checked' : ''}`}
    >
      <span aria-hidden="true" />
    </button>
  );
}
