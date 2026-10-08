# Changelog

atelier 所有值得注意的变更都会记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.0.1] - 2026-10-08

### Changed

- **新标签页派发**：批次首个 peer 改为在新标签页中打开（不抢当前焦点，
  herdr 即 tab、tmux 即 window），同批内后续 peer 仍在该页内右接；
  `openTab` 失败或后端不支持时自动回退同页分割，派发不会因此中断。
  关闭 peer 时同页无存活 peer 则顺手回收空标签页。

### Fixed

- **缺省派发不再阻塞主会话**：single/tasks/chain 的缺省行为从「等待整批
  完成」改为「后台执行 + 完成自动推送」——主会话发起后即可继续工作，
  结果以新消息推回（会话已 settled 会自动恢复）；显式 `wait:true` 仍是
  阻塞调用，`action:"wait"` 可事后认领已推送批次。
- **扩展加载失败致 pi 无法启动**：`runtime/peer.ts` 一处文档注释的
  定界符在编辑中丢失，裸文本行引发 TypeScript 解析错误，整个 atelier
  扩展加载失败（pi 的 TUI 与 `-p` 全模式拒启）。仅补回定界符，无逻辑
  变更。

### 关联提交

| 范围                                                                                     | Commit    | 说明                                            |
| ---------------------------------------------------------------------------------------- | --------- | ----------------------------------------------- |
| `runtime/multiplexer/` `runtime/peer.ts` `runtime/runner.ts` `index.ts` `core/types.ts`  | `42cff70` | FEATURE: 批次派发开新标签页（失败回退同页分割） |
| `index.ts` `core/schemas.ts` `docs/` `README.md`                                         | `e91e274` | FIX: 缺省阻塞改为默认异步 + 完成推送            |
| `runtime/peer.ts`                                                                        | `96cb1c9` | FIX: 补回 openPeer 注释定界符                   |
| `AGENTS.md`                                                                              | `6e9bfc6` | DOCS: AGENTS.md 更新                            |

---

## 技术细节 / Migration Notes

### 1. 无破坏性变更

无 schema、配置与存储格式变更，0.4.0 的用户配置与历史数据直接兼容。
两个行为面变化：批次派发默认开新标签页（需要旧布局时显式传
`rightOfPaneId` 走同页分割）；缺省异步推送（显式 `wait:true` 恢复阻塞
语义）。

## [0.4.0] - 2026-10-07

### Added

- **持久 peer 编排（harness 无关）**：subagent 派发模型从「spawn 一次性
  批处理进程」重构为「向持久 peer 委派任务」。一个 peer = 分屏 pane +
  活的 harness TUI 会话 + 角色 + 累积上下文，跑完不退出；主会话随时
  `action:"send"` 追加指令——空闲时是带文件契约的新任务（追问），
  忙碌时是注入 TUI 输入框的舵手消息（纠偏/解堵）。等待超时/blocked
  不杀 pane，peer 是持久资产，可被后续 send 救活。
- **多 harness 路由**：新增 `runtime/harness/` 适配层。内置
  pi/claude/codex/hermes/opencode/omp 六个 adapter + `genericAdapter`
  工厂（任意 PATH binary 零定制接入，如 mcode/zcode）。tier 配置升级
  为混合路由链——`["claude/sonnet", "codex", "pi/zai/GLM-5.2"]` 按序
  即优先级，外部 harness 优先、pi 兜底；旧 `{model, fallback}` 配置
  完全兼容。解析链：`params.harness/model` > agent frontmatter
  `harness:` pin > tier routes（跳过 binary 缺失与时段禁用）。
- **工具面扩展**：`subagent` 新增 `send`/`wait`/`read`/`peers`/`close`
  actions；单发默认异步返回 peerId 句柄（`wait:true` 阻塞）；`peer`
  参数显式复用、`harness` 参数显式覆盖、`lines` 控制 transcript 尾部；
  `send` 传 agent 角色名自动路由到该角色空闲 peer。
- **补写补救**：monitor 判定 peer 停止但 `result-N.md` 未落盘时，先向
  peer 注入一句补写指令（90s 处理窗口），补救无效才 transcript 兜底
  提取代写——空闲 peer 上下文还在，一句话即可自救，比抓屏噪声更干净。
