# atelier 技术文档

面向使用者/维护者的完整技术参考。仓库内部架构约束（目录分层、依赖方向、
修改禁区）见 `AGENTS.md`；本文聚焦「这个系统怎么用、怎么运转」。

## 1 核心模型：持久 peer

```
v1（已废弃）: subagent = 函数调用   spawn(task) → 跑 → 死 → result
v2（当前）:   subagent = 持久 peer   open(harness) → [msg₁→result₁] → [msg₂→result₂] → … → close
```

一个 **peer** = 分屏 pane + 活的 harness TUI 会话 + 角色（agent persona）
+ 累积对话上下文。task 只是发给 peer 的第 N 条消息；peer 跑完不退出，
主会话随时 `action:"send"` 追加指令（追问/纠偏/解堵）。

生命周期与 task 解耦：open 一次，send 多次，显式 close 退役。
等待超时/失败**不杀 pane**——peer 是持久资产，可以被后续 send 救活。

**auto-close + resume（空闲回收）**：消息 completed 后空闲超过
`idleGraceMs`（默认 120s），atelier 自动 closePeer 腾出 pane；之后再
`send` 该 peer 时用 harness 原生 resume（`claude --resume <id>` /
`codex resume <id>` / `pi --session <id>` / `hermes chat --resume <id>`）
重开，harness 会话上下文无损恢复。宽限期内追问则直接复用原 pane，
零开销。安全阀：拿不到原生 session id（tmux 后端 / integration 未识别）
或 harness 未声明 resume 命令的 peer **永不自动关**——关了就丢上下文；
failed/blocked/timeout 同样不自动关（保留 send 解堵语义）。

## 2 Harness 无关路由

派发目标不再只有 pi。`runtime/harness/` 提供 adapter 抽象：

- **harness spec（TOML 声明式）**：每个 CLI 的功能入口（启动子命令、
  model/approval/resume 参数组）存于统一配置文件，插件内置默认
  `context/harnesses.toml`（随 atelier 分发，适配即开箱可用）+
  用户覆盖 `~/.config/pi/atelier/harnesses.toml`（同名 harness 逐字段
  覆盖，新名扩展），见 §7
- **generic adapter**：任意未登记的 PATH binary 零定制接入（如 `mcode`、
  `zcode`）——启动命令 = binary 名 + extraArgs，无 resume 能力
- **detect**：`command -v` 按序探测 binary；不可用路由自动跳过

路由条目三种形态：

| 写法            | 解析                                      |
| --------------- | ----------------------------------------- |
| `claude/sonnet` | harness=claude, model=sonnet              |
| `codex`         | harness=codex（binary 在 PATH 即识别）    |
| `zai/GLM-5.2`   | 非已知 harness → pi + model（旧配置兼容） |

tier 配置升级为混合路由链（数组按序即优先级）：

```json
"tiers": {
  "pro":   ["claude/sonnet", "codex", "pi/zai/GLM-5.2"],
  "quick": ["hermes", "pi/qwen-3.8max"]
}
```

解析顺序：`params.harness/model` > agent frontmatter `harness:` pin
> tier routes 按序（跳过 binary 缺失与 `modelSchedules` 时段禁用）> 兜底 pi。
外部 harness 排前面即「优先外部」——各 harness 对自家模型适配最好。

## 3 工具面

`subagent` 单一工具承担全部操作：

```text
subagent({agent, task})                → 异步派发，返回 {peerId, msgId}，完成后自动推送
subagent({agent, task, wait:true})     → 阻塞到本条消息完成（仅后续工具强依赖结果时用）
subagent({tasks:[...]})                → 并行（默认异步返回批句柄，完成后自动推送）
subagent({chain:[...]})                → 串行链（默认异步，同 agent+harness 复用 peer）
subagent({peer:"<peerId>", task})      → 显式复用某 peer
subagent({harness:"codex", task})      → 显式 harness 覆盖

subagent({action:"send",  id, task})   → 随时向存活 peer 发新指令
subagent({action:"wait",  id})         → 手动核查收结果（peerId、批句柄或已推送批次缓存）
subagent({action:"read",  id, lines})  → 看 peer 实时 transcript 尾部
subagent({action:"peers"})             → 存活 peer 池一览
subagent({action:"close", id})         → 退役 peer（关 pane）
subagent({action:"list"})              → agent 路由表 + harness 可用性
subagent({action:"status",id?})        → 运行状态/registry 视图
```

**send 语义分化**：

| peer 状态          | send 语义 | 说明                                             |
| ------------------ | --------- | ------------------------------------------------ |
| 空闲/done          | 新任务    | msgSeq++、写 brief-N、重置 status.json           |
| working            | 舵手消息  | 文本注入 TUI 输入框，不动契约；不主动打断        |
| 已回收（可 resume）| 自动重开  | harness 原生 resume 恢复会话后走新任务流程       |

