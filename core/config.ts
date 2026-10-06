// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 配置加载 — 从独立 atelier.json 或 settings.json 的 atelier 字段加载运行时配置
 *
 * 查找顺序（先找到的赢，跳过剩余候选）：
 *   1. ~/.config/pi/atelier.json（独立配置文件，推荐）
 *   2. agent dir/settings.json 的 atelier 字段
 *   3. ~/.config/pi/settings.json 的 atelier 字段
 *
 * 独立文件优先：便于整体管理 atelier 配置（tier/schedule/timings 等），
 * 不与 pi 本身的 settings.json 混杂。两种路径解析出的对象结构一致，
 * 共用同一个 raw → SubagentConfig 的映射逻辑。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_CONFIG,
  type AgentModelConfig,
  type SubagentConfig,
} from "./types.ts";

/**
 * 按优先级查找并解析 atelier 配置对象。
 *
 * 候选顺序：
 *   - `atelier.json` 独立文件：整个 JSON 即配置对象（无 atelier 包裹层）
 *   - `settings.json`：取 `atelier` 子字段（向后兼容）
 *
 * 返回第一个解析成功的候选；全部失败返回 undefined。
 */
function findRawConfig(): Record<string, unknown> | undefined {
  for (const [cfgPath, kind] of configCandidates()) {
    const parsed = readJsonObject(cfgPath);
    if (!parsed) continue;
    const raw = kind === "standalone" ? parsed : parsed.atelier;
    if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  }
  return undefined;
}

/** 独立配置文件路径：候选之首，也是全部候选落空时的默认写入目标 */
function standaloneConfigPath(): string {
  return path.join(os.homedir(), ".config", "pi", "atelier.json");
}

/**
 * 候选 [path, kind]：kind=standalone 整文件即配置；kind=nested 取 .atelier 子字段。
 *
 * 做成函数而非模块级常量：getAgentDir() 读运行时 env，模块级求值会把这个副作用
 * 提前到 import 时（且一旦抛错会拖垮整个扩展加载）。
 */
function configCandidates(): Array<[string, "standalone" | "nested"]> {
  return [
    [standaloneConfigPath(), "standalone"],
    [path.join(getAgentDir(), "settings.json"), "nested"],
    [path.join(os.homedir(), ".config", "pi", "settings.json"), "nested"],
  ];
}

/** 读 JSON：文件存在 + 解析成功 + 顶层是对象才返回，其余情形一律 undefined */
function readJsonObject(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function loadConfig(): SubagentConfig {
  const raw = findRawConfig();
  if (!raw) return DEFAULT_CONFIG;
  return {
    pollIntervalMs:
      typeof raw.pollIntervalMs === "number"
        ? raw.pollIntervalMs
        : DEFAULT_CONFIG.pollIntervalMs,
    panePrefix:
      typeof raw.panePrefix === "string"
        ? raw.panePrefix
        : DEFAULT_CONFIG.panePrefix,
    keepResults:
      typeof raw.keepResults === "number"
        ? raw.keepResults
        : DEFAULT_CONFIG.keepResults,
    timeoutMs:
      typeof raw.timeoutMs === "number"
        ? raw.timeoutMs
        : DEFAULT_CONFIG.timeoutMs,
    maxTasks:
      typeof raw.maxTasks === "number" ? raw.maxTasks : DEFAULT_CONFIG.maxTasks,
    maxConcurrency:
      typeof raw.maxConcurrency === "number"
        ? raw.maxConcurrency
        : DEFAULT_CONFIG.maxConcurrency,
    defaultTier:
      typeof raw.defaultTier === "string"
        ? raw.defaultTier
        : DEFAULT_CONFIG.defaultTier,
    tiers: parseTiers(raw.tiers),
    modelSchedules: parseModelSchedules(raw.modelSchedules),
    peerApproval:
      raw.peerApproval === "full" ||
      raw.peerApproval === "safe" ||
      raw.peerApproval === "off"
        ? raw.peerApproval
        : DEFAULT_CONFIG.peerApproval,
    blockedGraceMs:
      typeof raw.blockedGraceMs === "number"
        ? raw.blockedGraceMs
        : DEFAULT_CONFIG.blockedGraceMs,
    peerReadyTimeoutMs:
      typeof raw.peerReadyTimeoutMs === "number"
        ? raw.peerReadyTimeoutMs
        : DEFAULT_CONFIG.peerReadyTimeoutMs,
    maxPeers:
      typeof raw.maxPeers === "number"
        ? raw.maxPeers
        : DEFAULT_CONFIG.maxPeers,
    harnessArgs: parseHarnessArgs(raw.harnessArgs),
  };
}

/** 从 atelier.harnessArgs 段解析 per-harness 追加参数 */
function parseHarnessArgs(raw: unknown): Record<string, string[]> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, string[]> = {};
  for (const [harness, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      const args = value.filter((x): x is string => typeof x === "string");
      if (args.length > 0) result[harness] = args;
    } else if (typeof value === "string" && value.trim()) {
      result[harness] = value.trim().split(/\s+/);
    }
  }
  return result;
}

