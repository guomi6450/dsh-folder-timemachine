// Real-Cordis verification: load this plugin into the *actual* cordis runtime
// that DSH ships, with the real timer service, and drive one snapshot →
// history → restore cycle through the registered tool.
//
//   node tools/verify-real-cordis.mjs
//
// Why this exists: the fake-context test (host-smoke.mjs) proves behaviour, but
// only real Cordis proves the *contract* — that `inject` is satisfied, that the
// timer mixin resolves, and that nothing is read before it was injected. That is
// exactly the class of bug that made the first install attempt fail.
//
// It needs an extracted copy of the runtime, because the packages live inside
// DSH's app.asar. Build one with tools/asar.mjs:
//
//   node tools/asar.mjs extract <asar> dsh/node_modules/@deepseek-ai/cordis              <root>/node_modules/@deepseek-ai/cordis
//   node tools/asar.mjs extract <asar> dsh/node_modules/@deepseek-ai/cordis-plugin-timer <root>/node_modules/@deepseek-ai/cordis-plugin-timer
//   node tools/asar.mjs extract <asar> dsh/node_modules/@deepseek-ai/cosmokit            <root>/node_modules/@deepseek-ai/cosmokit
//   node tools/asar.mjs extract <asar> dsh/node_modules/@standard-schema/spec            <root>/node_modules/@standard-schema/spec
//
// then put `{"type":"module"}` in <root>/package.json and run this script.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const verifyRoot = resolve(process.env.DSH_VERIFY_ROOT ?? 'D:\\dsh_work\\.verify');
const pluginEntry = resolve(process.env.DSH_PLUGIN_ENTRY ?? join(here, '..', 'lib', 'host.js'));

const load = (specifier) => import(pathToFileURL(join(verifyRoot, 'node_modules', specifier)).href);

let failures = 0;
function check(label, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ' — ' + detail}`);
}

const { Context, Service } = await load('@deepseek-ai/cordis/lib/index.js');
const timerPlugin = await load('@deepseek-ai/cordis-plugin-timer/lib/index.js');

/**
 * ESM modules are wrapped into `{ apply }` plugin objects, the way DSH's loader
 * materialises a profile entry. Never `default?.apply`: when `default` is a
 * function, that reads `Function.prototype.apply`.
 */
const asPlugin = (module_) => {
  const fallback = module_.default;
  if (typeof fallback === 'function') {
    return { name: fallback.name, inject: fallback.inject, Config: fallback.Config, apply: fallback };
  }
  return {
    name: module_.name,
    inject: module_.inject,
    Config: module_.Config,
    apply: module_.apply,
  };
};

class ToolsService extends Service {
  constructor(ctx) {
    super(ctx, 'tools');
    this.registered = [];
  }
  register(definition) {
    this.registered.push(definition);
    return () => {};
  }
}

class WebServerService extends Service {
  constructor(ctx) {
    super(ctx, 'webServer');
    this.routes = [];
  }
  register(route) {
    this.routes.push(route);
    return () => {};
  }
}

const home = await mkdtemp(join(tmpdir(), 'tm-verify-'));
process.env.DSH_HOME = home;

const plugin = await import(pathToFileURL(pluginEntry).href);
const ctx = new Context();

// The real timer plugin, so `inject(['timer'])` resolves against the genuine
// mixin service rather than a stand-in.
await ctx.plugin(asPlugin(timerPlugin));

const tools = new ToolsService(ctx);
const webServer = new WebServerService(ctx);

let intervalCalls = 0;
const timerProto = Object.getPrototypeOf(ctx.timer);
const originalInterval = timerProto.interval;
timerProto.interval = function patched(...args) {
  intervalCalls += 1;
  return originalInterval.apply(this, args);
};

check('a real timer service is present', ctx.timer !== undefined);
check('the timer service is mixed into the context', typeof ctx.interval === 'function');

let loadError;
try {
  await ctx.plugin(asPlugin(plugin));
} catch (error) {
  loadError = error;
}
check('the plugin activates under real Cordis', loadError === undefined, loadError === undefined ? '' : String(loadError?.message ?? loadError));
check('exactly one model tool registered', tools.registered.length === 1, `count=${tools.registered.length}`);

const tool = tools.registered[0];
check('the tool is folder_timemachine', tool?.name === 'folder_timemachine');
check('the tool has a parameters schema', typeof tool?.parameters === 'object' && tool.parameters.type === 'object');
check('the tool has an output schema + render', typeof tool?.output?.schema === 'object' && typeof tool?.output?.render === 'function');
check('the tool has an execute function', typeof tool?.execute === 'function');
check('the panel route is registered', webServer.routes.length === 1 && webServer.routes[0].kind === 'exact');
check('the auto-snapshot tick was installed through the real timer', intervalCalls === 1, `calls=${intervalCalls}`);

const target = await mkdtemp(join(tmpdir(), 'tm-verify-target-'));
await writeFile(join(target, 'note.txt'), 'hello\n');
const exec = { agent: { session: { header: { cwd: target } } } };

const snap = await tool.execute({ action: 'snapshot' }, exec);
check('tool execute() runs against the real context', snap?.snapshots?.length === 1, String(snap?.message ?? '').split('\n')[0]);
await writeFile(join(target, 'note.txt'), 'changed\n');
const history = await tool.execute({ action: 'history' }, exec);
check('history returns the snapshot', history.snapshots.length === 1);
const restored = await tool.execute({ action: 'restore', snapshotId: history.snapshots[0].id }, exec);
check('restore works end to end', (await readFile(join(target, 'note.txt'), 'utf8')) === 'hello\n', String(restored?.message ?? '').split('\n')[0]);

await ctx.stop?.();
timerProto.interval = originalInterval;
await rm(home, { recursive: true, force: true });
await rm(target, { recursive: true, force: true });

console.log(failures === 0 ? '\nall real-Cordis checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
