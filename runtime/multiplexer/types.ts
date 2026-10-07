// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 多路复用器后端抽象 — 调用方不感知具体是 tmux 还是 herdr
 *
 * 运行时按环境变量自动选择后端（detectBackend）：
 *   - HERDR_ENV=1 → HerdrBackend（herdr pane split/run/close）
 *   - $TMUX 非空 → TmuxBackend（tmux split-window/kill-pane）
 *   - 都没有    → 抛错（atelier 必须运行在某个多路复用器内）
 *
 * peer 派发入口是 openTab（新标签页 + 空 shell pane）或 splitShell（同页分割）
 * + sendText（起 harness TUI）；
 * setTitle/isAlive/kill 服务 pane 标识与生命周期治理，closeTab 回收空标签页。
 */

// ─── 后端接口 ─────────────────────────────────────────────────────────────

/** herdr 检测到的 agent 状态（tmux 无此概念，恒 null） */
export type MuxAgentStatus =
  | "idle"
  | "working"
  | "blocked"
  | "done"
  | "unknown";

/** splitShell 的输入：peer 模式创建空 shell pane */
export interface SplitShellOpts {
  /** 分割方向：down=垂直新行（herdr/tmux 通用），right=在 target 右侧 */
  direction: "down" | "right";
  /** 新 pane 占比（0-1） */
  ratio: number;
  /** direction=right 时的基准 pane */
  targetPaneId?: string;
  /** 新 pane 的工作目录 */
  cwd?: string;
  /** 注入新 pane 的环境变量（PI_SUBAGENT 等） */
  env?: Record<string, string>;
}

/** openTab 的输入：新标签页里的空 shell pane（peer 批次入口） */
export interface OpenTabOpts {
  /** 标签页标题（如 `sub:parallel:a1b2`） */
  label?: string;
  /** 新 pane 的工作目录 */
  cwd?: string;
  /** 注入新 pane 的环境变量（PI_SUBAGENT 等） */
  env?: Record<string, string>;
}

/** openTab 的返回：新标签页 id + 其中唯一的空 shell pane id */
export interface OpenedTab {
  tabId: string;
  paneId: string;
}

/**
 * 多路复用器后端接口。
 *
 * 所有方法同步执行（execFileSync），调用方依赖顺序执行 + 立即拿到 paneId。
 *
 * peer 方法集（splitShell/sendText/sendKeys/readPane/agentStatus/
 * agentSession）支持「pane 里跑持久交互式 harness」形态。
 * tmux 只能实现子集（无 agent_status 语义检测），接口相应标 optional。
 */
export interface MultiplexerBackend {
  /** 后端名（"tmux" / "herdr"），用于日志诊断 */
  readonly name: "tmux" | "herdr";

  /**
   * PR-12: 分割一个空 shell pane（不立即运行命令）——peer 模式入口。
   * 返回新 pane ID；随后用 sendText 在其中启动 harness TUI。
   */
  splitShell(opts: SplitShellOpts): string;

  /**
   * 新开一个标签页（内含一个空 shell pane）——peer 批次入口。
   * 焦点不离开当前页（herdr --no-focus / tmux -d）；随后用 sendText 在其中启动 harness TUI。
   * tmux 里“标签页”即新 window。失败时调用方回退到 splitShell 同页分割。
   */
  openTab(opts: OpenTabOpts): OpenedTab;

  /**
   * 关闭标签页（peer 全部退役后回收空页）。best-effort：页已不存在即静默。
   * tmux: kill-window；herdr: tab close（连其中活 pane 一起清理）。
   */
  closeTab(tabId: string): void;

  /**
   * 设置 pane 的标题/标签（用于在分屏界面识别 subagent）。
   * tmux: select-pane -T；herdr: pane rename。
   */
  setTitle(paneId: string, title: string): void;

  /**
   * 检查 pane 是否仍存活（用于 monitor 的 pane 死亡检测）。
   * @returns true 存活；false 已关闭
   */
  isAlive(paneId: string): boolean;

  /**
   * 终止指定 pane（用于 abort/timeout 清理 / closePeer）。
   * tmux: kill-pane；herdr: pane close。
   */
  kill(paneId: string): void;

  // ─── PR-12: peer 模式方法集 ─────────────────────────────────────────────

  /**
   * 向 pane 发送文本 + Enter。
   * herdr: pane run（对 shell 是执行命令，对 TUI 是输入消息）。
   * tmux: send-keys -l + Enter。
   */
  sendText(paneId: string, text: string): void;

  /**
   * 向 pane 发送裸按键（Escape/Enter/Down/C-c 等，用于打断/应答权限门）。
   * tmux: send-keys；herdr: pane send-keys。
   */
  sendKeys?(paneId: string, keys: string[]): void;

  /**
   * 读 pane transcript 尾部（peer 结果提取兜底/用户查看实时输出）。
   * herdr: pane read --source recent-unwrapped；tmux: capture-pane -p。
   */
  readPane?(paneId: string, lines?: number): string;

  /**
   * pane 内 agent 的语义状态。仅 herdr 有（integration 检测）；
   * tmux 恒 null；herdr 但 pane 内无已识别 agent → "unknown"。
   */
  agentStatus?(paneId: string): MuxAgentStatus | null;

  /**
   * pane 内 agent 原生 session 标识（herdr agent_session.value）。
   * 用于从 harness 自己的 session 文件提取结果的定位锚点。
   */
  agentSession?(paneId: string): string | null;
}
