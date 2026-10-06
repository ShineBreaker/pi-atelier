// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 执行编排 — 三种运行模式的顶层协调逻辑
 *
 * - runParallelBatches: 并行执行（含并发限制和分批）
 * - runChain: 串行链式执行（{previous} 替换）
 * - executeWithFallback: 带 fallback 模型重试的单 agent 执行
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  AgentConfig,
  AgentModelConfig,
  PeerInfo,
  RunResult,
  SubagentConfig,
} from "../core/types.ts";
import {
  parseSchedule,
  isModelAllowedNow,
} from "../core/schedule.ts";
import {
  generateRunId,
  paneIsAlive,
} from "./launcher.ts";
import { waitForPeerMessage } from "./monitor.ts";
import {
  closePeer,
  openPeer,
  sendToPeer,
} from "./peer.ts";
import {
  getAdapter,
  resolveRouteChain,
} from "./harness/resolve.ts";
import { ensureWorkfile } from "./workfile.ts";
import { isSystemAgent } from "../core/system-agents.ts";
import {
  createCheckpoint,
  markCheckpointFailed,
  markStepCompleted,
  writeCheckpoint,
} from "../lifecycle/checkpoint.ts";
import { generateWorkflowId, persistWorkflow } from "../lifecycle/workflow.ts";

/**
 * 从 settings.json 读 defaultProvider + defaultModel，组合成完整 model ID。
 *
 * 用途：tier=inherit 的"跟随前台"实际解析。
 * 原实现是返回 []（不传 --model），导致 wrapper.sh 启动日志显示
 * "model: default"，与子进程实际推理用的 defaultModel 不一致。
 * 改为显式拼出 [provider/model]，让 wrapper 日志如实显示当前正在用的模型。
 *
 * @returns ["provider/model"] 成功；[] 解析失败兜底（保持原行为）
 */
export function readDefaultModelFromSettings(): string[] {
  // 复用 config.ts 的查找策略：agent dir → ~/.config/pi/
  const candidates = [
    path.join(getAgentDir(), "settings.json"),
    path.join(os.homedir(), ".config", "pi", "settings.json"),
  ];
  for (const p of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<
        string,
        unknown
      >;
      const provider = raw.defaultProvider;
      const model = raw.defaultModel;
      if (
        typeof provider === "string" &&
        typeof model === "string" &&
        provider &&
        model
      ) {
        return [`${provider}/${model}`];
      }
    } catch {
      // 试下一个候选路径
      continue;
    }
  }
  return [];
}

// ─── Fallback 重试 ───────────────────────────────────────────────────────────

/** 同一任务最大重试次数（含首次尝试） */
const MAX_ATTEMPTS = 3;

/**
 * 解析 agent 的完整模型尝试链：[首选, ...fallback]，并按时段过滤
 *
 * 新优先级（自上而下短路）：
 *   1. 调用方显式覆盖（params.model）— 不过滤（用户显式指定，视为 override）
 *   2. agent frontmatter `tier: inherit` → 从 settings.json 读 defaultProvider/defaultModel 组成 ["provider/model"]，让 wrapper 日志如实显示当前模型
 *   3. agent frontmatter `tier: <name>` → 查 config.tiers[<name>]
 *   4. agent frontmatter 无 tier → 用 config.defaultTier
 *   5. 全部解析失败 → []（= inherit 行为，兜底跟随前台）
 *
 * 时段过滤（仅对 3/4 路径生效）：config.modelSchedules 按模型名声明
 * 可用时段。链中每个模型各自查 modelSchedules[modelName]：落在禁用窗口
 * 的模型被跳过，每跳过一个 console.warn 一次；全链被禁用 → 降级到
 * readDefaultModelFromSettings() 并 warn（保证总有模型可用）。
 *
 * @returns model 列表（可空），空数组表示"不传 --model"
 */
