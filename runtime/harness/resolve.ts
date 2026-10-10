// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * Harness 解析 — adapter 查找/探测 + 混合路由条目 → RouteCandidate 链
 *
 * 路由条目语法（tier routes / params / frontmatter 共用）：
 *   "claude/sonnet"   → harness=claude, model=sonnet
 *   "codex"           → harness=codex, model=undefined（继承 harness 默认）
 *   "pi/zai/GLM-5.2"  → harness=pi, model=zai/GLM-5.2（首个 / 前是 harness）
 *   "zai/GLM-5.2"     → 首段不是已知 harness/binary → pi/zai/GLM-5.2（旧配置兼容）
 *   "mcode"           → 不在 spec 表但 binary 在 PATH → generic harness mcode
 *
 * 判定顺序：spec 表 harness id（内置 harnesses.toml + 用户覆盖扩展）→
 * PATH binary（generic）→ 整体当 pi 模型名。
 */

import { execFileSync } from "node:child_process";
import type {
  AgentConfig,
  RouteCandidate,
  SubagentConfig,
} from "../../core/types.ts";
import { isModelAllowedNow, parseSchedule } from "../../core/schedule.ts";
import { genericAdapter, knownAdapters } from "./adapters.ts";
import type { HarnessAdapter } from "./types.ts";

// ─── Adapter 查找与探测 ──────────────────────────────────────────────────────

/**
 * spec 合并表（内置 context/harnesses.toml + 用户 ~/.config/pi/atelier/
 * harnesses.toml）生成的 adapter 索引。惰性：spec 文件读取有 getAgentDir
 * 副作用，不能在 import 时求值；一次加载后缓存（与 binaryCache 同假设）。
 */
function adapterIndexes(): {
  byId: Map<string, HarnessAdapter>;
  byKind: Map<string, HarnessAdapter>;
} {
  const adapters = knownAdapters();
  return {
    byId: new Map(adapters.map((a) => [a.id, a])),
    byKind: new Map(
      adapters.filter((a) => a.herdrKind).map((a) => [a.herdrKind!, a]),
    ),
  };
}

let indexCache: ReturnType<typeof adapterIndexes> | null = null;

function adapterIndex(): ReturnType<typeof adapterIndexes> {
  if (!indexCache) indexCache = adapterIndexes();
  return indexCache;
}

/** binary 探测缓存（一次扩展生命周期内 PATH 不变） */
const binaryCache = new Map<string, string | null>();

/** binary 是否在 PATH 中（返回解析路径或 null），结果缓存 */
export function findBinary(name: string): string | null {
  if (binaryCache.has(name)) return binaryCache.get(name)!;
  let found: string | null = null;
  try {
    found = execFileSync("which", [name], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() || null;
  } catch {
    found = null;
  }
  binaryCache.set(name, found);
  return found;
}

/**
 * 按 id 取 adapter：spec 表优先，否则若 binary 在 PATH 造 generic adapter，
 * 都没有返回 null。
 */
export function getAdapter(id: string): HarnessAdapter | null {
  const known = adapterIndex().byId.get(id);
  if (known) return findBinary(known.binaries[0]) ? known : null;
  return findBinary(id) ? genericAdapter(id) : null;
}

/** 只看 spec 表（不测 PATH）：用于 "x/y" 首段是否 harness 名的判定 */
export function isKnownHarnessId(id: string): boolean {
  return adapterIndex().byId.has(id);
}

/** adapter 是否可用（至少一个 binary 在 PATH） */
export function adapterAvailable(a: HarnessAdapter): boolean {
  return a.binaries.some((b) => findBinary(b) !== null);
}

/** 列出当前可用的全部 harness（action:list 用；含用户 spec 扩展项） */
export function listAvailableHarnesses(): HarnessAdapter[] {
  return knownAdapters().filter(adapterAvailable);
}

/** 按 herdr kind 名反查 adapter（herdr agent get 报的 agent 名 → 我们的 id） */
export function adapterByHerdrKind(kind: string): HarnessAdapter | null {
  return adapterIndex().byKind.get(kind) ?? null;
}

// ─── 路由条目解析 ─────────────────────────────────────────────────────────────

/**
 * 解析单条路由条目为 RouteCandidate。
 *
 * 规则：
 *  - 无 "/"：是 spec 表 harness 或 PATH binary → harness；否则视为裸模型名→pi
 *  - 有 "/"：首段是 spec 表 harness 或 PATH binary → harness/model 拆开；
 *            否则整串当 pi 模型名（如 "zai/GLM-5.2"）
 */
export function parseRouteEntry(entry: string): RouteCandidate {
  const trimmed = entry.trim();
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    if (isKnownHarnessId(trimmed) || findBinary(trimmed)) {
      return { harness: trimmed };
    }
    return { harness: "pi", model: trimmed };
  }
  const head = trimmed.slice(0, slash);
  const rest = trimmed.slice(slash + 1);
  if (isKnownHarnessId(head) || findBinary(head)) {
    return { harness: head, model: rest || undefined };
  }
  return { harness: "pi", model: trimmed };
}

