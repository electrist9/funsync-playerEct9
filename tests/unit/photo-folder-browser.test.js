/**
 * @vitest-environment jsdom
 *
 * Tests for the in-app photo folder browser modal
 * (renderer/components/photo-folder-browser.js).
 *
 * window.funsync is stubbed per test. jsdom has no IntersectionObserver,
 * so the no-IO immediate-load fallback (also real in older runtimes) is
 * the path exercised here. i18n gets a minimal EN bundle injected so t()
 * interpolates {count} like production instead of returning raw keys.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _setBundlesForTests } from '../../renderer/js/i18n.js';
import { openPhotoFolderBrowser } from '../../renderer/components/photo-folder-browser.js';

// Mirror of renderer/locales/en.json player.slideshowBrowser (interpolation
// in t() needs a real bundle: raw-key fallback returns the key verbatim).
_setBundlesForTests('en', { player: { slideshowBrowser: {
  title: 'Choose Photo Folder',
  select: 'Choose This Folder',
  selectCount: 'Choose This Folder ({count} photos)',
  osDialog: 'OS Dialog…',
  photos: '{count} photos',
  photosShort: 'photos',
  more: '+{count} more',
  search: 'Search in folder',
  empty: 'No folders or photos here',
  noPhotos: 'No photos in this folder',
  loadFailed: 'Couldn\'t read this folder',
  retry: 'Try Again',
  backToPrevious: 'Back to Previous Folder',
  drives: 'Drives',
  back: 'Up one level',
  pickFolderHint: 'Open a folder to choose it',
} } }, {});

const ROOTS = { roots: ['C:\\', 'D:\\'] };

const DIR_RESULT = () => ({
  path: 'C:\\Pictures',
  parent: 'C:\\',
  dirs: [
    { name: 'Vacation', path: 'C:\\Pictures\\Vacation', photoCount: 500, capped: true, coverPath: 'C:\\Pictures\\Vacation\\p0.jpg' },
    { name: 'Empty', path: 'C:\\Pictures\\Empty', photoCount: 0, capped: false, coverPath: null },
  ],
  images: [
    { name: 'a2.jpg', path: 'C:\\Pictures\\a2.jpg' },
    { name: 'a10.jpg', path: 'C:\\Pictures\\a10.jpg' },
  ],
  truncated: { dirs: false, images: false },
});

function setFunsync(overrides = {}) {
  const browse = overrides.browsePhotoDirectory || vi.fn(async (p) => (
    p === 'C:\\Pictures' || p === 'C:\\' ? DIR_RESULT() : ROOTS
  ));
  window.funsync = {
    browsePhotoDirectory: browse,
    readSlideshowThumbnail: vi.fn(async ({ filePath }) => (
      filePath.endsWith('p0.jpg') ? null : 'data:image/jpeg;base64,AAA'
    )),
    listSlideshowImages: vi.fn(async () => ({
      images: [{}, {}, {}, {}],
    })),
    selectDirectory: vi.fn(async () => null),
    ...overrides,
  };
  return window.funsync;
}

// Drain the IPC/promise chains the component chains onto microtasks.
async function flush(rounds = 12) {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

const q = (sel) => document.querySelector(sel);
const qa = (sel) => [...document.querySelectorAll(sel)];

async function cancel(resultPromise) {
  q('.modal-close-btn').click();
  return resultPromise;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('openPhotoFolderBrowser', () => {
  it('opens on the drives view with select disabled when no start path', async () => {
    const funsync = setFunsync();
    const result = openPhotoFolderBrowser(null);
    await flush();

    expect(funsync.browsePhotoDirectory).toHaveBeenCalledWith('');
    expect(q('.modal-panel').classList.contains('photo-browser')).toBe(true);
    expect(q('.photo-browser__crumb--current').textContent).toBe('Drives');
    expect(qa('.photo-browser__drive-name').map((el) => el.textContent))
      .toEqual(['C:', 'D:']);
    expect(q('.photo-browser__up').disabled).toBe(true);
    expect(q('.photo-browser__select').disabled).toBe(true);
    expect(q('.photo-browser__count').textContent).toBe('Open a folder to choose it');

    expect(await cancel(result)).toBe(null);
  });

  it('opens the start folder directly when it browses cleanly', async () => {
    const funsync = setFunsync();
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    expect(funsync.browsePhotoDirectory).toHaveBeenCalledWith('C:\\Pictures');
    expect(q('.photo-browser__crumb--current').textContent).toBe('Pictures');
    expect(q('.photo-browser__up').disabled).toBe(false);

    const dirTiles = qa('.photo-browser__tile--dir');
    expect(dirTiles).toHaveLength(2);
    expect(dirTiles[0].querySelector('.photo-browser__dir-name').textContent).toBe('Vacation');
    // Capped tile renders "N+ photos"; uncapped interpolates the photos key.
    expect(dirTiles[0].querySelector('.photo-browser__dir-count').textContent).toBe('500+ photos');
    expect(dirTiles[1].querySelector('.photo-browser__dir-count').textContent).toBe('0 photos');
    expect(dirTiles[1].querySelector('.photo-browser__cover--empty')).not.toBe(null);
    expect(qa('.photo-browser__tile--photo')).toHaveLength(2);

    // Footer total comes from listSlideshowImages for the open folder.
    expect(funsync.listSlideshowImages).toHaveBeenCalledWith('C:\\Pictures');
    expect(q('.photo-browser__count').textContent).toBe('4 photos');
    const selectBtn = q('.photo-browser__select');
    expect(selectBtn.disabled).toBe(false);
    expect(selectBtn.textContent).toBe('Choose This Folder (4 photos)');

    selectBtn.click();
    expect(await result).toBe('C:\\Pictures');
  });

  it('silently falls back to the drives view when the start path fails to browse', async () => {
    const funsync = setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => (
        p === '' ? ROOTS : { error: 'not-a-directory' }
      )),
    });
    const result = openPhotoFolderBrowser('C:\\Missing');
    await flush();

    expect(funsync.browsePhotoDirectory.mock.calls.map((c) => c[0]))
      .toEqual(['C:\\Missing', '']);
    expect(q('.photo-browser__error')).toBe(null);
    expect(q('.photo-browser__crumb--current').textContent).toBe('Drives');
    expect(qa('.photo-browser__drive-name')).toHaveLength(2);

    expect(await cancel(result)).toBe(null);
  });

  it('navigates drives -> subfolders by tile click and shows breadcrumbs', async () => {
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => {
        if (p === '') return ROOTS;
        if (p === 'C:\\') {
          return {
            path: 'C:\\',
            parent: null,
            dirs: [{ name: 'Pictures', path: 'C:\\Pictures', photoCount: 4, capped: false, coverPath: null }],
            images: [],
            truncated: { dirs: false, images: false },
          };
        }
        return DIR_RESULT();
      }),
      listSlideshowImages: vi.fn(async (p) => ({
        images: p === 'C:\\Pictures' ? [{}, {}] : [],
      })),
    });
    const result = openPhotoFolderBrowser(null);
    await flush();

    // Drive tile opens the drive root; parent=null disables "up".
    qa('.photo-browser__tile')[0].click();
    await flush();
    expect(q('.photo-browser__crumb--current').textContent).toBe('C:');
    expect(q('.photo-browser__up').disabled).toBe(true);
    expect(q('.photo-browser__select').disabled).toBe(true); // no photos at drive root

    qa('.photo-browser__tile--dir')[0].click();
    await flush();
    const crumbs = qa('.photo-browser__crumb').map((el) => el.textContent);
    expect(crumbs).toEqual(['C:', 'Pictures']);
    expect(q('.photo-browser__crumb--current').textContent).toBe('Pictures');

    // Breadcrumb jumps back to the drive without a second browse (cache).
    qa('.photo-browser__crumb')[0].click();
    await flush();
    expect(q('.photo-browser__crumb--current').textContent).toBe('C:');

    // "Up" from Pictures returns to C:.
    qa('.photo-browser__tile--dir')[0].click();
    await flush();
    q('.photo-browser__up').click();
    await flush();
    expect(q('.photo-browser__crumb--current').textContent).toBe('C:');

    expect(await cancel(result)).toBe(null);
  });

  it('shows an inline error when a clicked folder fails to browse', async () => {
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => (
        p === '' ? ROOTS : { error: 'read-failed' }
      )),
    });
    const result = openPhotoFolderBrowser(null);
    await flush();

    qa('.photo-browser__tile')[0].click();
    await flush();
    expect(q('.photo-browser__error').textContent).toBe('Couldn\'t read this folder');
    expect(q('.photo-browser__up').disabled).toBe(true);
    // Recovery affordances: retry offered; "back" only when a folder view
    // existed before the failure (drives view here has no prior folder).
    expect(q('.photo-browser__retry').textContent).toBe('Try Again');
    expect(q('.photo-browser__back')).toBe(null);

    expect(await cancel(result)).toBe(null);
  });

  it('recovers from a failed folder hop via retry', async () => {
    let vacationAttempts = 0;
    const vacation = {
      path: 'C:\\Pictures\\Vacation',
      parent: 'C:\\Pictures',
      dirs: [],
      images: [{ name: 'p1.jpg', path: 'C:\\Pictures\\Vacation\\p1.jpg' }],
      truncated: { dirs: false, images: false },
    };
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => {
        if (p === 'C:\\Pictures\\Vacation') {
          vacationAttempts += 1;
          return vacationAttempts === 1 ? { error: 'read-failed' } : vacation;
        }
        return p === 'C:\\Pictures' || p === 'C:\\' ? DIR_RESULT() : ROOTS;
      }),
    });
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    const tile = qa('.photo-browser__tile--dir').find(
      (el) => el.textContent.includes('Vacation'),
    );
    tile.click();
    await flush();
    expect(q('.photo-browser__error')).not.toBe(null);

    q('.photo-browser__retry').click();
    await flush();
    expect(q('.photo-browser__error')).toBe(null);
    expect(q('.photo-browser__crumb--current').textContent).toBe('Vacation');
    expect(vacationAttempts).toBe(2);

    expect(await cancel(result)).toBe(null);
  });

  it('never dead-ends: error view keeps crumbs and offers back-to-previous and up', async () => {
    const driveView = {
      path: 'C:\\',
      parent: null,
      dirs: [{ name: 'Pictures', path: 'C:\\Pictures', photoCount: 2, capped: false, coverPath: null }],
      images: [],
      truncated: { dirs: false, images: false },
    };
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => {
        if (p === 'C:\\Pictures\\Vacation') return { error: 'read-failed' };
        if (p === 'C:\\Pictures') return DIR_RESULT();
        if (p === 'C:\\') return driveView;
        return ROOTS;
      }),
    });
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    const tile = qa('.photo-browser__tile--dir').find(
      (el) => el.textContent.includes('Vacation'),
    );
    tile.click();
    await flush();
    expect(q('.photo-browser__error')).not.toBe(null);
    // Escape routes all available from the error view.
    expect(q('.photo-browser__back').textContent).toBe('Back to Previous Folder');
    expect(q('.photo-browser__up').disabled).toBe(false);
    expect(q('.photo-browser__crumb--current').textContent).toBe('Pictures');

    q('.photo-browser__back').click();
    await flush();
    expect(q('.photo-browser__error')).toBe(null);
    expect(q('.photo-browser__crumb--current').textContent).toBe('Pictures');
    expect(qa('.photo-browser__tile--dir')).toHaveLength(2);

    // And the up button still works from a later error view too.
    const tile2 = qa('.photo-browser__tile--dir').find(
      (el) => el.textContent.includes('Vacation'),
    );
    tile2.click();
    await flush();
    expect(q('.photo-browser__error')).not.toBe(null);
    q('.photo-browser__up').click();
    await flush();
    expect(q('.photo-browser__error')).toBe(null);
    expect(q('.photo-browser__crumb--current').textContent).toBe('C:');

    expect(await cancel(result)).toBe(null);
  });

  it('indexes browse results by resolved path so trailing-separator starts keep ↑ alive', async () => {
    const driveRoot = {
      path: 'C:\\',
      parent: null,
      dirs: [{ name: 'Pictures', path: 'C:\\Pictures', photoCount: 2, capped: false, coverPath: null }],
      images: [],
      truncated: { dirs: false, images: false },
    };
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => {
        if (p === 'C:\\Pictures\\' || p === 'C:\\Pictures') return DIR_RESULT();
        if (p === 'C:\\') return driveRoot;
        return ROOTS;
      }),
    });
    const result = openPhotoFolderBrowser('C:\\Pictures\\');
    await flush();

    // The view rendered (resolved path indexed) and up is enabled.
    expect(q('.photo-browser__crumb--current').textContent).toBe('Pictures');
    expect(q('.photo-browser__up').disabled).toBe(false);

    q('.photo-browser__up').click();
    await flush();
    expect(q('.photo-browser__error')).toBe(null);
    expect(q('.photo-browser__crumb--current').textContent).toBe('C:');

    expect(await cancel(result)).toBe(null);
  });

  it('lazy-loads thumbnails through the IPC with the open folder as root', async () => {
    const funsync = setFunsync();
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    // Two photos + one dir cover; Empty dir has no cover.
    expect(funsync.readSlideshowThumbnail.mock.calls.length).toBe(3);
    for (const [arg] of funsync.readSlideshowThumbnail.mock.calls) {
      expect(arg.root).toBe('C:\\Pictures');
      expect(arg.maxDim).toBe(256);
    }

    const painted = qa('.photo-browser__thumb').filter(
      (el) => el.style.backgroundImage.includes('data:image/jpeg;base64,AAA'),
    );
    expect(painted).toHaveLength(2);
    for (const el of painted) {
      expect(el.classList.contains('photo-browser__thumb--loading')).toBe(false);
    }
    // Rejected thumbnail (stub returns null for the cover) marks broken.
    const broken = qa('.photo-browser__thumb--broken');
    expect(broken).toHaveLength(1);

    expect(await cancel(result)).toBe(null);
  });

  it('caps in-flight thumbnail IPC calls at 8', async () => {
    const many = DIR_RESULT();
    many.images = Array.from({ length: 20 }, (_, i) => ({
      name: `img${i}.jpg`,
      path: `C:\\Pictures\\img${i}.jpg`,
    }));
    const funsync = setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => (p === 'C:\\Pictures' ? many : ROOTS)),
      readSlideshowThumbnail: vi.fn(() => new Promise(() => {})), // never settles
    });
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    expect(qa('.photo-browser__tile--photo')).toHaveLength(20);
    expect(funsync.readSlideshowThumbnail.mock.calls.length).toBe(8);

    expect(await cancel(result)).toBe(null);
  });

  it('filters folders and photos by the search box', async () => {
    setFunsync();
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    const search = q('.photo-browser__search');
    search.value = 'vacation';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect(qa('.photo-browser__tile--dir').map(
      (el) => el.querySelector('.photo-browser__dir-name').textContent,
    )).toEqual(['Vacation']);
    expect(qa('.photo-browser__tile--photo')).toHaveLength(0);

    search.value = 'zzz';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect(q('.photo-browser__empty').textContent).toBe('No folders or photos here');

    search.value = '';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect(qa('.photo-browser__tile--dir')).toHaveLength(2);
    expect(qa('.photo-browser__tile--photo')).toHaveLength(2);

    expect(await cancel(result)).toBe(null);
  });

  it('shows the truncation note when the browse response is capped', async () => {
    const cut = DIR_RESULT();
    cut.truncated = { dirs: false, images: true };
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => (p === 'C:\\Pictures' ? cut : ROOTS)),
    });
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    expect(q('.photo-browser__note').textContent).toBe('+2 more');

    expect(await cancel(result)).toBe(null);
  });

  it('keeps select disabled until the total arrives and flags the 5000 cap', async () => {
    let resolveList;
    const funsync = setFunsync({
      listSlideshowImages: vi.fn(() => new Promise((resolve) => { resolveList = resolve; })),
    });
    const result = openPhotoFolderBrowser('C:\\Pictures');
    await flush();

    // Total still in flight: footer empty, select disabled.
    expect(q('.photo-browser__count').textContent).toBe('');
    expect(q('.photo-browser__select').disabled).toBe(true);

    resolveList({ images: new Array(5000).fill({}) });
    await flush();
    expect(funsync.listSlideshowImages).toHaveBeenCalledWith('C:\\Pictures');
    expect(q('.photo-browser__count').textContent).toBe('5000+ photos');
    expect(q('.photo-browser__select').disabled).toBe(false);
    expect(q('.photo-browser__select').textContent).toBe('Choose This Folder (5000+ photos)');

    expect(await cancel(result)).toBe(null);
  });

  it('resolves with the OS dialog result from the fallback button', async () => {
    const funsync = setFunsync({
      selectDirectory: vi.fn(async () => 'D:\\OS Pick'),
    });
    const result = openPhotoFolderBrowser(null);
    await flush();

    q('.photo-browser__os').click();
    expect(await result).toBe('D:\\OS Pick');
    expect(funsync.selectDirectory).toHaveBeenCalled();
  });

  it('keeps the modal open when the OS dialog is cancelled', async () => {
    setFunsync({ selectDirectory: vi.fn(async () => null) });
    const result = openPhotoFolderBrowser(null);
    await flush();

    q('.photo-browser__os').click();
    await flush();
    expect(q('.modal-overlay')).not.toBe(null);

    expect(await cancel(result)).toBe(null);
  });

  it('disables select for an empty folder and hides the count chrome', async () => {
    const emptyDir = {
      path: 'C:\\Empty',
      parent: 'C:\\',
      dirs: [],
      images: [],
      truncated: { dirs: false, images: false },
    };
    setFunsync({
      browsePhotoDirectory: vi.fn(async (p) => (p === 'C:\\Empty' ? emptyDir : ROOTS)),
      listSlideshowImages: vi.fn(async () => ({ images: [] })),
    });
    const result = openPhotoFolderBrowser('C:\\Empty');
    await flush();

    expect(q('.photo-browser__empty').textContent).toBe('No photos in this folder');
    expect(q('.photo-browser__count').textContent).toBe('0 photos');
    const selectBtn = q('.photo-browser__select');
    expect(selectBtn.disabled).toBe(true);
    expect(selectBtn.textContent).toBe('Choose This Folder');

    expect(await cancel(result)).toBe(null);
  });
});
