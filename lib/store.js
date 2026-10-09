// dsh-folder-timemachine — snapshot engine (host half, no DSH dependency).
//
// The engine gives any folder a Git-like version history without requiring the
// user to know anything about Git: a snapshot is one click, history is a list of
// timestamps, and a restore is one more click.
//
// Layout of the repository (one repository per protected folder):
//
//   $DSH_HOME/folder-timemachine/
//     index.json                          ← protected folders
//     <key>/meta.json                     ← one repository's own record
//     <key>/objects/<aa>/<sha256>         ← content-addressed file contents
//     <key>/snapshots/<id>.json           ← one manifest per snapshot
//
// Deduplication is by content hash, so ten snapshots of a folder that changed
// one file cost exactly one file of extra disk. Restores never need the source
// folder to be in any particular state: the bytes live in `objects/`.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** File and folder names no snapshot ever walks into. */
export const DEFAULT_EXCLUDE = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.timemachine',
  '$RECYCLE.BIN',
  'System Volume Information',
  '.DS_Store',
  'Thumbs.db',
];

/** Files larger than this are recorded as skipped instead of being copied. */
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;

/** How many snapshots one repository keeps unless the user says otherwise. */
export const DEFAULT_KEEP = 50;

/**
 * How long a realtime watcher waits for changes to stop before it snapshots.
 * A save-all in an editor, or a build writing forty files, is one version — not
 * forty.
 */
export const DEFAULT_DEBOUNCE_MS = 8000;

export function timeMachineHome(env = process.env) {
  const base = env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(base, 'folder-timemachine');
}

function keyOf(path) {
  return createHash('sha256').update(resolve(path).toLowerCase()).digest('hex').slice(0, 16);
}

function snapshotId(at = Date.now()) {
  const d = new Date(at);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp =
    d.getFullYear() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds());
  return stamp + '-' + Math.random().toString(36).slice(2, 6);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

async function sha256File(file) {
  const hash = createHash('sha256');
  const stream = createReadStream(file);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function matchesExclude(name, relPath, patterns) {
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern === '') continue;
    if (pattern.startsWith('*.')) {
      if (name.toLowerCase().endsWith(pattern.slice(1).toLowerCase())) return true;
      continue;
    }
    if (pattern.includes('/')) {
      if (relPath.toLowerCase().startsWith(pattern.toLowerCase())) return true;
      continue;
    }
    if (name.toLowerCase() === pattern.toLowerCase()) return true;
  }
  return false;
}

/**
 * Whether a live change at `relPath` (relative to the watched folder) lands
 * somewhere the snapshot rules skip anyway.
 *
 * Without this, an editor writing its lock file inside `.git` or a package
 * manager churning `node_modules` would buy a version every few seconds, and the
 * history would be unreadable exactly where it matters most.
 */
export function isExcludedChange(relPath, patterns = []) {
  const segments = String(relPath)
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0) return false;
  const all = [...DEFAULT_EXCLUDE, ...patterns];
  for (let i = 0; i < segments.length; i += 1) {
    if (matchesExclude(segments[i], segments.slice(0, i + 1).join('/'), all)) return true;
  }
  return false;
}

/**
 * One repository per protected folder. Every mutating method queues behind the
 * previous one for the same folder, so a snapshot and a restore can never
 * interleave on the same tree.
 */
export class TimeMachine {
  constructor(options = {}) {
    this.home = options.home ?? timeMachineHome();
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.keep = options.keep ?? DEFAULT_KEEP;
    /** Files copied rather than hashed through a stream (smaller peak memory). */
    this.queues = new Map();
    this.log = options.log ?? (() => {});
  }