export function resolveModelChain(
  agent: AgentConfig,
  config: SubagentConfig,
  explicitModel?: string,
): string[] {
  // 1. 显式覆盖（不过滤——用户显式指定视为 override，包括时段限制）
  if (explicitModel) return [explicitModel];

  // 2-4. tier 解析
  const tier = agent.tier ?? config.defaultTier;

  // inherit 特殊值：从 settings.json 解析出 [provider/model]，既让 wrapper 启动日志如实显示，也保证 model 链路非空（避免 fallback 重试时跳过 inherit）
  if (tier === "inherit") return readDefaultModelFromSettings();

  // 查 tiers 配置
  const tierCfg: AgentModelConfig | undefined = config.tiers[tier];
  if (!tierCfg) return []; // 未知 tier → 回退 []（让 subagent-wrapper 用自己的 defaultModel）

  const fullChain = [tierCfg.model, ...tierCfg.fallback].filter(Boolean);

  // 无 modelSchedules → 不过滤
  const schedules = config.modelSchedules;
  if (!schedules || Object.keys(schedules).length === 0) return fullChain;

  // 按模型查 per-model schedule，逐个过滤。每跳过一个禁用模型 warn 一次。
  const usable: string[] = [];
  for (const model of fullChain) {
    const scheduleCfg = schedules[model];
    if (!scheduleCfg) {
      usable.push(model); // 该模型无 schedule → 不受限
      continue;
    }
    const parsed = parseSchedule(scheduleCfg, model);
    if (parsed.mode === "unrestricted" || isModelAllowedNow(parsed)) {
      usable.push(model);
    } else {
      console.warn(
        `[atelier:schedule] ${model} 当前时段被禁用（mode=${parsed.mode}），跳过`,
      );
    }
  }

  // 全链被禁用 → 降级 defaultModel，保证总有模型可用
  if (usable.length === 0) {
    console.warn(
      `[atelier:schedule] tier=${tier} 所有模型当前时段均被禁用，降级到 settings.json defaultModel`,
    );
    return readDefaultModelFromSettings();
  }

  return usable;
}

/**
 * PR-12: peer 化派发 — 解析路由链，逐个 harness 开 peer 尝试。
 *
 * 对同一任务按路由链尝试不同的 (harness, model)（最多 MAX_ATTEMPTS 次）：
 *   1. 开 peer（splitShell + 起 TUI）→ send 第一条消息 → wait 收结果
 *   2. 失败 → closePeer 退役该 pane，用链中下一个路由重试
 *   3. 全部失败 → 返回最后一个失败结果
 *
 * 对 abort/timeout/blocked 不重试（不是路由问题；且 timeout/blocked 的
 * peer 仍存活，主 agent 可 send 救活）。
 */
export async function executeWithFallback(
  agent: AgentConfig,
  task: string,
  config: SubagentConfig,
  cwd: string,
  explicitModel: string | undefined,
  signal: AbortSignal | undefined,
  topRowTargetPaneId?: string,
  splitPercent?: number,
  images?: string[],
  // PR-9: 系统子 agent 透传。默认由 isSystemAgent(agent.name) 推断。
  isSystemSpawned?: boolean,
  // PR-10: chain/parallel 内的 parent run id(由 runChain/runParallelBatches 生成)
  parentRunId?: string,
  // PR-12: 显式 harness 覆盖（params.harness）
  explicitHarness?: string,
): Promise<RunResult> {
  const resolvedSystem = isSystemSpawned ?? isSystemAgent(agent.name);
  const routes = resolveRouteChain(
    agent,
    config,
    explicitHarness || explicitModel
      ? { harness: explicitHarness, model: explicitModel }
      : undefined,
  );

  let lastResult: RunResult | undefined;
  let lastError: string | undefined;
  const maxAttempts = Math.min(MAX_ATTEMPTS, routes.length);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const route = routes[attempt];
    const adapter = getAdapter(route.harness);
    if (!adapter || !adapter.interactive) {
      lastError = `harness "${route.harness}" 不可用`;
      console.warn(`[atelier:route] ${lastError}，跳过`);
      continue;
    }

    let peer;
    try {
      peer = await openPeer({
        agent,
        route,
        adapter,
        config,
        cwd,
        rightOfPaneId: topRowTargetPaneId,
        splitRatio: (splitPercent ?? 50) / 100,
        isSystemSpawned: resolvedSystem,
        parentRunId,
      });
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(
        `[atelier:peer] openPeer(${route.harness}) 失败:`,
        lastError,
      );
      continue;
    }

    const sent = sendToPeer(peer, task, { images, parentRunId });
    const result = await waitForPeerMessage(peer, sent.seq, config, signal);

    if (result.status === "completed") return result;

    lastResult = result;
    // abort/timeout/blocked 不重试——不是路由问题；timeout/blocked 时
    // peer 仍存活，留给主 agent 用 send 救活
    if (
      result.error === "Aborted" ||
      result.error === "timeout" ||
      result.error === "blocked"
    ) {
      return result;
    }
    // 普通失败：退役该 peer，尝试链中下一个路由
    closePeer(peer);
  }

  return (
    lastResult ?? {
      runId: "(none)",
      agent: agent.name,
      status: "failed",
      exitCode: 1,
      output: `没有可用的 harness（所有路由均失败）。最后错误: ${lastError ?? "unknown"}`,
      durationMs: 0,
      tmuxPane: "",
      error: lastError ?? "no harness available",
    }
  );
}

