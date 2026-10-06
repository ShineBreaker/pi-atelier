// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * Harness 适配器抽象 — 让 atelier 把任务委派给任意 agent harness（pi/claude/
 * codex/hermes/…），而不只是 pi 自己。
 *
 * 设计前提（来自实测）：每个 harness 对自己的模型适配最好，所以路由层
 * 倾向把任务派给外部 harness，pi 退化为兜底/通用项。
 *
 * 两种执行形态：
 *   - peer（交互式 TUI）：pane 里跑活会话，sendText 随时发指令（追问/纠偏/
 *     解堵），完成检测靠文件契约 + mux 状态信号。首选形态。
 *   - batch（一次性 headless）：harness 的非交互命令跑完即退出。兜底形态
 *     （复用现有 wrapper 链路，仅 pi 有成熟实现）。
 */

import type { PeerInfo, SubagentConfig } from "../../core/types.ts";

/** peer 自治级别（对齐 SubagentConfig.peerApproval） */
export type ApprovalMode = "full" | "safe" | "off";

/** 构建 harness TUI 启动命令的输入 */
export interface HarnessLaunchOpts {
  /** 模型名（undefined = harness 默认模型） */
  model?: string;
  /** 自治级别 */
  approval: ApprovalMode;
  /** atelier.json harnessArgs[harnessId] 的追加参数 */
  extraArgs?: string[];
  /** 随命令注入的环境变量前缀（PI_SUBAGENT=1 等） */
  env?: Record<string, string>;
}

export interface HarnessAdapter {
  /** 规范 id，同时是 tier routes / frontmatter `harness:` / params.harness 的取值 */
  id: string;
  /**
   * herdr agent kind 名（herdr agent/integration 子命令的取值）。
   * 在 herdr kind 名单内的 harness 可获得 agent_status 语义检测；
   * 不在名单内的（mcode/zcode/…）只能走文件契约 + transcript 启发。
   */
  herdrKind?: string;
  /** 探测用的 binary 候选（command -v 按序试，首个命中即用） */
  binaries: string[];
  /** 交互式 TUI 是否可用（false = 仅 batch） */
  interactive: boolean;
  /**
   * 向 working 状态的 peer 发消息时的实测行为：
   *   - "queue":        输入排队，当前 turn 结束后处理（多数 TUI）
   *   - "interrupt":    立即打断当前输出并处理新输入
   *   - "esc-required": 需要先 sendKeys Escape 再发
   *   - "unknown":      未实测，按 queue 尝试并在文档里标注
   */
  steering: "queue" | "interrupt" | "esc-required" | "unknown";
  /**
   * 生成交互式 TUI 的启动命令行（单条 shell 命令字符串）。
   * 发送方式是 pane run / send-keys，所以返回整条命令文本而非 argv。
   */
  launchCommand(opts: HarnessLaunchOpts): string;
}
