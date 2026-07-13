import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { motion, useIsPresent, useReducedMotion } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import './ContextMenu.css';

/** Viewport coordinates at which a {@link ContextMenu} is anchored. */
export interface ContextMenuAnchor {
  /** Distance from the left edge of the viewport, in CSS pixels. */
  x: number;
  /** Distance from the top edge of the viewport, in CSS pixels. */
  y: number;
}

/** A single actionable row in a {@link ContextMenu}. */
export interface ContextMenuItem {
  /** Text shown for the row and exposed as its accessible name. */
  label: string;
  /** Action executed after the menu has requested to close. */
  onSelect: () => void;
  /** Whether the row is non-interactive. @defaultValue false */
  disabled?: boolean;
  /** Renders the row with a destructive accent. @defaultValue false */
  danger?: boolean;
  /** Optional Lucide glyph rendered before the label. */
  icon?: LucideIcon;
  /** Semantic group id; a fine divider is inserted between adjacent groups. */
  section?: string;
  /** Makes this the single visually prominent command. @defaultValue false */
  primary?: boolean;
  /** Renders the action in the dense utility rail. @defaultValue false */
  compact?: boolean;
  /** Short visible label used by compact utility actions. */
  shortLabel?: string;
}

/** Props for the compact operator command palette. */
export interface ContextMenuProps {
  /** Viewport coordinates the menu is positioned at. */
  anchor: ContextMenuAnchor;
  /**
   * Re-resolves a moving trigger in viewport coordinates. When supplied, the
   * menu follows that trigger through nested scrolling and window resizes.
   * Pointer-opened menus can omit it and keep their original click point.
   */
  resolveAnchor?: () => ContextMenuAnchor;
  /** The commands to display, in keyboard-navigation order. */
  items: ContextMenuItem[];
  /** Requests dismissal on selection, outside press, or Escape. */
  onClose: () => void;
  /** Optional account or entity name shown in the palette header. */
  title?: string;
  /** Optional secondary identifier shown below the title. */
  subtitle?: string;
  /** Small uppercase context label above the title. */
  eyebrow?: string;
}

/** Item paired with its position in the original flat command list. */
interface IndexedMenuItem {
  /** Command metadata and callback. */
  item: ContextMenuItem;
  /** Stable flat index used by roving keyboard focus. */
  index: number;
}

/** One contiguous semantic section inside the command palette. */
interface MenuSection {
  /** Semantic section identifier. */
  id: string;
  /** Ordered commands belonging to the section. */
  items: IndexedMenuItem[];
}

/** Preserve item order while collecting adjacent commands into semantic groups. */
function sectionItems(items: ContextMenuItem[]): MenuSection[] {
  return items.reduce<MenuSection[]>((sections, item, index) => {
    const id = item.section ?? 'commands';
    const current = sections.at(-1);
    if (!current || current.id !== id) {
      sections.push({ id, items: [{ item, index }] });
    } else {
      current.items.push({ item, index });
    }
    return sections;
  }, []);
}

/**
 * Compact viewport-anchored command palette used by cards and operational
 * surfaces. It portals to `body`, clamps its unscaled box, manages focus, and
 * supports the standard menu keyboard model.
 */
