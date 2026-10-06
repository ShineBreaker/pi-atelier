// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 多路复用器后端抽象 — 让 launcher.ts 不感知具体是 tmux 还是 herdr
 *
 * 运行时按环境变量自动选择后端（detectBackend）：
 *   - HERDR_ENV=1 → HerdrBackend（herdr pane split/run/close）
 *   - $TMUX 非空 → TmuxBackend（tmux split-window/kill-pane）
 *   - 都没有    → 抛错（atelier 必须运行在某个多路复用器内）
 *
 * 抽象的操作覆盖 launchSingle/launchParallel 的全部 pane 控制需求：
 *   currentPaneId / splitAbove / splitRight / setTitle / refocus /
 *   isAlive / kill
 *
 * 布局语义差异（接受，不抹平）：
 *   - tmux splitAbove 在主 pane 上方创建子 pane（40% 行）
 *   - herdr split 在主 pane 下方创建子 pane（ratio 0.4）
 *   两者都让子 agent 在独立 pane 跑，主 pane 保持可交互。上方/下方是
 *   纯界面差异，不影响 status.json 文件轮询（monitor.ts multiplexer 无关）。
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

/**
 * 多路复用器后端接口。
 *
 * 所有方法同步执行（execFileSync），与原 tmux 封装一致——launchSingle 的
 * 分屏逻辑依赖顺序执行 + 立即拿到 paneId。
 *
 * PR-12 新增 peer 方法集（splitShell/sendText/sendKeys/readPane/
 * agentStatus/agentSession）：支持「pane 里跑持久交互式 harness」形态。
 * tmux 只能实现子集（无 agent_status 语义检测），接口相应标 optional。
 */
export interface MultiplexerBackend {
  /** 后端名（"tmux" / "herdr"），用于日志诊断 */
  readonly name: "tmux" | "herdr";

  /**
   * 获取当前 pane 的 ID（调用 launchSingle 的 pane，subagent 要相对它分屏）。
   * @returns 当前 pane 的稳定 ID 字符串
   */
  currentPaneId(): string;

  /**
   * 在当前 pane 的「上方」（tmux）或「下方」（herdr）垂直分割一个新 pane，
   * 在其中运行 cmd，返回新 pane 的 ID。
   *
   * @param cmd 在新 pane 内执行的 shell 命令（subagent wrapper 调用串）
   * @param ratio 新 pane 占用的高度比例（0-1，如 0.4 = 40%）
   * @returns 新 pane 的 ID
   */
  splitAbove(cmd: string, ratio: number): string;

  /**
   * 在指定 pane 的右侧水平分割一个新 pane，在其中运行 cmd，返回新 pane ID。
   * 用于 parallel/chain 模式在顶部行内逐步扩展子 pane。
   *
   * @param targetPaneId 分割基准 pane 的 ID
   * @param cmd 新 pane 内执行的命令
   * @param ratio 新 pane 占用的宽度比例（0-1）
   * @returns 新 pane 的 ID
   */
  splitRight(targetPaneId: string, cmd: string, ratio: number): string;

  /**
   * PR-12: 分割一个空 shell pane（不立即运行命令）——peer 模式入口。
   * 返回新 pane ID；随后用 sendText 在其中启动 harness TUI。
   */
  splitShell(opts: SplitShellOpts): string;

  /**
   * 设置 pane 的标题/标签（用于在分屏界面识别 subagent）。
   * tmux: select-pane -T；herdr: pane rename。
   */
  setTitle(paneId: string, title: string): void;

  /**
   * 把焦点切回指定 pane（分屏结束后回主 pane）。
   * tmux: select-pane；herdr: no-op（split 时用 --no-focus，焦点从未离开）。
   */
  refocus(paneId: string): void;

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
