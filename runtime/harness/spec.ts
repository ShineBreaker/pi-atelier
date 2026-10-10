// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * Harness Spec — 各 CLI harness 功能入口的声明式定义（TOML）
 *
 * 数据源（按优先级合并，同名 harness 用户字段逐项覆盖内置）：
 *   1. ~/.config/pi/atelier/harnesses.toml（用户覆盖/扩展）
 *   2. 插件内置 context/harnesses.toml（随 atelier 分发的默认适配——
 *      插件做了适配即开箱可用，用户无需自己抄配置）
 *
 * spec 是纯数据：launch/resume 命令由 assembleCommand 统一组装，
 * adapters.ts 的 specToAdapter 把 spec 编译成 HarnessAdapter。
 *
 * TOML 解析用 pi 宿主（Bun）内置的 `bun:sqlite` 同源 `TOML` 模块，零新依赖。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TOML } from "bun";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getPluginRoot } from "../../core/context.ts";
import type { HarnessLaunchOpts } from "./types.ts";

/** 单个 harness 的功能入口声明（harnesses.toml 的 [harness.<id>] 表） */
export interface HarnessSpec {
  /** 规范 id（tier routes / frontmatter `harness:` / params.harness 的取值） */
  id: string;
  /** PATH 探测候选（command -v 按序试，首个命中即用）【必填】 */
  binaries: string[];
  /** herdr agent kind 名（herdr agent/integration 子命令取值；agent_status 检测资格） */
  herdrKind?: string;
  /** 启动子命令（拼在 binary 之后，如 hermes 的 "chat"） */
  subcommand?: string;
  /** 模型参数组；含 "{model}" 占位符，model 缺省时整组省略 */
  modelArgs?: string[];
  /** peerApproval=full 时的自治 flag 组 */
  approvalFull?: string[];
  /** peerApproval=safe 时的保守自动接受 flag 组 */
  approvalSafe?: string[];
  /**
   * 会话恢复参数组；含 "{sessionId}" 占位符（自含子命令，如 codex 的
   * "resume"、hermes 的 "chat --resume"）。缺省 = 不支持 resume，
   * auto-close 对该 harness 自动禁用。
   */
  resumeArgs?: string[];
}

// ─── 组装器 ─────────────────────────────────────────────────────────────────

/** shell 单引号转义（占位符注入值统一走这里；字面量 flag 原样输出） */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** assembleCommand 的输入（launch 与 resume 共用；sessionId 有值即 resume 模式） */
export type AssembleOpts = HarnessLaunchOpts & { sessionId?: string };

const PLACEHOLDER = /\{(model|sessionId)\}/g;

/**
 * 参数组渲染：token 内占位符替换为 shell 转义值；组内用了某占位符而对应值
 * 缺省 → 整组省略（如 model 未指定时 ["--model","{model}"] 不产生孤立的
 * "--model"）。组本身 undefined → 省略。显式空组 → 空组（用户 spec 用
 * `approval-full = []` 清除内置默认的途径）。
 */
function renderGroup(
  group: string[] | undefined,
  vars: { model?: string; sessionId?: string },
): string[] | undefined {
  if (!group) return undefined;
  const usesModel = group.some((t) => t.includes("{model}"));
  const usesSession = group.some((t) => t.includes("{sessionId}"));
  if ((usesModel && vars.model === undefined) || (usesSession && vars.sessionId === undefined)) {
    return undefined;
  }
  return group.map((t) =>
    t.replace(PLACEHOLDER, (_m, key: string) =>
      shellQuote(vars[key === "model" ? "model" : "sessionId"]!),
    ),
  );
}

/**
 * spec → 单条 shell 命令文本（pane run / send-keys 送进 peer pane 的 shell）。
 *
 *   launch：env + binary + [subcommand] + [model-args] + approval + extra
 *   resume：env + binary + [resume-args] + [model-args] + approval + extra
 */
export function assembleCommand(spec: HarnessSpec, opts: AssembleOpts): string {
  const vars = { model: opts.model, sessionId: opts.sessionId };
  const resume = opts.sessionId !== undefined;
  // resume 模式的 head 是 resume-args（自含子命令）；launch 模式是 subcommand
  const head = resume ? spec.resumeArgs : spec.subcommand ? [spec.subcommand] : [];
  const approval =
    opts.approval === "full"
      ? spec.approvalFull
      : opts.approval === "safe"
        ? spec.approvalSafe
        : undefined;

  const parts = [
    ...(renderGroup(head, vars) ?? []),
    ...(renderGroup(spec.modelArgs, vars) ?? []),
    ...(renderGroup(approval, vars) ?? []),
    ...(opts.extraArgs ?? []),
  ];

  const envPrefix = opts.env
    ? Object.entries(opts.env)
        .map(([k, v]) => `${k}=${shellQuote(v)}`)
        .join(" ") + " "
    : "";
  return envPrefix + [spec.binaries[0], ...parts].join(" ");
}