  queue(key, job) {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    this.queues.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  // ------------------------------------------------------------------ registry

  async readIndex() {
    const index = await readJson(join(this.home, 'index.json'));
    if (index !== undefined && Array.isArray(index.folders)) return index;
    return { version: 1, folders: [] };
  }

  async list() {
    const index = await this.readIndex();
    const rows = [];
    for (const folder of index.folders) {
      const repo = await this.repoOf(folder.path);
      const snapshots = repo === undefined ? [] : await this.snapshotList(repo);
      const last = snapshots[0];
      rows.push({
        path: folder.path,
        label: folder.label ?? basename(folder.path),
        addedAt: folder.addedAt,
        exclude: folder.exclude ?? [],
        watch: folder.watch ?? { enabled: false, intervalMs: 0 },
        snapshotCount: snapshots.length,
        lastSnapshotAt: last?.at,
        lastSnapshotId: last?.id,
        bytes: last?.stats?.bytes ?? 0,
        files: last?.stats?.files ?? 0,
      });
    }
    return rows;
  }

  async protect(path, options = {}) {
    const dir = resolve(path);
    const info = await stat(dir).catch(() => undefined);
    if (info === undefined) throw new Error(`folder not found: ${dir}`);
    if (!info.isDirectory()) throw new Error(`not a folder: ${dir}`);
    const index = await this.readIndex();
    const existing = index.folders.find((f) => f.path.toLowerCase() === dir.toLowerCase());
    if (existing !== undefined) {
      if (typeof options.label === 'string' && options.label !== '') existing.label = options.label;
      if (Array.isArray(options.exclude)) existing.exclude = options.exclude;
      await writeJsonAtomic(join(this.home, 'index.json'), index);
      return { added: false, folder: existing };
    }
    const folder = {
      path: dir,
      label: options.label ?? basename(dir),
      addedAt: new Date().toISOString(),
      exclude: Array.isArray(options.exclude) ? options.exclude : [],
    };
    index.folders.push(folder);
    await writeJsonAtomic(join(this.home, 'index.json'), index);
    await mkdir(this.repoPath(dir), { recursive: true });
    return { added: true, folder };
  }

  async unprotect(path) {
    const dir = resolve(path);
    const index = await this.readIndex();
    const kept = index.folders.filter((f) => f.path.toLowerCase() !== dir.toLowerCase());
    if (kept.length === index.folders.length) return { removed: false };
    index.folders = kept;
    await writeJsonAtomic(join(this.home, 'index.json'), index);
    return { removed: true, repoKeptAt: this.repoPath(dir) };
  }

  /** Drop a repository's history from disk (the protected folder is untouched). */
  async forget(path) {
    const dir = resolve(path);
    await this.unprotect(dir);
    await rm(this.repoPath(dir), { recursive: true, force: true });
    return { ok: true };
  }

  /**
   * Turn automatic snapshots on or off for one folder.
   *
   * Two modes, switchable at any time:
   *
   *   * `realtime: true` — the host watches the folder and stores a version a
   *     few seconds after the last change: one version per edit.
   *   * `realtime: false` — the host checks every minute and stores a version
   *     when the interval has elapsed and something actually changed.
   *
   * Watching a folder that is not protected yet protects it: "back this up
   * every hour" is a complete instruction, and asking for a second one first
   * would be a papercut.
   */
  async setWatch(path, options = {}) {
    const dir = resolve(path);
    const index = await this.readIndex();
    let folder = index.folders.find((f) => f.path.toLowerCase() === dir.toLowerCase());
    if (folder === undefined) {
      folder = (await this.protect(dir)).folder;
      return this.setWatch(dir, options);
    }
    const intervalMs = Number.isFinite(options.intervalMs)
      ? Math.max(60_000, Math.round(options.intervalMs))
      : 30 * 60_000;
    const debounceMs = Number.isFinite(options.debounceMs)
      ? Math.max(100, Math.round(options.debounceMs))
      : DEFAULT_DEBOUNCE_MS;
    folder.watch = {
      enabled: options.enabled !== false,
      realtime: options.realtime === true,
      intervalMs,
      debounceMs,
    };
    await writeJsonAtomic(join(this.home, 'index.json'), index);
    return folder;
  }

  /** Folders whose changes the host should watch live. */
  async realtimeFolders() {
    const index = await this.readIndex();
    return index.folders.filter((folder) => folder.watch?.enabled === true && folder.watch.realtime === true);
  }

  /** Protected folders whose next timed snapshot is due (realtime folders are watched instead). */
  async dueForAutoSnapshot(now = Date.now()) {
    const index = await this.readIndex();
    const due = [];
    for (const folder of index.folders) {
      const watch = folder.watch;
      if (watch === undefined || watch.enabled !== true) continue;
      if (watch.realtime === true) continue;
      const interval = Number.isFinite(watch.intervalMs) ? Math.max(60_000, watch.intervalMs) : 30 * 60_000;
      const repo = await this.repoOf(folder.path);
      const latest = repo === undefined ? undefined : (await this.snapshotList(repo))[0];
      const last = latest === undefined ? 0 : Date.parse(latest.at);
      if (!Number.isFinite(last) || now - last >= interval) due.push(folder);
    }
    return due;
  }

  async folderEntry(path) {
    const dir = resolve(path);
    const index = await this.readIndex();
    return index.folders.find((f) => f.path.toLowerCase() === dir.toLowerCase());
  }

  repoPath(path) {
    return join(this.home, keyOf(path));
  }

  async repoOf(path) {
    const dir = this.repoPath(path);
    const meta = await readJson(join(dir, 'meta.json'));
    if (meta === undefined) return undefined;
    return { dir, meta };
  }

  // ------------------------------------------------------------------ snapshots

  async snapshotList(repo) {
    const dir = join(repo.dir, 'snapshots');
    const names = await readdir(dir).catch(() => []);
    const rows = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const manifest = await readJson(join(dir, name));
      if (manifest === undefined) continue;
      rows.push({
        id: manifest.id,
        at: manifest.at,
        label: manifest.label ?? '',
        trigger: manifest.trigger ?? 'manual',
        stats: manifest.stats ?? { files: 0, bytes: 0 },
        summary: manifest.summary ?? { added: 0, changed: 0, removed: 0 },
      });
    }
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return rows;
  }

