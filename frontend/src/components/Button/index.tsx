import { forwardRef, type ReactNode } from 'react';
import {
  motion,
  useReducedMotion,
  type HTMLMotionProps,
  type Transition,
  type TargetAndTransition,
} from 'framer-motion';
import './Button.css';

/**
 * Visual style of a {@link Button}.
 *
 * - `'primary'`   — filled accent button for the main action in a context.
 * - `'secondary'` — subdued surface button for secondary actions.
 * - `'ghost'`     — transparent button used for low-emphasis/inline actions.
 * - `'danger'`    — destructive action button (delete, remove, clear).
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * Height of a {@link Button} on the shared row grid.
 *
 * - `'sm'` — `--row-sm` (28px), for toolbar and in-row actions.
 * - `'md'` — `--row` (32px), the default.
 * - `'lg'` — `--row-lg` (36px), matching the field recipe in dialogs.
 */
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * Props for the {@link Button} component.
 *
 * `Button` accepts every standard `<button>` attribute (via
 * {@link HTMLMotionProps}) — for example `onClick`, `disabled`, `aria-*`,
 * `title` and `className` — in addition to the documented props below. The
 * press-animation props (`whileTap`/`transition`) are managed internally and
 * therefore omitted from the public surface.
 */
export interface ButtonProps
  extends Omit<HTMLMotionProps<'button'>, 'whileTap' | 'transition' | 'ref' | 'children'> {
  /** Visual style variant. Defaults to `'primary'`. */
  variant?: ButtonVariant;
  /** Row-grid height. Defaults to `'md'` (`--row`). */
  size?: ButtonSize;
  /**
   * Renders the button as a square at its row height, for buttons whose only
   * content is an icon (the accessible name then comes from `aria-label`).
   *
   * @defaultValue false
   */
  iconOnly?: boolean;
  /**
   * Native button type. Defaults to `'button'` so the component never submits
   * a surrounding form unless explicitly asked to.
   */
  type?: 'button' | 'submit' | 'reset';
  /** Whether the button is disabled. Disabled buttons show no press feedback. */
  disabled?: boolean;
  /** Content rendered inside the button. */
  children: ReactNode;
}

/** Press dip, in seconds — mirrors the `--dur-micro` token. */
const PRESS_DURATION_S = 0.09;

/**
 * A pressable button on the shared control heights.
 *
 * Press feedback is a small scale dip over `--dur-micro` — enough to feel
 * physical, too small to shift anything around it. Under
 * `prefers-reduced-motion` (read through framer-motion's `useReducedMotion`)
 * the dip becomes an instant opacity change instead, satisfying
 * Requirement 6.3.
 *
 * Requirements: 5.3, 6.3.
 *
 * @example
 * ```tsx
 * <Button variant="danger" onClick={() => remove(id)}>Delete</Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    iconOnly = false,
    type = 'button',
    className,
    children,
    ...rest
  },
  ref,
) {
  // `useReducedMotion` can return null before the media query resolves; treat
  // the unresolved state as "motion allowed".
  const reducedMotion = useReducedMotion() ?? false;

  const whileTap: TargetAndTransition = reducedMotion ? { opacity: 0.85 } : { scale: 0.97 };
  const transition: Transition = { duration: reducedMotion ? 0 : PRESS_DURATION_S };

  const classes = [
    'ram-btn',
    `ram-btn--${variant}`,
    size !== 'md' ? `ram-btn--${size}` : null,
    iconOnly ? 'ram-btn--icon' : null,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <motion.button
      ref={ref}
      type={type}
      className={classes}
      whileTap={whileTap}
      transition={transition}
      {...rest}
    >
      {children}
    </motion.button>
  );
});
