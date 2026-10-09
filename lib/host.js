// dsh-folder-timemachine — host half.
//
// Gives any folder a Git-like history with none of Git's vocabulary: the model
// gets one `folder_timemachine` tool, the browser half gets one JSON route, and
// the bytes live in a content-addressed store under $DSH_HOME/folder-timemachine.
//
// Three deliberate choices:
//
//   * A snapshot never needs the folder to be clean, committed, or even open in
//     a session — it is a file-level copy, so "any folder" really means any
//     folder, including ones no repository owns.
//   * A restore always takes a safety snapshot first, so a restore is undoable
//     by the same click that caused it.
//   * Read-only actions (status / history / diff) run without approval; anything
//     that writes to disk asks first.

import { watch as watchFs } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  TimeMachine,
  describeSnapshot,
  formatBytes,
  isExcludedChange,
  timeMachineHome,
} from './store.js';

export const name = 'dsh-folder-timemachine';

export const inject = ['webServer'];

export const ROUTE = '/dsh-folder-timemachine/api';
const TOOL_NAME = 'folder_timemachine';
/** Read-only actions: they observe, they never write, so they never ask. */
const APPROVAL_FREE = ['status', 'history', 'diff'];

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['status', 'snapshot', 'history', 'diff', 'restore', 'protect', 'unprotect', 'watch', 'forget'],
      description:
        '要执行的操作。status=看哪些文件夹受保护；snapshot=立刻给文件夹存一个时间点；history=看历史时间点；' +
        'diff=比较两个时间点（或某个时间点与当前状态）；restore=回到某个时间点；protect/unprotect=加入/移出保护；' +
        'watch=定时自动存时间点；forget=连历史一起删掉（不动原文件夹）。',
    },
    dir: {
      type: 'string',
      description: '目标文件夹的绝对路径。省略则使用当前会话的工作目录。',
    },
    label: { type: 'string', description: 'snapshot 时给这个时间点起个名字，例如「改配置之前」。' },
    snapshotId: { type: 'string', description: 'restore 时要回到的时间点 id（来自 history）。' },
    from: { type: 'string', description: 'diff 的起始时间点 id。' },
    to: { type: 'string', description: 'diff 的目标：另一个时间点 id，或 "current"（当前文件夹，默认）。' },
    mode: {
      type: 'string',
      enum: ['exact', 'overwrite'],
      description:
        'restore 的方式。exact（默认）=让文件夹和那个时间点完全一致，包括删掉之后新建的文件；' +
        'overwrite=只把那个时间点里的文件写回去，不动更新的文件。',
    },
    minutes: {
      type: 'number',
      description:
        'watch 的间隔分钟数（定时存档的频率，最小 1 分钟）。realtime=true 时忽略。' +
        'watch 且 enabled=false 时表示关闭自动存档。',
    },
    realtime: {
      type: 'boolean',
      description:
        'watch 时是否用实时模式：true=文件夹一有改动、静默几秒后就自动存一个时间点（一次保存/一次构建算一版）；' +
        'false（默认）=按 minutes 定时检查，有变化才存。',
    },
    enabled: { type: 'boolean', description: 'watch 时开启/关闭自动存时间点。' },
    keep: { type: 'number', description: '最多保留多少个时间点（默认 50，超出后最旧的先删）。' },
  },
  required: ['action'],
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    folders: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          label: { type: 'string' },
          snapshotCount: { type: 'number' },
          lastSnapshotAt: { type: 'string' },
          files: { type: 'number' },
          bytes: { type: 'number' },
          watch: { type: 'string' },
        },
      },
    },
    snapshots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          at: { type: 'string' },
          label: { type: 'string' },
          trigger: { type: 'string' },
          files: { type: 'number' },
          dirs: { type: 'number' },
          bytes: { type: 'number' },
          added: { type: 'number' },
          changed: { type: 'number' },
          removed: { type: 'number' },
        },
      },
    },
    diff: {
      type: 'object',
      additionalProperties: false,
      properties: {
        added: { type: 'array', items: { type: 'string' } },
        changed: { type: 'array', items: { type: 'string' } },
        removed: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  required: ['message'],
};

function text(message, extra = {}) {
  return {
    message,
    folders: [],
    snapshots: [],
    ...extra,
  };
}

function stamp(iso) {
  if (typeof iso !== 'string' || iso === '') return '(未知)';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

export function apply(ctx) {
  const log = (level, message, error) => {
    const suffix = error === undefined ? '' : ` (${String(error?.message ?? error)})`;
    try {
      if (level === 'error') ctx.logger?.warn?.(`dsh-folder-timemachine: ${message}${suffix}`);
      else ctx.logger?.debug?.(`dsh-folder-timemachine: ${message}${suffix}`);
    } catch {
      /* logging must never break a snapshot */
    }
  };

  const machine = new TimeMachine({ home: timeMachineHome(), log: () => {} });

  const dirOf = (input, exec) => {
    const explicit = typeof input.dir === 'string' ? input.dir.trim() : '';
    if (explicit !== '') return resolve(explicit);
    const header = exec?.agent?.session?.header;
    const cwd = header !== undefined && typeof header.cwd === 'string' ? header.cwd : '';
    if (cwd === '') return '';
    return resolve(cwd);
  };

  // ------------------------------------------------------------------ actions

  async function runStatus() {
    const rows = await machine.list();
    if (rows.length === 0) {
      return text(
        '还没有任何文件夹受保护。用 folder_timemachine action=snapshot 给一个文件夹存第一个时间点（省略 dir 就用当前工作目录）。',
      );
    }
    const lines = rows.map(
      (row) =>
        `• ${row.label} — ${row.path}\n    时间点 ${row.snapshotCount} 个，最近 ${stamp(row.lastSnapshotAt)}，` +
        `${row.files} 个文件 / ${formatBytes(row.bytes)}${row.watch?.enabled === true ? `，自动存档每 ${Math.round(row.watch.intervalMs / 60000)} 分钟` : ''}`,
    );
    return text(`受保护的文件夹（${rows.length} 个）：\n${lines.join('\n')}`, {
      folders: rows.map((row) => ({
        path: row.path,
        label: row.label,
        snapshotCount: row.snapshotCount,
        lastSnapshotAt: row.lastSnapshotAt ?? '',
        files: row.files,
        bytes: row.bytes,
        watch:
          row.watch?.enabled === true ? `每 ${Math.round(row.watch.intervalMs / 60000)} 分钟` : '关闭',
      })),
    });
  }

  async function runSnapshot(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const result = await machine.snapshot(dir, {
      label: typeof input.label === 'string' ? input.label : '',
      keep: Number.isFinite(input.keep) ? input.keep : undefined,
      trigger: 'model',
    });
    return text(
      `已给 ${dir} 存下时间点 ${result.id}（${stamp(result.at)}）。\n` +
        `${result.files} 个文件${result.dirs > 0 ? ` + ${result.dirs} 个空目录` : ''} / ${formatBytes(result.bytes)}；` +
        `新增 ${result.added}、修改 ${result.changed}、删除 ${result.removed}；` +
        `新存内容 ${result.objectsStored} 份（复用 ${result.hashesReused} 份未变文件的哈希），耗时 ${result.durationMs} ms。` +
        (result.skippedCount > 0 ? `\n跳过了 ${result.skippedCount} 个（符号链接/超大文件/读不到）。` : ''),
      {
        snapshots: [
          {
            id: result.id,
            at: result.at,
            label: result.label,
            trigger: 'model',
            files: result.files,
            dirs: result.dirs ?? 0,
            bytes: result.bytes,
            added: result.added,
            changed: result.changed,
            removed: result.removed,
          },
        ],
      },
    );
  }

  async function runHistory(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const rows = await machine.snapshots(dir, { limit: 30 });
    if (rows.length === 0) {
      return text(`${dir} 还没有任何时间点。用 action=snapshot 存一个。`);
    }
    return text(
      `${dir} 的历史时间点（新→旧）：\n${rows.map((row) => '  ' + describeSnapshot(row)).join('\n')}\n` +
        `用 action=restore + snapshotId 回到其中任意一个（恢复前会自动再存一个「恢复点」）。`,
      {
        snapshots: rows.map((row) => ({
          id: row.id,
          at: row.at,
          label: row.label ?? '',
          trigger: row.trigger ?? '',
          files: row.stats?.files ?? 0,
          dirs: row.stats?.dirs ?? 0,
          bytes: row.stats?.bytes ?? 0,
          added: row.summary?.added ?? 0,
          changed: row.summary?.changed ?? 0,
          removed: row.summary?.removed ?? 0,
        })),
      },
    );
  }

  async function runDiff(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const from = typeof input.from === 'string' && input.from !== '' ? input.from : (await machine.snapshots(dir, { limit: 1 }))[0]?.id;
    if (from === undefined) return text(`${dir} 还没有任何时间点，无法比较。`);
    const result = await machine.diff(dir, { from, to: typeof input.to === 'string' ? input.to : 'current' });
    const fmt = (rows) => rows.slice(0, 60).map((row) => `    ${row.path} (${formatBytes(row.size)})`).join('\n');
    const parts = [
      `比较 ${result.from.id}（${stamp(result.from.at)}）→ ${result.to.id === 'current' ? '当前文件夹' : `${result.to.id}（${stamp(result.to.at)}）`}：`,
      `  新增 ${result.added.length} 个${result.added.length > 0 ? '\n' + fmt(result.added) : ''}`,
      `  修改 ${result.changed.length} 个${result.changed.length > 0 ? '\n' + fmt(result.changed) : ''}`,
      `  删除 ${result.removed.length} 个${result.removed.length > 0 ? '\n' + fmt(result.removed) : ''}`,
    ];
    if (result.added.length + result.changed.length + result.removed.length > 180) {
      parts.push('  （列表已截断到每类 60 条）');
    }
    return text(parts.join('\n'), {
      diff: {
        added: result.added.slice(0, 200).map((row) => row.path),
        changed: result.changed.slice(0, 200).map((row) => row.path),
        removed: result.removed.slice(0, 200).map((row) => row.path),
      },
    });
  }

  async function runRestore(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const snapshotId = typeof input.snapshotId === 'string' ? input.snapshotId.trim() : '';
    if (snapshotId === '') return text('restore 需要 snapshotId：先 action=history 看 id。');
    const result = await machine.restore(dir, {
      snapshotId,
      mode: typeof input.mode === 'string' ? input.mode : 'exact',
    });
    if (result.ok !== true) {
      return text(
        `恢复未完成：有 ${result.missingObjects.length} 个文件的内容不在存档里（${result.missingObjects.slice(0, 5).join('、')}…）。` +
          `已恢复的部分保留，安全时间点 ${result.safetySnapshotId}。`,
      );
    }
    return text(
      `已把 ${dir} 回到时间点 ${result.snapshotId}（方式：${result.mode === 'exact' ? '完全一致' : '只覆盖旧文件'}）。\n` +
        `写回 ${result.restored} 个文件` +
        (result.restoredDirs > 0 ? ` + 重建 ${result.restoredDirs} 个空目录` : '') +
        `，删除 ${result.deleted} 个文件` +
        (result.deletedDirs > 0 ? ` + ${result.deletedDirs} 个空目录` : '') +
        '。\n' +
        `恢复前的状态已自动存为安全时间点 ${result.safetySnapshotId}——想撤销这次恢复，就再恢复它。`,
    );
  }

  async function runProtect(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const result = await machine.protect(dir, {
      label: typeof input.label === 'string' ? input.label : undefined,
    });
    return text(
      result.added
        ? `已把 ${dir} 加入保护（名称：${result.folder.label}）。第一次还要 action=snapshot 才会存下第一个时间点。`
        : `${dir} 已在保护中（名称：${result.folder.label}），已更新设置。`,
    );
  }

  async function runUnprotect(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const result = await machine.unprotect(dir);
    return text(
      result.removed
        ? `${dir} 已移出保护。历史仍留在 ${result.repoKeptAt}（用 action=forget 才会真正删掉）。`
        : `${dir} 本来就不在保护列表里。`,
    );
  }

  async function runForget(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    await machine.forget(dir);
    return text(`${dir} 的保护与全部历史已删除；原文件夹本身没有被改动。`);
  }

  async function runWatch(input, exec) {
    const dir = dirOf(input, exec);
    if (dir === '') return text('没有可用的目录：请给 dir，或在一个有工作目录的会话里调用。');
    const enabled = input.enabled !== false;
    const realtime = input.realtime === true;
    const minutes = Number.isFinite(input.minutes) ? Math.max(1, Math.round(input.minutes)) : 30;
    const folder = await machine.setWatch(dir, { enabled, realtime, intervalMs: minutes * 60_000 });
    await syncWatchers();
    const seconds = Math.round((folder.watch?.debounceMs ?? 8000) / 1000);
    if (enabled === false) return text(`已关闭 ${dir} 的自动存档（已有的时间点都还在）。`);
    return text(
      realtime
        ? `已开启实时存档：${dir} 一有改动，静默 ${seconds} 秒后自动存一个时间点（编辑器一次保存 / 一次构建只算一版）。`
        : `已开启定时存档：每 ${minutes} 分钟检查一次 ${dir}，有变化就存一个时间点。`,
    );
  }

  // ------------------------------------------------------------------ tool

  ctx.inject(['tools'], (toolsCtx) => {
    const tools = toolsCtx.get('tools');
    if (tools === undefined) return;
    const definition = {
      name: TOOL_NAME,
      description:
        '给文件夹存历史时间点，随时回到过去的样子——像 Git 一样有历史版本，但不需要懂 Git，任何文件夹都能用。' +
        'action=status 看受保护的文件夹；action=snapshot 立刻存一个时间点（可带 label 注明「改之前」）；' +
        'action=history 看历史时间点；action=diff 比较某个时间点与当前文件夹（或两个时间点）；' +
        'action=restore 把文件夹恢复到某个时间点（恢复前会自动存一个安全时间点，可再恢复回来）；' +
        'action=protect/unprotect 加入或移出保护列表；action=watch 定时或实时自动存；action=forget 连历史一起删除（不动原文件夹）。' +
        'dir 省略时用当前会话的工作目录。' +
        '**除 status / history / diff 外，所有操作都会先弹给用户审批；被拒绝就停手，不要反复重试。**' +
        '如果本会话的审批被自动拒绝（例如审批预设是 never），不要重试也不要断言插件不可用：' +
        '直接告诉用户可以在窗口左下角的「文件夹时光机」面板里点那条时间点的「恢复」——' +
        '面板入口是用户自己的操作，不经过模型审批。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: TOOL_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      async execute(args, exec) {
        const input = args !== null && typeof args === 'object' ? args : {};
        const action = typeof input.action === 'string' ? input.action : 'status';
        try {
          if (action === 'status') return await runStatus();
          if (action === 'snapshot') return await runSnapshot(input, exec);
          if (action === 'history') return await runHistory(input, exec);
          if (action === 'diff') return await runDiff(input, exec);
          if (action === 'restore') return await runRestore(input, exec);
          if (action === 'protect') return await runProtect(input, exec);
          if (action === 'unprotect') return await runUnprotect(input, exec);
          if (action === 'forget') return await runForget(input, exec);
          if (action === 'watch') return await runWatch(input, exec);
          return text(`未知的 action：${action}`);
        } catch (error) {
          log('error', `action=${action} 失败`, error);
          return text(`操作失败：${String(error?.message ?? error)}`);
        }
      },
    };
    ctx.effect(() => tools.register(definition), 'dsh-folder-timemachine: folder_timemachine tool');
  });

  // Anything that writes asks first.
  ctx.on('tools/pre-execute', (exec, next) => {
    if (exec === undefined || exec === null || exec.name !== TOOL_NAME) return next();
    const input = exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {};
    const action = typeof input.action === 'string' ? input.action : 'status';
    if (APPROVAL_FREE.indexOf(action) >= 0) return next();
    const dir = typeof input.dir === 'string' && input.dir !== '' ? input.dir : '(当前工作目录)';
    const detail =
      action === 'restore'
        ? `恢复 ${dir} 到时间点 ${String(input.snapshotId ?? '')}（${input.mode === 'overwrite' ? '只覆盖旧文件' : '完全一致'}）`
        : action === 'forget'
          ? `删除 ${dir} 的全部历史版本`
          : `${action} ${dir}`;
    return { kind: 'ask', reason: '文件夹时光机要改动磁盘内容：' + detail };
  });

  // ------------------------------------------------------------------ HTTP

  const readJsonBody = async (request, limit = 1 << 20) => {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > limit) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };

  const sendJson = (response, status, body) => {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(JSON.stringify(body));
  };

  /**
   * The panel's route is fenced the same way the harness fences its own: the
   * connection service decides, and anything we do not understand is refused.
   *
   * `connection` arrives through a second, optional inject rather than
   * `ctx.get(...)`: Cordis refuses to read a service that was never injected, so
   * a `get` here would take the whole plugin down on a profile without it.
   */
  let connection;
  ctx.inject(['connection'], (connectionCtx) => {
    connection = connectionCtx.connection;
  });

  const refuseUntrusted = (request, response) => {
    let status;
    if (connection !== undefined && typeof connection.requestRejection === 'function') {
      try {
        status = connection.requestRejection(request);
      } catch (error) {
        log('error', '信任校验抛错，按拒绝处理', error);
        status = 403;
      }
      if (status !== undefined && typeof status !== 'number') status = 403;
    } else {
      const host = String(request?.headers?.host ?? '');
      status = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host) ? undefined : 403;
    }
    if (status === undefined) return false;
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(status === 401 ? 'unauthorized' : 'forbidden');
    return true;
  };

  async function handleApi(input) {
    const op = typeof input.op === 'string' ? input.op : 'status';
    if (op === 'status') {
      const folders = await machine.list();
      return { ok: true, folders };
    }
    if (op === 'history') {
      const dir = resolve(String(input.dir ?? ''));
      return { ok: true, snapshots: await machine.snapshots(dir, { limit: 100 }) };
    }
    if (op === 'diff') {
      const dir = resolve(String(input.dir ?? ''));
      const from = String(input.from ?? '');
      const snapshots = await machine.snapshots(dir, { limit: 1 });
      const start = from !== '' ? from : snapshots[0]?.id;
      if (start === undefined) return { ok: false, error: '这个文件夹还没有时间点' };
      const result = await machine.diff(dir, { from: start, to: input.to === undefined ? 'current' : String(input.to) });
      return {
        ok: true,
        diff: {
          from: result.from,
          to: result.to,
          added: result.added.slice(0, 300),
          changed: result.changed.slice(0, 300),
          removed: result.removed.slice(0, 300),
        },
      };
    }
    if (op === 'snapshot') {
      const dir = resolve(String(input.dir ?? ''));
      const result = await machine.snapshot(dir, {
        label: typeof input.label === 'string' ? input.label : '',
        trigger: 'panel',
      });
      return { ok: true, snapshot: result };
    }
    if (op === 'restore') {
      const dir = resolve(String(input.dir ?? ''));
      const result = await machine.restore(dir, {
        snapshotId: String(input.snapshotId ?? ''),
        mode: input.mode === 'overwrite' ? 'overwrite' : 'exact',
      });
      return { ok: result.ok === true, restore: result };
    }
    if (op === 'protect') {
      const result = await machine.protect(resolve(String(input.dir ?? '')), {
        label: typeof input.label === 'string' ? input.label : undefined,
      });
      return { ok: true, folder: result.folder, added: result.added };
    }
    if (op === 'unprotect') {
      return { ok: true, ...(await machine.unprotect(resolve(String(input.dir ?? '')))) };
    }
    if (op === 'forget') {
      await machine.forget(resolve(String(input.dir ?? '')));
      return { ok: true };
    }
    if (op === 'watch') {
      const minutes = Number.isFinite(input.minutes) ? Math.max(1, Math.round(input.minutes)) : 30;
      const folder = await machine.setWatch(resolve(String(input.dir ?? '')), {
        enabled: input.enabled !== false,
        realtime: input.realtime === true,
        intervalMs: minutes * 60_000,
        debounceMs: Number.isFinite(input.debounceSeconds)
          ? Math.round(input.debounceSeconds * 1000)
          : undefined,
      });
      await syncWatchers();
      return { ok: true, watch: folder.watch };
    }
    if (op === 'reveal') {
      // Where the history actually lives — the panel shows this instead of
      // pretending the versions are somewhere mysterious.
      const dir = resolve(String(input.dir ?? ''));
      return { ok: true, repo: machine.repoPath(dir), home: machine.home };
    }
    return { ok: false, error: `unknown op: ${op}` };
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () =>
        hostCtx.webServer.register({
          kind: 'exact',
          path: ROUTE,
          handler: async (request, response) => {
            try {
              if (refuseUntrusted(request, response)) return;
              if (request.method === 'GET') {
                const url = new URL(request.url === undefined ? '/' : request.url, 'http://localhost');
                const input = Object.fromEntries(url.searchParams.entries());
                return sendJson(response, 200, await handleApi(input));
              }
              if (request.method !== 'POST') {
                response.writeHead(405, { allow: 'GET, POST' });
                response.end();
                return;
              }
              const body = await readJsonBody(request);
              const result = await handleApi(body ?? {});
              return sendJson(response, result.ok === false ? 200 : 200, result);
            } catch (error) {
              log('error', 'HTTP 路由处理失败', error);
              return sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        }),
      'dsh-folder-timemachine: api route',
    );
  });

  // ------------------------------------------------------------------ auto

  // One tick for every watched folder: a per-folder timer would keep the
  // process awake once per repository, and the check itself is a timestamp
  // comparison, not a scan.
  const tick = async () => {
    try {
      const due = await machine.dueForAutoSnapshot();
      for (const folder of due) {
        const result = await machine.snapshot(folder.path, { trigger: 'auto', label: '自动存档' });
        if (result.skipped === true) log('debug', `定时存档：${folder.path} 没有变化，跳过`);
        else log('info', `定时存档 ${folder.path} → ${result.id}`);
      }
    } catch (error) {
      log('error', '自动存档检查失败', error);
    }
  };
  // `timer` is optional: a profile without it loses timed snapshots only, and
  // manual snapshots keep working.
  //
  // The timer service is *mixed into* Cordis contexts, so two spellings can
  // exist depending on how the mixin is projected: `timerCtx.timer.interval(…)`
  // for the service object, `timerCtx.interval(…)` for the mixin. Reading the
  // wrong one throws, so take whichever this runtime actually offers.
  ctx.inject(['timer'], (timerCtx) => {
    let start;
    try {
      const service = timerCtx.timer;
      if (service !== undefined && typeof service.interval === 'function') {
        start = (fn, ms) => service.interval(fn, ms);
      }
    } catch {
      /* no service object: try the mixin below */
    }
    if (start === undefined) {
      try {
        if (typeof timerCtx.interval === 'function') start = (fn, ms) => timerCtx.interval(fn, ms);
      } catch {
        /* neither shape is available */
      }
    }
    if (start === undefined) {
      log('error', 'timer 服务不可用，自动存档已停用（手动 snapshot 不受影响）');
      return;
    }
    start(tick, 60_000);
  });

  // ---------------------------------------------------------------- realtime

  /**
   * One `fs.watch` per folder the user asked to watch live.
   *
   * Every event only resets a debounce timer rather than snapshotting: Windows
   * reports a burst of events for one logical change, and a save-all in an editor
   * or a build writing forty files must cost one version, not forty.
   */
  const watchers = new Map();

  function closeWatcher(key) {
    const entry = watchers.get(key);
    if (entry === undefined) return;
    try {
      entry.watcher?.close?.();
    } catch {
      /* already closed */
    }
    if (entry.timer !== null) clearTimeout(entry.timer);
    watchers.delete(key);
  }

  function closeAllWatchers() {
    for (const key of [...watchers.keys()]) closeWatcher(key);
  }

  function scheduleWatchedSnapshot(entry) {
    if (entry.timer !== null) clearTimeout(entry.timer);
    const delay = entry.folder.watch?.debounceMs ?? 8000;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      machine
        .snapshot(entry.dir, { trigger: 'watch', label: '自动存档（改动）', autoProtect: false })
        .then((result) => {
          if (result.skipped === true) return; // the events carried no content change
          log('info', `实时存档 ${entry.dir} → ${result.id}（+${result.added} ~${result.changed} -${result.removed}）`);
        })
        .catch((error) => log('error', `实时存档失败 ${entry.dir}`, error));
    }, delay);
  }

  /** Make the live watchers match the folders that currently ask for realtime. */
  async function syncWatchers() {
    let folders;
    try {
      folders = await machine.realtimeFolders();
    } catch (error) {
      log('error', '读取自动存档配置失败', error);
      return;
    }
    const wanted = new Map(folders.map((folder) => [folder.path.toLowerCase(), folder]));
    for (const key of [...watchers.keys()]) if (!wanted.has(key)) closeWatcher(key);

    for (const [key, folder] of wanted) {
      const existing = watchers.get(key);
      if (existing !== undefined) {
        existing.folder = folder;
        continue;
      }
      if (typeof watchFs !== 'function') {
        log('error', 'fs.watch 不可用，实时存档已停用（定时存档不受影响）');
        return;
      }
      const entry = { dir: folder.path, folder, timer: null, watcher: null };
      try {
        entry.watcher = watchFs(folder.path, { recursive: true, persistent: false }, (eventType, filename) => {
          const rel = typeof filename === 'string' ? filename : '';
          if (rel !== '') {
            if (isExcludedChange(rel, folder.exclude ?? [])) return;
            // If someone protects a folder that contains our own store, reacting
            // to it would be a snapshot loop. Never our own writes.
            const full = resolve(folder.path, rel).toLowerCase();
            const home = machine.home.toLowerCase();
            if (full === home || full.startsWith(home + sep)) return;
          }
          scheduleWatchedSnapshot(entry);
        });
        entry.watcher.on?.('error', (error) => {
          log('error', `实时监听 ${folder.path} 出错，已停止`, error);
          closeWatcher(key);
        });
        watchers.set(key, entry);
        log(
          'info',
          `实时监听 ${folder.path}（静默 ${Math.round((folder.watch?.debounceMs ?? 8000) / 1000)} 秒后存一版）`,
        );
      } catch (error) {
        log('error', `无法实时监听 ${folder.path}`, error);
      }
    }
  }

  ctx.effect(() => () => closeAllWatchers(), 'dsh-folder-timemachine: realtime watchers');
  syncWatchers().catch((error) => log('error', '初始化实时监听失败', error));

  log('info', `已就绪，历史存放在 ${machine.home}`);
}
