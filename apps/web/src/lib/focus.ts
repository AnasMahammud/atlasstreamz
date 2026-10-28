/**
 * Spatial navigation for remotes and keyboards.
 *
 * Any visible element with `data-focusable` (or a native button/link/input inside the app)
 * is a target. Arrow keys move to the nearest target in that direction, weighting
 * alignment on the cross axis heavily so moving down a column of shelves feels natural.
 *
 * Zones (`data-focus-zone="id"`) remember their last focused child: moving back into a
 * shelf restores the card you left, like Apple TV. A zone can also be a trap
 * (`data-focus-trap`) for dialogs and the player overlay.
 *
 * Back (Escape, Backspace, BrowserBack, TV back keycodes) runs the top handler on the back
 * stack, falling back to history.back().
 */

import { inWebOsApp, leaveWebOsApp } from './device.ts';

type Dir = 'up' | 'down' | 'left' | 'right';

const SELECTOR = '[data-focusable], button:not([disabled]):not([tabindex="-1"]), a[href], input:not([type="hidden"]):not([disabled]), select, textarea, [tabindex="0"]';

const zoneMemory = new Map<string, HTMLElement>();
const backStack: Array<() => boolean | void> = [];

const KEY_DIR: Record<string, Dir> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'Back']);
const BACK_CODES = new Set([10009 /* Tizen */, 461 /* webOS */, 8 /* legacy backspace */]);

function isVisible(el: HTMLElement, viewport: DOMRect): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  // Allow off-screen targets within a generous margin so shelves can scroll into them.
  if (r.bottom < -viewport.height || r.top > viewport.height * 2) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && !el.closest('[inert],[aria-hidden="true"]');
}

function candidates(scope: ParentNode): HTMLElement[] {
  const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  return Array.from(scope.querySelectorAll<HTMLElement>(SELECTOR)).filter((el) => !el.hasAttribute('data-focus-skip') && isVisible(el, viewport));
}

function activeScope(): ParentNode {
  const traps = document.querySelectorAll<HTMLElement>('[data-focus-trap]');
  return traps.length ? traps[traps.length - 1] : document;
}

