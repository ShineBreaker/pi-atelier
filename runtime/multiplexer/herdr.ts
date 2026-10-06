// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * HerdrBackend — MultiplexerBackend 的 herdr 实现
 *
 * herdr 是终端多路复用器（与 tmux 对等）。CLI 通过 `herdr pane` 子命令
 * 控制 pane：split（创建空 pane）+ run（在其中执行命令）两步，区别于
 * tmux 的 split-window <cmd> 一步到位。
 *
 * 关键差异（接受，不抹平）：
 *   - herdr split 创建的新 pane 在主 pane **下方**（--direction down），
 *     tmux 在上方（-b）。纯界面差异，不影响 monitor 的 status.json 轮询。
 *   - herdr pane ID 是不透明字符串（如 w1:p1），tmux 是 %N。
 *   - herdr pane 是常驻 shell：run 的命令退出后 shell 仍在、pane 不消失
 *     （tmux split-window 的 pane 进程即命令本身，退出即自动关闭）。
 *     需要自闭合的场景在命令尾拼 `; herdr pane close <id>`；peer 模式
 *     的 splitShell 不带自闭合（pane 常驻正是 peer 的生命周期前提）。
 *   - herdr 无「焦点切回」概念：split 用 --no-focus，焦点从未离开主 pane。
 *
 * 环境契约：HERDR_ENV=1 时 herdr 向每个 managed pane 注入
 *   HERDR_WORKSPACE_ID / HERDR_TAB_ID / HERDR_PANE_ID。
 */

import { execFileSync } from "node:child_process";
import type {
  MultiplexerBackend,
  MuxAgentStatus,
  SplitShellOpts,
} from "./types.ts";

/** 同步执行 herdr 命令，返回 stdout（已 trim） */
function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** 同步执行 herdr 命令，失败返回 null */
function herdrExecMaybe(args: string[]): string | null {
  try {
    return herdrExec(args);
  } catch {
    return null;
  }
}

/**
 * 从 herdr pane split 的 JSON 响应中提取新 pane ID。
 *
 * herdr split 返回形状（v0.7.5）：`{ result: { pane: { pane_id: "w1:p2", ... } } }`
 * 解析失败抛错——split 必须返回合法 pane id，否则后续 run/setTitle 无法进行。
 */
function parsePaneId(json: string): string {
  const parsed = JSON.parse(json) as {
    result?: { pane?: { pane_id?: string } };
  };
  const paneId = parsed?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
    throw new Error(`herdr split 未返回 pane_id: ${json.slice(0, 200)}`);
  }
  return paneId;
}

export class HerdrBackend implements MultiplexerBackend {
  readonly name = "herdr" as const;

  /** 设置 pane 标签（herdr pane rename）。失败静默。 */
  setTitle(paneId: string, title: string): void {
    herdrExecMaybe(["pane", "rename", paneId, title]);
  }

  /**
   * 检查 pane 是否存活。
   *
   * herdr pane get 对已关闭 pane 返回非零 exit；用 herdrExecMaybe 捕获，
   * 非 null 即存活。注意：herdr pane ID 关闭后不重用，get 失败 = 已死。
   */
  isAlive(paneId: string): boolean {
    return herdrExecMaybe(["pane", "get", paneId]) !== null;
  }

  /** 关闭 pane（herdr 子命令是 close 而非 kill）。失败静默。 */
  kill(paneId: string): void {
    herdrExecMaybe(["pane", "close", paneId]);
  }

  // ─── PR-12: peer 模式方法集 ─────────────────────────────────────────────

  /**
   * 分割空 shell pane（peer 模式入口）。不带 run 命令——harness TUI 由
   * 后续 sendText(launchCommand) 启动。
   *
   * env 走 `pane split --env K=V`（herdr 原生支持，注入 pane 进程环境）。
   */
  splitShell(opts: SplitShellOpts): string {
    const args = ["pane", "split"];
    if (opts.direction === "right" && opts.targetPaneId) {
      args.push(opts.targetPaneId, "--direction", "right");
    } else {
      args.push("--current", "--direction", "down");
    }
    args.push("--no-focus", "--ratio", String(opts.ratio));
    if (opts.cwd) args.push("--cwd", opts.cwd);
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        args.push("--env", `${k}=${v}`);
      }
    }
    return parsePaneId(herdrExec(args));
  }

  /**
   * 向 pane 发文本 + Enter。
   * pane run 对 shell pane 是执行命令；对已识别 agent 的 pane 等价于
   * agent prompt（文本进 TUI 输入框并回车）。peer 模式两种用途共用此路。
   */
  sendText(paneId: string, text: string): void {
    herdrExec(["pane", "run", paneId, text]);
  }

  /** 裸按键（Escape/Enter/Down/C-c），用于打断或应答权限门。 */
  sendKeys(paneId: string, keys: string[]): void {
    herdrExecMaybe(["pane", "send-keys", paneId, ...keys]);
  }

  /** 读 transcript 尾部（recent-unwrapped：软换行合并，适合日志/提取）。 */
  readPane(paneId: string, lines = 120): string {
    return (
      herdrExecMaybe([
        "pane",
        "read",
        paneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        String(lines),
      ]) ?? ""
    );
  }

  /**
   * pane 内 agent 的语义状态。
   * agent get 失败（pane 无 agent/已关）→ null；检测到 agent 但状态未明
   * → "unknown"（herdr 自己的枚举值）。
   */
  agentStatus(paneId: string): MuxAgentStatus | null {
    const out = herdrExecMaybe(["agent", "get", paneId]);
    if (!out) return null;
    try {
      const parsed = JSON.parse(out) as {
        result?: { agent?: { agent_status?: string } | null };
      };
      const status = parsed?.result?.agent?.agent_status;
      if (parsed?.result?.agent == null || !status) return null;
      if (
        status === "idle" ||
        status === "working" ||
        status === "blocked" ||
        status === "done" ||
        status === "unknown"
      ) {
        return status;
      }
      return "unknown";
    } catch {
      return null;
    }
  }

  /**
   * pane 内 agent 原生 session 标识（agent_session.value，如
   * "20261006_204701_7786a4"）。供 native session 文件定位用。
   */
  agentSession(paneId: string): string | null {
    const out = herdrExecMaybe(["agent", "get", paneId]);
    if (!out) return null;
    try {
      const parsed = JSON.parse(out) as {
        result?: {
          agent?: {
            agent_session?: { value?: string } | null;
          } | null;
        };
      };
      return parsed?.result?.agent?.agent_session?.value ?? null;
    } catch {
      return null;
    }
  }
}