export function ContextMenu({
  anchor,
  resolveAnchor,
  items,
  onClose,
  title,
  subtitle,
  eyebrow = 'Comandos',
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const geometryFrameRef = useRef<number | null>(null);
  const focusFrameRef = useRef<number | null>(null);
  const liveAnchorRef = useRef<ContextMenuAnchor>(anchor);
  const [pos, setPos] = useState<ContextMenuAnchor>(anchor);
  const reducedMotion = useReducedMotion() ?? false;
  const isPresent = useIsPresent();
  const sections = useMemo(() => sectionItems(items), [items]);

  // Clamp against the real layout box. Entrance scale must not shrink the
  // measurements or the palette will drift past viewport edges on frame one.
  const updatePosition = useCallback(() => {
    const element = menuRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const width = element.offsetWidth || rect.width;
    const height = element.offsetHeight || rect.height;
    const pad = 8;
    const liveAnchor = resolveAnchor?.() ?? anchor;
    liveAnchorRef.current = liveAnchor;
    const maxX = Math.max(pad, window.innerWidth - pad - width);
    const maxY = Math.max(pad, window.innerHeight - pad - height);
    const x = Math.min(Math.max(pad, liveAnchor.x), maxX);
    const y = Math.min(Math.max(pad, liveAnchor.y), maxY);
    setPos((current) => (current.x === x && current.y === y ? current : { x, y }));
  }, [anchor, resolveAnchor]);

  useLayoutEffect(() => {
    updatePosition();
  }, [items.length, updatePosition]);

  // Scroll can fire once per nested scroller and high-resolution trackpads can
  // emit several events inside one frame. Coalesce every geometry read/write
  // into one rAF so following the card never turns into layout thrashing.
  useEffect(() => {
    if (!isPresent) return;
    const schedulePosition = (): void => {
      if (geometryFrameRef.current !== null) return;
      geometryFrameRef.current = window.requestAnimationFrame(() => {
        geometryFrameRef.current = null;
        updatePosition();
      });
    };

    window.addEventListener('resize', schedulePosition);
    window.addEventListener('scroll', schedulePosition, true);
    return () => {
      window.removeEventListener('resize', schedulePosition);
      window.removeEventListener('scroll', schedulePosition, true);
      if (geometryFrameRef.current !== null) {
        window.cancelAnimationFrame(geometryFrameRef.current);
        geometryFrameRef.current = null;
      }
    };
  }, [isPresent, updatePosition]);

  // A menu takes real focus when it opens and gives it back on unmount. This
  // keeps the overflow button and keyboard workflows from losing their place.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const firstEnabled = items.findIndex((item) => !item.disabled);
    if (firstEnabled >= 0) itemRefs.current[firstEnabled]?.focus({ preventScroll: true });

    return () => {
      if (focusFrameRef.current !== null) {
        window.cancelAnimationFrame(focusFrameRef.current);
        focusFrameRef.current = null;
      }
      const previous = previousFocusRef.current;
      const active = document.activeElement;
      if (
        previous?.isConnected &&
        (active === document.body || (active instanceof Node && menu?.contains(active)))
      ) {
        previous.focus({ preventScroll: true });
      }
    };
    // Focus ownership is established once for each mounted menu instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AnimatePresence keeps the portal mounted for its exit. Make that visual
  // ghost inert immediately, then restore focus only if the menu still owns it;
  // a modal opened by a command must keep its newly acquired focus.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    if (isPresent) {
      menu.removeAttribute('inert');
      return;
    }

    menu.setAttribute('inert', '');
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null;
      const previous = previousFocusRef.current;
      const active = document.activeElement;
      if (
        previous?.isConnected &&
        (active === document.body || (active instanceof Node && menu.contains(active)))
      ) {
        previous.focus({ preventScroll: true });
      }
    });
  }, [isPresent]);

  useEffect(() => {
    if (!isPresent) return;
    const handlePointer = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const enabled = items
        .map((item, index) => (item.disabled ? -1 : index))
        .filter((index) => index >= 0);
      if (!enabled.length) return;

      const activeIndex = itemRefs.current.findIndex((element) => element === document.activeElement);
      let nextIndex: number;
      if (event.key === 'Home') {
        nextIndex = enabled[0];
      } else if (event.key === 'End') {
        nextIndex = enabled[enabled.length - 1];
      } else {
        const enabledPosition = enabled.indexOf(activeIndex);
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        const base = enabledPosition >= 0 ? enabledPosition : delta > 0 ? -1 : 0;
        nextIndex = enabled[(base + delta + enabled.length) % enabled.length];
      }
      itemRefs.current[nextIndex]?.focus({ preventScroll: true });
    };

    document.addEventListener('mousedown', handlePointer);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handlePointer);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isPresent, items, onClose]);

  const handleSelect = (item: ContextMenuItem) => {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  };

  const transformOrigin = `${pos.x < liveAnchorRef.current.x ? 'right' : 'left'} ${
    pos.y < liveAnchorRef.current.y ? 'bottom' : 'top'
  }`;

  const menu = (
    <motion.div
      ref={menuRef}
      role="menu"
      aria-label={title ? `Acciones para ${title}` : 'Acciones'}
      className="command-menu"
      data-context-menu-portal="true"
      initial={reducedMotion ? false : { opacity: 0, scale: 0.975, y: -2 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={
        reducedMotion
          ? { opacity: 0, transition: { duration: 0 } }
          : {
              opacity: 0,
              scale: 0.985,
              y: -1,
              transition: { duration: 0.1, ease: [0.4, 0, 1, 1] },
            }
      }
      aria-hidden={isPresent ? undefined : true}
      transition={
        reducedMotion
          ? { duration: 0 }
          : { type: 'spring', stiffness: 520, damping: 38, mass: 0.58 }
      }
      style={{
        top: pos.y,
        left: pos.x,
        transformOrigin,
        pointerEvents: isPresent ? 'auto' : 'none',
      }}
    >
      {(title || subtitle) && (
        <div className="command-menu__header">
          <div className="command-menu__heading">
            <span className="command-menu__eyebrow">{eyebrow}</span>
            {title && <strong title={title}>{title}</strong>}
            {subtitle && <span className="command-menu__subtitle" title={subtitle}>{subtitle}</span>}
          </div>
          <kbd aria-label="Cerrar con Escape">ESC</kbd>
        </div>
      )}

      <div className="command-menu__body">
        {sections.map((section) => {
          const compact = section.items.every(({ item }) => item.compact);
          return (
            <div
              key={`${section.id}-${section.items[0].index}`}
              className={`command-menu__section${compact ? ' command-menu__section--compact' : ''}`}
              role="none"
              data-section={section.id}
            >
              {compact && <span className="command-menu__section-label">Copiar</span>}
              <div className={compact ? 'command-menu__utilities' : 'command-menu__rows'} role="none">
                {section.items.map(({ item, index }) => {
                  const Icon = item.icon;
                  return (
                    <motion.button
                      key={`${item.label}-${index}`}
                      ref={(element) => { itemRefs.current[index] = element; }}
                      type="button"
                      role="menuitem"
                      aria-label={item.label}
                      title={compact ? item.label : undefined}
                      className={[
                        'command-menu__item',
                        compact ? 'command-menu__item--compact' : '',
                        item.primary ? 'is-primary' : '',
                        item.danger ? 'is-danger' : '',
                      ].filter(Boolean).join(' ')}
                      disabled={item.disabled}
                      onClick={() => handleSelect(item)}
                      whileTap={reducedMotion || item.disabled ? undefined : { scale: 0.975 }}
                      transition={{ type: 'spring', stiffness: 560, damping: 38, mass: 0.48 }}
                    >
                      {Icon && <Icon size={compact ? 14 : 15} strokeWidth={2} aria-hidden="true" />}
                      <span>{compact ? item.shortLabel ?? item.label : item.label}</span>
                      {!compact && item.primary && <span className="command-menu__primary-mark" aria-hidden="true" />}
                    </motion.button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );

  // A transformed page/card creates a new fixed-position containing block.
  // Portalling to body keeps viewport client coordinates exact.
  return createPortal(menu, document.body);
}
