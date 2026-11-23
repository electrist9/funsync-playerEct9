// @vitest-environment node
/**
 * Unit tests for electron/photo-browser.js — the pure helpers behind the
 * 'browse-photo-directory' IPC (in-app photo folder browser).
 *
 * fs promises and the drive-exists probe are INJECTED, so everything runs
 * against a fake filesystem. Paths are built with the host `path` module
 * so the suite is identical on win32 and POSIX.
 */
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import {
  enumerateRoots,
  parentOf,
  summarizeDir,
  browseDirectory,
} from '../../electron/photo-browser.js';

// Host-neutral absolute base: drive root (win32) or '/' plus a marker dir,
// so path.resolve() in the helpers is an identity for every key we use.
const BASE = path.join(path.resolve(path.sep), 'funsync-browse-test');

function dirent(name, kind) {
  return {
    name,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
  };
}

// tree: { absoluteDirPath: Dirent-like[] } — missing dirs reject like ENOENT.
function makeFs(tree) {
  const readdir = vi.fn(async (dir) => {
    const entries = tree[dir];
    if (entries === undefined) throw new Error(`ENOENT, readdir '${dir}'`);
    return entries;
  });
  return { promises: { readdir } };
}

describe('enumerateRoots', () => {
  it('returns the single POSIX root on non-win32', () => {
    expect(enumerateRoots(() => true, 'linux')).toEqual(['/']);
    expect(enumerateRoots(() => true, 'darwin')).toEqual(['/']);
  });

  it('probes A:\\..Z:\\ on win32 and keeps only existing drives, in order', () => {
    const exists = (p) => p === 'C:\\' || p === 'D:\\';
    expect(enumerateRoots(exists, 'win32')).toEqual(['C:\\', 'D:\\']);
  });

  it('skips drives whose statSync throws', () => {
    const exists = (p) => {
      if (p === 'E:\\') throw new Error('EPERM');
      return p === 'C:\\';
    };
    expect(enumerateRoots(exists, 'win32')).toEqual(['C:\\']);
  });
});

describe('parentOf', () => {
  it('returns null for a filesystem root (up would be a no-op)', () => {
    expect(parentOf(path.resolve(path.sep))).toBeNull();
  });

  it('returns the parent directory otherwise', () => {
    const child = path.join(BASE, 'sub');
    expect(parentOf(child)).toBe(path.dirname(child));
    expect(parentOf(BASE)).toBe(path.dirname(BASE));
  });
});

describe('summarizeDir', () => {
  const sub = path.join(BASE, 'sub');
  const deeper = path.join(sub, 'deeper');
  const tree = {
    [BASE]: [
      dirent('img_top.jpg', 'file'),
      dirent('sub', 'dir'),
      dirent('.hidden.jpg', 'file'), // dot segment — never counted
      dirent('readme.txt', 'file'), // not an image extension
      dirent('linkthing', 'other'), // neither file nor dir
    ],
    [sub]: [dirent('s1.png', 'file'), dirent('deeper', 'dir')],
    [deeper]: [dirent('d1.jpg', 'file'), dirent('notes.txt', 'file')],
  };

  it('counts images recursively and takes the shallowest as cover', async () => {
    const fs = makeFs(tree);
    const s = await summarizeDir(fs.promises, BASE, 500, { left: 100 });
    expect(s.count).toBe(3); // img_top.jpg, s1.png, d1.jpg
    expect(s.coverName).toBe('img_top.jpg');
    expect(s.coverPath).toBe(path.join(BASE, 'img_top.jpg'));
  });

  it('cover is the first BFS image even when only deep photos exist', async () => {
    const s = await summarizeDir(
      makeFs({
        [BASE]: [dirent('sub', 'dir')],
        [sub]: [dirent('deep.jpg', 'file')],
      }).promises,
      BASE, 500, { left: 100 },
    );
    expect(s.count).toBe(1);
    expect(s.coverPath).toBe(path.join(sub, 'deep.jpg'));
  });

  it('stops early at countCap', async () => {
    const fs = makeFs(tree);
    const s = await summarizeDir(fs.promises, BASE, 2, { left: 100 });
    expect(s.count).toBe(2);
    // BASE + sub read, but deeper was never touched (early return).
    expect(fs.promises.readdir).not.toHaveBeenCalledWith(deeper, { withFileTypes: true });
  });

  it('stops at a shared budget of readdir ops', async () => {
    const fs = makeFs(tree);
    const s = await summarizeDir(fs.promises, BASE, 500, { left: 1 });
    expect(fs.promises.readdir).toHaveBeenCalledTimes(1);
    expect(s.count).toBe(1); // only the top level was read
  });

  it('tolerates unreadable subfolders', async () => {
    const bad = path.join(BASE, 'bad');
    const fs = makeFs({
      [BASE]: [dirent('bad', 'dir'), dirent('a.jpg', 'file')],
      // 'bad' deliberately missing from the tree -> readdir rejects.
    });
    const s = await summarizeDir(fs.promises, BASE, 500, { left: 100 });
    expect(s.count).toBe(1);
    expect(s.coverPath).toBe(path.join(BASE, 'a.jpg'));
    expect(fs.promises.readdir).toHaveBeenCalledWith(bad, { withFileTypes: true });
  });
});

