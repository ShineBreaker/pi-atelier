// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 内置 harness adapters — pi/claude/codex/hermes + generic 工厂
 *
 * launchCommand 返回单条 shell 命令文本：调用方通过 herdr `pane run` 或
 * tmux `send-keys` 送进 peer pane 的 shell 执行。env 以 `K=V` 前缀内联，
 * 与具体 shell 无关（fish/bash 都吃）。
 */

import type {
  ApprovalMode,
  HarnessAdapter,
  HarnessLaunchOpts,
} from "./types.ts";

/** shell 单引号转义 */
function q(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 把 env 映射转成 `K=V K2=V2` 命令前缀 */
function envPrefix(env?: Record<string, string>): string {
  if (!env) return "";
  const parts = Object.entries(env).map(([k, v]) => `${k}=${q(v)}`);
  return parts.length > 0 ? `${parts.join(" ")} ` : "";
}

/** 拼 argv 风格命令行 + env 前缀（adapter 统一出口） */
function cmdline(
  opts: HarnessLaunchOpts,
  parts: Array<string | undefined>,
): string {
  return (
    envPrefix(opts.env) +
    parts
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(" ")
  );
}

/** 把 approval 级别映射成各 harness 的自治 flag */
function approvalArgs(
  approval: ApprovalMode,
  full: string[],
  safe: string[],
): string[] {
  if (approval === "full") return full;
  if (approval === "safe") return safe;
  return [];
}

// ─── pi ─────────────────────────────────────────────────────────────────────
// pi TUI 默认无权限门（工具直接跑），approval 不产生 flag。

const pi: HarnessAdapter = {
  id: "pi",
  herdrKind: "pi",
  binaries: ["pi"],
  interactive: true,
  launchCommand(opts) {
    return cmdline(opts, [
      "pi",
      opts.model && `--model ${q(opts.model)}`,
      ...(opts.extraArgs ?? []),
    ]);
  },
};

// ─── claude ─────────────────────────────────────────────────────────────────
// full: --dangerously-skip-permissions（无人值守前提）
// safe: --permission-mode acceptEdits（文件编辑自动接受，bash 仍弹门→blocked）

const claude: HarnessAdapter = {
  id: "claude",
  herdrKind: "claude",
  binaries: ["claude"],
  interactive: true,
  launchCommand(opts) {
    const perm = approvalArgs(
      opts.approval,
      ["--dangerously-skip-permissions"],
      ["--permission-mode", "acceptEdits"],
    );
    return cmdline(opts, [
      "claude",
      opts.model && `--model ${q(opts.model)}`,
      ...perm,
      ...(opts.extraArgs ?? []),
    ]);
  },
};

// ─── codex ──────────────────────────────────────────────────────────────────
// full/safe 都映射 --full-auto（workspace-write 沙箱内自动执行）；
// 彻底无沙箱用 harnessArgs 显式加 --dangerously-bypass-approvals-and-sandbox。

const codex: HarnessAdapter = {
  id: "codex",
  herdrKind: "codex",
  binaries: ["codex"],
  interactive: true,
  launchCommand(opts) {
    const perm = approvalArgs(
      opts.approval,
      ["--full-auto"],
      ["--full-auto"],
    );
    return cmdline(opts, [
      "codex",
      opts.model && `--model ${q(opts.model)}`,
      ...perm,
      ...(opts.extraArgs ?? []),
    ]);
  },
};

// ─── hermes ─────────────────────────────────────────────────────────────────
// `hermes chat` 启动 TUI（devin 会话实测命令）。--model 是常见约定的猜测，
// 不生效时用 harnessArgs 覆盖。

const hermes: HarnessAdapter = {
  id: "hermes",
  herdrKind: "hermes",
  binaries: ["hermes"],
  interactive: true,
  launchCommand(opts) {
    return cmdline(opts, [
      "hermes",
      "chat",
      opts.model && `--model ${q(opts.model)}`,
      ...(opts.extraArgs ?? []),
    ]);
  },
};

// ─── opencode / omp 等已知 kind 的轻量适配 ───────────────────────────────────
// 与 hermes 同构：TUI 即 binary 本身，模型走 --model 猜测。

function simpleTui(id: string, herdrKind: string): HarnessAdapter {
  return {
    id,
    herdrKind,
    binaries: [id],
    interactive: true,
      launchCommand(opts) {
      return cmdline(opts, [
        id,
        opts.model && `--model ${q(opts.model)}`,
        ...(opts.extraArgs ?? []),
      ]);
    },
  };
}

const opencode = simpleTui("opencode", "opencode");
const omp = simpleTui("omp", "omp");

// ─── generic 工厂 ────────────────────────────────────────────────────────────
/**
 * 未内置适配的 harness（mcode/zcode/dsh/任意 binary）：
 * 启动命令 = binary 名 + extraArgs。detection/submission 全靠文件契约。
 */
export function genericAdapter(id: string): HarnessAdapter {
  return {
    id,
    binaries: [id],
    interactive: true,
      launchCommand(opts) {
      return cmdline(opts, [id, ...(opts.extraArgs ?? [])]);
    },
  };
}

/** 全部内置 adapter（id → adapter） */
export const BUILTIN_ADAPTERS: HarnessAdapter[] = [
  claude,
  codex,
  pi,
  hermes,
  opencode,
  omp,
];