// ─── 并行执行 ────────────────────────────────────────────────────────────────

/**
 * 并行执行多批任务，每批不超过 maxConcurrency。
 *
 * PR-12 peer 化：每个任务开一个 peer（第一个垂直分割开新行，后续在行内
 * 右侧水平分割），send 后 waitForPeerMessage 收结果。peer 完成后存活
 * （可 send 复用），不自动关 pane。
 *
 * 布局效果（以 3 个任务为例，herdr 下新行在下方）：
 *   ┌───────────────────────────────┐
 *   │  主 agent                      │
 *   ├──────────┬──────────┬──────────┤
 *   │  peer1   │  peer2   │  peer3   │   ← 新行，水平等分
 *   └──────────┴──────────┴──────────┘
 */
export async function runParallelBatches(
  tasks: Array<{ agent: AgentConfig; task: string; cwd?: string }>,
  config: SubagentConfig,
  cwd: string,
  explicitModel?: string,
  signal?: AbortSignal,
  // PR-12: 显式 harness 覆盖（作用于全部任务）
  explicitHarness?: string,
  // PR-12: 异步派发时由调用方预生成 parentRunId（wait:false 的句柄）
  parentRunIdIn?: string,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  const concurrency = Math.max(
    1,
    Math.min(config.maxConcurrency, config.maxTasks),
  );
  const startedAt = Date.now();
  const parentRunId = parentRunIdIn ?? generateRunId();
  let rowAnchorPaneId: string | undefined;

  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    if (rowAnchorPaneId && !paneIsAlive(rowAnchorPaneId)) {
      rowAnchorPaneId = undefined;
    }

    const pending: Array<{ peer: PeerInfo; seq: number }> = [];

    for (const t of batch) {
      // parallel 模式逐任务解析路由链，取首个可用候选
      // （per-task fallback 重试由主 agent 看结果后自行决定，不在此处展开）
      const routes = resolveRouteChain(
        t.agent,
        config,
        explicitHarness || explicitModel
          ? { harness: explicitHarness, model: explicitModel }
          : undefined,
      );
      const route = routes.find((r) => {
        const a = getAdapter(r.harness);
        return a !== null && a.interactive;
      });
      if (!route) {
        results.push({
          runId: "(none)",
          agent: t.agent.name,
          status: "failed",
          exitCode: 1,
          output: "没有可用 harness",
          durationMs: 0,
          tmuxPane: "",
          error: "no harness available",
        });
        continue;
      }
      try {
        const adapter = getAdapter(route.harness)!;
        const peer = await openPeer({
          agent: t.agent,
          route,
          adapter,
          config,
          cwd: t.cwd ?? cwd,
          rightOfPaneId: rowAnchorPaneId,
          splitRatio: rowAnchorPaneId ? 0.5 : 0.4,
          parentRunId,
        });
        rowAnchorPaneId = peer.paneId;
        const sent = sendToPeer(peer, t.task, {
          parentRunId,
          mode: "parallel",
        });
        pending.push({ peer, seq: sent.seq });
      } catch (err) {
        results.push({
          runId: "(none)",
          agent: t.agent.name,
          status: "failed",
          exitCode: 1,
          output: `peer 启动失败: ${(err as Error).message}`,
          durationMs: 0,
          tmuxPane: "",
          error: (err as Error).message,
        });
      }
    }

    const batchResults = await Promise.all(
      pending.map((p) => waitForPeerMessage(p.peer, p.seq, config, signal)),
    );
    results.push(...batchResults);
  }

  // 验证 workfile（agent 未自行写入时兜底持久化）
  for (const r of results) {
    if (r.status === "completed") {
      ensureWorkfile(r, cwd, startedAt);
    }
  }

  return results;
}