describe('browseDirectory', () => {
  const b2 = path.join(BASE, 'B2');
  const b10 = path.join(BASE, 'B10');

  const tree = {
    [BASE]: [
      dirent('B10', 'dir'),
      dirent('B2', 'dir'),
      dirent('img10.jpg', 'file'),
      dirent('img2.jpg', 'file'),
      dirent('.dotdir', 'dir'), // dot segment — never listed
      dirent('.hidden.png', 'file'), // dot segment — never listed
      dirent('readme.txt', 'file'), // not an image — never listed
      dirent('clip.mp4', 'file'), // video is not a photo — never listed
      dirent('weird', 'other'), // neither file nor dir
    ],
    [b2]: [dirent('b2photo.jpg', 'file')],
    [b10]: [],
  };

  it('returns the browse contract with natural-ordered dirs and images', async () => {
    const res = await browseDirectory(makeFs(tree).promises, BASE);
    expect(res.path).toBe(BASE);
    expect(res.parent).toBe(path.dirname(BASE));
    expect(res.dirs.map((d) => d.name)).toEqual(['B2', 'B10']);
    // Regression: images were once sorted with naturalCompare(objects),
    // which stringified to '[object Object]' and silently no-oped.
    expect(res.images.map((i) => i.name)).toEqual(['img2.jpg', 'img10.jpg']);
    expect(res.images.map((i) => i.path))
      .toEqual([path.join(BASE, 'img2.jpg'), path.join(BASE, 'img10.jpg')]);
    expect(res.truncated).toEqual({ dirs: false, images: false });

    expect(res.dirs[0].photoCount).toBe(1);
    expect(res.dirs[0].capped).toBe(false);
    expect(res.dirs[0].coverPath).toBe(path.join(b2, 'b2photo.jpg'));
    expect(res.dirs[0].path).toBe(b2);
    expect(res.dirs[1].photoCount).toBe(0);
    expect(res.dirs[1].coverPath).toBeNull();
  });

  it('skips dot segments, non-image files and non-file/dir entries', async () => {
    const res = await browseDirectory(makeFs(tree).promises, BASE);
    const names = res.dirs.map((d) => d.name).concat(res.images.map((i) => i.name));
    expect(names).not.toContain('.dotdir');
    expect(names).not.toContain('.hidden.png');
    expect(names).not.toContain('readme.txt');
    expect(names).not.toContain('clip.mp4');
    expect(names).not.toContain('weird');
  });

  it('caps images and reports truncation', async () => {
    const res = await browseDirectory(makeFs(tree).promises, BASE, { maxImages: 1 });
    expect(res.images).toHaveLength(1);
    expect(res.images[0].name).toBe('img2.jpg'); // slice AFTER the natural sort
    expect(res.truncated.images).toBe(true);
  });

  it('caps directories and reports truncation', async () => {
    const res = await browseDirectory(makeFs(tree).promises, BASE, { maxDirs: 1 });
    expect(res.dirs.map((d) => d.name)).toEqual(['B2']);
    expect(res.truncated.dirs).toBe(true);
  });

  it('flags per-tile photoCount as capped at countCap', async () => {
    const res = await browseDirectory(makeFs(tree).promises, BASE, { countCap: 1 });
    expect(res.dirs[0].photoCount).toBe(1);
    expect(res.dirs[0].capped).toBe(true);
  });

  it('shares the stat budget across directory tiles', async () => {
    const res = await browseDirectory(makeFs(tree).promises, BASE, { totalStatCap: 1 });
    // B2 (first tile, natural order) consumed the single readdir op.
    expect(res.dirs[0].photoCount).toBe(1);
    // B10's summary budget-had to stop before reading anything.
    expect(res.dirs[1].photoCount).toBe(0);
  });

  it('rejects when the top-level readdir fails', async () => {
    await expect(browseDirectory(makeFs({}).promises, BASE)).rejects.toThrow(/ENOENT/);
  });
});
