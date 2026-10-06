// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 运行监控 — 两种等待原语：
 *
 * waitForCompletion（batch 遗留）：轮询 run 目录 status.json（wrapper 写）。
 * waitForPeerMessage（PR-12 peer）：轮询 peer 目录 status.json
 *   （peer 按执行契约写）+ herdr agent_status + transcript 稳定性启发。
 *
 * 支持：超时检测、pane 存活检测、abort signal、blocked 宽容期、
 *       缺文件时 transcript 兜底提取、完成后读结果 + Return Header 解析。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  LaunchResult,
  PeerInfo,
  RunResult,
  SubagentConfig,
} from "../core/types.ts";
import {
  getSubagentsDir,
  killPane,
  paneIsAlive,
  readResult,
  readStatus,
  writeFailedStatus,
} from "./launcher.ts";
import { detectBackend } from "./multiplexer/detect.ts";
import {
  updateRunStatus,
  updateRunReturnStatus,
  updatePeerMeta,
  markPeerClosed,
  incrementReentryCount,
} from "../registry/registry.ts";
import { parseReturnHeader } from "../registry/return-header.ts";
import { decide as completionGateDecide } from "../registry/completion-gate.ts";

/**
 * 轮询等待单个 subagent 完成。
 *
 * 检测机制（按 pollIntervalMs 间隔）：
 * 1. abort signal → 终止 pane，返回失败
 * 2. 超时 → 终止 pane，返回失败
 * 3. status.json 不再是 "running" → 读取 result.md，返回结果
 * 4. pane 不再存活 → 读取 stderr 日志，返回失败
 */
export async function waitForCompletion(
  launch: LaunchResult,
  config: SubagentConfig,
  signal?: AbortSignal,
): Promise<RunResult> {
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    const interval = setInterval(() => {
      const agent = launch.paneTitle.replace(config.panePrefix, "");

      // 统一的失败处理：清理 interval、写状态、resolve
      const finishFailed = (
        exitCode: number,
        output: string,
        error?: string,
      ) => {
        clearInterval(interval);
        writeFailedStatus(launch.runDir, exitCode, error ?? output, startedAt);
        // 同步终态到全局 registry（SQLite）
        updateRunStatus({
          runId: launch.runId,
          status: "failed",
          exitCode,
          error: error ?? output,
        });
        resolve({
          runId: launch.runId,
          agent,
          status: "failed",
          exitCode,
          output,
          durationMs: Date.now() - startedAt,
          tmuxPane: launch.paneTitle,
          error,
        });
      };

      // 检查 abort
      if (signal?.aborted) {
        killPane(launch.paneId);
        finishFailed(-1, "Aborted", "Aborted");
        return;
      }

      // 检查超时
      if (Date.now() - startedAt > config.timeoutMs) {
        killPane(launch.paneId);
        finishFailed(124, `Timed out after ${config.timeoutMs}ms`, "timeout");
        return;
      }

      // PR-7: 检查 status.json 终态
      const status = readStatus(launch.runDir);
      if (status && status.status !== "running") {
        clearInterval(interval);
        const output = readResult(launch.runDir);
        // wrapper 写的终态（completed / failed）同步到全局 registry
        updateRunStatus({
          runId: launch.runId,
          status: status.status === "completed" ? "completed" : "failed",
          exitCode: status.exitCode ?? 1,
          error: status.error,
        });
        // PR-7: 解析 result.md 的 Return Header，写入 registry return_status
        try {
          const parsed = parseReturnHeader(output);
          if (parsed) {
            updateRunReturnStatus({
              runId: launch.runId,
              returnStatus: parsed.status,
              returnSummary: parsed.summary,
            });
          } else {
            // 缺 header: 标 unknown（不阻塞 subagent，仅警告）
            updateRunReturnStatus({
              runId: launch.runId,
              returnStatus: "unknown",
              returnSummary: "(no return header)",
            });
            console.warn(
              `[atelier:monitor] run ${launch.runId} (${agent}) result.md 缺 Return Header，标 return_status=unknown`,
            );
          }
        } catch (headerErr) {
          console.warn(
            `[atelier:monitor] parseReturnHeader failed for ${launch.runId}:`,
            headerErr,
          );
        }

        // PR-8: completion gate（no-op: isTaskToolAvailable=false → 恒 false）
        // 当前阶段 isTaskToolAvailable() 返回 false，gate 不触发 reentry。
        // 架构保留便于未来接入 pi 的 task 工具。
        try {
          const gate = completionGateDecide(launch.runId, agent, 0);
          if (gate.needReentry) {
            incrementReentryCount(launch.runId);
            console.warn(
              `[atelier:monitor] completion gate requested reentry for ${launch.runId} — 架构保留中，当前 no-op`,
            );
          }
          if (gate.downgradedTo) {
            console.warn(
              `[atelier:monitor] gate downgraded ${launch.runId} → ${gate.downgradedTo}`,
            );
          }
        } catch (gateErr) {
          console.warn(
            `[atelier:monitor] completionGate failed for ${launch.runId}:`,
            gateErr,
          );
        }

        resolve({
          runId: launch.runId,
          agent,
          status: status.status,
          exitCode: status.exitCode ?? 1,
          output,
          durationMs:
            (status.finishedAt ?? Date.now()) - (status.startedAt ?? startedAt),
          tmuxPane: launch.paneTitle,
          error: status.error,
        });
        return;
      }

      // 检查 pane 存活
      if (!paneIsAlive(launch.paneId)) {
        const stderrPath = path.join(launch.runDir, "stderr.log");
        let stderr = "";
        try {
          stderr = fs.readFileSync(stderrPath, "utf-8").trim();
        } catch {
          /* ignore */
        }
        finishFailed(
          127,
          stderr || "tmux pane exited before writing final status",
          stderr || undefined,
        );
      }
    }, config.pollIntervalMs);
  });
}