peer 复用策略由主 agent 决定：默认新开；`peer` 显式指定；`send` 传
agent 角色名自动路由到该角色空闲 peer；chain 内同 agent+同 harness
步骤自动复用（上下文零损耗）。

## 4 文件契约（结果回收主通道）

peer 目录 `$XDG_CACHE_HOME/pi/subagents/<peerId>/`：

| 文件          | 写者    | 内容                                               |
| ------------- | ------- | -------------------------------------------------- |
| `peer.json`   | atelier | peer 生命周期元数据（唯一权威，含 paneId/sessionId） |
| `brief-N.md`  | atelier | 第 N 条消息完整指令（persona 只在 N=1 注入）       |
| `result-N.md` | peer    | 结果 + Return Header（`**Status**: …`）            |
| `status.json` | 共享    | atelier 派单写 `{running,msgSeq:N}`；peer 覆写终态 |
| `task.md`     | atelier | 最新任务摘要（兼容旧路径）                          |

每条消息对应 registry 一行 run：`runId = <peerId>-m<seq>`。

**完成检测降级链**（waitForPeerMessage，按优先级）：

1. `status.json` 终态且 `msgSeq>=当前seq`（文件契约，主通道）
2. herdr `agent_status`：观测到 working 后转 idle/done 连续 2 次
3. transcript 稳定性启发：尾部先变化（在干活）后连续 4 次不变
4. **判定停止但未落盘** → 先注入补写指令（90s 窗口）→ 无效才 `readPane` 兜底提取代写

blocked（权限门/输入门）走 `blockedGraceMs` 宽容期，超时返回带
「用 send 解堵」提示的失败；abort 是唯一杀 pane 的主动作。

## 5 编排模式

- **single**：`executeWithFallback` 按路由链逐 harness 尝试（普通失败才换路由；abort/timeout/blocked 不重试）
- **parallel**：每任务一 peer；批次首 peer 开新标签页（焦点不抢），后续在页内右分；受 `maxConcurrency`/`maxTasks` 约束
- **chain**：`{previous}`/`{task}` 替换照常；同 agent+同 harness 步骤自动复用 peer（上下文零损耗），跨 harness 走输出接力；链首步开新标签页
- **标签页**：每批派发一新页（herdr 即 tab，tmux 即 window），主会话页不再被挤占；同页末 peer 关闭即回收空页；openTab 失败回退同页分割
- **异步默认**：缺省（非 wait:true）时 single/tasks/chain 一律后台执行，立即返回句柄；
  完成即 `sendUserMessage` 推送到主会话（会话可先 settled，推送到达自动恢复），无需轮询。
  在途批次挂 pendingOps，推送后进 finishedOps 供事后核查；显式 `action:wait` 会认领并跳过推送。

## 6 Registry 与恢复

- **status.json 是 single source of truth**；SQLite registry
  （`$XDG_DATA_HOME/pi/atelier-registry.db`，bun:sqlite）只是查询视图，可丢可重建
- schema v3：`atelier_peers` 表 + runs 的 `peer_id`/`msg_seq`/`harness` 列；
  `PRAGMA user_version` + `ALTER TABLE` 增量迁移
- 启动两步：`rebuildFromStatusFiles`（加载时，跳过 peer 目录防幻影）→
  `orphanRecovery`（session id 首次提取后一次）
- **孤儿认领按 session 归属**：peer.json 记 `sessionId`，只收尾当前会话
  名下的 unsettled 记录；判定依据 pane/harness 存活探测 +
  `agentSession` 原生 session 复用比对（非时间启发）：
  - pane 死 / id 复用 / peer 已关 → orphan + 落终态
  - pane 活且 agent_status idle/done 但 status.json 卡 running → 代写终态
  - pane 活且 working/blocked/无法判定 → 保留（文件契约会收尾）
  - `run.msgSeq < peer.msgSeq` 的过期消息行 → registry 直接收尾为 orphan

## 7 配置参考（atelier.json）

加载顺序：`~/.config/pi/atelier.json` > agent dir/settings.json 的
`atelier` 字段 > `~/.config/pi/settings.json`。`/atelier-config` 打开
TUI 面板编辑，保存即热重载。