- **session 归属孤儿认领**：peer.json 记录派发方 pi session id，孤儿
  收尾延迟到会话首次就绪后按归属执行一次；判定依据 pane/harness 存活
  探测 + `agentSession` 原生 session 复用比对（非时间启发）。pane 活
  且 agent 已停的代写终态，pane 死/id 复用的标 orphan。
- **pane 标题可互对**：`sub:角色@harness#<peerId尾4位>`，界面 pane 与
  主会话持有的 peerId 句柄直接对上。
- **peer 相关配置**：`peerApproval`（full/safe/off 权限模式映射）、
  `blockedGraceMs`、`peerReadyTimeoutMs`、`maxPeers`、`harnessArgs`
  （per-harness 追加启动参数）。`modelSchedules` 键升级为
  `harness/model` > `model` > `harness` 三级。

### Changed

- **chain 上下文零损耗**：同 agent+同 harness 的步骤自动复用同一 peer
  （peer 记得全部上下文，`{previous}` 降级为冗余保险）；跨 harness
  步骤仍走输出接力。
- **parallel 布局**：每任务一个 peer，首个开新行、后续行内右分；
  完成后 pane 保留构成可用 peer 池。
- **完成检测四级降级**：status.json 文件契约（msgSeq 对齐）> herdr
  `agent_status` 语义检测 > transcript 稳定性启发 > 补写补救 >
  transcript 兜底提取。
- **舵手消息纯注入**：忙碌 peer 追加消息只进 TUI 输入框，一律不主动
  打断（harness 自行排队消化；单次 Esc 实测未必有效，半吊子打断更糟，
  打断将作显式原语按需引入）。

### Removed

- **batch 遗留层整删**：`scripts/subagent-wrapper.sh`、
  `extract-pi-result.py`、`launchSingle`/`launchParallel`、
  `waitForCompletion`、`resolveModelChain`、`LaunchResult`、多路复用器
  batch 方法集（`splitAbove`/`splitRight`/`refocus`/`currentPaneId`）。
  外部 harness 无等价 batch 协议，peer 模式已覆盖原场景；
  `cleanupOldRuns` 接回 `openPeer`。
- **stuck-detector 删除**：peer 长任务下「5 分钟无更新」必然误报且无
  自动动作；超时/blocked 宽容期/pane 死亡三层机制已覆盖。`RunStatus`
  保留 `stuck` 值仅供旧数据兼容。

### Fixed

- **session id 提取**：`getEntries()` 不含 session header，改用
  `getSessionId()`——孤儿认领与 `peer.sessionId` 此前实际不生效。
- `settleRun` 必填参数跟在可选参数后（TS1016）；`run.msgSeq <
  peer.msgSeq` 的过期消息行在 registry 侧收尾为 orphan。
- `collectPeerResult` 在无 mux 环境兜底提取时 `detectBackend` 抛错。
- `listRunning` 跳过 peer 目录，不再产生 `runId=peerId` 幻影运行。

### 关联提交

| 范围                                                            | Commit    | 说明                                             |
| --------------------------------------------------------------- | --------- | ------------------------------------------------ |
| `runtime/harness/` `runtime/peer.ts` + 18 文件                  | `354c774` | FEATURE: 持久 peer 编排层——harness 无关派发      |
| `AGENTS.md` `README.md`                                          | `6ea1934` | DOCS: peer 编排架构文档                          |
| `scripts/` `runtime/` 等 13 文件                                 | `ece68ea` | REFACTOR: 移除 batch 遗留层                      |
| `runtime/peer.ts`                                                | `ab39e83` | FEATURE: pane 标题追加 peerId 尾段               |
| `runtime/monitor.ts`                                             | `965a6ed` | FEATURE: 补写指令先行，transcript 兜底           |
| `runtime/harness/` `runtime/peer.ts`                             | `3dab606` | REFACTOR: 舵手消息纯注入，删自动 Esc             |
| `core/session.ts` `registry/` `index.ts`                         | `a360ee3` | FEATURE: 孤儿认领按 session 归属，删 stuck-detector |
| `AGENTS.md` `README.md` `runtime/`                              | `2fa78d3` | DOCS: 同步实际架构                               |
| `index.ts`                                                       | `bbb0cce` | FIX: session id 提取改用 getSessionId()          |
| `registry/orphan-recovery.ts`                                    | `46ace13` | FIX: settleRun 签名 + 过期消息行收尾             |
| `runtime/monitor.ts`                                             | `53a13e9` | FIX: collectPeerResult 无 mux 抛错               |
| `runtime/monitor.ts`                                             | `1fa1600` | FIX: listRunning 跳过 peer 目录幻影              |