function center(r: DOMRect) {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Score a move from `from` to `to`: lower is better, Infinity means "not in that direction". */
function score(dir: Dir, from: DOMRect, to: DOMRect): number {
  const f = center(from);
  const t = center(to);
  let primary: number;
  let cross: number;
  switch (dir) {
    case 'right':
      if (to.left < from.right - from.width * 0.3 && t.x <= f.x + 1) return Infinity;
      primary = Math.max(0, to.left - from.right);
      cross = overlap(from.top, from.bottom, to.top, to.bottom) > 0 ? 0 : Math.abs(t.y - f.y);
      break;
    case 'left':
      if (to.right > from.left + from.width * 0.3 && t.x >= f.x - 1) return Infinity;
      primary = Math.max(0, from.left - to.right);
      cross = overlap(from.top, from.bottom, to.top, to.bottom) > 0 ? 0 : Math.abs(t.y - f.y);
      break;
    case 'down':
      if (to.top < from.bottom - from.height * 0.3 && t.y <= f.y + 1) return Infinity;
      primary = Math.max(0, to.top - from.bottom);
      cross = overlap(from.left, from.right, to.left, to.right) > 0 ? Math.abs(t.x - f.x) * 0.15 : Math.abs(t.x - f.x);
      break;
    case 'up':
      if (to.bottom > from.top + from.height * 0.3 && t.y >= f.y - 1) return Infinity;
      primary = Math.max(0, from.top - to.bottom);
      cross = overlap(from.left, from.right, to.left, to.right) > 0 ? Math.abs(t.x - f.x) * 0.15 : Math.abs(t.x - f.x);
      break;
  }
  return primary + cross * 2.2;
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function zoneOf(el: Element | null): HTMLElement | null {
  return (el?.closest('[data-focus-zone]') as HTMLElement | null) ?? null;
}

/** The last focused element outside the TV side menu, to return to when leaving it. */
let lastContentFocus: HTMLElement | null = null;

export function focusElement(el: HTMLElement | null | undefined, opts: { scroll?: boolean } = {}): boolean {
  if (!el) return false;
  el.focus({ preventScroll: true });
  if (document.activeElement !== el) return false;
  const zone = zoneOf(el);
  if (zone?.dataset.focusZone) zoneMemory.set(zone.dataset.focusZone, el);
  if (!el.closest('[data-rail]')) lastContentFocus = el;
  if (opts.scroll !== false) revealElement(el);
  return true;
}

const isTv = () => document.documentElement.dataset.device === 'tv';

/**
 * TV scrolling: instant and predictable. The focused card is pinned to the left of its row
 * and the focused row sits near the top of the screen, so the remote never "loses" focus and
 * a weak TV doesn't have to animate long smooth scrolls. Uses the plain numeric scroll APIs,
 * which every TV WebView supports.
 */
function revealOnTv(el: HTMLElement): void {
  if (el.closest('[data-rail]')) return;
  const shelf = el.closest<HTMLElement>('[data-shelf]');
  if (shelf) {
    const pad = parseFloat(getComputedStyle(shelf).paddingLeft) || 0;
    shelf.scrollLeft = Math.max(0, el.offsetLeft - pad);
  }
  const scroller = el.closest<HTMLElement>('[data-scroll-y]');
  if (scroller) {
    const r = el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    if (r.top < sr.top + 20 || r.bottom > sr.bottom - 20) scroller.scrollTop += r.top - sr.top - sr.height * 0.3;
    return;
  }
  if (el.closest('[data-reveal-top]')) {
    window.scrollTo(0, 0);
    return;
  }
  const vh = window.innerHeight;
  const row = el.closest<HTMLElement>('section, .vgrid-row, .guide-row, .page-header, .chip-rail') ?? el;
  const rowTop = row.getBoundingClientRect().top;
  const r = el.getBoundingClientRect();
  // Keep the whole row, title included, comfortably on screen.
  if (rowTop < vh * 0.08 || r.bottom > vh * 0.92) {
    window.scrollTo(0, Math.max(0, window.scrollY + rowTop - vh * 0.12));
  }
  // Fallback for any WebView that ignored the scroll.
  const after = el.getBoundingClientRect();
  if (after.bottom < 0 || after.top > vh) el.scrollIntoView({ block: 'center', inline: 'nearest' });
}

/** Bring the focused element into view: shelves scroll horizontally, the page vertically. */
export function revealElement(el: HTMLElement): void {
  if (isTv()) return revealOnTv(el);
  const shelf = el.closest<HTMLElement>('[data-shelf]');
  const smooth = document.documentElement.dataset.motion === 'reduced' ? 'auto' : 'smooth';
  if (shelf) {
    const pad = parseFloat(getComputedStyle(shelf).paddingLeft) || 0;
    const left = el.offsetLeft - pad;
    const r = el.getBoundingClientRect();
    const sr = shelf.getBoundingClientRect();
    if (r.left < sr.left + pad || r.right > sr.right - pad * 0.5) shelf.scrollTo({ left: Math.max(0, left), behavior: smooth });
  }
  const scroller = el.closest<HTMLElement>('[data-scroll-y]');
  const r = el.getBoundingClientRect();
  if (scroller) {
    const sr = scroller.getBoundingClientRect();
    if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) scroller.scrollBy({ top: r.top - sr.top - sr.height * 0.35, behavior: smooth });
    return;
  }
  const navH = 96;
  const vh = window.innerHeight;
  // The hero is revealed fully when returning to the top of the page.
  if (el.closest('[data-reveal-top]')) {
    window.scrollTo({ top: 0, behavior: smooth });
    return;
  }
  if (r.top < navH || r.bottom > vh - 24) {
    const target = window.scrollY + r.top - Math.max(navH + 20, vh * 0.28);
    window.scrollTo({ top: Math.max(0, target), behavior: smooth });
  }
}

export function move(dir: Dir): boolean {
  const scope = activeScope();
  const current = document.activeElement as HTMLElement | null;
  const list = candidates(scope);
  if (!list.length) return false;
  if (!current || current === document.body || !scope.contains(current)) {
    return focusElement(list.find((el) => el.hasAttribute('data-autofocus')) ?? list[0]);
  }
  // Inputs keep left/right for the caret.
  if ((current.tagName === 'INPUT' || current.tagName === 'TEXTAREA') && (dir === 'left' || dir === 'right')) {
    const input = current as HTMLInputElement;
    const atEdge = dir === 'left' ? input.selectionStart === 0 : input.selectionEnd === input.value.length;
    if (!atEdge) return false;
  }
  const from = current.getBoundingClientRect();
  const currentZone = zoneOf(current);
  // TV side menu: Up/Down stay inside it (or inside the page); only Left enters it and only
  // Right leaves it, like the Fire TV / Android TV home screens.
  const rail = document.querySelector<HTMLElement>('[data-rail]');
  const inRail = !!rail && rail.contains(current);
  if (inRail && dir === 'left') return true;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of list) {
    if (el === current) continue;
    if (rail && (dir === 'up' || dir === 'down') && rail.contains(el) !== inRail) continue;
    if (inRail && dir === 'right' && rail!.contains(el)) continue;
    const s = score(dir, from, el.getBoundingClientRect());
    if (s < bestScore) {
      bestScore = s;
      best = el;
    }
  }
  if (!best) return false;
  const targetZone = zoneOf(best);
  if (targetZone && targetZone !== currentZone) {
    // Zones with a fixed entry point (the TV side menu lands on the current page).
    const entry = targetZone.dataset.focusEnter ? targetZone.querySelector<HTMLElement>(targetZone.dataset.focusEnter) : null;
    if (entry && list.includes(entry)) best = entry;
    // Entering a different zone vertically: restore its remembered child if still present.
    else if (dir === 'up' || dir === 'down') {
      const remembered = zoneMemory.get(targetZone.dataset.focusZone!);
      if (remembered && targetZone.contains(remembered) && list.includes(remembered)) best = remembered;
    }
  }
  // Leaving the TV side menu to the right: return to where you were on the page.
  if (dir === 'right' && currentZone?.hasAttribute('data-rail')) {
    const back = lastContentFocus && document.contains(lastContentFocus) && list.includes(lastContentFocus) ? lastContentFocus : null;
    if (back) best = back;
  }
  return focusElement(best);
}

