/**
 * @vitest-environment jsdom
 *
 * Regression tests for createSlideshowPopover (renderer/js/slideshow.js).
 * Guards the 2026-11-20 fix where open() called refresh() BEFORE unhiding
 * the popover element — refresh() early-returns while hidden, so the
 * popover opened empty (looked like "the settings panel never opens").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSlideshowPopover } from '../../renderer/js/slideshow.js';

const t = (k) => k;

function makeController(overrides = {}) {
  return {
    state: {
      active: true,
      folder: 'C:\\Pictures\\trip',
      imageCount: 3,
      presets: [{ name: 'P1' }],
      presetName: '',
      corner: 'bottom_right',
      sizeDenom: 8,
      imageOrder: 'name',
      ...overrides,
    },
    toggle() {},
    setFolder() {},
    setPresetName() {},
    setCorner() {},
    setSizeDenom() {},
    setImageOrder() {},
  };
}

describe('createSlideshowPopover', () => {
  let popoverEl;
  let anchor;
  let controller;
  let popover;

  beforeEach(() => {
    document.body.innerHTML = '<div id="pop"></div><button id="anchor"></button>';
    popoverEl = document.getElementById('pop');
    popoverEl.hidden = true;
    anchor = document.getElementById('anchor');
    controller = makeController();
    popover = createSlideshowPopover({ controller, popoverEl, t });
  });

  it('opens non-hidden AND populated (refresh runs after unhide)', () => {
    popover.open(anchor);
    expect(popoverEl.hidden).toBe(false);
    expect(popover.isOpen()).toBe(true);
    // Regression guard: the popover must not be empty after open().
    expect(popoverEl.children.length).toBeGreaterThan(0);
    const items = popoverEl.querySelectorAll('.slideshow-popover__item');
    // toggle + change-folder + builtin preset + P1 + 4 corners + 3 sizes + 2 orders
    expect(items.length).toBe(13);
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
  });

  it('close() hides the popover and resets aria-expanded', () => {
    popover.open(anchor);
    popover.close();
    expect(popoverEl.hidden).toBe(true);
    expect(popover.isOpen()).toBe(false);
    expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });

  it('refresh() while closed is a no-op', () => {
    popover.open(anchor);
    const before = popoverEl.innerHTML;
    popover.close();
    controller.state = { ...controller.state, active: false };
    popover.refresh();
    expect(popoverEl.innerHTML).toBe(before);
  });

  it('reopening reflects updated controller state', () => {
    popover.open(anchor);
    popover.close();
    controller.state = { ...controller.state, active: false, corner: 'top_left' };
    popover.open(anchor);
    const firstItem = popoverEl.querySelector('.slideshow-popover__item');
    expect(firstItem.textContent).toBe('player.slideshow.toggleOn');
    const tl = [...popoverEl.querySelectorAll('.slideshow-popover__item')]
      .find((b) => b.title === 'player.slideshow.cornerTopLeft');
    expect(tl.classList.contains('slideshow-popover__item--current')).toBe(true);
  });
});
