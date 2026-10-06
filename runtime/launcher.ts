// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * Subagent 启动基础设施 — run 目录管理、prompt 准备、pane 存活查询
 *
 * peer 派发（peer.ts openPeer）直接起 harness TUI，不经任何 wrapper
 * 脚本；本模块只保留各路径共用的基础原语。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  StatusFile,
  SubagentConfig,
} from "../core/types.ts";
import {
  removeSubagentOnlyMarkers,
  resolveAgentFile,
} from "../core/context.ts";
import { formatReturnHeaderInstruction } from "../registry/return-header.ts";
import { detectBackend } from "./multiplexer/detect.ts";

// ─── XDG 路径 ────────────────────────────────────────────────────────────────

function resolveXdgCache(): string {
  return process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache");
}

/** 所有运行数据的根目录 */
export function getSubagentsDir(): string {
  return path.join(resolveXdgCache(), "pi", "subagents");
}

/** 单次运行的目录 */
export function getRunDir(runId: string): string {
  return path.join(getSubagentsDir(), runId);
}

// ─── 多路复用器封装 ──────────────────────────────────────────────────────────
//
// paneIsAlive/killPane 作为公共导出保留——monitor.ts 基于 status.json 文件
// 轮询（multiplexer 无关），通过这两个薄包装间接调后端，无需感知具体实现。

// ─── Run 目录管理 ────────────────────────────────────────────────────────────

/** 生成唯一 run ID */
export function generateRunId(): string {
  return `sa-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

/** 清理过期的运行记录（跳过存活 peer 目录——peer 是持久资产） */
export function cleanupOldRuns(config: SubagentConfig): void {
  if (config.keepResults <= 0) return;

  const subagentsDir = getSubagentsDir();
  if (!fs.existsSync(subagentsDir)) return;

  const runs = fs
    .readdirSync(subagentsDir)
    .map((name) => {
      const runDir = path.join(subagentsDir, name);
      const status = readStatus(runDir);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(runDir).mtimeMs;
      } catch {
        /* ignore */
      }
      return { name, runDir, status, mtimeMs };
    })
    .filter((run) => run.status?.status !== "running")
    // PR-12: peer.json alive=true 的目录是活 peer 的资产，永不清
    .filter((run) => {
      try {
        const peer = JSON.parse(
          fs.readFileSync(path.join(run.runDir, "peer.json"), "utf-8"),
        ) as { alive?: boolean };
        return peer.alive !== true;
      } catch {
        return true; // 无 peer.json → 普通 run 目录，照常清理
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const run of runs.slice(config.keepResults)) {
    try {
      fs.rmSync(run.runDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 检查 pane 是否仍存活（multiplexer 无关）。
 *
 * 公共导出：monitor.ts（pane 死亡检测）和 runner.ts（parallel batch 续接
 * 前检查 pane 存活）调用。内部委托 detectBackend()。
 */
export function paneIsAlive(paneId: string): boolean {
  return detectBackend().isAlive(paneId);
}

/**
 * 终止 pane（multiplexer 无关）。
 *
 * 公共导出：monitor.ts（abort/timeout 清理）调用。内部委托 detectBackend()。
 */
export function killPane(paneId: string): void {
  detectBackend().kill(paneId);
}

/**
 * 为 subagent 准备 prompt 文件（到 runDir/subagent-prompt.md）。
 *
 * 处理逻辑：
 *  1. 读 agent .md 全文
 *  2. 剥除 frontmatter（首个 --- 到第二个 --- 之间的内容）
 *  3. 去除 subagent-only HTML 注释标记（保留标记之间的内容）
 *  4. 写入 $runDir/subagent-prompt.md
 *
 * 如果 agent .md 不存在或读取失败，函数静默失败（返回 null）——调用方
 * 继续使用原 wrapper 逻辑（从 agent .md 直接读 prompt）。
 *
 * @returns 写入的文件路径，失败返回 null
 */
export function prepareAgentPrompt(
  agentName: string,
  runDir: string,
): string | null {
  // 走共享路径解析（插件内置 context/agents 优先，~/.config/pi/agents 兼容）
  const agentPath = resolveAgentFile(agentName);
  if (!agentPath) return null;

  let content: string;
  try {
    content = fs.readFileSync(agentPath, "utf-8");
  } catch {
    return null;
  }

  // 提取 body：跳到第二个 --- 之后的全部内容
  const lines = content.split("\n");
  let inFrontmatter = false;
  let frontmatterEnded = false;
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (!frontmatterEnded && line === "---") {
      if (!inFrontmatter) {
        inFrontmatter = true;
        continue;
      } else {
        inFrontmatter = false;
        frontmatterEnded = true;
        continue;
      }
    }
    if (frontmatterEnded) {
      bodyLines.push(line);
    }
  }

  const rawBody = removeSubagentOnlyMarkers(bodyLines.join("\n")).trim();
  if (!rawBody) return null;

  // 一次性追加：能力自检段 + Return Header 指令 + agent 自有 body。
  // Return Header 指令（PR-7）让子 agent 在 final message 顶部写出结构化字段。
  const body = `${CAPABILITY_SELF_CHECK}\n\n${RETURN_FORMAT_INSTRUCTION}\n\n${rawBody}`;

  const promptPath = path.join(runDir, "subagent-prompt.md");
  try {
    fs.writeFileSync(promptPath, body, "utf-8");
    return promptPath;
  } catch {
    return null;
  }
}

/**
 * 能力自检段——统一注入到所有 subagent 的 prompt 头部。
 *
 * 动机：很多模型原生支持多模态（minimax-cn/MiniMax-M3、xiaomi/mimo-v2.5），
 * 但部分模型（zai/GLM-5.1、deepseek-v4-flash、deepseek-v4-pro 等）没有视觉能力。
 * 不在 atelier 维护 modelCapabilities 表，而是让模型自检：发现自己无视觉时
 * 显式调用 visual subagent 处理图片。
 */
const CAPABILITY_SELF_CHECK = `## 能力自检（重要）

如果你发现自己**没有视觉能力**（无法直接理解图片附件）但收到了图片附件，**不要**试图猜测图片内容。请调用 visual subagent 处理图片：

\`\`\`
subagent({ agent: "visual", task: "分析以下图片：[描述图片情境]", images: [...] })
\`\`\`

支持视觉的模型：minimax-cn/MiniMax-M3、xiaomi/mimo-v2.5。`;

// PR-7：Return Header 指令——统一注入到所有 subagent 的 prompt 头部。
// 让子 agent 在 final message 顶部写出 "Status:"/Summary 等结构化字段，
// 方便父会话结构化解析而非靠 regex 猜。
//
// 由 prepareAgentPrompt() 在 CAPABILITY_SELF_CHECK 之后追加。
const RETURN_FORMAT_INSTRUCTION = formatReturnHeaderInstruction();

/** 读取 run 目录下的 status.json */
export function readStatus(runDir: string): StatusFile | null {
  const statusPath = path.join(runDir, "status.json");
  try {
    return JSON.parse(fs.readFileSync(statusPath, "utf-8"));
  } catch {
    return null;
  }
}
