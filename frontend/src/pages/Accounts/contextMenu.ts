// pages/Accounts/contextMenu.ts
//
// Pure item-list generation for the per-account context menu (Requirement
// 12.1) plus a thin binding helper that attaches action handlers.
//
// The design deliberately separates *which* items appear (and their labels /
// danger accent) from *what happens* when they are chosen:
//
//  - `contextMenuItems(launched)` is a PURE function of the launch state. It
//    returns ordered {@link ContextMenuItemDescriptor}s (stable `id` + `label`
//    + `danger`) and holds no handlers, so it can be property-tested in
//    isolation. This is the function exercised by Property 24 ("Ítems del menú
//    contextual según estado de lanzamiento"): the "matar instancia" item is
//    present *iff* `launched`, while every other fixed item appears exactly
//    once regardless of `launched`.
//  - `buildContextMenuItems(launched, handlers)` binds those descriptors to a
//    map of handlers, producing the `ContextMenuItem[]` the `ContextMenu`
//    component consumes. Wiring is intentionally kept out of the pure part.

import type { ContextMenuItem } from '@/components/ContextMenu';
import {
  AtSign,
  CirclePlay,
  CircleStop,
  Cookie,
  Globe2,
  Hash,
  KeyRound,
  LockKeyhole,
  PencilLine,
  UserPen,
  UserPlus,
} from 'lucide-react';

/**
 * Stable identifier for each context-menu action.
 *
 * Ids (not labels) are the identity of an item: the "launch/relaunch" row keeps
 * the single id `'launch'` whether its label reads "Lanzar" or "Relanzar", so
 * presence can be reasoned about independently of the display text.
 */
export type ContextMenuActionId =
  | 'kill'
  | 'launch'
  | 'edit'
  | 'openBrowser'
  | 'quickLogin'
  | 'friendRequest'
  | 'changeDisplayName'
  | 'changePassword'
  | 'copyUserId'
  | 'copyUsername'
  | 'copyCookie';

/**
 * A pure description of a single context-menu row: its stable {@link
 * ContextMenuActionId}, the text to show, and whether it carries a destructive
 * (danger) accent. Deliberately free of any `onSelect` handler so the item set
 * can be generated and tested without side effects.
 */
export interface ContextMenuItemDescriptor {
  /** Stable identity of the action (independent of the label). */
  id: ContextMenuActionId;
  /** Text shown for the row. */
  label: string;
  /** Renders the row with a destructive accent. @defaultValue false */
  danger?: boolean;
  /** Lucide glyph carried into the visual command palette. */
  icon: ContextMenuItem['icon'];
  /** Semantic group used to separate related commands. */
  section: 'session' | 'account' | 'identity' | 'copy';
  /** Marks the single high-priority command. @defaultValue false */
  primary?: boolean;
  /** Renders the command in the dense utility rail. @defaultValue false */
  compact?: boolean;
  /** Short visual label for compact utilities; the accessible label stays intact. */
  shortLabel?: string;
}

/**
 * The ten fixed items that always appear in a per-account context menu, in
 * display order, regardless of the account's launch state (Requirement 12.1).
 * The "kill instance" item is intentionally NOT in this list; it is prepended
 * only when the account is launched.
 */
const FIXED_ITEMS: readonly ContextMenuItemDescriptor[] = [
  { id: 'edit', label: 'Editar cuenta', icon: PencilLine, section: 'account' },
  { id: 'openBrowser', label: 'Abrir en navegador', icon: Globe2, section: 'account' },
  { id: 'quickLogin', label: 'Quick login', icon: KeyRound, section: 'account' },
  { id: 'friendRequest', label: 'Enviar solicitud de amistad', icon: UserPlus, section: 'identity' },
  { id: 'changeDisplayName', label: 'Cambiar nombre de display', icon: UserPen, section: 'identity' },
  { id: 'changePassword', label: 'Cambiar contraseña', icon: LockKeyhole, section: 'identity' },
  {
    id: 'copyUserId',
    label: 'Copiar ID de usuario',
    icon: Hash,
    section: 'copy',
    compact: true,
    shortLabel: 'UID',
  },
  {
    id: 'copyUsername',
    label: 'Copiar nombre de usuario',
    icon: AtSign,
    section: 'copy',
    compact: true,
    shortLabel: 'USER',
  },
  {
    id: 'copyCookie',
    label: 'Copiar cookie',
    icon: Cookie,
    section: 'copy',
    compact: true,
    shortLabel: 'COOKIE',
  },
];

/**
 * The per-account context-menu items for a given launch state (Requirement
 * 12.1). Pure: depends only on `launched` and produces fresh descriptor objects
 * on every call.
 *
 * Composition (validated by Property 24):
 * - `'kill'` ("Matar instancia") is present **iff** `launched` is `true`, and
 *   is always the first row when present.
 * - `'launch'` is always present exactly once; its label reflects the state
 *   ("Relanzar" when launched, otherwise "Lanzar") but its id is invariant.
 * - Every other fixed item ({@link FIXED_ITEMS}) is present exactly once,
 *   independent of `launched`.
 *
 * @param launched - Whether the account currently has a launched instance.
 * @returns The ordered, side-effect-free item descriptors for the menu.
 */
export function contextMenuItems(launched: boolean): ContextMenuItemDescriptor[] {
  const items: ContextMenuItemDescriptor[] = [];
  if (launched) {
    items.push({
      id: 'kill',
      label: 'Matar instancia',
      icon: CircleStop,
      section: 'session',
      danger: true,
    });
  }
  items.push({
    id: 'launch',
    label: launched ? 'Relanzar' : 'Lanzar',
    icon: CirclePlay,
    section: 'session',
    primary: true,
  });
  items.push(...FIXED_ITEMS.map((item) => ({ ...item })));
  return items;
}

/**
 * A map from each possible {@link ContextMenuActionId} to the action to run
 * when that row is chosen. Every id must be provided so the produced menu never
 * has a row without an action.
 */
export type ContextMenuHandlers = Record<ContextMenuActionId, () => void>;

/**
 * Binds the pure {@link contextMenuItems} descriptors to their handlers,
 * producing the `ContextMenuItem[]` consumed by the `ContextMenu` component.
 *
 * The presence and order of rows is entirely delegated to
 * {@link contextMenuItems} (so Property 24 governs it); this helper only
 * attaches `onSelect` from `handlers` keyed by the descriptor's stable id.
 *
 * @param launched - Whether the account currently has a launched instance.
 * @param handlers - Action to run for each {@link ContextMenuActionId}.
 * @returns The bound menu items, in display order.
 */
export function buildContextMenuItems(
  launched: boolean,
  handlers: ContextMenuHandlers,
): ContextMenuItem[] {
  return contextMenuItems(launched).map((descriptor) => ({
    label: descriptor.label,
    danger: descriptor.danger,
    icon: descriptor.icon,
    section: descriptor.section,
    primary: descriptor.primary,
    compact: descriptor.compact,
    shortLabel: descriptor.shortLabel,
    onSelect: handlers[descriptor.id],
  }));
}
