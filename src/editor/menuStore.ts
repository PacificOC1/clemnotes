/**
 * A one-slot registry letting the app-level popup menus (slash commands, the
 * `[[` link picker) claim the arrow keys and Enter from whichever rem editor
 * currently has focus.
 *
 * Every bullet is its own Tiptap instance, so wiring a menu into each editor's
 * keymap would mean hundreds of duplicated plugins. Instead there is exactly
 * one menu on screen at a time; it registers its key handler here, and each
 * editor's `handleKeyDown` offers the event to that handler first. Returning
 * true means the menu consumed the key.
 */

export type MenuKeyHandler = (event: KeyboardEvent) => boolean;

let handler: MenuKeyHandler | null = null;

export function setMenuKeyHandler(next: MenuKeyHandler | null): void {
  handler = next;
}

export function handleMenuKey(event: KeyboardEvent): boolean {
  return handler ? handler(event) : false;
}

export function isMenuOpen(): boolean {
  return handler !== null;
}