---

## 技术细节 / Migration Notes

### 1. Registry schema v3

`PRAGMA user_version` 自动迁移：新增 `atelier_peers` 表，`atelier_runs`
加 `peer_id`/`msg_seq`/`harness` 列。旧库启动自动 ALTER，无需手工操作。

### 2. 配置兼容

- 旧 `tiers: {name: {model, fallback[]}}` 完全兼容，归一化为 routes。
- `modelSchedules` 键仍支持裸模型名；新写法 `harness/model` 优先级更高。
- 新增字段全部有默认值，`atelier.json` 不改也能跑（默认 pi 派发）。

### 3. 行为差异

- **无 mux 环境无法派发**：peer 需要 splitShell，无 tmux/herdr 时
  `openPeer` 抛错（原 batch 路径同样依赖 mux，行为一致）。
- **peer 目录豁免清理**：`peer.json alive:true` 的目录永不被
  `keepResults` 清理。
- **peer.json 缺 sessionId 的旧 peer**：孤儿认领视为本会话记录，
  按探针正常判定。

## [0.3.0] - 2026-09-12

### Added

- **图形化配置面板**：新增 `/atelier-config` 命令，打开 TUI 设置面板（SettingsList）
  编辑全部 atelier.json 字段 —— 6 个标量（pollIntervalMs / panePrefix / keepResults /
  timeoutMs / maxTasks / maxConcurrency）、defaultTier，以及 `tiers`、`modelSchedules`
  两个子菜单（增删改 tier 的 model/fallback、模型的 allow/deny 时段）。改动先落草稿，
  选「💾 保存并应用」才写回配置文件（按现有加载顺序决定是 atelier.json 还是
  settings.json 的 `atelier` 段，未知字段原样保留），保存即热重载，无需重启 pi；
  Esc 放弃全部修改。

### Fixed

- **herdr 下 subagent pane 不自动关闭**：herdr pane 是常驻 shell（split 建空 pane
  + run 往里发命令），subagent 命令跑完后 shell 仍在、pane 残留。现 run 命令尾
  拼 `; herdr pane close <id>` 自闭合，对齐 tmux「进程退出即关」语义；
  `PI_SUBAGENT_KEEP_PANE=1` 时 exec 出的交互 shell 被用户退出后才关闭，保留语义不变。

### 关联提交

| 范围                                                         | Commit    | 说明                                |
| ------------------------------------------------------------ | --------- | ----------------------------------- |
| `runtime/multiplexer/herdr.ts`                               | `bbfe42f` | FIX: run 命令尾缀自闭合             |
| `core/config.ts` `ui/` `index.ts` `package.json`             | `90b4ad4` | FEATURE: /atelier-config TUI 配置面板 |
| `AGENTS.md`                                                  | `5c844e7` | DOCS: 0.3.0 架构说明                |

---

## 技术细节 / Migration Notes

### 1. 配置面板的写回目标

保存时 `core/config.ts` 的 `resolveConfigTarget()` 按与加载相同的优先级决定写回
位置：`~/.config/pi/atelier.json`（standalone，整文件即配置）> 首个解析出 `atelier`
字段的 settings.json（nested，只改 `atelier` 子键）。写回走「读旧 → 浅合并 → 整写」，
配置文件里 atelier 不认识的字段不会被抹掉。

保存成功后 `index.ts` 的 `config` 变量被重 `loadConfig()` 的结果替换，同一会话
后续 subagent 启动立即生效，无需重启 pi。

### 2. herdr pane 自闭合