// ─── spec 文件解析与合并 ─────────────────────────────────────────────────────

/** 用户 spec 文件路径：~/.config/pi/atelier/harnesses.toml */
export function userSpecPath(): string {
  return path.join(getAgentDir(), "atelier", "harnesses.toml");
}

/**
 * 字段级规范化和校验。binaries 允许为空（用户条目可从内置同名字段继承，
 * 必填性由 parseSpecsFile/mergedSpecs 分层校验）；其余字段缺省时返回
 * undefined（合并时继承内置同名字段）。
 *
 * 数组字段的覆盖语义：缺省/非数组 → 继承内置；显式数组（含空数组）→
 * 覆盖（空数组 = 清除内置默认值，如 `approval-safe = []`）。
 * 唯一例外是 binaries：空数组 = 继承（空 binaries 无意义）。
 */
function normalizeSpec(id: string, value: unknown): HarnessSpec | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const x = v[key];
    return typeof x === "string" && x.length > 0 ? x : undefined;
  };
  const arr = (key: string): string[] | undefined => {
    const x = v[key];
    if (!Array.isArray(x)) return undefined;
    return x.filter((s): s is string => typeof s === "string" && s.length > 0);
  };
  const binaries = Array.isArray(v.binaries)
    ? (v.binaries as unknown[]).filter(
        (s): s is string => typeof s === "string" && s.length > 0,
      )
    : [];
  return {
    id,
    binaries,
    herdrKind: str("herdr-kind"),
    subcommand: str("subcommand"),
    modelArgs: arr("model-args"),
    approvalFull: arr("approval-full"),
    approvalSafe: arr("approval-safe"),
    resumeArgs: arr("resume-args"),
  };
}

/**
 * 解析单个 spec 文件为 id → HarnessSpec 表；文件不存在/解析失败返回空表。
 *
 * @param requireBinaries 内置表必填 binaries；用户表允许缺省（同名条目
 *                        从内置继承，全新条目则必须自带，否则在合并层丢弃）
 */
function parseSpecsFile(
  filePath: string,
  source: string,
  requireBinaries: boolean,
): Map<string, HarnessSpec> {
  const out = new Map<string, HarnessSpec>();
  if (!fs.existsSync(filePath)) return out;
  let raw: Record<string, unknown>;
  try {
    raw = TOML.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  } catch (err) {
    console.warn(
      `[atelier:harness] ${source} spec 解析失败（忽略该文件）: ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return out;
  }
  const harnesses = raw.harness;
  if (!harnesses || typeof harnesses !== "object") return out;
  for (const [id, value] of Object.entries(harnesses as Record<string, unknown>)) {
    const spec = normalizeSpec(id, value);
    if (!spec) continue;
    if (requireBinaries && spec.binaries.length === 0) {
      console.warn(`[atelier:harness] spec "${id}" 缺少合法 binaries（非空字符串数组），忽略`);
      continue;
    }
    out.set(id, spec);
  }
  return out;
}

/** 用户条目只保留显式设置的字段（undefined 字段不覆盖内置同名值） */
function shallowMerge(builtin: HarnessSpec, user: HarnessSpec): HarnessSpec {
  const out = { ...builtin };
  for (const [k, v] of Object.entries(user)) {
    if (v === undefined) continue;
    if (k === "binaries" && v.length === 0) continue; // 空 binaries = 继承
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

let mergedCache: Map<string, HarnessSpec> | null = null;

/**
 * 内置 + 用户 spec 合并表（id → HarnessSpec）。惰性加载一次缓存——
 * 扩展生命周期内 spec 文件不重读（与 binaryCache 的 PATH 假设一致）；
 * 用户改 spec 后重启 pi 生效。
 */
export function mergedSpecs(): Map<string, HarnessSpec> {
  if (mergedCache) return mergedCache;
  const merged = parseSpecsFile(
    path.join(getPluginRoot(), "context", "harnesses.toml"),
    "内置",
    true,
  );
  for (const [id, user] of parseSpecsFile(userSpecPath(), "用户", false)) {
    const builtin = merged.get(id);
    const combined = builtin ? shallowMerge(builtin, user) : user;
    if (combined.binaries.length === 0) {
      console.warn(
        `[atelier:harness] 用户 spec "${id}" 无 binaries（非覆盖内置且未自带），忽略`,
      );
      continue;
    }
    merged.set(id, combined);
  }
  mergedCache = merged;
  return merged;
}
