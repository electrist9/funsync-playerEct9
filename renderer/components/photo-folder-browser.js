/**
 * In-app photo folder browser — the shopping-site-style picker for the
 * slideshow photo folder (player.slideshowFolderPicker = 'inapp').
 *
 * Replaces the OS folder dialog for slideshow activations: drill down
 * folder tiles (cover thumbnail + recursive photo count), see the photos
 * in the current folder as a lazy thumbnail grid, search, and pick the
 * open folder with one button. Everything rides the browse-photo-
 * directory / read-slideshow-thumbnail IPCs; thumbnails arrive as data
 * URLs because CSP img-src allows data:, not file:.
 *
 * openPhotoFolderBrowser(startPath) resolves with the chosen absolute
 * path, or null on cancel (X / Esc).
 */
import { t } from '../js/i18n.js';
import { Modal } from './modal.js';

const THUMB_MAX_DIM = 256;
const THUMB_CONCURRENCY = 8;      // in-flight readSlideshowThumbnail calls
const THUMB_CACHE_LIMIT = 200;    // LRU-ish: evict oldest entries past this
const TOTAL_COUNT_CAP = 5000;     // listSlideshowImages hard cap
const DIR_COUNT_CAP = 500;        // photo-browser.js per-tile count cap

// Map drive/root paths to a short label: 'C:\\' -> 'C:', '/' -> '/'.
function rootLabel(p) {
  const trimmed = String(p).replace(/[\\/]+$/, '');
  return trimmed || String(p);
}

// Clickable breadcrumb chain for a Windows or POSIX path.
function pathChain(dirPath) {
  const p = String(dirPath);
  const out = [];
  const win = /^[A-Za-z]:[\\/]/.test(p);
  if (win) {
    out.push({ path: p.slice(0, 2) + '\\', name: p.slice(0, 2) });
    for (const part of p.slice(2).split(/[\\/]+/)) {
      if (!part) continue;
      const prev = out[out.length - 1].path;
      // prev ends with the separator only for the drive root crumb ("C:\");
      // deeper crumbs need an explicit separator before the segment.
      out.push({ path: prev.endsWith('\\') ? prev + part : prev + '\\' + part, name: part });
    }
    return out;
  }
  out.push({ path: '/', name: '/' });
  for (const part of p.split('/')) {
    if (!part) continue;
    const prev = out[out.length - 1].path;
    out.push({ path: prev === '/' ? '/' + part : prev + '/' + part, name: part });
  }
  return out;
}

class PhotoFolderBrowser {
  /**
   * @param {HTMLElement} bodyEl — the modal body to fill
   * @param {(value: string|null) => void} close — closes the modal
   */
  constructor(bodyEl, close) {
    this.body = bodyEl;
    this.close = (value) => { this.alive = false; close(value); };
    this.alive = true;
    this.current = null;          // null = roots (drives) view
    this.failedTarget = null;     // path of the last failed browse hop
    this.query = '';
    this.browseCache = new Map(); // '' = roots result, else dir path
    this.totalCache = new Map();  // dir path -> { count, capped }
    this.thumbCache = new Map();  // image path -> dataUrl | null
    this.inflight = 0;
    this.queue = [];
    this.io = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((records) => {
        for (const rec of records) {
          if (!rec.isIntersecting) continue;
          this.io.unobserve(rec.target);
          this.enqueueThumb(rec.target.dataset.thumb);
        }
      }, { root: null, rootMargin: '200px' })
      : null;
    this.build();
  }

