// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * Harness adapters — spec 数据 → HarnessAdapter 的编译层
 *
 * 命令组装逻辑全部在 spec.ts 的 assembleCommand（launch/resume 共用）；
 * 本模块只做 spec → adapter 的形状转换。spec 数据源（插件内置
 * context/harnesses.toml + 用户 ~/.config/pi/atelier/harnesses.toml 覆盖扩展）
 * 见 spec.ts。
 *
 * launchCommand/resumeCommand 返回单条 shell 命令文本：调用方通过 herdr
 * `pane run` 或 tmux `send-keys` 送进 peer pane 的 shell 执行。
 */

import {
  assembleCommand,
  mergedSpecs,
  type HarnessSpec,
} from "./spec.ts";
import type { HarnessAdapter, HarnessResumeOpts } from "./types.ts";

/** spec → adapter：launchCommand 恒有；resumeCommand 仅在声明 resume-args 时生成 */
export function specToAdapter(spec: HarnessSpec): HarnessAdapter {
  return {
    id: spec.id,
    ...(spec.herdrKind ? { herdrKind: spec.herdrKind } : {}),
    binaries: spec.binaries,
    interactive: true,
    launchCommand: (opts) => assembleCommand(spec, opts),
    ...(spec.resumeArgs
      ? { resumeCommand: (opts: HarnessResumeOpts) => assembleCommand(spec, opts) }
      : {}),
  };
}

// ─── generic 工厂 ────────────────────────────────────────────────────────────
/**
 * 未在 spec 表登记的 harness（mcode/zcode/dsh/任意 PATH binary）：
 * 启动命令 = binary 名 + extraArgs。detection/submission 全靠文件契约，
 * 无 resume 能力（auto-close 对 generic peer 自动禁用）。
 */
export function genericAdapter(id: string): HarnessAdapter {
  return specToAdapter({ id, binaries: [id] });
}

/** 全部已知 adapter（spec 合并表生成：内置 + 用户覆盖/扩展），action:list 等用 */
export function knownAdapters(): HarnessAdapter[] {
  return [...mergedSpecs().values()].map(specToAdapter);
}
