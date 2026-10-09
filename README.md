# 文件夹时光机 · dsh-folder-timemachine

给**任意文件夹**留下历史时间点，随时一键回到过去的样子。

像 Git 一样有版本历史，但**不需要懂 Git**：没有 commit、没有暂存区、没有仓库概念；任何文件夹都能用——游戏存档、配置目录、文档草稿、公司共享目录，哪怕它这辈子都没见过 `.git`。

这是把 [FolderRewind（存档时光机）](https://github.com/Leafuke/FolderRewind) 那套思路做成了 DeepSeek Harness 插件：DSH 里多一个悬浮面板 + 一个模型工具 `folder_timemachine`。

---

## 它解决什么

「改之前先备份一下」这句话听起来简单，做起来要三步：找到备份工具、选目录、起名。于是绝大多数时候没人做，出事之后才后悔。

装上这个插件之后：

- 面板上一个按钮 = 存一个时间点；
- 时间线上一行 = 当时那个样子，点「恢复」就回去了；
- 模型自己也能存 / 看历史 / 回滚——你说「先把存档存一下再改」就行。

## 安装

**最省事：直接从 GitHub 装**（一条命令）：

```bash
dsh plugin --profile desktop add github:guomi6450/dsh-folder-timemachine
```

**或者手动：** 把整个文件夹放到任意位置（**目录名必须保持 `dsh-folder-timemachine`**），再作为本地依赖装进 profile：

```bash
dsh plugin --profile desktop add link:<插件文件夹的绝对路径>

# 例如：
#   Windows  dsh plugin --profile desktop add link:D:\plugins\dsh-folder-timemachine
#   macOS    dsh plugin --profile desktop add link:/Users/me/plugins/dsh-folder-timemachine
```

`desktop` 是你的 profile 名（不确定就看 `<DSH_HOME>/profiles/` 下的目录名）。装完在插件列表里能看到 `dsh-folder-timemachine`。

> 目录名为什么要和包名一致：DSH 解析本地 `link:` 依赖时会按包名在父目录下找 `package.json`，改名会让它的插件清点报 `ENOENT`，插件在列表里显示为「异常」。

**装完必须重启 DSH 应用（退出再打开），只刷新网页不够。**

原因：面板（浏览器半）由 Web 端增量扫描 `dsh.client` 提供，刷新页面就能出现；但宿主半是 DSH 进程**启动时**加载的插件模块，Node 的 ESM 缓存按 URL 键控，进程内无法把已经加载过的入口换成新文件，所以只 refresh 页面会出现「面板在、但所有按钮都失败」的现象——客户端会明确提示「宿主半还没加载：要重启 DSH 应用才会生效」。

重启不会丢会话：会话日志是持久化的，重新打开后可以接着用。重启之后：

- 窗口**左下角**出现「⏱ 文件夹时光机」面板（右上角是 TODO 板、右下角是余额小鲸鱼），可拖动、位置会记住；
- 模型多了一个 `folder_timemachine` 工具（可以 `action=status` 验证）。

用 DSH 的插件管理界面以本地目录（`link:` 形式）安装同一个路径也一样。

## 用面板

| 操作 | 效果 |
| --- | --- |
| 填路径 → **开始保护** | 把这个文件夹加入保护列表（此时还没有时间点） |
| **立即存一个** / **存一个时间点** | 现在这个状态存成一个时间点 |
| **自动存档** 下拉 | 关闭 / **实时（一改就存）** / 每 5、15、30 分钟 / 每 1 小时 |
| 点文件夹行 | 展开它的历史时间线（时间、文件数、体积、+新增/修改/删除） |
| 某一行 **恢复** | 让文件夹回到那一刻（二次确认；恢复前会自动先存一个安全时间点） |
| **移出保护** | 不再跟踪；**历史仍然留在磁盘上**，不会顺手删掉 |

## 自动存档：两档

| 档位 | 什么时候存一版 |
| --- | --- |
| **实时（一改就存）** | 宿主用 `fs.watch` 盯着文件夹，**最后一次改动静默约 8 秒后**存一版 |
| 每 N 分钟 | 每分钟检查一次，间隔到了**且目录有变化**才存；没变化不产生空版本 |

两档都只记录「改动之后的样子」，所以回退到上一条就是改动前的状态。

实时档为什么要静默几秒：Windows 为一次逻辑改动会报一串事件，编辑器「保存全部」或一次构建可能写几十个文件——防抖让它们合成**一版**，而不是几十版。写进 `node_modules` / `.git` 等默认排除目录的改动一律忽略，不占用版本（`isExcludedChange()`，有单测覆盖）。

## 给 AI 的改动上保险

这个插件的另一个用法是保护**你让 AI 改的目录**：把它设成实时存档后，AI 每轮写入都会留下版本；一旦改坏，直接在时间线上点「恢复」回到动手之前。对我（模型）自己来说这尤其有用——我改文件时没有内置备份，`write`/`edit` 只保证「改前先读」，可回退性此前全靠对话上下文。

想更严格一点，也可以在让我动手前直接说「先存一下」，我会调 `action=snapshot` 存一版再改（这一步会弹审批框）。

## 用模型工具

工具名 `folder_timemachine`，一个 `action` 决定做什么：

| action | 作用 | 需要审批 |
| --- | --- | --- |
| `status` | 列出受保护的文件夹 | 否 |
| `history` | 列出某个文件夹的时间点 | 否 |
| `diff` | 比较某个时间点与当前状态（或两个时间点之间） | 否 |
| `snapshot` | 立刻存一个时间点（可带 `label`，例如「改配置之前」） | 是 |
| `restore` | 回到某个时间点（`mode: exact` 完全一致 / `overwrite` 只覆盖旧文件） | 是 |
| `protect` / `unprotect` | 加入 / 移出保护 | 是 |
| `watch` | 自动存档：`realtime=true` 一改就存，或每 N 分钟定时存（见上） | 是 |
| `forget` | 连历史一起删除（原文件夹不动） | 是 |

`dir` 省略时用当前会话的工作目录——所以「把当前项目存一下」不需要写路径。

## 历史存在哪、占多大

```
$DSH_HOME/folder-timemachine/
  index.json                     ← 受保护的文件夹清单
  <每个文件夹一个 key>/
    meta.json
    objects/<aa>/<sha256>        ← 文件内容，按内容寻址
    snapshots/<时间戳>.json      ← 每个时间点一份清单
```

- **按内容去重**：同一个文件内容在 100 个时间点里只存一份。改了 1 个文件的两个时间点，磁盘上只多那 1 个文件。
- **未变的文件不重算哈希**：大小 + 修改时间没变就沿用上次的哈希，所以第二次之后的快照很快。
- **空文件夹也是状态**：不含任何文件的文件夹（含嵌套）会单独记一笔，恢复时一并重建——mod 加载器、存档扫描器、某些软件的配置夹都要求那个空夹存在。有内容的文件夹不单独记录（文件路径已经隐含了它）。
- **内容没变就不存新版本**（自动档）：定时/实时触发时若与上一版逐字节相同，直接跳过，时间线里不会出现 `+0 ~0 -0` 的空版本；手动点「存一个时间点」则永远落一版。
- **默认不碰的东西**：`.git`、`.hg`、`.svn`、`node_modules`、`$RECYCLE.BIN`、`System Volume Information`、`.DS_Store`、`Thumbs.db`；符号链接不跟随；单个超过 512MB 的文件只记录「跳过」不复制。
- 默认每个文件夹保留最近 **50** 个时间点，更早的自动清理（`snapshot` 可传 `keep` 改）。

## 安全边界

- **恢复是可撤销的**：每次 restore 之前都会自动存一个名为 `restore point` 的安全时间点，想反悔就再恢复它。
- **`exact` 会删文件**：它让文件夹和那个时间点完全一致，因此在快照之后新建的文件会被删掉——面板的二次确认里写明了这一点。只想写回旧文件、不想删任何东西，就用 `overwrite`。
- **删目录只删空的**：`exact` 会清掉「版本里没有、且当前是空的」文件夹；**非空目录一律不动**（`rmdir` 对非空目录会失败，这个失败就是安全网）。不会为了凑形状去删掉装着文件的东西。
- **对象只加不改**：时间点里的内容是复制出来的独立副本，**不是硬链接**。源文件后来怎么改都不会污染历史（硬链接省磁盘，但会让「原地修改」悄悄改写历史，这个交换不划算）。
- **源文件夹永远是只读的**：除了 `restore` 之外，没有任何 action 会改动受保护的文件夹。
- 面板路由 `/dsh-folder-timemachine/api` 走 DSH 自己的信任校验（`connection.requestRejection`），校验不了的一律按 403 拒掉。

## 为什么不直接用社区里已有的快照插件

DSH 社区里已经有几个很不错的「回滚」类插件，但它们都是**围绕 git 工作区或会话回合**的：

| 插件 | 粒度 | 需要 git |
| --- | --- | --- |
| [`dsh-turnsnap`](https://awesome-dsh-plugin.com/p/yongshuai0314/dsh-turnsnap/) | 每个 agent 回合 | 是（`git add -A` + 标签提交） |
| [`@goodandready/dsh-time-machine`](https://awesome-dsh-plugin.com/p/GooDAnDReaDY/dsh-time-machine/) | 影子 git 快照 + 侧栏时间线 | 是（影子 index） |
| [`dsh-checkpoint-diff`](https://awesome-dsh-plugin.com/p/tmpdot/dsh-checkpoint-diff/) | 会话检查点时间线 | 依赖上游检查点 |

它们的共同前提是「这是一个 git 项目、关心的是代码」。而 FolderRewind 那类需求里的文件夹——游戏存档目录、软件配置目录、一堆散落的文档——通常不是 git 仓库，也不该为了一次备份变成 git 仓库。

这个插件的取舍就是：**牺牲「和 git 历史互操作」，换「任何文件夹、零前置条件、备份软件的心智模型」**。

## 测试与验证

```bash
node tools/smoke.mjs              # 引擎：快照 / diff / 恢复 / 去重语义（26 项）
node tools/host-smoke.mjs         # 宿主半：工具注册、审批闸门、HTTP 路由（38 项）
node tools/verify-real-cordis.mjs # 真实 Cordis 加载 + 真实 timer 服务（13 项）
```

前两个脚本把插件装进一个假 Cordis context，用临时目录跑，不碰真实 `$DSH_HOME`，可以反复执行。

第三个是**契约验证**：把插件加载进 DSH 真正在用的那份 cordis 运行时（`@deepseek-ai/cordis` 4.0.4 + 真实 `cordis-plugin-timer`），验证 `inject` 能被满足、timer 混入可用、工具/路由注册成功，并跑完一次 snapshot → history → restore。它能抓到的正是「未注入就访问 `ctx.interval`」这类只有在真框架下才炸的错误。

由于这些包在 DSH 的 `app.asar` 里，需要先解出运行时（`tools/asar.mjs` 是一个只读的 asar 解析器）：

```bash
node tools/asar.mjs extract "D:\dsh\resources\app.asar" dsh/node_modules/@deepseek-ai/cordis              D:\dsh_work\.verify\node_modules\@deepseek-ai\cordis
node tools/asar.mjs extract "D:\dsh\resources\app.asar" dsh/node_modules/@deepseek-ai/cordis-plugin-timer D:\dsh_work\.verify\node_modules\@deepseek-ai\cordis-plugin-timer
node tools/asar.mjs extract "D:\dsh\resources\app.asar" dsh/node_modules/@deepseek-ai/cosmokit             D:\dsh_work\.verify\node_modules\@deepseek-ai\cosmokit
node tools/asar.mjs extract "D:\dsh\resources\app.asar" dsh/node_modules/@standard-schema/spec             D:\dsh_work\.verify\node_modules\@standard-schema\spec
# D:\dsh_work\.verify\package.json 里放 {"type":"module"}
node tools/verify-real-cordis.mjs   # 可用 DSH_VERIFY_ROOT / DSH_PLUGIN_ENTRY 覆盖路径
```

## 已知边界

- 时间点里存的是**文件内容**，不含 NTFS ACL、ADS、创建时间等元数据；恢复回来的是内容一致的普通文件。
- 被其他进程独占锁定的文件会记进 `skipped`，不会让整个快照失败。
- **实时档是「有变化才存」，不是「每次写入单独一版」**：静默窗口内的多次改动合成一版。窗口默认 8 秒，可用 `watch` 的 `debounceSeconds` 调（工具/接口都支持）。
- 实时档用 `fs.watch(..., { recursive: true })`：Windows 原生支持递归监听，**网络驱动器 / 部分同步盘可能不触发事件**——那种目录请用定时档。
- 监控的是**文件系统事件**，不含「文件被打开但没写」这类无内容变化的行为；快照也只在事件后发生，所以「改之前」那一版来自上一轮存档或你手动存的那一版。
- 定时档是每分钟检查一次到期没有；面板只显示最近 20 个时间点，更早的用工具 `action=history` 看。
