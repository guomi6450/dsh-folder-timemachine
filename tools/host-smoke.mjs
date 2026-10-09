// Host-half integration test: load the real plugin into a fake Cordis context
// and drive it the way DSH would — tool registration, the approval waterfall,
// and the HTTP route the panel talks to.
//
//   node tools/host-smoke.mjs
//
// DSH_HOME points at a throwaway directory, so nothing here touches the real
// ~/.dsh store.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const home = await mkdtemp(join(tmpdir(), 'tm-host-'));
process.env.DSH_HOME = home;

const { apply, name, inject, ROUTE } = await import('../lib/host.js');

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ' — ' + detail}`);
}

// --------------------------------------------------------------------- fake ctx

const tools = [];
const routes = [];
const approvalChecks = [];
const effects = [];
let intervalCalls = 0;

function makeCtx(options = {}) {
  const toolRegistry = {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  };
  const mixinInterval =
    options.mixinOnly === true
      ? function interval() {
          intervalCalls += 1;
          return () => {};
        }
      : undefined;
  const hostServices = {
    tools: toolRegistry,
    timer:
      options.mixinOnly === true
        ? undefined
        : {
            interval() {
              intervalCalls += 1;
              return () => {};
            },
          },
    // No connection service in this fake context: the route must fall back to
    // its own local-host fence, which is exactly what the 403 check below proves.
    connection: undefined,
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    get(key) {
      return this[key];
    },
  };
  const ctx = {
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    effect(fn) {
      effects.push(fn());
      return () => {};
    },
    on(event, handler) {
      if (event === 'tools/pre-execute') approvalChecks.push(handler);
      return () => {};
    },
    inject(names, callback) {
      const slice = {};
      for (const key of names) slice[key] = hostServices[key];
      if (mixinInterval !== undefined) slice.interval = mixinInterval;
      slice.get = (key) => hostServices[key];
      slice.effect = ctx.effect;
      callback(slice);
    },
    get() {
      return undefined;
    },
    webServer: hostServices.webServer,
  };
  return ctx;
}

apply(makeCtx());

check('plugin exports a name', name === 'dsh-folder-timemachine');
check('plugin injects webServer', Array.isArray(inject) && inject.includes('webServer'));
check('registers exactly one tool', tools.length === 1, `tools=${tools.length}`);
check('tool is named folder_timemachine', tools[0]?.name === 'folder_timemachine');
check('registers the panel route', routes.length === 1 && routes[0].path === ROUTE);
check('installs one auto-snapshot tick', intervalCalls === 1, `intervals=${intervalCalls}`);
check('subscribes to the approval waterfall', approvalChecks.length === 1);

const tool = tools[0];
const call = (args) => tool.execute(args, { agent: { session: { header: { cwd: target } } } });

// --------------------------------------------------------------------- fixture

const target = await mkdtemp(join(tmpdir(), 'tm-target-'));
await writeFile(join(target, 'save.dat'), 'level 1\n');
await mkdir(join(target, 'profiles'), { recursive: true });
await writeFile(join(target, 'profiles', 'p1.cfg'), 'gamma=1\n');

// --------------------------------------------------------------------- tool

const status0 = await call({ action: 'status' });
check('status on an empty store explains itself', /还没有任何文件夹受保护/.test(status0.message));

const snap1 = await call({ action: 'snapshot', label: '改之前' });
check('snapshot via tool succeeds', /存下时间点/.test(snap1.message), snap1.message.split('\n')[0]);
check('snapshot output carries a snapshot row', snap1.snapshots.length === 1);
check('snapshot output rows match the output schema', /^[0-9]{8}-[0-9]{6}-/.test(snap1.snapshots[0].id));
check('snapshot without dir used the session cwd', snap1.message.includes(target));

const status1 = await call({ action: 'status' });
check('status lists the folder after the first snapshot', status1.folders.length === 1);
check('status reports one snapshot', status1.folders[0].snapshotCount === 1, JSON.stringify(status1.folders[0]));

await writeFile(join(target, 'save.dat'), 'level 2\n');
await writeFile(join(target, 'new.txt'), 'added later\n');
const snap2 = await call({ action: 'snapshot' });
check('second snapshot sees the change', snap2.snapshots[0].changed === 1 && snap2.snapshots[0].added === 1);

const history = await call({ action: 'history' });
check('history lists both snapshots newest first', history.snapshots.length === 2);
check('history rows carry the label', history.snapshots.some((row) => row.label === '改之前'));

const diff = await call({ action: 'diff', from: history.snapshots[1].id });
check('diff finds the added file', diff.diff.added.includes('new.txt'), JSON.stringify(diff.diff.added));
check('diff finds the changed file', diff.diff.changed.includes('save.dat'));

const restore = await call({ action: 'restore', snapshotId: history.snapshots[1].id, mode: 'exact' });
check('restore via tool reports the rollback', /已把/.test(restore.message), restore.message.split('\n')[0]);
check('restored file content is back', (await readFile(join(target, 'save.dat'), 'utf8')) === 'level 1\n');
check('added file was removed by exact restore', await readFile(join(target, 'new.txt'), 'utf8').then(() => false, () => true));

const watch = await call({ action: 'watch', enabled: true, minutes: 5 });
check('watch turns timed snapshots on', /每 5 分钟/.test(watch.message), watch.message);

const unknown = await call({ action: 'nonsense' });
check('unknown action answers instead of throwing', /未知的 action/.test(unknown.message));

// --------------------------------------------------------------------- approval

const gate = approvalChecks[0];
const gateOf = (action) => {
  let passed = false;
  const outcome = gate({ name: 'folder_timemachine', arguments: { action } }, () => {
    passed = true;
    return 'next';
  });
  return { passed, outcome };
};
check('status needs no approval', gateOf('status').passed === true);
check('history needs no approval', gateOf('history').passed === true);
check('diff needs no approval', gateOf('diff').passed === true);
check('snapshot asks for approval', gateOf('snapshot').outcome?.kind === 'ask', JSON.stringify(gateOf('snapshot').outcome));
check('restore asks for approval', gateOf('restore').outcome?.kind === 'ask');
check('forget asks for approval', gateOf('forget').outcome?.kind === 'ask');
check('unrelated tools pass through', gate({ name: 'bash', arguments: {} }, () => 'next') === 'next');

// --------------------------------------------------------------------- HTTP

function fakeRequest({ method = 'GET', url = ROUTE, body, host = '127.0.0.1:19387' } = {}) {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  stream.method = method;
  stream.url = url;
  stream.headers = { host, 'content-type': 'application/json' };
  return stream;
}

function fakeResponse() {
  const chunks = [];
  return {
    status: 0,
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers ?? {};
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(String(chunk));
    },
    text() {
      return chunks.join('');
    },
    json() {
      return JSON.parse(chunks.join('') || '{}');
    },
  };
}

const handler = routes[0].handler;

/** Read one stored manifest straight off disk — the panel's own second opinion. */
async function loadManifest(id) {
  const root = join(home, 'folder-timemachine');
  const entries = await readdir(root, { withFileTypes: true });
  const repo = entries.find((entry) => entry.isDirectory());
  return JSON.parse(await readFile(join(root, repo.name, 'snapshots', id + '.json'), 'utf8'));
}
const getStatus = fakeResponse();
await handler(fakeRequest({ url: ROUTE + '?op=status' }), getStatus);
check('GET ?op=status returns the folder list', getStatus.status === 200 && getStatus.json().folders.length === 1, getStatus.text().slice(0, 120));

const getHistory = fakeResponse();
await handler(fakeRequest({ url: ROUTE + '?op=history&dir=' + encodeURIComponent(target) }), getHistory);
check('GET ?op=history returns snapshots', getHistory.json().snapshots.length >= 2, `count=${getHistory.json().snapshots?.length}`);

const postSnapshot = fakeResponse();
await handler(fakeRequest({ method: 'POST', body: { op: 'snapshot', dir: target } }), postSnapshot);
check('POST op=snapshot works from the panel route', postSnapshot.json().ok === true, postSnapshot.text().slice(0, 160));

const postBadOp = fakeResponse();
await handler(fakeRequest({ method: 'POST', body: { op: 'nope' } }), postBadOp);
check('unknown op is refused politely', postBadOp.json().ok === false && /unknown op/.test(postBadOp.json().error));

const forbidden = fakeResponse();
await handler(fakeRequest({ url: ROUTE + '?op=status', host: 'evil.example.com' }), forbidden);
check('a foreign Host header is refused', forbidden.status === 403, `status=${forbidden.status}`);

// --------------------------------------------------------------------- realtime watch

// The host half watches real folders with fs.watch and snapshots after the
// changes stop. Drive it for real: a 0.3s debounce keeps the test quick while
// still going through the same code path a user's edit takes.
const postWatch = fakeResponse();
await handler(
  fakeRequest({
    method: 'POST',
    body: { op: 'watch', dir: target, enabled: true, realtime: true, debounceSeconds: 0.3 },
  }),
  postWatch,
);
check(
  'realtime watch is accepted over the panel route',
  postWatch.json().ok === true && postWatch.json().watch?.realtime === true,
  postWatch.text().slice(0, 160),
);

const beforeLive = (await call({ action: 'history' })).snapshots.length;
await writeFile(join(target, 'live-change.txt'), 'a live edit\n');
await new Promise((resolve_) => setTimeout(resolve_, 2200));
const afterLive = await call({ action: 'history' });
check(
  'a live file change produced a new version',
  afterLive.snapshots.length === beforeLive + 1,
  `${beforeLive} -> ${afterLive.snapshots.length}`,
);
check(
  'the live version is labelled as automatic',
  afterLive.snapshots[0]?.trigger === 'watch',
  String(afterLive.snapshots[0]?.trigger),
);

// A write inside an excluded folder must not buy a version.
const beforeExcluded = afterLive.snapshots.length;
await mkdir(join(target, 'node_modules'), { recursive: true });
await writeFile(join(target, 'node_modules', 'noise.js'), '// excluded\n');
await new Promise((resolve_) => setTimeout(resolve_, 1600));
const afterExcluded = (await call({ action: 'history' })).snapshots.length;
check('an excluded folder change bought no version', afterExcluded === beforeExcluded, `${beforeExcluded} -> ${afterExcluded}`);

// A directory-only change is state too: an empty folder must buy a version,
// because "this folder must exist" is exactly what mod loaders and save
// scanners depend on.
const beforeDirOnly = (await call({ action: 'history' })).snapshots.length;
await mkdir(join(target, 'empty-dir'), { recursive: true });
await new Promise((resolve_) => setTimeout(resolve_, 1600));
const afterDirOnly = await call({ action: 'history' });
check(
  'an empty-folder change produced a version',
  afterDirOnly.snapshots.length === beforeDirOnly + 1,
  `${beforeDirOnly} -> ${afterDirOnly.snapshots.length}`,
);
const dirManifest = await loadManifest(afterDirOnly.snapshots[0].id);
check(
  'that version remembers the empty folder',
  dirManifest.entries.some((entry) => entry.p === 'empty-dir' && entry.d === true),
  JSON.stringify(dirManifest.entries.map((entry) => entry.p)),
);

// Turning realtime off must actually stop the watcher.
const offWatch = fakeResponse();
await handler(fakeRequest({ method: 'POST', body: { op: 'watch', dir: target, enabled: false } }), offWatch);
const beforeQuiet = (await call({ action: 'history' })).snapshots.length;
await writeFile(join(target, 'after-off.txt'), 'no watcher now\n');
await new Promise((resolve_) => setTimeout(resolve_, 1600));
check(
  'after turning it off, changes no longer snapshot',
  (await call({ action: 'history' })).snapshots.length === beforeQuiet,
);

// --------------------------------------------------------------------- timer mixin

// The timer service is mixed into contexts, and a runtime may project it as the
// mixin (`ctx.interval`) rather than the service object (`ctx.timer`). The plugin
// must install its tick either way, so drive both shapes.
tools.length = 0;
routes.length = 0;
const beforeMixin = intervalCalls;
apply(makeCtx({ mixinOnly: true }));
check(
  'timer mixin shape also installs the tick',
  intervalCalls === beforeMixin + 1,
  `calls=${intervalCalls - beforeMixin}`,
);

// --------------------------------------------------------------------- tidy

// Stop the realtime watchers before the temp tree disappears under them.
for (const dispose of effects) {
  try {
    dispose?.();
  } catch {
    /* a disposer that throws must not fail the run */
  }
}

await rm(home, { recursive: true, force: true });
await rm(target, { recursive: true, force: true });

console.log(failures === 0 ? '\nall host checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