/** 等待多个 subagent 全部完成 */
export function waitForAll(
  launches: LaunchResult[],
  config: SubagentConfig,
  signal?: AbortSignal,
): Promise<RunResult[]> {
  return Promise.all(launches.map((l) => waitForCompletion(l, config, signal)));
}

// ─── PR-12: peer 消息等待 ────────────────────────────────────────────────────
//
// 完成信号优先级：
//   1. status.json {msgSeq>=seq, status≠running} —— 文件契约（主通道）
//   2. herdr agent_status：观测到 working 后转 idle/done 连续 2 次
//   3. transcript 稳定性：pane 尾部哈希先变化（说明在干活）后连续 4 次不变
// 缺 result-N.md 时用 transcript 尾部兜底提取并补写，保证总有产出。

/** peer 消息终态收集：读 result-N.md，缺则 transcript 兜底补写 */
function collectPeerResult(
  peer: PeerInfo,
  seq: number,
): { output: string; extracted: boolean } {
  const resultPath = path.join(peer.peerDir, `result-${seq}.md`);
  try {
    return { output: fs.readFileSync(resultPath, "utf-8"), extracted: false };
  } catch {
    /* 走兜底 */
  }
  // 兜底：transcript 尾部。TUI chrome 混在里面是可接受的降级。
  const tail =
    detectBackend().readPane?.(peer.paneId, 200) ?? "(no output)";
  const output =
    tail.trim() ||
    "(peer 未写 result 文件，transcript 尾部为空)";
  try {
    fs.writeFileSync(resultPath, output, "utf-8");
  } catch {
    /* best-effort */
  }
  return { output, extracted: true };
}