  build() {
    const bar = document.createElement('div');
    bar.className = 'photo-browser__bar';

    this.upBtn = document.createElement('button');
    this.upBtn.type = 'button';
    this.upBtn.className = 'photo-browser__up';
    this.upBtn.textContent = '↑';
    this.upBtn.title = t('player.slideshowBrowser.back');
    this.upBtn.setAttribute('aria-label', t('player.slideshowBrowser.back'));
    this.upBtn.addEventListener('click', () => {
      const res = this.browseCache.get(this.current || '');
      if (res && res.parent) this.navigate(res.parent);
    });
    bar.appendChild(this.upBtn);

    this.crumbs = document.createElement('nav');
    this.crumbs.className = 'photo-browser__crumbs';
    bar.appendChild(this.crumbs);

    this.search = document.createElement('input');
    this.search.type = 'search';
    this.search.className = 'photo-browser__search';
    this.search.placeholder = t('player.slideshowBrowser.search');
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this.render();
    });
    bar.appendChild(this.search);
    this.body.appendChild(bar);

    this.scroller = document.createElement('div');
    this.scroller.className = 'photo-browser__scroll';
    this.grid = document.createElement('div');
    this.grid.className = 'photo-browser__grid';
    this.scroller.appendChild(this.grid);
    this.body.appendChild(this.scroller);

    const footer = document.createElement('div');
    footer.className = 'photo-browser__footer';
    this.countEl = document.createElement('span');
    this.countEl.className = 'photo-browser__count';
    footer.appendChild(this.countEl);

    this.osBtn = document.createElement('button');
    this.osBtn.type = 'button';
    this.osBtn.className = 'modal-btn modal-btn--secondary photo-browser__os';
    this.osBtn.textContent = t('player.slideshowBrowser.osDialog');
    this.osBtn.addEventListener('click', async () => {
      let dir = null;
      try { dir = await window.funsync.selectDirectory(); } catch { dir = null; }
      if (this.alive && dir) this.close(dir);
    });
    footer.appendChild(this.osBtn);

    this.selectBtn = document.createElement('button');
    this.selectBtn.type = 'button';
    this.selectBtn.className = 'modal-btn modal-btn--primary photo-browser__select';
    this.selectBtn.addEventListener('click', () => {
      if (this.current) this.close(this.current);
    });
    footer.appendChild(this.selectBtn);
    this.body.appendChild(footer);
  }

  async start(startPath) {
    if (startPath) {
      const ok = await this.navigate(startPath, true);
      if (ok || !this.alive) return;
    }
    await this.navigate(null);
  }

  // One browse hop. silent=true suppresses the error line (used for the
  // start-path probe, which falls back to the roots view).
  async navigate(dirPath, silent = false) {
    const key = dirPath || '';
    let res = this.browseCache.get(key);
    if (!res) {
      try { res = await window.funsync.browsePhotoDirectory(key); } catch { res = null; }
      if (!res || res.error) {
        this.failedTarget = key;
        if (this.alive && !silent) this.showError();
        return false;
      }
      this.browseCache.set(key, res);
    }
    if (!this.alive) return true;
    this.failedTarget = null;
    // Index the result under the resolved path as well, so lookups keyed by
    // current (up button, render) always hit even when the typed/navigated
    // key differed (e.g. a trailing separator from a start path).
    if (res.path && !this.browseCache.has(res.path)) this.browseCache.set(res.path, res);
    this.current = res.roots ? null : res.path;
    this.render();
    if (this.current) this.loadTotal(this.current);
    return true;
  }

  // A failed hop is a recoverable state, not a dead end: keep the crumbs of
  // the last successfully loaded folder (they stay clickable) and offer
  // retry / back-to-previous affordances, so an unreadable folder (locked
  // system folder, network hiccup, permissions) can never trap the user.
  showError() {
    this.grid.innerHTML = '';
    const err = document.createElement('p');
    err.className = 'photo-browser__error';
    err.textContent = t('player.slideshowBrowser.loadFailed');
    this.grid.appendChild(err);

    const actions = document.createElement('div');
    actions.className = 'photo-browser__actions';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'modal-btn modal-btn--primary photo-browser__retry';
    retry.textContent = t('player.slideshowBrowser.retry');
    retry.addEventListener('click', () => {
      if (this.alive && this.failedTarget !== null) this.navigate(this.failedTarget);
    });
    actions.appendChild(retry);

    const prevRes = this.browseCache.get(this.current || '');
    if (this.current && prevRes) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'modal-btn modal-btn--secondary photo-browser__back';
      back.textContent = t('player.slideshowBrowser.backToPrevious');
      back.addEventListener('click', () => {
        if (this.alive && this.current) this.navigate(this.current);
      });
      actions.appendChild(back);
    }
    this.grid.appendChild(actions);
    this.renderFooter();
    // Keep the up button usable when the last good folder has a parent, so
    // the error view can be escaped with ↑ as well.
    this.upBtn.disabled = !(prevRes && prevRes.parent && !prevRes.roots);
  }

  loadTotal(dirPath) {
    const apply = () => {
      if (this.alive && this.current === dirPath) this.renderFooter();
    };
    if (this.totalCache.has(dirPath)) { apply(); return; }
    this.totalCache.set(dirPath, null); // in-flight marker
    Promise.resolve()
      .then(() => window.funsync.listSlideshowImages(dirPath))
      .then((res) => {
        const n = res && Array.isArray(res.images) ? res.images.length : 0;
        this.totalCache.set(dirPath, { count: n, capped: n >= TOTAL_COUNT_CAP });
        apply();
      })
      .catch(() => {
        this.totalCache.set(dirPath, { count: 0, capped: false });
        apply();
      });
    this.renderFooter();
  }

  // Lazily load one grid thumbnail (data URL) through a small queue so a
  // huge folder never opens more IPC calls than THUMB_CONCURRENCY at once.
  enqueueThumb(filePath) {
    if (!filePath) return;
    if (this.thumbCache.has(filePath)) {
      this.paintThumb(filePath);
      return;
    }
    this.queue.push(filePath);
    this.pump();
  }

  pump() {
    while (this.inflight < THUMB_CONCURRENCY && this.queue.length > 0) {
      const filePath = this.queue.shift();
      if (this.thumbCache.has(filePath)) continue;
      this.inflight += 1;
      const root = this.current || '';
      Promise.resolve()
        .then(() => window.funsync.readSlideshowThumbnail({
          root, filePath, maxDim: THUMB_MAX_DIM,
        }))
        .then((dataUrl) => {
          this.thumbCacheSet(filePath, dataUrl || null);
          if (this.alive) this.paintThumb(filePath);
        })
        .catch(() => {
          this.thumbCacheSet(filePath, null);
          if (this.alive) this.paintThumb(filePath);
        })
        .finally(() => {
          this.inflight -= 1;
          this.pump();
        });
    }
  }

  thumbCacheSet(key, value) {
    this.thumbCache.set(key, value);
    if (this.thumbCache.size > THUMB_CACHE_LIMIT) {
      // Insertion-order Map: the first key is the least recently *loaded*
      // entry, good enough for a bounded preview cache.
      this.thumbCache.delete(this.thumbCache.keys().next().value);
    }
  }

  paintThumb(filePath) {
    const url = this.thumbCache.get(filePath);
    // Linear scan over the grid's thumb boxes: path values contain \ and :
    // which selector engines escape inconsistently, and the grid is bounded
    // by the browse caps anyway.
    for (const el of this.grid.querySelectorAll('[data-thumb]')) {
      if (el.dataset.thumb !== filePath) continue;
      el.classList.remove('photo-browser__thumb--loading');
      if (url) el.style.backgroundImage = `url("${url}")`;
      else el.classList.add('photo-browser__thumb--broken');
    }
  }

  tileButton(label, title, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'photo-browser__tile';
    btn.appendChild(label);
    if (title) { btn.title = title; btn.setAttribute('aria-label', title); }
    btn.addEventListener('click', onClick);
    return btn;
  }

  thumbBox(filePath, extraClass) {
    const box = document.createElement('div');
    box.className = `photo-browser__thumb ${extraClass || ''}`.trim();
    if (this.thumbCache.has(filePath)) {
      const url = this.thumbCache.get(filePath);
      if (url) box.style.backgroundImage = `url("${url}")`;
      else box.classList.add('photo-browser__thumb--broken');
    } else {
      box.classList.add('photo-browser__thumb--loading');
      box.dataset.thumb = filePath;
      if (this.io) this.io.observe(box);
      else this.enqueueThumb(filePath);
    }
    return box;
  }

  render() {
    const res = this.browseCache.get(this.current || '');
    if (!res || !this.alive) return;
    this.crumbs.textContent = '';
    this.grid.innerHTML = '';

    this.upBtn.disabled = !(res.parent && !res.roots);

    if (res.roots) {
      this.addCrumb(this.current, t('player.slideshowBrowser.drives'), true);
      const items = res.roots
        .map((p) => ({ path: p, name: rootLabel(p) }))
        .filter((it) => !this.query || it.name.toLowerCase().includes(this.query));
      for (const it of items) {
        const label = document.createElement('span');
        label.className = 'photo-browser__drive-name';
        label.textContent = it.name;
        this.grid.appendChild(this.tileButton(label, it.name, () => this.navigate(it.path)));
      }
    } else {
      for (const seg of pathChain(res.path)) {
        this.addCrumb(seg.path, seg.name, seg.path === res.path);
      }
      const dirs = res.dirs.filter((d) => !this.query || d.name.toLowerCase().includes(this.query));
      for (const d of dirs) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'photo-browser__tile photo-browser__tile--dir';
        if (d.coverPath) tile.appendChild(this.thumbBox(d.coverPath, 'photo-browser__cover'));
        else {
          const ph = document.createElement('div');
          ph.className = 'photo-browser__cover photo-browser__cover--empty';
          tile.appendChild(ph);
        }
        const text = document.createElement('span');
        text.className = 'photo-browser__dir-text';
        const name = document.createElement('span');
        name.className = 'photo-browser__dir-name';
        name.textContent = d.name;
        const count = document.createElement('span');
        count.className = 'photo-browser__dir-count';
        count.textContent = d.capped
          ? `${d.photoCount}+ ${t('player.slideshowBrowser.photosShort')}`
          : t('player.slideshowBrowser.photos', { count: d.photoCount });
        text.appendChild(name);
        text.appendChild(count);
        tile.appendChild(text);
        tile.title = d.path;
        tile.addEventListener('click', () => this.navigate(d.path));
        this.grid.appendChild(tile);
      }
      const photos = res.images.filter((im) => !this.query || im.name.toLowerCase().includes(this.query));
      for (const im of photos) {
        const btn = this.tileButton(
          this.thumbBox(im.path, 'photo-browser__cover'),
          im.name,
          () => {}, // photos are not selectable — the FOLDER is the pick
        );
        btn.classList.add('photo-browser__tile--photo');
        btn.setAttribute('aria-hidden', 'true');
        btn.tabIndex = -1;
        this.grid.appendChild(btn);
      }
      if (res.truncated.images || res.truncated.dirs) {
        const note = document.createElement('p');
        note.className = 'photo-browser__note';
        note.textContent = t('player.slideshowBrowser.more', {
          count: Math.max(res.images.length, res.dirs.length),
        });
        this.grid.appendChild(note);
      }
      if (dirs.length === 0 && photos.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'photo-browser__empty';
        empty.textContent = this.query
          ? t('player.slideshowBrowser.empty')
          : t('player.slideshowBrowser.noPhotos');
        this.grid.appendChild(empty);
      }
    }
    this.renderFooter();
  }

  addCrumb(path, name, isCurrent) {
    if (this.crumbs.childElementCount > 0) {
      const sep = document.createElement('span');
      sep.className = 'photo-browser__crumb-sep';
      sep.textContent = '›';
      this.crumbs.appendChild(sep);
    }
    if (isCurrent) {
      const cur = document.createElement('span');
      cur.className = 'photo-browser__crumb photo-browser__crumb--current';
      cur.textContent = name;
      this.crumbs.appendChild(cur);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'photo-browser__crumb';
      btn.textContent = name;
      btn.addEventListener('click', () => this.navigate(path));
      this.crumbs.appendChild(btn);
    }
  }

  renderFooter() {
    if (!this.current) {
      this.countEl.textContent = t('player.slideshowBrowser.pickFolderHint');
      this.selectBtn.disabled = true;
      this.selectBtn.textContent = t('player.slideshowBrowser.select');
      return;
    }
    const total = this.totalCache.get(this.current);
    if (total) {
      const label = total.capped ? `${total.count}+` : String(total.count);
      this.countEl.textContent = t('player.slideshowBrowser.photos', { count: label });
      this.selectBtn.disabled = total.count === 0;
      this.selectBtn.textContent = total.count > 0
        ? t('player.slideshowBrowser.selectCount', { count: label })
        : t('player.slideshowBrowser.select');
    } else {
      this.countEl.textContent = '';
      this.selectBtn.disabled = true;
      this.selectBtn.textContent = t('player.slideshowBrowser.select');
    }
  }
}

/**
 * @param {string|null} startPath — folder to open on (usually the current one)
 * @returns {Promise<string|null>} chosen absolute path, null on cancel
 */
export async function openPhotoFolderBrowser(startPath) {
  return Modal.open({
    title: t('player.slideshowBrowser.title'),
    panelClass: 'photo-browser',
    onRender: (bodyEl, close) => {
      new PhotoFolderBrowser(bodyEl, close).start(startPath || null);
    },
  });
}