`HerdrBackend` 的 `splitRun`（splitAbove/splitRight 共用）把 run 命令拼成
`<cmd>; <herdr-bin> pane close <paneId>`。herdr 路径取宿主进程 env 的
`HERDR_BIN_PATH`，缺失退回 PATH 查找——不在命令串里做 shell 参数展开，
因为 pane 内是用户交互 shell（fish 不认 `${VAR:-default}`）。

## [0.2.0] - 2026-08-04

### Added

- **herdr 多路复用器支持**：atelier 不再 tmux 专有。新增 `runtime/multiplexer/`
  抽象层（`MultiplexerBackend` 接口 + `TmuxBackend` + `HerdrBackend`），
  `detectBackend()` 按 `HERDR_ENV=1`/`$TMUX` 自动选择。在 herdr 内运行 pi 时，
  subagent 通过 `herdr pane split/run/close` 可视化执行，行为对等 tmux 路径。

- **模型使用时间限制**：新增 `core/schedule.ts` DSL 解析器 + `runner.ts`
  `resolveModelChain` 时段过滤。配置在 `atelier.json` 的 `modelSchedules` 字段
  （按模型名索引，跨 tier 生效）：`{ "zai/GLM-5.2": { "deny": ["Mon-Fri 14:00-18:00"] } }`。
  落在禁用窗口的模型自动跳过（每跳过一个 console.warn），全链禁用时降级
  defaultModel。支持 `allow`/`deny`、星期段（`Mon-Fri`/`Sat,Sun`）、跨午夜
  （`22:00-08:00` 自动展开）。

- **独立配置文件**：atelier 配置可从 `~/.config/pi/atelier.json` 加载
  （整文件即配置，优先级最高），不再强制塞在 `settings.json` 的 `atelier`
  字段里。两种路径共存，向后兼容。

- **griller agent + 对抗式诘问**：新增 `context/agents/griller.md`，承载
  grilling 方法论（逐个提问、决策树遍历、每问附推荐答案、事实查环境）。

- **脚本内化**：`subagent-wrapper.sh` + `extract-pi-result.py` 从外部
  `stow/pi/.local/share/pi/scripts/` 内化到插件 `scripts/` 目录。恢复
  0.1.1→0.2.0 之间因外部脚本丢失导致的功能性损坏，让 atelier 成为自包含
  pi-package。

### Changed

- **Plan review gate 重构**：拦截 `plannotator_submit_plan` 后，不再委派
  oracle subagent 做一次性审查，改为把 `griller.md` 方法论注入主会话
  systemPrompt，让主 agent 与用户做多轮对抗式诘问（一次一个问题，每问附
  推荐答案），达成共识后才放行提交。grilling 本质是主会话交互式流程，
  委派给独立 subagent 会丢失「逐个提问、等用户反馈」的闭环。

- **launcher 去 tmux 硬编码**：`launchSingle`/`launchParallel` 改调
  `MultiplexerBackend` 接口，删除 `tmuxExec`/`splitAboveCurrentPane` 等
  tmux 专有函数。`paneIsAlive`/`killPane` 保留为公共导出（monitor/runner
  multiplexer 无关），改为薄包装委托 `detectBackend()`。

### Fixed

- **subagent-wrapper.sh KEEP_PANE 多路复用器感知**：`PI_SUBAGENT_KEEP_PANE=1`
  的 pane 保留检查从仅 `$TMUX` 扩展为 `$TMUX || $HERDR_ENV`，herdr 内也生效。

### Removed

- **移除弃用的 `/run-plan` + `/loop` 命令**：loopctl 前端薄包装，loopctl
  本身已弃用（父仓 `5aae9f6e`），这两个命令入口随之删除。plan review gate
  放行后用户直接按计划实施即可。
- 删除 `load_subagents_config()`（读已废弃的 `~/.config/pi/subagents.json`，
  per-agent model 配置已被 tier 系统取代）。
- 删除 `TOP_ROW_PERCENT` 常量（tmux 专有，ratio 化后不再需要）。

### 关联提交