/** 写 peer 侧 status.json 终态（兜底路径下 atelier 代写） */
function writePeerStatus(
  peer: PeerInfo,
  seq: number,
  status: "completed" | "failed" | "blocked",
  error?: string,
  startedAt?: number,
): void {
  try {
    fs.writeFileSync(
      path.join(peer.peerDir, "status.json"),
      JSON.stringify({
        status,
        msgSeq: seq,
        startedAt,
        finishedAt: Date.now(),
        ...(error ? { error } : {}),
      }),
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
}

/**
 * 等待 peer 的第 seq 条消息完成。
 *
 * 与 batch waitForCompletion 的差异：
 *   - 超时/失败 **不杀 pane**（peer 是持久资产，后续可能仍写出文件或
 *     被 send 救活）；只有显式 abort 才杀 pane。
 *   - herdr blocked 状态走 blockedGraceMs 宽容期，超时返回带「用 send 解堵」
 *     提示的失败结果。
 *
 * registry：本条消息对应 runId = `<peerId>-m<seq>`。
 */
export async function waitForPeerMessage(
  peer: PeerInfo,
  seq: number,
  config: SubagentConfig,
  signal?: AbortSignal,
): Promise<RunResult> {
  const startedAt = Date.now();
  const msgId = `${peer.peerId}-m${seq}`;
  const statusPath = path.join(peer.peerDir, "status.json");
  let backend: ReturnType<typeof detectBackend> | null = null;
  try {
    backend = detectBackend();
  } catch {
    /* 无 mux 环境：纯文件契约等待（agent_status/transcript 信号退化） */
  }

  // transcript 稳定性启发状态
  const submitSig = backend?.readPane?.(peer.paneId, 60) ?? "";
  let lastSig = submitSig;
  let sawActivity = false;
  let stablePolls = 0;
  // agent_status 启发状态
  let sawWorking = false;
  let idlePolls = 0;
  let blockedSince: number | null = null;

  const finish = (
    status: "completed" | "failed",
    output: string,
    exitCode: number,
    error?: string,
  ): RunResult => {
    peer.lastStatus = status === "completed" ? "idle" : status;
    updatePeerMeta(peer.peerId, { lastStatus: peer.lastStatus });
    updateRunStatus({ runId: msgId, status, exitCode, error });
    if (status === "completed" || status === "failed") {
      try {
        const parsed = parseReturnHeader(output);
        updateRunReturnStatus({
          runId: msgId,
          returnStatus: parsed ? parsed.status : "unknown",
          returnSummary: parsed ? parsed.summary : "(no return header)",
        });
      } catch {
        /* header 解析失败不阻塞 */
      }
    }
    return {
      runId: msgId,
      peerId: peer.peerId,
      harness: peer.harness,
      agent: peer.agent,
      status,
      exitCode,
      output,
      durationMs: Date.now() - startedAt,
      tmuxPane: peer.paneId,
      error,
    };
  };

  return new Promise<RunResult>((resolve) => {
    const interval = setInterval(() => {
      // 1. abort → 杀 pane（显式终止语义）
      if (signal?.aborted) {
        clearInterval(interval);
        killPane(peer.paneId);
        peer.alive = false;
        markPeerClosed(peer.peerId);
        resolve(finish("failed", "Aborted", -1, "Aborted"));
        return;
      }

      // 2. 文件契约：peer 写了终态 status.json（msgSeq 对齐防止读到上轮的）
      try {
        const st = JSON.parse(fs.readFileSync(statusPath, "utf-8")) as {
          status?: string;
          msgSeq?: number;
          error?: string;
        };
        if (
          (st.msgSeq ?? 0) >= seq &&
          st.status &&
          st.status !== "running"
        ) {
          clearInterval(interval);
          const { output, extracted } = collectPeerResult(peer, seq);
          if (extracted) {
            console.warn(
              `[atelier:monitor] ${msgId} peer 未写 result-${seq}.md，已用 transcript 兜底`,
            );
          }
          const ok = st.status === "completed";
          resolve(
            finish(
              ok ? "completed" : "failed",
              output,
              ok ? 0 : 1,
              st.error,
            ),
          );
          return;
        }
      } catch {
        /* status.json 不存在/解析失败 → 继续等其他信号 */
      }

      // 3. pane 存活
      if (!paneIsAlive(peer.paneId)) {
        clearInterval(interval);
        peer.alive = false;
        markPeerClosed(peer.peerId);
        resolve(
          finish(
            "failed",
            "peer pane exited before writing status.json",
            127,
            "pane exited",
          ),
        );
        return;
      }

      // 4. 超时（不杀 pane——peer 是持久资产）
      if (Date.now() - startedAt > config.timeoutMs) {
        clearInterval(interval);
        resolve(
          finish(
            "failed",
            `Timed out after ${config.timeoutMs}ms（peer pane 仍存活，可用 send 追问或 read 查看）`,
            124,
            "timeout",
          ),
        );
        return;
      }

      // 5. herdr agent_status 语义信号
      const agentStatus = backend?.agentStatus?.(peer.paneId) ?? null;
      if (agentStatus === "working") {
        sawWorking = true;
        idlePolls = 0;
        blockedSince = null;
      } else if (agentStatus === "blocked") {
        blockedSince ??= Date.now();
        if (Date.now() - blockedSince > config.blockedGraceMs) {
          clearInterval(interval);
          writePeerStatus(peer, seq, "blocked", "permission/input gate", startedAt);
          resolve(
            finish(
              "failed",
              "peer 被权限门/输入门卡住超过 blockedGraceMs。" +
                `用 subagent({action:"send", id:"${peer.peerId}", task:"<应答>"}) 解堵。`,
              2,
              "blocked",
            ),
          );
          return;
        }
      } else if (agentStatus === "idle" || agentStatus === "done") {
        blockedSince = null;
        if (sawWorking) {
          idlePolls += 1;
          if (idlePolls >= 2) {
            clearInterval(interval);
            const { output } = collectPeerResult(peer, seq);
            writePeerStatus(peer, seq, "completed", undefined, startedAt);
            resolve(finish("completed", output, 0));
            return;
          }
        }
      }

      // 6. transcript 稳定性启发（tmux / agent_status=unknown 的兜底检测）
      const curSig = backend?.readPane?.(peer.paneId, 60) ?? "";
      if (curSig !== lastSig) {
        sawActivity = true;
        stablePolls = 0;
        lastSig = curSig;
      } else if (sawActivity) {
        stablePolls += 1;
        if (stablePolls >= 4 && !sawWorking) {
          clearInterval(interval);
          const { output } = collectPeerResult(peer, seq);
          writePeerStatus(peer, seq, "completed", undefined, startedAt);
          resolve(finish("completed", output, 0));
          return;
        }
      }
    }, config.pollIntervalMs);
  });
}
/**
 * 列出所有正在运行的 subagent（从 cache 目录扫描 status.json）
 *
 * PR-9: 默认隐藏系统子 agent。传 `{ includeSystem: true }` 可看全部。
 */
export function listRunning(
  opts: { includeSystem?: boolean } = {},
): RunResult[] {
  const includeSystem = opts.includeSystem ?? false;
  const subagentsDir = getSubagentsDir();
  if (!fs.existsSync(subagentsDir)) return [];

  const results: RunResult[] = [];
  for (const entry of fs.readdirSync(subagentsDir)) {
    const runDir = path.join(subagentsDir, entry);
    const status = readStatus(runDir);
    if (!status || status.status !== "running") continue;

    let task = "";
    try {
      task = fs.readFileSync(path.join(runDir, "task.md"), "utf-8");
    } catch {
      /* ignore */
    }

    // PR-9: 默认隐藏系统子 agent（runId 以 sys- 开头）
    if (!includeSystem && entry.startsWith("sys-")) continue;

    results.push({
      runId: entry,
      agent: "(unknown)",
      status: "running",
      exitCode: -1,
      output: task.slice(0, 200),
      durationMs: Date.now() - (status.startedAt ?? Date.now()),
      tmuxPane: "",
    });
  }
  return results;
}