/**
 * 解析「配置该写到哪」——与 findRawConfig 共用候选顺序，避免写了一份、读的是另一份。
 *
 * standalone 候选文件存在即认（整文件就是配置）；nested 候选必须真的解析出 .atelier
 * 对象才认（settings.json 里没有 atelier 段时，它不是 atelier 配置的宿主）。
 * 全部落空 → 默认新建独立文件。
 */
export function resolveConfigTarget(): {
  path: string;
  kind: "standalone" | "nested";
} {
  for (const [cfgPath, kind] of configCandidates()) {
    if (!existsSync(cfgPath)) continue;
    if (kind === "standalone") return { path: cfgPath, kind };
    const nested = readJsonObject(cfgPath)?.atelier;
    if (nested && typeof nested === "object") return { path: cfgPath, kind };
  }
  return { path: standaloneConfigPath(), kind: "standalone" };
}

/**
 * 写回配置，返回实际写入的路径。
 *
 * 两种目标形态都走「读旧 → 浅合并 → 整写」：旧文件里 atelier 不认识的字段
 * （手写的注释字段、未来版本新增字段）不会因为一次保存被抹掉。
 */
export function saveConfig(cfg: SubagentConfig): string {
  const target = resolveConfigTarget();
  let next: Record<string, unknown>;
  if (target.kind === "standalone") {
    next = { ...readJsonObject(target.path), ...cfg };
  } else {
    const settings = readJsonObject(target.path) ?? {};
    const old = settings.atelier;
    next = {
      ...settings,
      atelier: { ...(old && typeof old === "object" ? old : {}), ...cfg },
    };
  }
  try {
    mkdirSync(path.dirname(target.path), { recursive: true });
    writeFileSync(target.path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  } catch (err) {
    throw new Error(
      `写入 atelier 配置失败 (${target.path}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return target.path;
}

/**
 * 从 settings.json 的 atelier.tiers 段解析 tier 配置。
 *
 * PR-12: 每个 tier 支持三种形态，统一归一到 routes（harness/model 混合路由）：
 *   - string:                    "claude/sonnet"          → routes=[该串]
 *   - string[]:                  ["claude/sonnet","pi/…"]  → routes=数组
 *   - {model, fallback, routes}: routes 优先；否则 [model,...fallback]
 * 旧式 {model, fallback[]} 完全兼容（裸模型名解析时默认 pi harness）。
 */
function parseTiers(raw: unknown): Record<string, AgentModelConfig> {
  if (!raw || typeof raw !== "object") return DEFAULT_CONFIG.tiers;
  const result: Record<string, AgentModelConfig> = {};
  const asRoutes = (v: unknown): string[] | undefined => {
    if (typeof v === "string" && v.trim()) return [v.trim()];
    if (Array.isArray(v)) {
      const arr = v.filter(
        (x): x is string => typeof x === "string" && x.trim().length > 0,
      );
      if (arr.length > 0) return arr.map((s) => s.trim());
    }
    return undefined;
  };
  for (const [name, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      const routes = asRoutes(value);
      if (routes) result[name] = { model: "", fallback: [], routes };
      continue;
    }
    const v = value as Record<string, unknown>;
    const routes =
      asRoutes(v.routes) ??
      asRoutes([v.model, ...(Array.isArray(v.fallback) ? v.fallback : [])]);
    if (!routes) continue;
    result[name] = {
      model: typeof v.model === "string" ? v.model : "",
      fallback: Array.isArray(v.fallback)
        ? v.fallback.filter((f): f is string => typeof f === "string")
        : [],
      routes,
    };
  }
  return result;
}

/**
 * 从 atelier.modelSchedules 段解析 per-model 时段限制。
 *
 * 形状：`{ "zai/GLM-5.2": { deny: ["Mon-Fri 14:00-18:00"] } }`。
 * 非对象/缺字段 → 空对象（无限制）。条目语法错误由 schedule.ts 的
 * parseSchedule 在运行时兜底（warn + unrestricted），此处只做结构过滤。
 */
function parseModelSchedules(
  raw: unknown,
): Record<string, { allow?: string[]; deny?: string[] }> {
  if (!raw || typeof raw !== "object") return {};
  const result: Record<string, { allow?: string[]; deny?: string[] }> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const v = value as { allow?: unknown; deny?: unknown };
    const allow = Array.isArray(v.allow)
      ? v.allow.filter((x): x is string => typeof x === "string")
      : undefined;
    const deny = Array.isArray(v.deny)
      ? v.deny.filter((x): x is string => typeof x === "string")
      : undefined;
    if (allow || deny) result[model] = { allow, deny };
  }
  return result;
}
