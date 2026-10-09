// dsh-folder-timemachine — browser half.
//
// One floating panel in `shell.overlay`: the protected folders, their timeline,
// and the two buttons that matter — 存一个时间点 / 恢复到这里. Everything it
// shows comes from the host's `/dsh-folder-timemachine/api` route; the panel
// itself never touches the filesystem.
//
// It sits bottom-left by default, because the two plugins already living in this
// overlay occupy the top-right (TODO 板) and bottom-right (余额小鲸鱼). It is
// draggable, and remembers where you put it.
window.__ModuleLoader__.load({
  id: 'dsh-folder-timemachine',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');
    const h = React.createElement;

    const ROUTE = '/dsh-folder-timemachine/api';
    const STORE_KEY = 'dsh.folderTimemachine.v1';

    const log = (...args) => {
      try {
        console.debug('[dsh-folder-timemachine]', ...args);
      } catch {
        /* console unavailable */
      }
    };

    // ------------------------------------------------------------------ state

    function readPrefs() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY);
        if (raw === null) return {};
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function writePrefs(patch) {
      try {
        window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readPrefs(), ...patch }));
      } catch {
        /* private mode: the panel just forgets where it was */
      }
    }

    async function api(op, params = {}, method = 'GET') {
      const query = new URLSearchParams({ op, ...params });
      const response =
        method === 'GET'
          ? await fetch(ROUTE + '?' + query.toString())
          : await fetch(ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ op, ...params }),
            });
      const body = await response.json().catch(() => ({ ok: false, error: 'HTTP ' + response.status }));
      if (response.ok !== true || body.ok === false) {
        throw new Error(body.error ?? 'HTTP ' + response.status);
      }
      return body;
    }

    /**
     * 404/405 on this route never means "the button was wrong": it means the
     * route does not exist, which means the host half is not loaded. The host
     * half only loads when the DSH process starts, so the browser half says that
     * instead of reporting an HTTP code at the user.
     */
    function describeFailure(error, what) {
      const message = String(error?.message ?? error);
      if (message === 'HTTP 404' || message === 'HTTP 405') {
        return '宿主半还没加载：要重启 DSH 应用才会生效（只刷新页面不够）';
      }
      return what + '失败：' + message;
    }

    // ------------------------------------------------------------------ format

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const power = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      const value = bytes / 1024 ** power;
      return `${value >= 100 || power === 0 ? Math.round(value) : value.toFixed(1)} ${units[power]}`;
    }

    function relativeTime(iso) {
      const then = Date.parse(iso);
      if (!Number.isFinite(then)) return '';
      const seconds = Math.round((Date.now() - then) / 1000);
      if (seconds < 60) return '刚刚';
      if (seconds < 3600) return Math.round(seconds / 60) + ' 分钟前';
      if (seconds < 86400) return Math.round(seconds / 3600) + ' 小时前';
      return Math.round(seconds / 86400) + ' 天前';
    }

    function clockTime(iso) {
      const at = new Date(iso);
      if (Number.isNaN(at.getTime())) return iso;
      const pad = (n) => String(n).padStart(2, '0');
      return (
        `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
        `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
      );
    }

    /**
     * Automatic snapshots.
     *
     * `realtime` watches the folder and stores a version a few seconds after the
     * last change — one version per edit. The timed choices check every minute and
     * store only when something actually changed, so they are *at most* those
     * intervals and an idle folder never grows empty versions.
     */
    const WATCH_CHOICES = [
      ['off', '关闭'],
      ['realtime', '实时（一改就存）'],
      ['5', '每 5 分钟'],
      ['15', '每 15 分钟'],
      ['30', '每 30 分钟'],
      ['60', '每 1 小时'],
    ];

    function watchValueOf(row) {
      const watch = row.watch;
      if (watch === undefined || watch.enabled !== true) return 'off';
      if (watch.realtime === true) return 'realtime';
      const minutes = Math.max(1, Math.round((watch.intervalMs ?? 0) / 60000));
      return String(minutes);
    }

    function watchHintOf(row) {
      const watch = row.watch;
      if (watch === undefined || watch.enabled !== true) return '';
      if (watch.realtime === true) {
        return `改动静默 ${Math.round((watch.debounceMs ?? 8000) / 1000)} 秒后存一版`;
      }
      return '有变化才存新版本';
    }

    // ------------------------------------------------------------------ panel

    function Panel() {
      const [prefs, setPrefs] = React.useState(readPrefs);
      const [folders, setFolders] = React.useState(null);
      const [expanded, setExpanded] = React.useState(null);
      const [history, setHistory] = React.useState({});
      const [draft, setDraft] = React.useState('');
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState(null);

      const open = prefs.open !== false;
      const pos = prefs.pos ?? { left: 16, bottom: 24 };

      const patchPrefs = React.useCallback((patch) => {
        setPrefs((current) => {
          const next = { ...current, ...patch };
          writePrefs(patch);
          return next;
        });
      }, []);

      /**
       * Timelines are pulled fresh, never served from memory: a cached list is how
       * the panel ended up showing 12:27 while the store already had 12:48. The
       * panel's job is to be the window onto the store, so every refresh re-reads
       * whatever the user is currently looking at.
       */
      const expandedRef = React.useRef(null);
      React.useEffect(() => {
        expandedRef.current = expanded;
      }, [expanded]);

      const loadHistory = React.useCallback(async (dir) => {
        try {
          const body = await api('history', { dir });
          setHistory((current) => ({ ...current, [dir]: body.snapshots ?? [] }));
        } catch (error) {
          setNotice({ kind: 'error', text: describeFailure(error, '历史读取') });
        }
      }, []);

      const refresh = React.useCallback(async () => {
        try {
          const body = await api('status');
          setFolders(body.folders ?? []);
          setNotice(null);
          const open = expandedRef.current;
          if (open !== null && open !== undefined) await loadHistory(open);
        } catch (error) {
          setFolders([]);
          setNotice({ kind: 'error', text: describeFailure(error, '读取') });
        }
      }, [loadHistory]);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      // Poll only while the panel is open: a closed panel costs nothing.
      React.useEffect(() => {
        if (!open) return undefined;
        const timer = window.setInterval(refresh, 60_000);
        return () => window.clearInterval(timer);
      }, [open, refresh]);

      const toggle = React.useCallback(
        async (dir) => {
          const next = expanded === dir ? null : dir;
          setExpanded(next);
          // Always re-read on open: the store may have moved on since last time.
          if (next !== null) await loadHistory(next);
        },
        [expanded, loadHistory],
      );

      const act = React.useCallback(
        async (label, op, params, after) => {
          setBusy(label);
          setNotice(null);
          try {
            const body = await api(op, params, 'POST');
            if (after !== undefined) await after(body);
            await refresh();
            setNotice({ kind: 'ok', text: label + ' ✓' });
          } catch (error) {
            setNotice({ kind: 'error', text: describeFailure(error, label) });
          } finally {
            setBusy('');
          }
        },
        [refresh],
      );

      // ---- drag

      /**
       * Dragging is deliberately forgiving — pressing anywhere on the panel moves
       * it, except on a control — because the panel grows upward when a folder is
       * expanded, so "the header" is a moving target. The grab cursor stays on the
       * header only: everywhere works, the handle shows you where.
       *
       * The one rule that must never break: **a press is not a drag until the
       * pointer actually moves.** Capturing the pointer — or swallowing the event
       * — on pointerdown retargets the following click at the capturing element,
       * which is how the folder rows stopped opening (their onClick never fired)
       * and, before that, how the header buttons went dead.
       *
       * So pointerdown only records a candidate. Capture happens at the first
       * move past the threshold, at which point the click is already a drag.
       */
      const dragRef = React.useRef(null);
      /**
       * Set for the instant after a real drag. A click fires on pointerup even
       * when the pointer travelled, so without this a drag that started on a
       * folder row would also open/close that row on release.
       */
      const draggedRef = React.useRef(false);
      const onDragStart = (event) => {
        if (event.button !== 0) return;
        const target = event.target;
        if (
          target instanceof Element &&
          target.closest('button, input, a, select, textarea, [contenteditable="true"], [data-no-drag]') !== null
        ) {
          return;
        }
        // Nothing is captured and nothing is prevented here: a plain click must
        // reach the row underneath untouched. Text selection is already off via
        // `userSelect: none` on the panel, so a drag will not smear a selection.
        dragRef.current = {
          x: event.clientX,
          y: event.clientY,
          left: pos.left,
          bottom: pos.bottom,
          moved: false,
          pointerId: event.pointerId,
          node: event.currentTarget,
        };
      };
      const onDragMove = (event) => {
        const start = dragRef.current;
        if (start === null || event.pointerId !== start.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (start.moved !== true) {
          // Under three pixels is noise, not a drag — and the click stays intact.
          if (Math.abs(dx) + Math.abs(dy) < 3) return;
          start.moved = true;
          try {
            start.node.setPointerCapture?.(start.pointerId);
          } catch {
            /* capture is a nicety: the drag still tracks while the pointer is over the panel */
          }
        }
        const left = Math.max(4, Math.min(window.innerWidth - 120, start.left + dx));
        const bottom = Math.max(4, Math.min(window.innerHeight - 60, start.bottom - dy));
        patchPrefs({ pos: { left, bottom } });
      };
      const onDragEnd = (event) => {
        const start = dragRef.current;
        if (start === null) return;
        dragRef.current = null;
        if (start.moved !== true) return; // a click, not a drag: leave it alone
        draggedRef.current = true;
        // The click lands right after this handler; clear the flag after it.
        window.setTimeout(() => {
          draggedRef.current = false;
        }, 0);
        try {
          start.node.releasePointerCapture?.(start.pointerId);
        } catch {
          /* never captured, or already released */
        }
      };

      // ---- collapsed

      if (!open) {
        return h(
          'button',
          {
            type: 'button',
            onClick: () => patchPrefs({ open: true }),
            title: '文件夹时光机',
            style: {
              position: 'fixed',
              left: pos.left + 'px',
              bottom: pos.bottom + 'px',
              zIndex: 60,
              pointerEvents: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '999px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
              background: 'var(--dsw-alias-bg-overlay, rgba(30,30,30,.9))',
              color: 'var(--dsw-alias-label-primary, inherit)',
              font: 'inherit',
              fontSize: '12px',
              cursor: 'pointer',
              boxShadow: '0 4px 18px rgba(0,0,0,.18)',
            },
          },
          '⏱',
          '时光机',
        );
      }

      const rows = folders ?? [];
      const hint = busy !== '' ? busy + '…' : null;

      return h(
        'section',
        {
          onPointerDown: onDragStart,
          onPointerMove: onDragMove,
          onPointerUp: onDragEnd,
          onPointerCancel: onDragEnd,
          // Swallow the one click a finished drag would otherwise deliver to
          // whatever control the drag started on.
          onClickCapture: (event) => {
            if (draggedRef.current !== true) return;
            event.preventDefault();
            event.stopPropagation();
          },
          style: {
            position: 'fixed',
            left: pos.left + 'px',
            bottom: pos.bottom + 'px',
            zIndex: 60,
            pointerEvents: 'auto',
            width: '352px',
            maxHeight: '62vh',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: '12px',
            border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
            background: 'var(--dsw-alias-bg-overlay, rgba(28,28,30,.94))',
            color: 'var(--dsw-alias-label-primary, inherit)',
            boxShadow: '0 10px 34px rgba(0,0,0,.28)',
            backdropFilter: 'blur(8px)',
            overflow: 'hidden',
            fontSize: '12.5px',
            // Never inherit the overlay layer's cursor: an inherited `grab` over
            // the whole panel is what made it look draggable everywhere while
            // only one strip actually was.
            cursor: 'default',
            userSelect: 'none',
          },
        },
        // ---------------- header
        h(
          'header',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '9px 12px',
              borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
              userSelect: 'none',
            },
          },
          // The grab cursor lives here and only here: it is the signpost, not the
          // boundary — pressing anywhere on the panel drags it.
          h(
            'div',
            {
              title: '按住面板任意位置即可拖动（这里是把手）',
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                minWidth: 0,
                cursor: 'grab',
                padding: '2px 6px',
                margin: '-2px 0 -2px -6px',
                borderRadius: '7px',
              },
            },
            h('span', { style: { fontSize: '14px' } }, '⏱'),
            h('strong', { style: { fontWeight: 600, whiteSpace: 'nowrap' } }, '文件夹时光机'),
            h(
              'span',
              {
                style: {
                  color: 'var(--dsw-alias-label-secondary, #999)',
                  fontSize: '11px',
                  whiteSpace: 'nowrap',
                },
              },
              rows.length > 0 ? `${rows.length} 个文件夹` : '',
            ),
            h(
              'span',
              {
                'aria-hidden': 'true',
                style: { color: 'var(--dsw-alias-border-l2, #888)', fontSize: '11px', lineHeight: 1 },
              },
              '⠿',
            ),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              title: '刷新',
              onClick: refresh,
              style: iconButtonStyle,
            },
            '↻',
          ),
          h(
            'button',
            {
              type: 'button',
              title: '收起',
              onClick: () => patchPrefs({ open: false }),
              style: iconButtonStyle,
            },
            '–',
          ),
        ),

        // ---------------- notice
        notice !== null
          ? h(
              'div',
              {
                style: {
                  padding: '7px 12px',
                  fontSize: '11.5px',
                  color:
                    notice.kind === 'error'
                      ? 'var(--dsw-alias-state-error-primary, #e5484d)'
                      : 'var(--dsw-alias-state-success-primary, #30a46c)',
                  borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.2))',
                },
              },
              notice.text,
            )
          : null,
        hint !== null
          ? h(
              'div',
              {
                style: {
                  padding: '6px 12px',
                  fontSize: '11.5px',
                  color: 'var(--dsw-alias-label-secondary, #999)',
                },
              },
              hint,
            )
          : null,

        // ---------------- folders
        h(
          'div',
          { style: { overflowY: 'auto', flex: 1, padding: rows.length === 0 ? '14px 12px' : '6px 0' } },
          rows.length === 0
            ? h(
                'div',
                { style: { color: 'var(--dsw-alias-label-secondary, #999)', lineHeight: 1.6 } },
                '还没有受保护的文件夹。',
                h('br'),
                '在下面填一个绝对路径（例如 D:\\Games\\Saves），点「开始保护」——',
                '之后每个时间点都能一键回来，不需要懂 git。',
              )
            : rows.map((row) => folderRow(row)),
        ),

        // ---------------- footer
        h(
          'div',
          {
            style: {
              borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25))',
              padding: '9px 12px',
              display: 'flex',
              flexDirection: 'column',
              gap: '7px',
            },
          },
          h('input', {
            value: draft,
            placeholder: '文件夹绝对路径，例如 D:\\Games\\Saves',
            onChange: (event) => setDraft(event.target.value),
            style: {
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px',
              borderRadius: '7px',
              border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
              background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04))',
              color: 'inherit',
              font: 'inherit',
              fontSize: '12px',
              // The panel turns selection off so a drag cannot smear one; a text
              // field has to opt back in, or existing paths become hard to edit.
              userSelect: 'text',
            },
          }),
          h(
            'div',
            { style: { display: 'flex', gap: '6px' } },
            h(
              'button',
              {
                type: 'button',
                disabled: busy !== '' || draft.trim() === '',
                onClick: () =>
                  act('加入保护', 'protect', { dir: draft.trim() }, async () => {
                    await loadHistory(draft.trim());
                    setExpanded(draft.trim());
                  }),
                style: primaryButtonStyle(busy !== '' || draft.trim() === ''),
              },
              '开始保护',
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy !== '' || draft.trim() === '',
                title: '立刻给这个文件夹存一个时间点',
                onClick: () => act('存时间点', 'snapshot', { dir: draft.trim() }, async () => loadHistory(draft.trim())),
                style: ghostButtonStyle(busy !== '' || draft.trim() === ''),
              },
              '立即存一个',
            ),
          ),
          h(
            'div',
            { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #999)' } },
            '恢复前会自动再存一个安全时间点，恢复本身也能撤销。',
          ),
        ),
      );

      function folderRow(row) {
        const isOpen = expanded === row.path;
        const snaps = history[row.path];
        return h(
          'div',
          {
            key: row.path,
            style: { borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.14))' },
          },
          h(
            'div',
            {
              // The row is both a click target and a place you can grab the panel
              // from: the threshold in onDragMove keeps a press a press, and a
              // completed drag suppresses the click it would otherwise fire.
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 12px',
                cursor: 'pointer',
              },
              onClick: () => toggle(row.path),
            },
            h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary, #999)' } }, isOpen ? '▾' : '▸'),
            h(
              'div',
              { style: { flex: 1, minWidth: 0 } },
              h('div', { style: { fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, row.label),
              h(
                'div',
                {
                  title: row.path,
                  style: {
                    color: 'var(--dsw-alias-label-secondary, #999)',
                    fontSize: '10.5px',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    direction: 'rtl',
                    textAlign: 'left',
                  },
                },
                row.path,
              ),
            ),
            h(
              'div',
              { style: { textAlign: 'right', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #999)' } },
              h('div', null, `${row.snapshotCount} 个时间点`),
              h('div', null, row.lastSnapshotAt ? relativeTime(row.lastSnapshotAt) : '还没存过'),
            ),
          ),
          isOpen
            ? h(
                'div',
                { style: { padding: '0 12px 10px 30px' } },
                h(
                  'div',
                  { style: { display: 'flex', gap: '6px', marginBottom: '7px' } },
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: () => act('存时间点', 'snapshot', { dir: row.path }, async () => loadHistory(row.path)),
                      style: primaryButtonStyle(busy !== ''),
                    },
                    '存一个时间点',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy !== '',
                      onClick: () => act('移出保护', 'unprotect', { dir: row.path }, async () => loadHistory(row.path)),
                      style: ghostButtonStyle(busy !== ''),
                    },
                    '移出保护',
                  ),
                ),
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '7px' } },
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary, #999)' } }, '自动存档'),
                  h(
                    'select',
                    {
                      value: watchValueOf(row),
                      disabled: busy !== '',
                      onChange: (event) => {
                        const value = event.target.value;
                        const realtime = value === 'realtime';
                        const enabled = value !== 'off';
                        const minutes = enabled && !realtime ? Number(value) : 30;
                        act(
                          enabled === false ? '关闭自动存档' : realtime ? '开启实时存档' : '开启定时存档',
                          'watch',
                          { dir: row.path, enabled, realtime, minutes },
                          async () => loadHistory(row.path),
                        );
                      },
                      style: {
                        padding: '3px 6px',
                        borderRadius: '6px',
                        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
                        background: 'var(--dsw-alias-bg-layer-2, rgba(255,255,255,.04))',
                        color: 'inherit',
                        font: 'inherit',
                        fontSize: '11.5px',
                      },
                    },
                    ...(WATCH_CHOICES.some(([choice]) => choice === watchValueOf(row))
                      ? WATCH_CHOICES
                      : [...WATCH_CHOICES, [watchValueOf(row), `每 ${watchValueOf(row)} 分钟`]]
                    ).map(([choice, label]) => h('option', { key: choice, value: choice }, label)),
                  ),
                  h(
                    'span',
                    { style: { color: 'var(--dsw-alias-label-secondary, #999)', fontSize: '10.5px' } },
                    watchHintOf(row),
                  ),
                ),
                snaps === undefined
                  ? h('div', { style: { color: 'var(--dsw-alias-label-secondary, #999)' } }, '读取历史…')
                  : snaps.length === 0
                    ? h(
                        'div',
                        { style: { color: 'var(--dsw-alias-label-secondary, #999)' } },
                        '还没有时间点，点「存一个时间点」开始记录。',
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
                        snaps.slice(0, 20).map((snap) =>
                          h(
                            'div',
                            {
                              key: snap.id,
                              style: {
                                display: 'flex',
                                alignItems: 'center',
                                gap: '8px',
                                padding: '4px 0',
                              },
                            },
                            h(
                              'div',
                              { style: { flex: 1, minWidth: 0 } },
                              h(
                                'div',
                                { style: { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } },
                                clockTime(snap.at),
                                snap.label !== '' && snap.label !== undefined
                                  ? h(
                                      'span',
                                      { style: { color: 'var(--dsw-alias-brand-primary, #4d6bfe)', marginLeft: '6px' } },
                                      snap.label,
                                    )
                                  : null,
                              ),
                              h(
                                'div',
                                { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #999)' } },
                                `${snap.stats?.files ?? 0} 个文件` +
                                  (snap.stats?.dirs > 0 ? ` + ${snap.stats.dirs} 个空目录` : '') +
                                  ` / ${formatBytes(snap.stats?.bytes ?? 0)}` +
                                  ` · +${snap.summary?.added ?? 0} ~${snap.summary?.changed ?? 0} -${snap.summary?.removed ?? 0}` +
                                  (snap.trigger === 'auto' ? ' · 自动' : snap.trigger === 'model' ? ' · AI' : ''),
                              ),
                            ),
                            h(
                              'button',
                              {
                                type: 'button',
                                disabled: busy !== '',
                                title: '把这个文件夹恢复到此刻的样子',
                                onClick: (event) => {
                                  event.stopPropagation();
                                  const ok = window.confirm(
                                    `把 ${row.path}\n恢复到 ${clockTime(snap.at)} 的样子？\n\n` +
                                      '文件夹里之后新建的文件会被删除（当前状态会先自动存成一个安全时间点，可以再恢复回来）。',
                                  );
                                  if (!ok) return;
                                  act('恢复', 'restore', { dir: row.path, snapshotId: snap.id, mode: 'exact' }, async () => {
                                    await loadHistory(row.path);
                                  });
                                },
                                style: ghostButtonStyle(busy !== ''),
                              },
                              '恢复',
                            ),
                          ),
                        ),
                        snaps.length > 20
                          ? h(
                              'div',
                              { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary, #999)' } },
                              `还有 ${snaps.length - 20} 个更早的时间点（AI 可以用 folder_timemachine 工具查看全部）。`,
                            )
                          : null,
                      ),
              )
            : null,
        );
      }
    }

    const iconButtonStyle = {
      border: 'none',
      background: 'none',
      color: 'var(--dsw-alias-label-secondary, #999)',
      font: 'inherit',
      fontSize: '13px',
      lineHeight: 1,
      cursor: 'pointer',
      padding: '2px 4px',
      borderRadius: '5px',
    };

    function primaryButtonStyle(disabled) {
      return {
        flex: 1,
        padding: '5px 10px',
        borderRadius: '7px',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-brand-primary, #4d6bfe)',
        color: '#fff',
        font: 'inherit',
        fontSize: '12px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      };
    }

    function ghostButtonStyle(disabled) {
      return {
        padding: '4px 9px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.35))',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, inherit)',
        font: 'inherit',
        fontSize: '11.5px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        whiteSpace: 'nowrap',
      };
    }

    // ------------------------------------------------------------------ entry

    function apply(ctx) {
      log('apply');
      try {
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'folder-timemachine', order: 60, label: '文件夹时光机' },
            Panel,
          ),
        );
      } catch (error) {
        log('failed:', String(error?.message ?? error));
      }
    }

    exports.name = 'dsh-folder-timemachine';
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