// ─── 串行链式执行 ────────────────────────────────────────────────────────────

/**
 * 串行执行任务链。
 *
 * 每步的 task 中的 {previous} 被替换为上一步的输出，
 * {task} 被替换为根任务。每步使用 executeWithFallback 自动处理 fallback。
 *
 * 布局效果（以 3 步链为例）：
 *   ┌──────────┬──────────┬──────────┐
 *   │  step1   │  step2   │  step3   │   ← 上方行，逐步水平扩展
 *   ├──────────┴──────────┴──────────┤
 *   │  主 agent                       │
 *   └────────────────────────────────┘
 *
 * 注意：chain 的每一步依次启动，上一步完成后下一步才开始。
 * topRowTargetPaneId 确保所有步骤共享上方行。
 */
export async function runChain(
  steps: Array<{ agent: AgentConfig; task: string; cwd?: string }>,
  config: SubagentConfig,
  cwd: string,
  rootTask?: string,
  explicitModel?: string,
  signal?: AbortSignal,
  // PR-12: 显式 harness 覆盖
  explicitHarness?: string,
  // PR-12: 异步派发时由调用方预生成 parentRunId（wait:false 的句柄）
  parentRunIdIn?: string,
): Promise<RunResult[]> {
  const results: RunResult[] = [];
  let previous = rootTask ?? "";
  let rowAnchorPaneId: string | undefined;
  /** PR-12: 上一步的 peer——同 agent+同 harness 时复用（上下文零损耗） */
  let prevPeer: PeerInfo | null = null;
  const startedAt = Date.now();

  // PR-10: 为整个 chain 生成一个 parentRunId；所有 step 的 registerRun 关联到此 id。
  // 同时创建 checkpoint（5 节格式 YAML）与 Workflow（PR-11 JSON）并持久化。
  // PR-12: 异步派发时调用方预生成（wait:false 返回给主 agent 的句柄）。
  const parentRunId = parentRunIdIn ?? generateRunId();
  const intent = (rootTask ?? steps[0]?.task ?? "").slice(0, 200);

  let checkpoint: ReturnType<typeof createCheckpoint> | null = null;
  let workflow: import("./workflow.ts").Workflow | null = null;
  try {
    checkpoint = createCheckpoint(
      parentRunId,
      "chain",
      steps.map((s, idx) => ({
        id: `step-${idx + 1}`,
        agent: s.agent.name,
        task: s.task,
      })),
      intent,
    );
    writeCheckpoint(checkpoint, cwd);
  } catch (err) {
    console.warn(
      `[atelier:runner] chain ${parentRunId} createCheckpoint failed:`,
      err,
    );
    checkpoint = null;
  }
  try {
    workflow = {
      id: generateWorkflowId(),
      name: `chain-${parentRunId}`,
      mode: "chain",
      steps: steps.map((s, idx) => ({
        id: `step-${idx + 1}`,
        agent: s.agent.name,
        task: s.task,
        dependsOn: idx === 0 ? [] : [`step-${idx}`],
        status: "pending",
      })),
      context: { task: rootTask ?? "" },
      parentRunId,
    };
    persistWorkflow(workflow, cwd);
  } catch (err) {
    console.warn(
      `[atelier:runner] chain ${parentRunId} workflow persist failed:`,
      err,
    );
    workflow = null;
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const task = step.task
      .replaceAll("{previous}", previous)
      .replaceAll("{task}", rootTask ?? previous);

    // PR-12: peer 化 dispatch —— 同 agent+同 harness 且存活时复用上一步
    // peer（peer 保有全部上下文，{previous} 替换只作冗余保险）；否则开新
    // peer 并在行内右接前 pane。
    const routes = resolveRouteChain(
      step.agent,
      config,
      explicitHarness || explicitModel
        ? { harness: explicitHarness, model: explicitModel }
        : undefined,
    );
    const route = routes.find((r) => {
      const a = getAdapter(r.harness);
      return a !== null && a.interactive;
    });

    let result: RunResult;
    let stepPeer: PeerInfo | null = null;
    const reusable =
      route &&
      prevPeer &&
      prevPeer.alive &&
      paneIsAlive(prevPeer.paneId) &&
      prevPeer.agent === step.agent.name &&
      prevPeer.harness === route.harness;

    if (reusable && prevPeer) {
      stepPeer = prevPeer;
      const sent = sendToPeer(prevPeer, task, {
        parentRunId,
        mode: "chain",
      });
      result = await waitForPeerMessage(prevPeer, sent.seq, config, signal);
    } else if (route) {
      try {
        const adapter = getAdapter(route.harness)!;
        const peer = await openPeer({
          agent: step.agent,
          route,
          adapter,
          config,
          cwd: step.cwd ?? cwd,
          rightOfPaneId: rowAnchorPaneId,
          splitRatio: rowAnchorPaneId ? 0.5 : 0.4,
          parentRunId,
        });
        stepPeer = peer;
        rowAnchorPaneId = peer.paneId;
        const sent = sendToPeer(peer, task, {
          parentRunId,
          mode: "chain",
        });
        result = await waitForPeerMessage(peer, sent.seq, config, signal);
      } catch (err) {
        result = {
          runId: "(none)",
          agent: step.agent.name,
          status: "failed",
          exitCode: 1,
          output: `peer 启动失败: ${(err as Error).message}`,
          durationMs: 0,
          tmuxPane: "",
          error: (err as Error).message,
        };
      }
    } else {
      result = {
        runId: "(none)",
        agent: step.agent.name,
        status: "failed",
        exitCode: 1,
        output: "没有可用 harness",
        durationMs: 0,
        tmuxPane: "",
        error: "no harness available",
      };
    }
    prevPeer = stepPeer && stepPeer.alive ? stepPeer : null;

    // 验证 workfile
    if (result.status === "completed") {
      ensureWorkfile(result, cwd, startedAt);
    }

    // PR-10: 每完成一步写 checkpoint（写盘 + 更新 workflow 状态 + persist）
    if (checkpoint) {
      try {
        checkpoint = markStepCompleted(checkpoint, i, {
          runId: result.runId,
          workfilePath: result.workfilePath,
          outputPreview: result.output.slice(0, 500),
          inheritedContextForNext: previous.slice(0, 2000),
        });
        writeCheckpoint(checkpoint, cwd);
      } catch (err) {
        console.warn(
          `[atelier:runner] chain ${parentRunId} step ${i + 1} markStepCompleted failed:`,
          err,
        );
      }
    }
    if (workflow) {
      try {
        workflow.steps[i].status =
          result.status === "completed" ? "completed" : "failed";
        persistWorkflow(workflow, cwd);
      } catch (err) {
        console.warn(
          `[atelier:runner] chain ${parentRunId} workflow step ${i + 1} persist failed:`,
          err,
        );
      }
    }

    // 将 workfile 路径注入到下一步的上下文中
    let outputWithContext = result.output;
    if (result.workfilePath) {
      outputWithContext += `\n\n---\n上一步工作产物已持久化到: ${result.workfilePath}`;
    }

    results.push(result);
    previous = outputWithContext;
    if (result.status === "failed") {
      if (checkpoint) {
        try {
          checkpoint = markCheckpointFailed(
            checkpoint,
            i,
            result.error ?? "failed",
          );
          writeCheckpoint(checkpoint, cwd);
        } catch (err) {
          console.warn(
            `[atelier:runner] chain ${parentRunId} markCheckpointFailed failed:`,
            err,
          );
        }
      }
      break;
    }
  }

  return results;
}