  async snapshots(path, options = {}) {
    const dir = resolve(path);
    const repo = await this.repoOf(dir);
    if (repo === undefined) return [];
    const rows = await this.snapshotList(repo);
    const limit = Number.isFinite(options.limit) ? Math.max(1, options.limit) : 50;
    return rows.slice(0, limit);
  }

  async manifestOf(path, id) {
    const dir = resolve(path);
    const repo = await this.repoOf(dir);
    if (repo === undefined) throw new Error(`folder is not protected: ${dir}`);
    const manifest = await readJson(join(repo.dir, 'snapshots', id + '.json'));
    if (manifest === undefined) throw new Error(`snapshot not found: ${id}`);
    return { repo, manifest };
  }

  /**
   * Walk a folder and record every file's content hash (content-addressed).
   *
   * Directories that hold no file at all — directly or anywhere beneath them —
   * are recorded too. They have no content to hash, but "this empty folder must
   * exist" is real state: mod loaders, save-game scanners and config tools all
   * care about a folder being there, and a version that forgot it would restore
   * a folder that the app then refuses to start with.
   */
  async scan(dir, exclude) {
    const files = [];
    const dirs = [];
    const skipped = [];
    const patterns = [...DEFAULT_EXCLUDE, ...(exclude ?? [])];
    const walk = async (current, rel) => {
      const children = await readdir(current, { withFileTypes: true }).catch((error) => {
        skipped.push({ path: rel === '' ? '.' : rel, reason: String(error?.code ?? error) });
        return [];
      });
      for (const child of children) {
        const childRel = rel === '' ? child.name : rel + '/' + child.name;
        if (matchesExclude(child.name, childRel, patterns)) continue;
        if (child.isSymbolicLink()) {
          skipped.push({ path: childRel, reason: 'symlink' });
          continue;
        }
        const full = join(current, child.name);
        if (child.isDirectory()) {
          dirs.push(childRel);
          await walk(full, childRel);
          continue;
        }
        if (!child.isFile()) {
          skipped.push({ path: childRel, reason: 'not-a-file' });
          continue;
        }
        const info = await stat(full).catch(() => undefined);
        if (info === undefined) {
          skipped.push({ path: childRel, reason: 'stat-failed' });
          continue;
        }
        if (info.size > this.maxFileBytes) {
          skipped.push({ path: childRel, reason: 'too-large', size: info.size });
          continue;
        }
        files.push({ p: childRel, s: info.size, m: Math.floor(info.mtimeMs), full });
      }
    };
    await walk(dir, '');

    // A directory only needs its own entry when nothing beneath it survived the
    // walk — otherwise the file paths already imply it exists.
    const entries = [...files];
    for (const parent of dirs) {
      const prefix = parent + '/';
      if (files.some((file) => file.p.startsWith(prefix))) continue;
      entries.push({ p: parent, d: true, s: 0, m: 0 });
    }
    entries.sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0));
    return { entries, skipped };
  }

  async objectPath(repo, hash) {
    return join(repo.dir, 'objects', hash.slice(0, 2), hash);
  }

  /**
   * Store one file's bytes under its hash, unless that hash is already stored.
   *
   * A copy — never a hard link — is deliberate: a hard-linked object shares its
   * inode with the live file, so the first program that edits that file in place
   * would silently rewrite history. Copies cost disk; history that can be
   * rewritten costs trust.
   */
  async storeObject(repo, hash, source) {
    const target = await this.objectPath(repo, hash);
    const existing = await stat(target).catch(() => undefined);
    if (existing !== undefined && existing.size > 0) return false;
    await mkdir(dirname(target), { recursive: true });
    const tmp = target + '.tmp-' + process.pid;
    await copyFile(source, tmp);
    await rename(tmp, target);
    return true;
  }

  async snapshot(path, options = {}) {
    const dir = resolve(path);
    const existing = await this.folderEntry(dir);
    if (existing === undefined && options.autoProtect !== false) {
      // A snapshot's own label names the moment, never the folder; the folder
      // keeps its directory name unless `protect` was told otherwise.
      await this.protect(dir, { exclude: options.exclude });
    } else if (existing !== undefined && Array.isArray(options.exclude)) {
      existing.exclude = options.exclude;
    }
    const folder = (await this.folderEntry(dir)) ?? { path: dir, exclude: [] };
    return this.queue(dir.toLowerCase(), () => this.snapshotLocked(dir, folder, options));
  }

  /**
   * The snapshot body.
   *
   * Callers must already hold this folder's queue: `restore` runs inside it and
   * takes a safety snapshot, and queueing a second time from in there would wait
   * on itself forever.
   */
  async snapshotLocked(dir, folder, options = {}) {
    {
      const repo = { dir: this.repoPath(dir) };
      await mkdir(join(repo.dir, 'objects'), { recursive: true });
      await mkdir(join(repo.dir, 'snapshots'), { recursive: true });
      const startedAt = Date.now();
      const { entries, skipped } = await this.scan(dir, folder.exclude ?? []);
      const previous = await this.latestManifest(repo);
      const previousByPath = new Map();
      for (const entry of previous?.entries ?? []) previousByPath.set(entry.p, entry);

      // Hash only what changed: an unchanged size + mtime inherits the old hash,
      // which is what keeps a nightly snapshot of a big folder cheap.
      const recorded = [];
      let bytes = 0;
      let copied = 0;
      let reused = 0;
      let added = 0;
      let changed = 0;
      for (const entry of entries) {
        const before = previousByPath.get(entry.p);
        if (entry.d === true) {
          // A directory carries no content, but its existence is state: a version
          // that lost an empty folder would restore a tree the app cannot start
          // from. Coming or going counts as a change; nothing else about it can.
          if (before === undefined || before.d !== true) added += 1;
          recorded.push({ p: entry.p, d: true });
          continue;
        }
        let hash;
        if (before !== undefined && before.s === entry.s && before.m === entry.m) {
          hash = before.h;
          reused += 1;
        } else {
          hash = await sha256File(entry.full);
          const stored = await this.storeObject(repo, hash, entry.full);
          if (stored) copied += 1;
        }
        if (before === undefined) added += 1;
        else if (before.h !== hash) changed += 1;
        bytes += entry.s;
        recorded.push({ p: entry.p, h: hash, s: entry.s, m: entry.m });
      }
      const fileCount = recorded.filter((entry) => entry.d !== true).length;
      const dirCount = recorded.length - fileCount;
      let removed = 0;
      if (previous !== undefined) {
        const present = new Set(recorded.map((entry) => entry.p));
        for (const entry of previous.entries) if (!present.has(entry.p)) removed += 1;
      }

      // An automatic snapshot that would record exactly what the previous
      // version already says is not history, it is noise: a folder-event storm
      // (a build touching a temp dir, an editor rewriting its own lock file, a
      // new empty directory) must not bury the versions that matter.
      //
      // Manual snapshots always land: a person asking for a version is the
      // authority on whether they want it, even when nothing changed.
      const automatic = options.trigger === 'auto' || options.trigger === 'watch';
      const identical =
        previous !== undefined &&
        previous.entries.length === recorded.length &&
        recorded.every(
          (entry, index) => previous.entries[index].p === entry.p && previous.entries[index].h === entry.h,
        );
      if (automatic && options.force !== true && identical) {
        return {
          skipped: true,
          reason: 'unchanged',
          id: previous.id,
          at: previous.at,
          label: previous.label ?? '',
          files: fileCount,
          dirs: dirCount,
          bytes,
          added: 0,
          changed: 0,
          removed: 0,
          objectsStored: 0,
          hashesReused: reused,
          skippedCount: skipped.length,
          durationMs: Date.now() - startedAt,
        };
      }

      const at = new Date().toISOString();
      const id = snapshotId(startedAt);
      const manifest = {
        id,
        at,
        root: dir,
        label: options.label ?? '',
        trigger: options.trigger ?? 'manual',
        stats: {
          files: fileCount,
          dirs: dirCount,
          bytes,
          bytesCopied: 0,
          objectsStored: copied,
          hashesReused: reused,
          durationMs: Date.now() - startedAt,
          skipped: skipped.slice(0, 200),
          skippedCount: skipped.length,
        },
        summary: { added, changed, removed },
        entries: recorded,
      };
      await writeJsonAtomic(join(repo.dir, 'snapshots', id + '.json'), manifest);
      await writeJsonAtomic(join(repo.dir, 'meta.json'), {
        root: dir,
        label: folder.label ?? basename(dir),
        updatedAt: at,
        snapshotCount: (await this.snapshotList(repo)).length,
      });
      await this.prune(repo, options.keep ?? this.keep);
      return {
        id,
        at,
        label: manifest.label,
        files: fileCount,
        dirs: dirCount,
        bytes,
        added,
        changed,
        removed,
        objectsStored: copied,
        hashesReused: reused,
        skippedCount: skipped.length,
        skipped: skipped.slice(0, 20),
        durationMs: manifest.stats.durationMs,
      };
    }
  }

  async latestManifest(repo) {
    const rows = await this.snapshotList(repo);
    if (rows.length === 0) return undefined;
    return readJson(join(repo.dir, 'snapshots', rows[0].id + '.json'));
  }

  async prune(repo, keep) {
    if (!Number.isFinite(keep) || keep <= 0) return 0;
    const rows = await this.snapshotList(repo);
    let removed = 0;
    for (const row of rows.slice(keep)) {
      await rm(join(repo.dir, 'snapshots', row.id + '.json'), { force: true });
      removed += 1;
    }
    return removed;
  }

  // ------------------------------------------------------------------ compare

  /** Compare a snapshot against the live folder (`to` omitted) or another snapshot. */
  async diff(path, options = {}) {
    const dir = resolve(path);
    const { repo, manifest: from } = await this.manifestOf(dir, options.from);
    let to;
    if (options.to === undefined || options.to === '' || options.to === 'current') {
      const folder = (await this.folderEntry(dir)) ?? { exclude: [] };
      const { entries, skipped } = await this.scan(dir, folder.exclude ?? []);
      const map = new Map();
      for (const entry of entries) {
        if (entry.d === true) {
          map.set(entry.p, { p: entry.p, d: true });
          continue;
        }
        const before = from.entries.find((e) => e.p === entry.p);
        let hash = before?.h;
        if (hash === undefined || before.s !== entry.s || before.m !== entry.m) {
          hash = await sha256File(entry.full);
        }
        map.set(entry.p, { p: entry.p, h: hash, s: entry.s, m: entry.m });
      }
      to = { id: 'current', at: new Date().toISOString(), entries: [...map.values()], stats: { skipped } };
    } else {
      to = (await this.manifestOf(dir, options.to)).manifest;
    }
    const fromMap = new Map(from.entries.map((entry) => [entry.p, entry]));
    const toMap = new Map(to.entries.map((entry) => [entry.p, entry]));
    const added = [];
    const removed = [];
    const changed = [];
    for (const [p, entry] of toMap) {
      const before = fromMap.get(p);
      if (before === undefined) added.push({ path: p, size: entry.s ?? 0 });
      else if (before.h !== entry.h) changed.push({ path: p, size: entry.s, beforeSize: before.s });
    }
    for (const [p, entry] of fromMap) if (!toMap.has(p)) removed.push({ path: p, size: entry.s });
    return {
      root: dir,
      from: { id: from.id, at: from.at, files: from.entries.length },
      to: { id: to.id, at: to.at, files: to.entries.length },
      added,
      changed,
      removed,
      skipped: to.stats?.skipped ?? [],
    };
  }

  // ------------------------------------------------------------------ restore

  /**
   * Put a folder back to a snapshot.
   *
   * `mode: 'exact'` (default) makes the folder look exactly like the snapshot,
   * including deleting files created after it and empty folders that were not
   * there. `mode: 'overwrite'` only restores the snapshot's own files and leaves
   * anything newer in place.
   *
   * Only *empty* folders are ever removed: a folder holding files the snapshot
   * never knew about (excluded paths, files another process just wrote) is left
   * alone, because deleting it would destroy content to satisfy a shape.
   *
   * A safety snapshot is taken first, always: a restore is itself undoable.
   */
  async restore(path, options = {}) {
    const dir = resolve(path);
    const { repo, manifest } = await this.manifestOf(dir, options.snapshotId);
    const mode = options.mode === 'overwrite' ? 'overwrite' : 'exact';
    return this.queue(dir.toLowerCase(), async () => {
      const safety = options.safetySnapshot === false
        ? undefined
        : await this.snapshotLocked(
            dir,
            (await this.folderEntry(dir)) ?? { path: dir, exclude: [] },
            { label: 'restore point', trigger: 'pre-restore' },
          );
      const wanted = new Map(manifest.entries.map((entry) => [entry.p, entry]));
      const { entries: present } = await this.scan(dir, (await this.folderEntry(dir))?.exclude ?? []);
      const restored = [];
      const restoredDirs = [];
      const missingObjects = [];
      for (const entry of manifest.entries) {
        const target = join(dir, ...entry.p.split('/'));
        if (entry.d === true) {
          // An empty folder the version remembers. Recreate it, and count it as
          // restored only when it was actually missing.
          const info = await stat(target).catch(() => undefined);
          if (info !== undefined && info.isDirectory()) continue;
          await mkdir(target, { recursive: true });
          restoredDirs.push(entry.p);
          continue;
        }
        const info = await stat(target).catch(() => undefined);
        let current = undefined;
        if (info !== undefined && info.isFile() && info.size === entry.s) {
          current = await sha256File(target);
        }
        if (current === entry.h) continue;
        const object = await this.objectPath(repo, entry.h);
        const objectInfo = await stat(object).catch(() => undefined);
        if (objectInfo === undefined) {
          missingObjects.push(entry.p);
          continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await copyFile(object, target);
        restored.push(entry.p);
      }
      const deleted = [];
      const deletedDirs = [];
      if (mode === 'exact') {
        for (const entry of present) {
          if (wanted.has(entry.p)) continue;
          if (entry.d === true) {
            // Only an empty folder can be removed; rmdir refuses anything else,
            // and that refusal is the safety net we want.
            const removedDir = await rmdir(join(dir, ...entry.p.split('/'))).then(() => true, () => false);
            if (removedDir) deletedDirs.push(entry.p);
            continue;
          }
          await rm(entry.full, { force: true });
          deleted.push(entry.p);
        }
      }
      return {
        ok: missingObjects.length === 0,
        root: dir,
        snapshotId: manifest.id,
        mode,
        restored: restored.length,
        restoredPaths: restored.slice(0, 200),
        restoredDirs: restoredDirs.length,
        restoredDirPaths: restoredDirs.slice(0, 200),
        deleted: deleted.length,
        deletedPaths: deleted.slice(0, 200),
        deletedDirs: deletedDirs.length,
        missingObjects,
        safetySnapshotId: safety?.id,
      };
    });
  }
}

/** A short human summary of one snapshot row, for tool output and the panel. */
export function describeSnapshot(row) {
  const when = new Date(row.at);
  const files = row.stats?.files ?? 0;
  const dirs = row.stats?.dirs ?? 0;
  const bytes = row.stats?.bytes ?? 0;
  return `${row.id}  ${when.toLocaleString()}  ${files} 个文件` +
    (dirs > 0 ? ` + ${dirs} 个空目录` : '') +
    ` / ${formatBytes(bytes)}` +
    ` (+${row.summary?.added ?? 0} ~${row.summary?.changed ?? 0} -${row.summary?.removed ?? 0})`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** power;
  return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
}
