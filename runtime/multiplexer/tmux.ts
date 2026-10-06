// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * TmuxBackend — MultiplexerBackend 的 tmux 实现
 *
 * ratio 参数（float 0-1）在内部转换为 tmux 的 percentage（int 0-100）。
 */

import { execFileSync } from "node:child_process";
import type { MultiplexerBackend, SplitShellOpts } from "./types.ts";

/** 同步执行 tmux 命令，返回 stdout（已 trim） */
function tmuxExec(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** 同步执行 tmux 命令，失败返回 null */
function tmuxExecMaybe(args: string[]): string | null {
  try {
    return tmuxExec(args);
  } catch {
    return null;
  }
}

/** float ratio (0-1) → tmux percentage (int 1-100)，夹紧到合法范围 */
function ratioToPercent(ratio: number): string {
  return String(Math.max(1, Math.min(100, Math.round(ratio * 100))));
}

export class TmuxBackend implements MultiplexerBackend {
  readonly name = "tmux" as const;

  setTitle(paneId: string, title: string): void {
    tmuxExecMaybe(["select-pane", "-t", paneId, "-T", title]);
  }

  isAlive(paneId: string): boolean {
    return (
      tmuxExecMaybe(["display-message", "-p", "-t", paneId, "#{pane_id}"]) ===
      paneId
    );
  }

  kill(paneId: string): void {
    tmuxExecMaybe(["kill-pane", "-t", paneId]);
  }

  // ─── PR-12: peer 模式方法集 ─────────────────────────────────────────────
  //
  // tmux 无 agent_status 语义检测（agentStatus/agentSession 不实现），
  // peer 完成检测全靠文件契约 + transcript 稳定性启发（monitor 侧处理）。

  /**
   * 分割空 shell pane（peer 模式入口）。不带命令 → 跑默认 shell。
   * env 用 tmux ≥3.2 的 `split-window -e K=V`；老版本失败时降级不带 env
   * 重试（PI_SUBAGENT 缺失仅影响递归守卫，不致命）。
   */
  splitShell(opts: SplitShellOpts): string {
    const base = ["split-window"];
    if (opts.direction === "right" && opts.targetPaneId) {
      base.push("-t", opts.targetPaneId, "-h");
    } else {
      base.push("-v", "-b");
    }
    base.push("-p", ratioToPercent(opts.ratio));
    if (opts.cwd) base.push("-c", opts.cwd);
    const envArgs: string[] = [];
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        envArgs.push("-e", `${k}=${v}`);
      }
    }
    const printId = ["-P", "-F", "#{pane_id}"];
    try {
      return tmuxExec([...base, ...envArgs, ...printId]);
    } catch {
      // 老 tmux 无 -e → 不带 env 重试
      return tmuxExec([...base, ...printId]);
    }
  }

  /**
   * 向 pane 发文本 + Enter：先 -l 字面量发文本，再单独发 Enter。
   * 对 shell pane 是执行命令，对 TUI 是输入消息（与 herdr pane run 同义）。
   */
  sendText(paneId: string, text: string): void {
    tmuxExec(["send-keys", "-t", paneId, "-l", "--", text]);
    tmuxExec(["send-keys", "-t", paneId, "Enter"]);
  }

  /** 裸按键（Escape/Enter/Down/C-c）。 */
  sendKeys(paneId: string, keys: string[]): void {
    tmuxExecMaybe(["send-keys", "-t", paneId, ...keys]);
  }

  /** 读 pane 尾部输出（capture-pane 可见区+回卷）。 */
  readPane(paneId: string, lines = 120): string {
    return (
      tmuxExecMaybe([
        "capture-pane",
        "-p",
        "-t",
        paneId,
        "-S",
        `-${lines}`,
      ]) ?? ""
    );
  }
}
