// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 运行监控 — peer 消息等待原语：
 *
 * waitForPeerMessage（PR-12 peer）：轮询 peer 目录 status.json
 *   （peer 按执行契约写）+ herdr agent_status + transcript 稳定性启发。
 *
 * 支持：超时检测、pane 存活检测、abort signal、blocked 宽容期、
 *       缺文件时 transcript 兜底提取、完成后读结果 + Return Header 解析。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  PeerInfo,
  RunResult,
  SubagentConfig,
} from "../core/types.ts";
import {
  getSubagentsDir,
  killPane,
  paneIsAlive,
  readStatus,
} from "./launcher.ts";
import { detectBackend } from "./multiplexer/detect.ts";
import {
  updateRunStatus,
  updateRunReturnStatus,
  updatePeerMeta,
  markPeerClosed,
} from "../registry/registry.ts";
import { parseReturnHeader } from "../registry/return-header.ts";

// ─── PR-12: peer 消息等待 ────────────────────────────────────────────────────
//
// 完成信号优先级：
//   1. status.json {msgSeq>=seq, status≠running} —— 文件契约（主通道）
//   2. herdr agent_status：观测到 working 后转 idle/done 连续 2 次
//   3. transcript 稳定性：pane 尾部哈希先变化（说明在干活）后连续 4 次不变
// 「判定停止但 result-N.md 未落盘」→ 先注入一句补写指令给 peer（空闲 +
// 上下文还在，一轮即可补救），继续轮询等文件契约命中；补救无效（再次
// 判定停止仍无文件）才降级 transcript 尾部兜底提取代写，保证总有产出。

/** peer 消息终态收集：读 result-N.md，缺则 transcript 兜底补写 */
function collectPeerResult(
  peer: PeerInfo,
  seq: number,
  backend: ReturnType<typeof detectBackend> | null,
): { output: string; extracted: boolean } {
  const resultPath = path.join(peer.peerDir, `result-${seq}.md`);
  try {
    return { output: fs.readFileSync(resultPath, "utf-8"), extracted: false };
  } catch {
    /* 走兜底 */
  }
  // 兜底：transcript 尾部。TUI chrome 混在里面是可接受的降级。
  const tail = backend?.readPane?.(peer.paneId, 200) ?? "(no output)";
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

/** 补写指令发出后给 peer 的处理窗口（超此仍无文件 → transcript 兜底） */
const REMEDIATE_GRACE_MS = 90_000;

/**
 * 等待 peer 的第 seq 条消息完成。
 *
 * 设计要点：
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
  // 补写补救状态：一次机会；发出后给 REMEDIATE_GRACE_MS 处理窗口
  let remediated = false;
  let remediatedAt = 0;

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

  /**
   * 「判定停止但 result 未落盘」的收尾：
   *   首次 → 注入一句补写指令（舵手消息，不动 seq/契约），继续轮询等
   *          文件契约信号命中。peer 处理指令会重新产生活动，启发状态
   *          （sawWorking/stablePolls）自然重置。
   *   窗口内 → 保持等待（防停止信号复触立刻兜底）。
   *   窗口后仍无文件 → 补救无效，transcript 兜底提取代写 + 收尾。
   * @returns true 已 resolve（调用方 clearInterval 后 return）
   */
  const settleIdle = (): boolean => {
    const resultPath = path.join(peer.peerDir, `result-${seq}.md`);
    if (!fs.existsSync(resultPath)) {
      if (!remediated) {
        remediated = true;
        remediatedAt = Date.now();
        try {
          backend?.sendText(
            peer.paneId,
            `检测到你已停止工作但未按契约落盘。请立即把本条任务的最终结果` +
              `（顶部含 Return Header）写入 ${resultPath}，并把 ${statusPath}` +
              ` 覆写为 {"status":"completed","msgSeq":${seq}}。除此之外不要做任何事。`,
          );
          console.warn(
            `[atelier:monitor] ${msgId} 判定停止但未落盘，已发补写指令`,
          );
        } catch {
          /* 发送失败：窗口过后走 transcript 兜底 */
        }
        return false;
      }
      if (Date.now() - remediatedAt < REMEDIATE_GRACE_MS) return false;
    }
    const { output, extracted } = collectPeerResult(peer, seq, backend);
    if (extracted) {
      console.warn(`[atelier:monitor] ${msgId} 补写无效，transcript 兜底`);
    }
    writePeerStatus(peer, seq, "completed", undefined, startedAt);
    resolve(finish("completed", output, 0));
    return true;
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
          const { output, extracted } = collectPeerResult(peer, seq, backend);
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
            if (settleIdle()) {
              clearInterval(interval);
              return;
            }
            idlePolls = 0; // 补写等待中，防停止信号复触立即兜底
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
          if (settleIdle()) {
            clearInterval(interval);
            return;
          }
          stablePolls = 0; // 补写等待中，防停止信号复触立即兜底
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