| 范围                           | Commit    | 说明                                              |
| ------------------------------ | --------- | ------------------------------------------------- |
| `core/config.ts`               | `caf6b1d` | FEATURE: 支持 atelier.json 独立配置文件           |
| `core/schedule.ts`             | `556d90a` | FEATURE: 时间窗口 DSL 解析器                      |
| `runtime/runner.ts`            | `df607d6` | FEATURE: resolveModelChain 按时段过滤模型         |
| `context/agents/griller.md`    | `e0b1445` | FEATURE: grilling 方法论 agent 定义               |
| `index.ts`                     | `e5af262` | REFACTOR: plan review gate 改为注入 grill 方法论  |
| `scripts/`                     | `6382ef2` | FEATURE: 内化 wrapper + extract 脚本              |
| `runtime/launcher.ts`          | `d1ab274` | REFACTOR: wrapper 路径改从 plugin root 解析       |
| `scripts/subagent-wrapper.sh`  | `edd62b2` | CLEANUP: 移除 legacy subagents.json + 硬编码路径  |
| `runtime/multiplexer/types.ts` | `9972ce8` | REFACTOR: 抽 MultiplexerBackend 接口              |
| `runtime/multiplexer/tmux.ts`  | `a402b70` | REFACTOR: 迁出 TmuxBackend                        |
| `runtime/multiplexer/herdr.ts` | `6375075` | FEATURE: HerdrBackend                             |
| `runtime/launcher.ts`          | `ad79b4a` | REFACTOR: 改调 backend 接口                       |
| `scripts/subagent-wrapper.sh`  | `48fd640` | FIX: KEEP_PANE 块 multiplexer 感知                |
| `index.ts`                     | `8437de9` | REMOVE: 移除弃用的 /run-plan + /loop loopctl 命令 |

---

## 技术细节 / Migration Notes

### 1. 配置迁移（settings.json → atelier.json）

旧配置（`settings.json` 内）：

```json
{ "atelier": { "defaultTier": "pro", "tiers": {...} } }
```

新配置（`~/.config/pi/atelier.json`，推荐）：

```json
{
  "defaultTier": "pro",
  "tiers": { "ultra": { "model": "...", "fallback": [...] }, ... },
  "modelSchedules": { "zai/GLM-5.2": { "deny": ["Mon-Fri 14:00-18:00"] } }
}
```

`config.ts` 查找顺序：atelier.json > agent dir/settings.json > ~/.config/pi/settings.json。
旧的 settings.json#atelier 仍生效（向后兼容），但建议迁移到独立文件。

### 2. 多路复用器后端

新增 `runtime/multiplexer/`：

- `types.ts` — `MultiplexerBackend` 接口（currentPaneId/splitAbove/splitRight/setTitle/refocus/isAlive/kill）
- `detect.ts` — 按 `HERDR_ENV=1`/`$TMUX` 选择后端
- `tmux.ts` — tmux 实现（从 launcher.ts 迁出，行为字节级一致）
- `herdr.ts` — herdr 实现（split 两步：pane split + pane run；kill=pane close）

差异接受：tmux 新 pane 在主 pane 上方，herdr 在下方。monitor.ts 基于
status.json 文件轮询，multiplexer 无关，零改动。

### 3. 脚本内化路径变化

| 旧路径（已废弃）                                 | 新路径                                  |
| ------------------------------------------------ | --------------------------------------- |
| `$XDG_DATA_HOME/pi/scripts/subagent-wrapper.sh`  | `<plugin>/scripts/subagent-wrapper.sh`  |
| `$XDG_DATA_HOME/pi/scripts/extract-pi-result.py` | `<plugin>/scripts/extract-pi-result.py` |

`launcher.ts` 的 `getScriptsDir()` 改用 `getPluginRoot()/scripts`。
wrapper 内的 `PLUGIN_AGENTS_DIR` 从硬编码 XDG 改为 `SCRIPT_DIR/../context/agents`。

### 4. 兼容性矩阵

| 项               | 0.1.1                 | 0.2.0                            |
| ---------------- | --------------------- | -------------------------------- |
| 多路复用器       | tmux only             | tmux + herdr                     |
| 配置文件         | settings.json#atelier | atelier.json（+ 旧路径兼容）     |
| 模型时段限制     | 无                    | modelSchedules（allow/deny DSL） |
| plan review gate | 委派 oracle subagent  | 主会话多轮 grill                 |
| 脚本位置         | 外部 stow 部署        | 插件内置 scripts/                |
| schema 版本      | v2                    | v2（无变化）                     |