| 字段                | 默认      | 说明                                                    |
| ------------------- | --------- | ------------------------------------------------------- |
| `tiers`             | —         | tier→路由链（string / string[] / {model,fallback,routes}） |
| `modelSchedules`    | —         | 时段限制；键支持 `harness/model` > `model` > `harness`  |
| `defaultTier`       | `inherit` | frontmatter 无 tier 时的回退                            |
| `peerApproval`      | `off`     | `"full"` 自治 / `"safe"` 保守 / `"off"` harness 默认权限 |
| `blockedGraceMs`    | —         | 权限门卡住宽容期（超时提示 send 解堵）                  |
| `peerReadyTimeoutMs`| —         | harness TUI 就绪等待上限                                |
| `maxPeers`          | `0`       | peer 池上限（0=不限；超限 openPeer 抛错）               |
| `harnessArgs`       | —         | `{harness: [extra flags]}` 追加启动参数                 |
| `autoClose`         | `true`    | completed 后空闲自动回收 pane（仅可 resume 的 peer）   |
| `idleGraceMs`       | `120000`  | autoClose 空闲宽限期（期内追问免 resume 往返）         |
| `maxConcurrency`    | —         | parallel 批内并发上限                                   |
| `maxTasks`          | —         | parallel 任务总数上限                                   |
| `timeoutMs`         | —         | 单条消息等待超时（不杀 pane）                           |
| `pollIntervalMs`    | —         | monitor 轮询间隔                                        |
| `keepResults`       | —         | run 目录保留上限（存活 peer 目录豁免）                  |
| `panePrefix`        | `sub:`    | pane 标题前缀（标题 = `sub:角色@harness#peerId尾4位`）  |

agent frontmatter 支持 `harness:` pin（锁定派发目标）与 `tier:`。

### 7.1 harness spec（harnesses.toml）

各 CLI harness 的功能入口统一存 TOML（Bun 原生解析，零依赖）：

- 插件内置默认：atelier 包内 `context/harnesses.toml`（随插件分发，
  内置适配 pi/claude/codex/hermes/opencode/omp）
- 用户覆盖/扩展：`~/.config/pi/atelier/harnesses.toml`（同名 harness
  逐字段覆盖内置，新名追加；改后重启 pi 生效）

```toml
[harness.claude]
binaries = ["claude"]              # PATH 探测候选【必填，用户覆盖内置时可不写】
herdr-kind = "claude"              # herdr agent kind（agent_status 检测资格）
model-args = ["--model", "{model}"]        # model 缺省时整组省略
approval-full = ["--dangerously-skip-permissions"]
approval-safe = ["--permission-mode", "acceptEdits"]
resume-args = ["--resume", "{sessionId}"]  # 缺省 = 不支持 resume → 禁用 auto-close

[harness.mymcode]                  # 新 harness 零源码接入
binaries = ["mymcode"]
```

数组字段覆盖语义：缺省 = 继承内置；显式数组（含空）= 覆盖
（`approval-safe = []` 即清除内置默认）。`resume-args` 自含子命令
（codex 的 `["resume","{sessionId}"]`、hermes 的
`["chat","--resume","{sessionId}"]`）。

## 8 多路复用器

`detectBackend()`：`HERDR_ENV=1` → herdr；`$TMUX` → tmux；否则抛错
（atelier 必须运行在多路复用器内）。

peer 方法集差异：

| 方法          | herdr | tmux | 说明                                 |
| ------------- | ----- | ---- | ------------------------------------ |
| `splitShell`  | ✓     | ✓    | 空 shell pane（peer 生命周期前提）   |
| `openTab`     | ✓     | ✓    | 新标签页（herdr tab / tmux window，批次入口） |
| `closeTab`    | ✓     | ✓    | 空页回收（best-effort）              |
| `sendText`    | ✓     | ✓    | 文本+回车注入                        |
| `sendKeys`    | ✓     | ✓    | 按键序列（保留给显式打断原语）       |
| `readPane`    | ✓     | ✓    | transcript 尾部                      |
| `agentStatus` | ✓     | —    | integration 语义检测（idle/working…） |
| `agentSession`| ✓     | —    | 原生 session id（pane id 复用检测）  |

tmux 下完成检测退化到文件契约 + transcript 启发；孤儿认领的探针相应
降级（无 agentStatus/agentSession → 保守放行）。tmux 也拿不到原生
session id → auto-close 自动禁用（无 resume 锚点的 peer 保持常驻）。

## 9 已知边界

- 外部 harness 无 batch/headless 协议，peer（交互式 TUI）是唯一执行形态
- peer 写 `result-N`/`status.json` 靠 brief 契约指令（LLM 自觉），
  未落盘由 monitor 四级降级链兜底
- 舵手无打断能力：peer 彻底跑飞时只能 close 重开（打断需显式原语，待实测引入）
- `sendKeys` 接口预留但目前零调用方
- 非当前 session 的 unsettled 记录归原会话收尾；会话永不恢复则残留
  「running」态（registry 视图层，不影响正确性）
- resume 依赖 herdr `agentSession` 报告的原生 session id 与 harness 自身
  的 resume 命令行为（如 `claude --resume` 的会话分支语义）；pi 的
  `--session <id>` 锚点格式建议在真实 herdr 环境实测确认
