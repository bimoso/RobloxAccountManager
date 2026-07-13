import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, ChevronsUpDown } from 'lucide-react';
import './Dropdown.css';

/** A selectable entry in the operational dropdown. */
export interface DropdownOption<T extends string = string> {
  /** Value reported through {@link DropdownProps.onChange}. */
  value: T;
  /** Human-readable option label. */
  label: string;
  /** Prevents this option from being selected. */
  disabled?: boolean;
}

/** Props for the controlled, viewport-aware dropdown. */
export interface DropdownProps<T extends string = string> {
  /** Entries rendered in their supplied order. */
  options: ReadonlyArray<DropdownOption<T>>;
  /** Currently selected value. */
  value: T;
  /** Called after the user chooses an enabled entry. */
  onChange: (value: T) => void;
  /** Disables the complete control. */
  disabled?: boolean;
  /** Optional trigger id for an external label. */
  id?: string;
  /** Accessible name for the combobox trigger. */
  'aria-label'?: string;
}

/** Viewport coordinates calculated for the portaled listbox. */
interface PopupPosition {
  /** Fixed left coordinate in CSS pixels. */
  left: number;
  /** Fixed top coordinate in CSS pixels. */
  top: number;
  /** Popup width, never narrower than the compact menu baseline. */
  width: number;
  /** Whether the listbox had to open above the trigger. */
  openAbove: boolean;
}

const VIEWPORT_GUTTER = 8;
const POPUP_GAP = 6;

/**
 * Compact custom listbox used by command filters. The popup is portaled to the
 * document body so transformed page transitions never offset viewport geometry.
 */
export function Dropdown<T extends string = string>({
  options,
  value,
  onChange,
  disabled = false,
  id,
  'aria-label': ariaLabel,
}: DropdownProps<T>): JSX.Element {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const geometryFrameRef = useRef<number | null>(null);
  const generatedId = useId().replace(/:/g, '');
  const listboxId = `${id ?? `dropdown-${generatedId}`}-listbox`;
  const reducedMotion = useReducedMotion() ?? false;
  const [open, setOpen] = useState(false);
  const [popupMounted, setPopupMounted] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [position, setPosition] = useState<PopupPosition>({
    left: VIEWPORT_GUTTER,
    top: VIEWPORT_GUTTER,
    width: 190,
    openAbove: false,
  });

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const selected = options[selectedIndex] ?? options[0];
  const enabledIndices = useMemo(
    () => options.flatMap((option, index) => (option.disabled ? [] : [index])),
    [options],
  );

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const popupHeight = listRef.current?.offsetHeight ?? Math.min(options.length * 34 + 8, 292);
    const width = Math.max(190, rect.width);
    const left = Math.min(
      Math.max(VIEWPORT_GUTTER, rect.left),
      Math.max(VIEWPORT_GUTTER, window.innerWidth - VIEWPORT_GUTTER - width),
    );
    const roomBelow = window.innerHeight - rect.bottom - VIEWPORT_GUTTER;
    const openAbove = roomBelow < popupHeight + POPUP_GAP && rect.top > roomBelow;
    const top = openAbove
      ? Math.max(VIEWPORT_GUTTER, rect.top - popupHeight - POPUP_GAP)
      : Math.min(rect.bottom + POPUP_GAP, window.innerHeight - VIEWPORT_GUTTER - popupHeight);
    setPosition({ left, top, width, openAbove });
  }, [options.length]);

  const scheduleMeasure = useCallback(() => {
    if (geometryFrameRef.current !== null) return;
    geometryFrameRef.current = window.requestAnimationFrame(() => {
      geometryFrameRef.current = null;
      measure();
    });
  }, [measure]);

  const show = useCallback(() => {
    if (disabled || enabledIndices.length === 0) return;
    setActiveIndex(options[selectedIndex]?.disabled ? enabledIndices[0] : selectedIndex);
    setPopupMounted(true);
    setOpen(true);
  }, [disabled, enabledIndices, options, selectedIndex]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (reducedMotion) setPopupMounted(false);
    if (restoreFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [reducedMotion]);

  const choose = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      close(true);
    },
    [close, onChange, options],
  );

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    listRef.current?.focus({ preventScroll: true });
  }, [measure, open]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !listRef.current?.contains(target)) close();
    };
    const handleGeometry = () => scheduleMeasure();
    document.addEventListener('mousedown', handleOutside);
    window.addEventListener('resize', handleGeometry);
    window.addEventListener('scroll', handleGeometry, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('resize', handleGeometry);
      window.removeEventListener('scroll', handleGeometry, true);
      if (geometryFrameRef.current !== null) {
        window.cancelAnimationFrame(geometryFrameRef.current);
        geometryFrameRef.current = null;
      }
    };
  }, [close, open, scheduleMeasure]);

  const moveActive = (delta: number): void => {
    if (!enabledIndices.length) return;
    const current = enabledIndices.indexOf(activeIndex);
    const base = current >= 0 ? current : 0;
    setActiveIndex(enabledIndices[(base + delta + enabledIndices.length) % enabledIndices.length]);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      show();
    }
  };

  const handleListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActiveIndex(event.key === 'Home' ? enabledIndices[0] : enabledIndices.at(-1) ?? 0);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close();
    }
  };

  const popup = popupMounted ? (
    <motion.div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          className="ui-dropdown__menu"
          data-open-above={position.openAbove ? 'true' : 'false'}
          aria-hidden={open ? undefined : true}
          tabIndex={-1}
          initial={
            reducedMotion
              ? false
              : { opacity: 0, scale: 0.97, y: position.openAbove ? 4 : -4 }
          }
          animate={open
            ? { opacity: 1, scale: 1, y: 0 }
            : { opacity: 0, scale: reducedMotion ? 1 : 0.985, y: 0 }}
          transition={
            reducedMotion
              ? { duration: 0 }
              : open
                ? { type: 'spring', stiffness: 520, damping: 38, mass: 0.58 }
                : { duration: 0.1, ease: [0.4, 0, 1, 1] }
          }
          onAnimationComplete={() => {
            if (!open) setPopupMounted(false);
          }}
          onKeyDown={handleListKeyDown}
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            pointerEvents: open ? 'auto' : 'none',
          }}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            const isActive = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={option.disabled}
                className={`ui-dropdown__option${isActive ? ' is-active' : ''}${
                  isSelected ? ' is-selected' : ''
                }`}
                tabIndex={-1}
                onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                <motion.span
                  className="ui-dropdown__check"
                  aria-hidden="true"
                  animate={{ opacity: isSelected ? 1 : 0, scale: isSelected ? 1 : 0.72 }}
                  transition={
                    reducedMotion
                      ? { duration: 0 }
                      : { type: 'spring', stiffness: 600, damping: 34, mass: 0.45 }
                  }
                >
                  <Check size={13} strokeWidth={2.4} />
                </motion.span>
              </button>
            );
          })}
    </motion.div>
  ) : null;

  return (
    <div className="ui-dropdown">
      <motion.button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        disabled={disabled}
        className="ui-dropdown__trigger"
        onClick={() => (open ? close() : show())}
        onKeyDown={handleTriggerKeyDown}
        whileTap={reducedMotion || disabled ? undefined : { scale: 0.985 }}
        transition={{ type: 'spring', stiffness: 520, damping: 36, mass: 0.5 }}
      >
        <span className="ui-dropdown__value">{selected?.label ?? value}</span>
        <ChevronsUpDown className="ui-dropdown__chevrons" size={14} aria-hidden="true" />
      </motion.button>
      {typeof document !== 'undefined' && createPortal(popup, document.body)}
    </div>
  );
}