---

## [0.1.1] - 2026-07-03

### Fixed

- **SQLite 写入崩溃**：`launchSingle` 调用 `registerRun` 时漏传 `runDir`，
  导致 `undefined` 绑定到 SQLite 参数 4（schema 要求 `run_dir TEXT NOT NULL`），
  抛出 `TypeE: Provided value cannot be bound to SQLite parameter 4`，
  整个 subagent 启动链路静默失败，仅在 console.warn 留下告警。
  对齐 `launchParallel` 的调用约定后修复。

- **Agent/prompt 读取路径失效**：agent/prompt `.md` 源文件从
  `~/.config/pi/agents/` 迁到插件内置 `context/{agents,prompts}/` 后，
  原 `getAgentDir()/agents` 读取路径全部失效，部署的 symlink 成断链，
  `discoverAgents()` 返回空数组，所有 subagent 启动找不到 agent .md。
  引入统一路径解析层修复（见下方 FEATURE）。

- **subagent-wrapper.sh 断链失败**：bash 端的 `parse_agent_md` 同样硬编码
  `~/.config/pi/agents`，与 TS 端策略对齐为多路径回退。

### Added

- **统一 agent/prompt 路径解析层**（`core/context.ts`）：新增
  `getPluginRoot()`（用 `import.meta.url` 定位插件根）、
  `getAgentDirs()` / `getPromptDirs()`（多候选目录列表）、
  `resolveAgentFile(name)`（按优先级查找）。被 `discoverAgents`、
  `discoverPrompts`、`prepareAgentPrompt`、`loadMainSessionAgentContext` 复用。
  优先级：插件内置 `context/{agents,prompts}/` > `getAgentDir()/{agents,prompts}/`
  （兼容用户自定义 agent）。同名 agent 插件内置赢，后扫到的跳过。

- **/&lt;agentname&gt; 空上下文注入**：当主会话还没有任何 user 消息时，
  `/<agentname> <task>` 不再启动独立 subagent pane，而是把对应 agent
  的 prompt 注入当前主会话的 systemPrompt，让主 agent 以该 agent
  身份直接执行 task。命令处理程序用 `appendEntry("atelier:context-inject", ...)`
  写隐藏标记，`before_agent_start` 钩子读到后追加 prompt 并清除标记
  （一次性注入）。优先级：**命令注入 > plan 模式 (planner) > 默认 (worker)**。
  非空上下文维持原 `launchSingle` 行为。

- **Agent/prompt 目录自包含**：atelier 作为独立 pi-package，agent 定义
  (7 agents) 与 prompt 模板 (7 templates) 全部内嵌在 `context/`
  目录中，不再依赖外部部署。

### Changed

- **AGENTS.md 文档更新**：目录树补 `context/agents` + `context/prompts`；
  新增 "Agent/Prompt 路径解析" 一节（4 个读取点 + 优先级策略）；
  新增 "主会话上下文注入" 一节（三级优先级）。

### 关联提交

| 范围                                    | Commit    | 说明                                     |
| --------------------------------------- | --------- | ---------------------------------------- |
| `atelier` 子模块                        | `93cf4ec` | FIX: `registerRun` 补 `runDir`           |
| `atelier` 子模块                        | `4b8de46` | FEATURE: 多目录路径解析                  |
| `atelier` 子模块                        | `f7e30b3` | FEATURE: /&lt;agentname&gt; 空上下文注入 |
| `atelier` 子模块                        | `e4e545e` | DOCS: AGENTS.md 路径解析/注入说明        |
| `atelier` 子模块                        | `d15d7e2` | UPDATE: package.json 0.1.0 → 0.1.1       |
| 父仓库 `stow/pi/.../wrapper.sh`         | `e75298f` | FIX: bash 端 `resolve_agent_file`        |
| 父仓库 `stow/pi/.../extensions/atelier` | `a9cde8f` | UPDATE: bump submodule → 0.1.1           |

---

## 技术细节 / Migration Notes