// ─── 路由链解析（tier / frontmatter / 显式参数 → RouteCandidate[]）─────────────

/**
 * 按 modelSchedules 过滤候选。键依次试 "harness/model"、"model"、"harness"。
 * 命中的候选若当前时段禁用则剔除（warn 一次）。
 */
function filterBySchedule(
  candidates: RouteCandidate[],
  config: SubagentConfig,
): RouteCandidate[] {
  const schedules = config.modelSchedules;
  if (!schedules || Object.keys(schedules).length === 0) return candidates;
  const usable: RouteCandidate[] = [];
  for (const c of candidates) {
    const keys = [
      c.model ? `${c.harness}/${c.model}` : null,
      c.model ?? null,
      c.harness,
    ].filter((k): k is string => k !== null);
    let denied = false;
    for (const key of keys) {
      const cfg = schedules[key];
      if (!cfg) continue;
      const parsed = parseSchedule(cfg, key);
      if (parsed.mode !== "unrestricted" && !isModelAllowedNow(parsed)) {
        console.warn(
          `[atelier:schedule] ${key} 当前时段被禁用（mode=${parsed.mode}），跳过`,
        );
        denied = true;
        break;
      }
    }
    if (!denied) usable.push(c);
  }
  return usable;
}

/**
 * 解析 agent 的完整路由尝试链：[首选 harness/model, ...fallback]。
 *
 * 优先级（自上而下短路）：
 *   1. params.harness / params.model 显式覆盖（不过滤 schedule）
 *   2. agent frontmatter `harness:` pin → tier routes 中同 harness 的项；
 *      没有同 harness 项时 → {harness: pin, model: undefined}
 *   3. agent tier → config.tiers[tier].routes（或旧式 [model,...fallback]）
 *   4. 全部落空 → [{harness:"pi"}]（继承默认）
 *
 * 然后按可用性过滤：adapter binary 不在 PATH 的候选剔除（warn）。
 * schedule 过滤对 2/3 路径生效；显式覆盖不过滤。
 *
 * @returns RouteCandidate[]（非空；空表示连 pi 都不可用——极端情况）
 */
export function resolveRouteChain(
  agent: AgentConfig,
  config: SubagentConfig,
  explicit?: { harness?: string; model?: string },
): RouteCandidate[] {
  // 1. 显式覆盖
  if (explicit?.harness || explicit?.model) {
    return [
      {
        harness: explicit.harness ?? agent.harness ?? "pi",
        model: explicit.model,
      },
    ];
  }

  // tier routes（旧式 {model,fallback} 已在 config 层归一成 routes）
  const tier = agent.tier ?? config.defaultTier;
  const tierCfg = tier === "inherit" ? undefined : config.tiers[tier];
  const tierRoutes = tierCfg?.routes ?? [];

  // 2. harness pin
  if (agent.harness) {
    const sameHarness = tierRoutes
      .map(parseRouteEntry)
      .filter((c) => c.harness === agent.harness);
    const pinned: RouteCandidate[] =
      sameHarness.length > 0 ? sameHarness : [{ harness: agent.harness }];
    return filterBySchedule(pinned, config);
  }

  // 3. tier routes → 解析 + 可用性/schedule 过滤
  if (tier === "inherit") {
    // inherit = pi + 前台默认模型（与 readDefaultModelFromSettings 语义一致，
    // 但 peer 模式不传 model，让 pi TUI 自己用 defaultModel）
    return [{ harness: "pi" }];
  }
  const parsed = tierRoutes.map(parseRouteEntry);
  const available = parsed.filter((c) => {
    const ok = getAdapter(c.harness) !== null;
    if (!ok) {
      console.warn(
        `[atelier:route] harness "${c.harness}" 不可用（binary 不在 PATH），跳过`,
      );
    }
    return ok;
  });
  const usable = filterBySchedule(available, config);
  if (usable.length > 0) return usable;

  if (parsed.length > 0) {
    console.warn(
      `[atelier:route] tier=${tier} 全部路由不可用/被禁用，降级 pi`,
    );
  }

  // 4. 兜底
  return [{ harness: "pi" }];
}