/** Register a back handler; return true from it to stop propagation. Returns an unregister fn. */
export function pushBack(handler: () => boolean | void): () => void {
  backStack.push(handler);
  return () => {
    const i = backStack.lastIndexOf(handler);
    if (i >= 0) backStack.splice(i, 1);
  };
}

/** Screens with nothing behind them: Back from here leaves the TV apps. */
const ROOT_PATHS = ['/', '/profiles', '/login', '/setup', '/register'];

export function goBack(): void {
  for (let i = backStack.length - 1; i >= 0; i--) {
    if (backStack[i]() === true) return;
  }
  // In the LG webOS app, Back from the first screens returns to the TV's home screen.
  if (inWebOsApp() && ROOT_PATHS.includes(location.pathname)) return leaveWebOsApp();
  // Never step out of Home by accident in a browser.
  if (location.pathname === '/') return;
  if (history.length > 1) history.back();
}

/**
 * Back for the Android app: returns false when there is nothing left to go back to, so the
 * app can close (TV convention) instead of getting stuck on Home.
 */
export function nativeBack(): boolean {
  for (let i = backStack.length - 1; i >= 0; i--) {
    if (backStack[i]() === true) return true;
  }
  if (ROOT_PATHS.includes(location.pathname)) return false;
  history.back();
  return true;
}

let installed = false;
export function installSpatialNavigation(): void {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    const dir = KEY_DIR[e.key];
    if (dir) {
      if (typing && (dir === 'up' || dir === 'down') && target.closest('[data-allow-vertical-typing]')) return;
      if (target.closest('[data-own-arrows]')) return;
      if (move(dir)) e.preventDefault();
      else if (!typing) e.preventDefault();
      return;
    }
    if (BACK_KEYS.has(e.key) || (BACK_CODES.has(e.keyCode) && !typing && e.key !== 'Backspace') || (e.key === 'Backspace' && !typing)) {
      e.preventDefault();
      goBack();
      return;
    }
    if (e.key === 'Enter' && !typing && target.hasAttribute('data-focusable') && target.tagName !== 'BUTTON' && target.tagName !== 'A') {
      e.preventDefault();
      target.click();
    }
  });
  // Mouse hover moves focus too, so hover and remote focus share one visual state.
  window.addEventListener(
    'pointerover',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = (e.target as HTMLElement).closest<HTMLElement>('.card, .glass-btn, .chip, .nav-tab, .rail-link');
      if (el && document.activeElement !== el && !document.activeElement?.matches('input, textarea')) {
        el.focus({ preventScroll: true });
        const zone = zoneOf(el);
        if (zone?.dataset.focusZone) zoneMemory.set(zone.dataset.focusZone, el);
      }
    },
    { passive: true },
  );
}

/** Focus the first sensible target inside a container (or the page) after navigation. */
export function focusFirst(container: ParentNode = document, opts: { scroll?: boolean } = {}): void {
  requestAnimationFrame(() => {
    const list = candidates(container);
    const el = list.find((x) => x.hasAttribute('data-autofocus')) ?? list[0];
    if (el) focusElement(el, { scroll: opts.scroll ?? false });
  });
}