面向从 0.1.0 升级或自编译部署的开发者。

### 1. SQLite schema 兼容性

修复 A 涉及 `registerRun` 写入参数 4（`run_dir`）的修复，不引入 schema
变更。现有 `$XDG_DATA_HOME/pi/atelier-registry.db` 无需重建，启动时
`rebuildFromStatusFiles` 会自然重新填充 `run_dir`。

### 2. 路径解析层

新模块 `core/context.ts`（依赖 `getAgentDir()` from `@earendil-works/pi-coding-agent`，
`import.meta.url` from `node:url`）。被以下 4 个读取点复用：

| 读取点                                                | 用途                                  | 解析方式                                           |
| ----------------------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `core/discovery.ts`                                   | `discoverAgents/discoverPrompts`      | `getAgentDirs()/getPromptDirs()` 多目录扫描 + 去重 |
| `runtime/launcher.ts`                                 | `prepareAgentPrompt`（subagent 启动） | `resolveAgentFile(name)`                           |
| `index.ts` `loadMainSessionAgentContext`              | 主会话 worker/planner/reviewer 注入   | `resolveAgentFile(name)`                           |
| `stow/pi/.local/share/pi/scripts/subagent-wrapper.sh` | `parse_agent_md`（pane 内 bash）      | `resolve_agent_file()` 函数（与 TS 端策略一致）    |

**bash 端 fallback 路径**（与 TS 端 `getAgentDirs()` 一致）：

```bash
PLUGIN_AGENTS_DIR="$XDG_CONFIG_HOME/pi/extensions/atelier/context/agents"
USER_AGENTS_DIR="$XDG_CONFIG_HOME/pi/agents"
```

### 3. 上下文注入协议

新增内部自定义 entry 类型 `CustomEntry`（不进 LLM 上下文，仅供钩子读取），
`customType: "atelier:context-inject"`，`data: { agent: string } | null`。
**不要**误用 `CustomMessageEntry`（会进入 LLM 上下文，会被 compaction 压缩）。

钩子读取后通过 `appendEntry("atelier:context-inject", null)` 写空标记
实现一次性消费。下次 `before_agent_start` 扫描到空标记时 `break` 走默认逻辑。

### 4. 部署影响

- **无需迁移**：`~/.config/pi/agents/*.md` 的旧 symlink 自动失效但被
  `resolveAgentFile` / `resolve_agent_file` 多路径策略绕过。
  下次 `blue stow pi --restow` 会清理掉。
- **subagent-wrapper.sh 需重新部署**：`blue stow pi --restow`。
- **plugin 自身重启即可生效**：`blue rebuild` 后 pi 进程重启时
  atelier 重新加载（jiti + tsx 缓存）。

### 5. 兼容性矩阵

| 项                          | 0.1.0 | 0.1.1                            |
| --------------------------- | ----- | -------------------------------- |
| pi 扩展 API 最低版本        | 0.74+ | 0.74+                            |
| 运行时（pi 内置 Bun）       | —     | `bun:sqlite`（非 `node:sqlite`） |
| tmux 最低版本               | 3.0+  | 3.0+                             |
| schema 版本（atelier_runs） | v2    | v2（无变化）                     |

### 6. 已知问题

- `~/.config/pi/agents/` 下 7 个旧 symlink 仍存在但失效，不影响功能。
  建议 `rm -f ~/.config/pi/agents/*.md` 清理（stow 重新部署会自动
  移除）。
- `subagent` 工具的 `images` 字段在 parallel / chain 模式下未做透传
  （仅 single 模式支持），沿用 0.1.0 行为。

---

## 早期版本

### [0.1.0] - 2026-06-30

- INITIAL: bootstrap pi-atelier as standalone pi package
- tmux split subagent execution
- SQLite registry + orphan-recovery + stuck-detector
- checkpoint / resume / workflow 长程任务恢复
- CAPABILITY_SELF_CHECK + Return Header 协议

[0.2.0]: https://github.com/ShineBreaker/pi-atelier/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/ShineBreaker/pi-atelier/compare/162d0fe...v0.1.1
[0.1.0]: https://github.com/ShineBreaker/pi-atelier/releases/tag/v0.1.0
