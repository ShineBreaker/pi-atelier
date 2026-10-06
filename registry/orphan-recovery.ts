// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * Orphan Recovery — 对 unsettled 记录按 session 归属收尾。
 *
 * 触发时机：pi session 首次就绪（before_agent_start 提取到 session id 后
 * 执行一次，见 index.ts）——「进入了相同的会话之后，扫描该会话的记录」。
 *
 * 判定依据：**harness 程序本身是否仍存活**（pane 探测 + 原生 session
 * 比对），而非时间启发：
 *   - 非当前 session 的记录 → 跳过（等它的会话回来收尾）
 *   - peer.json alive=false 或 pane 已死 → 孤儿：peer 标死 + 落终态
 *   - pane 活但原生 session 与记录不符 → pane id 被复用，同孤儿
 *   - pane 活且 harness 已 idle/done 但 status.json 卡 running
 *     → peer 干完没落盘：atelier 代写终态收尾（不判孤儿）
 *   - pane 活且 working/blocked/无法判定 → 保留（文件契约会收尾）
 *   - 无 peer.json 的历史 run（batch 时代遗物）→ 无 pane 可查，直接孤儿
 *
 * 探针由 index.ts 注入（当前 mux 后端的 isAlive/agentStatus/agentSession），
 * registry 层不依赖 runtime；无探针（不在 mux 内）时保守放行。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { listUnsettled, updateRunStatus, markPeerClosed } from "./registry.ts";
import { piSession } from "../core/session.ts";
import type { PeerInfo } from "../core/types.ts";

/** mux 探针（index.ts 从当前后端注入） */
export interface OrphanProbes {
  paneAlive(paneId: string): boolean;
  agentStatus(paneId: string): string | null;
  agentSession(paneId: string): string | null;
}

/** orphan 标记的错误描述（写进 status.json / atelier_runs.error 列） */
const ORPHAN_ERROR = "orphaned: harness gone before completion";

export interface OrphanRecoveryReport {
  scanned: number;
  /** 孤儿收尾（pane 死 / id 复用 / peer 已关 / 无主遗物） */
  recovered: number;
  /** pane 活 + harness 已停 → 代写终态收尾 */
  settled: number;
  /** 其他 session 的记录，留给它的会话 */
  skippedForeignSession: number;
  /** pane 活着（working/blocked/无法判定） */
  skippedAlive: number;
  /** 无探针，保守放行 */
  skippedNoProbe: number;
}

function readPeerJson(runDir: string): PeerInfo | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(runDir, "peer.json"), "utf-8"),
    ) as PeerInfo;
  } catch {
    return null;
  }
}

/** 把 run 落终态：写 status.json（SoT）+ 同步 registry */
function settleRun(
  run: { runId: string; runDir: string; msgSeq: number | null },
  status: "completed" | "failed",
  msgSeq: number | undefined,
  error?: string,
  now: number,
): void {
  try {
    fs.writeFileSync(
      path.join(run.runDir, "status.json"),
      JSON.stringify({
        status,
        msgSeq,
        finishedAt: now,
        ...(error ? { error } : {}),
      }),
      "utf-8",
    );
  } catch {
    /* 目录可能已被清理——registry 仍要收尾 */
  }
  updateRunStatus({
    runId: run.runId,
    status: status === "completed" ? "completed" : "orphan",
    exitCode: status === "completed" ? 0 : 1,
    error,
    finishedAt: now,
  });
}

/** peer 标死落盘（peer.json + registry 视图） */
function markPeerDead(peer: PeerInfo): void {
  peer.alive = false;
  try {
    fs.writeFileSync(
      path.join(peer.peerDir, "peer.json"),
      JSON.stringify(peer),
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
  markPeerClosed(peer.peerId);
}

/**
 * 对当前 session 名下的 unsettled 记录收尾。
 *
 * 应在 `rebuildFromStatusFiles()` 之后、session id 就绪后调用（一次）。
 */
export function orphanRecovery(
  now: number = Date.now(),
  probes?: OrphanProbes,
): OrphanRecoveryReport {
  const unsettled = listUnsettled();
  const report: OrphanRecoveryReport = {
    scanned: unsettled.length,
    recovered: 0,
    settled: 0,
    skippedForeignSession: 0,
    skippedAlive: 0,
    skippedNoProbe: 0,
  };

  for (const run of unsettled) {
    const peer = run.peerId ? readPeerJson(run.runDir) : null;

    if (run.peerId) {
      if (peer) {
        // 归属判定：其他 session 的记录不归本次扫描管
        if (
          peer.sessionId &&
          piSession.id &&
          peer.sessionId !== piSession.id
        ) {
          report.skippedForeignSession++;
          continue;
        }

        if (peer.alive === false) {
          settleRun(run, "failed", peer.msgSeq, ORPHAN_ERROR, now);
          report.recovered++;
          continue;
        }

        if (!probes) {
          report.skippedNoProbe++;
          continue;
        }

        if (!probes.paneAlive(peer.paneId)) {
          markPeerDead(peer);
          settleRun(run, "failed", peer.msgSeq, ORPHAN_ERROR, now);
          report.recovered++;
          continue;
        }

        // pane 活：ID 复用检测（herdr workspace 重启后 w1:p1 可能指向新 pane）
        const curSession = probes.agentSession(peer.paneId);
        if (
          peer.nativeSessionId &&
          curSession &&
          curSession !== peer.nativeSessionId
        ) {
          markPeerDead(peer);
          settleRun(
            run,
            "failed",
            peer.msgSeq,
            "orphaned: pane id reused by new session",
            now,
          );
          report.recovered++;
          continue;
        }

        const agentStatus = probes.agentStatus(peer.paneId);
        if (agentStatus === "idle" || agentStatus === "done") {
          // harness 已停但没落盘（主会话崩了没人等它）→ 代写终态收尾
          settleRun(run, "completed", peer.msgSeq, undefined, now);
          report.settled++;
          continue;
        }

        // working/blocked/unknown/null：仍在跑或无法判定，留给文件契约
        report.skippedAlive++;
        continue;
      }

      // 有 peerId 但 peer.json 丢失（目录被清理）→ 无主，收尾
      settleRun(run, "failed", run.msgSeq ?? undefined, ORPHAN_ERROR, now);
      report.recovered++;
      continue;
    }

    // 无 peerId：batch 时代遗物，无 pane 可查 → 直接孤儿
    settleRun(run, "failed", run.msgSeq ?? undefined, ORPHAN_ERROR, now);
    report.recovered++;
  }

  return report;
}
