// Engine smoke test: no DSH, no network, just the snapshot contract.
//
//   node tools/smoke.mjs
//
// It builds a throwaway folder, snapshots it, changes it, diffs, restores, and
// asserts the folder is byte-for-byte back to where it started.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimeMachine, formatBytes, isExcludedChange } from '../lib/store.js';

let failures = 0;
function check(label, condition, detail = '') {
  const mark = condition ? 'ok  ' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`${mark} ${label}${detail === '' ? '' : ' — ' + detail}`);
}

const home = await mkdtemp(join(tmpdir(), 'tm-home-'));
const root = await mkdtemp(join(tmpdir(), 'tm-src-'));
const tm = new TimeMachine({ home, log: () => {} });

try {
  // ---- fixture
  await writeFile(join(root, 'a.txt'), 'first version\n');
  await mkdir(join(root, 'sub'), { recursive: true });
  await writeFile(join(root, 'sub', 'b.txt'), 'bee\n');
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '// excluded\n');

  // ---- protect + first snapshot
  const protectedNow = await tm.protect(root, { label: 'smoke folder' });
  check('protect() registers the folder', protectedNow.added === true);

  const s1 = await tm.snapshot(root);
  check('snapshot 1 counts only non-excluded files', s1.files === 2, `files=${s1.files}`);
  check('snapshot 1 reports both files as added', s1.added === 2, `added=${s1.added}`);
  check('first snapshot stores both objects', s1.objectsStored === 2, `stored=${s1.objectsStored}`);

  // ---- unchanged snapshot reuses hashes (the cheap path)
  const s1again = await tm.snapshot(root);
  check('identical re-snapshot reuses every hash', s1again.hashesReused === 2, `reused=${s1again.hashesReused}`);
  check('identical re-snapshot copies no object', s1again.objectsStored === 0, `stored=${s1again.objectsStored}`);

  // ---- mutate: change one, add one, delete one
  await writeFile(join(root, 'a.txt'), 'second version\n');
  await writeFile(join(root, 'd.txt'), 'new file\n');
  await rm(join(root, 'sub', 'b.txt'));

  const s2 = await tm.snapshot(root);
  // +2, not +1: d.txt is new, and deleting sub/b.txt turned `sub` into an empty
  // folder — an empty folder is state, so its arrival counts as a change.
  check('snapshot 2 sees the new file and the newly-empty folder', s2.added === 2, `added=${s2.added}`);
  check('snapshot 2 sees 1 changed', s2.changed === 1, `changed=${s2.changed}`);
  check('snapshot 2 sees 1 removed', s2.removed === 1, `removed=${s2.removed}`);

  // ---- history listing
  const history = await tm.snapshots(root);
  check('history lists snapshots newest first', history.length >= 2 && history[0].id === s2.id);

  // ---- diff against the live folder
  const d = await tm.diff(root, { from: s1.id });
  check('diff.a added', d.added.some((entry) => entry.path === 'd.txt'));
  check('diff.a changed', d.changed.some((entry) => entry.path === 'a.txt'));
  check('diff.a removed', d.removed.some((entry) => entry.path === 'sub/b.txt'));

  // ---- restore the first snapshot exactly
  const back = await tm.restore(root, { snapshotId: s1.id, mode: 'exact' });
  check('restore reports success', back.ok === true, JSON.stringify(back.missingObjects));
  check('restore wrote a safety snapshot first', typeof back.safetySnapshotId === 'string');
  check('a.txt is back to its first content', (await readFile(join(root, 'a.txt'), 'utf8')) === 'first version\n');
  check('sub/b.txt is back', (await readFile(join(root, 'sub', 'b.txt'), 'utf8')) === 'bee\n');
  const dGone = await stat(join(root, 'd.txt')).then(() => false, () => true);
  check('d.txt (created after snapshot 1) was removed in exact mode', dGone === true);
  const excluded = await stat(join(root, 'node_modules', 'pkg', 'index.js')).then(() => true, () => false);
  check('excluded node_modules was never touched', excluded === true);

  // ---- overwrite mode leaves newer files alone
  await writeFile(join(root, 'a.txt'), 'third version\n');
  await writeFile(join(root, 'keep.txt'), 'should survive\n');
  const soft = await tm.restore(root, { snapshotId: s1.id, mode: 'overwrite', safetySnapshot: false });
  check('overwrite mode restores the snapshot file', (await readFile(join(root, 'a.txt'), 'utf8')) === 'first version\n');
  check('overwrite mode keeps an unrelated newer file', (await readFile(join(root, 'keep.txt'), 'utf8')) === 'should survive\n');
  check('overwrite mode deletes nothing', soft.deleted === 0, `deleted=${soft.deleted}`);

  // ---- disk dedup: three snapshots of one changed file keep one object per content
  const objects = await tm.objectPath({ dir: tm.repoPath(root) }, 'x'.repeat(64)).then((p) => p.replace(/[\\/]x{2}[\\/].*$/, ''));
  const bytes = await tm.list();
  check('list() reports the folder with history', bytes.length === 1 && bytes[0].snapshotCount >= 4, JSON.stringify(bytes[0]?.snapshotCount));
  console.log(`     repository at ${objects}`);

  // ---- realtime vs timed automatic snapshots
  const watched = await tm.setWatch(root, { enabled: true, realtime: true, debounceMs: 250 });
  check('setWatch() records realtime mode', watched.watch.realtime === true && watched.watch.debounceMs === 250, JSON.stringify(watched.watch));
  const realtimeRows = await tm.realtimeFolders();
  check('realtimeFolders() lists the folder', realtimeRows.length === 1 && realtimeRows[0].path === root);
  const due = await tm.dueForAutoSnapshot();
  check('the timed scan skips realtime folders', due.length === 0, `due=${due.length}`);

  const timed = await tm.setWatch(root, { enabled: true, realtime: false, intervalMs: 60_000 });
  check('switching back to timed mode sticks', timed.watch.realtime === false);
  check('realtimeFolders() is empty again', (await tm.realtimeFolders()).length === 0);
  check('the timed scan now considers the folder', (await tm.dueForAutoSnapshot(Date.now() + 3_600_000)).length === 1);

  check('isExcludedChange() ignores node_modules writes', isExcludedChange('node_modules/pkg/index.js') === true);
  check('isExcludedChange() ignores .git writes', isExcludedChange('.git/index') === true);
  check('isExcludedChange() respects custom patterns', isExcludedChange('build/out.bin', ['build']) === true);
  check('isExcludedChange() allows ordinary files', isExcludedChange('src/main.js') === false);
  check('isExcludedChange() allows a file merely named like a folder', isExcludedChange('notes/node_modules.md') === false);

  // ---- automatic snapshots skip identical content; manual ones always land
  // Bring the tip up to date first: the restores above left the folder in a
  // state no version describes yet, and "unchanged" is only meaningful against
  // the newest version.
  await tm.snapshot(root, { trigger: 'model' });
  const beforeSkip = (await tm.snapshots(root)).length;
  const autoSame = await tm.snapshot(root, { trigger: 'watch' });
  check('an unchanged automatic snapshot is skipped', autoSame.skipped === true, JSON.stringify(autoSame).slice(0, 90));
  check('a skipped snapshot wrote no version', (await tm.snapshots(root)).length === beforeSkip);
  const manualSame = await tm.snapshot(root, { trigger: 'model' });
  check('a manual snapshot always lands', manualSame.skipped !== true && typeof manualSame.id === 'string', String(manualSame.id));
  check('the manual one added a version', (await tm.snapshots(root)).length === beforeSkip + 1);
  const forced = await tm.snapshot(root, { trigger: 'watch', force: true });
  check('force overrides the skip', forced.skipped !== true, String(forced.id));

  // ---- empty folders are state too
  await mkdir(join(root, 'empty-one'), { recursive: true });
  await mkdir(join(root, 'nested', 'deep-empty'), { recursive: true });
  const withDirs = await tm.snapshot(root, { trigger: 'model' });
  const manifestWithDirs = (await tm.manifestOf(root, withDirs.id)).manifest;
  check('an empty folder is recorded', manifestWithDirs.entries.some((entry) => entry.p === 'empty-one' && entry.d === true));
  check('a nested empty folder is recorded', manifestWithDirs.entries.some((entry) => entry.p === 'nested/deep-empty' && entry.d === true));
  check('the snapshot reports its folder count', withDirs.dirs >= 2, `dirs=${withDirs.dirs}`);
  check(
    'the file count still excludes folders',
    withDirs.files === manifestWithDirs.entries.filter((entry) => entry.d !== true).length,
    `files=${withDirs.files}`,
  );
  check(
    'a folder holding files is not recorded as empty',
    !manifestWithDirs.entries.some((entry) => entry.p === 'sub' && entry.d === true),
  );

  await rm(join(root, 'empty-one'), { recursive: true, force: true });
  await rm(join(root, 'nested'), { recursive: true, force: true });
  const dirsBack = await tm.restore(root, { snapshotId: withDirs.id, mode: 'exact', safetySnapshot: false });
  check('restore recreates the empty folder', await stat(join(root, 'empty-one')).then((info) => info.isDirectory(), () => false));
  check('restore recreates the nested empty folder', await stat(join(root, 'nested', 'deep-empty')).then((info) => info.isDirectory(), () => false));
  check('restore reports the folders it recreated', dirsBack.restoredDirs >= 2, `restoredDirs=${dirsBack.restoredDirs}`);

  await mkdir(join(root, 'stranger'), { recursive: true });
  const cleaned = await tm.restore(root, { snapshotId: withDirs.id, mode: 'exact', safetySnapshot: false });
  check('exact restore removes a folder the version never had', await stat(join(root, 'stranger')).then(() => false, () => true));
  check('exact restore reports the folder it removed', cleaned.deletedDirs >= 1, `deletedDirs=${cleaned.deletedDirs}`);

  // overwrite mode must not remove folders either
  await mkdir(join(root, 'kept-folder'), { recursive: true });
  await tm.restore(root, { snapshotId: withDirs.id, mode: 'overwrite', safetySnapshot: false });
  check('overwrite restore keeps an unknown folder', await stat(join(root, 'kept-folder')).then((info) => info.isDirectory(), () => false));

  // ---- unprotect keeps history on disk
  const off = await tm.unprotect(root);
  check('unprotect() removes the registry row', off.removed === true);
  const afterUnprotect = (await tm.snapshots(root)).length;
  check('history survives unprotect', afterUnprotect >= 4, `snapshots=${afterUnprotect}`);
  check('formatBytes() reads like a human wrote it', formatBytes(1536) === '1.5 KB', formatBytes(1536));
} finally {
  await rm(home, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall engine checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
