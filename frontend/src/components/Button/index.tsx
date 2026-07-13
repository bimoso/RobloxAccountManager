import { forwardRef, type ReactNode } from 'react';
import {
  motion,
  useReducedMotion,
  type HTMLMotionProps,
  type Transition,
  type TargetAndTransition,
} from 'framer-motion';
import { pressFeedbackKind } from '@/lib/animation';
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

/**
 * A pressable button with motion-aware press feedback.
 *
 * The kind of press feedback is chosen by {@link pressFeedbackKind}, driven by
 * the user's `prefers-reduced-motion` setting (read through framer-motion's
 * `useReducedMotion`):
 *
 * - **`'scale'`** (motion allowed) — a brief scale + downward nudge on press,
 *   released by a tightly damped spring so rapid clicks remain interruptible.
 * - **`'color'`** (reduced motion) — an instant opacity change on press with
 *   **no** scaling or vertical movement, satisfying Requirement 6.3.
 *
 * Requirements: 5.3, 6.3.
 *
 * @example
 * ```tsx
 * <Button variant="danger" onClick={() => remove(id)}>Delete</Button>
 * ```
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', type = 'button', className, children, ...rest },
  ref,
) {
  // `useReducedMotion` can return null before the media query resolves; treat
  // the unresolved state as "motion allowed".
  const reducedMotion = useReducedMotion() ?? false;
  const kind = pressFeedbackKind(reducedMotion);

  // 'scale': animate transform only (scale + tiny vertical nudge).
  // 'color': animate opacity only — no scale, no vertical movement (Req 6.3).
  const whileTap: TargetAndTransition =
    kind === 'scale' ? { scale: 0.96, y: 1 } : { opacity: 0.72 };

  // A Kinetics-style spring gives immediate feedback without a second CSS
  // transition fighting Motion's compositor transform. Reduced motion still
  // collapses to an instant (0ms) color change.
  const transition: Transition =
    kind === 'scale'
      ? { type: 'spring', stiffness: 440, damping: 32, mass: 0.62 }
      : { duration: 0 };

  const classes = ['ram-btn', `ram-btn--${variant}`, className]
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
