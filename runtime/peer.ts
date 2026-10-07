// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * PeerEngine — 持久 peer 的生命周期与消息原语
 *
 * peer = pane + 活的 harness TUI 会话 + 角色 + 累积上下文。
 * 生命周期与 task 解耦：open 一次，send 多次（追问/纠偏/解堵），close 退役。
 *
 * 文件契约（peerDir = $XDG_CACHE_HOME/pi/subagents/<peerId>/）：
 *   peer.json        — atelier 写的生命周期元数据（唯一权威）
 *   brief-N.md       — 第 N 条消息的完整指令（persona 只在 N=1 注入）
 *   result-N.md      — peer 写的第 N 条结果（Return Header 顶部）
 *   status.json      — 共享终态信号：atelier 派单写 {running,msgSeq:N}；
 *                      peer 完成后覆写 {completed|failed,msgSeq:N,...}
 *
 * 发送语义（sendToPeer）：
 *   peer 空闲 → 新任务：msgSeq++、写 brief-N、重置 status.json、发提交消息
 *   peer 忙   → 舵手：只把文本送进 TUI 输入（各 harness 排队行为不同，
 *              但一律不主动打断——打断需显式操作，将来按需引入）
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentConfig,
  PeerInfo,
  RouteCandidate,
  SubagentConfig,
} from "../core/types.ts";
import {
  cleanupOldRuns,
  getSubagentsDir,
  prepareAgentPrompt,
} from "./launcher.ts";
import { detectBackend } from "./multiplexer/detect.ts";
import type { MultiplexerBackend } from "./multiplexer/types.ts";
import type { HarnessAdapter } from "./harness/types.ts";
import { piSession } from "../core/session.ts";
import {
  registerPeer,
  updatePeerMeta,
  markPeerClosed,
  registerRun,
} from "../registry/registry.ts";
import { isSystemAgent } from "../core/system-agents.ts";

// ─── peer.json 读写 ─────────────────────────────────────────────────────────

function peerJsonPath(peerDir: string): string {
  return path.join(peerDir, "peer.json");
}

function writePeerJson(peer: PeerInfo): void {
  try {
    fs.writeFileSync(
      peerJsonPath(peer.peerDir),
      JSON.stringify(peer, null, 2),
      "utf-8",
    );
  } catch {
    /* best-effort */
  }
}

/** 从磁盘读 peer.json（跨进程恢复用）；失败返回 null */
export function readPeerJson(peerDir: string): PeerInfo | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(peerJsonPath(peerDir), "utf-8"),
    ) as PeerInfo;
    return raw && raw.peerId ? raw : null;
  } catch {
    return null;
  }
}

// ─── 内存 peer 表（会话内快查，磁盘 peer.json 是真相）──────────────────────────

const peers = new Map<string, PeerInfo>();

/** detectBackend 无 mux 时抛错——包一层，拿不到 backend 就无法校验存活 */
function tryBackend(): MultiplexerBackend | null {
  try {
    return detectBackend();
  } catch {
    return null;
  }
}

/** 取 peer：内存优先，miss 时从磁盘恢复并校验存活 */
export function getPeer(peerId: string): PeerInfo | null {
  const backend = tryBackend();
  const mem = peers.get(peerId);
  if (mem) {
    if (mem.alive && backend && !backend.isAlive(mem.paneId)) {
      mem.alive = false;
      writePeerJson(mem);
    }
    return mem.alive ? mem : null;
  }
  const disk = readPeerJson(path.join(getSubagentsDir(), peerId));
  if (!disk || !disk.alive) return null;
  if (backend && !backend.isAlive(disk.paneId)) {
    disk.alive = false;
    writePeerJson(disk);
    return null;
  }
  peers.set(peerId, disk);
  return disk;
}

/**
 * 列出存活 peer（磁盘全量扫描 + pane 存活校验）。
 * action:"peers" / reuse 查找用。
 */
export function listPeers(): PeerInfo[] {
  const dir = getSubagentsDir();
  if (!fs.existsSync(dir)) return [];
  const backend = tryBackend();
  const out: PeerInfo[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const peerDir = path.join(dir, entry);
    const peer = peers.get(entry) ?? readPeerJson(peerDir);
    if (!peer || !peer.alive) continue;
    if (backend && !backend.isAlive(peer.paneId)) {
      peer.alive = false;
      writePeerJson(peer);
      peers.set(entry, peer);
      continue;
    }
    peers.set(entry, peer);
    out.push(peer);
  }
  return out;
}

/**
 * 找可复用 peer：存活 + 空闲（无进行中消息）+ 角色/harness 匹配。
 * agent 指定时优先同角色；否则同 harness。返回最新创建者。
 */
export function findReusablePeer(opts: {
  agent?: string;
  harness?: string;
}): PeerInfo | null {
  const candidates = listPeers()
    .filter((p) => !peerBusy(p))
    .filter((p) => {
      if (opts.agent && p.agent === opts.agent) return true;
      if (!opts.agent && opts.harness && p.harness === opts.harness)
        return true;
      return false;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0] ?? null;
}

/** peer 是否有未完成消息（status.json.msgSeq == peer.msgSeq 且非终态） */
export function peerBusy(peer: PeerInfo): boolean {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(peer.peerDir, "status.json"), "utf-8"),
    ) as { status?: string; msgSeq?: number };
    return raw.msgSeq === peer.msgSeq && raw.status === "running";
  } catch {
    return false;
  }
}

// ─── brief / 契约文本 ─────────────────────────────────────────────────────────

/**
 * atelier peer 执行契约——追加在每条 brief 末尾的指令块。
 * 契约由文件承载（文件契约是通用完成信号，与 mux 检测解耦）。
 */
function contractBlock(peer: PeerInfo, seq: number): string {
  const statusPath = path.join(peer.peerDir, "status.json");
  const resultPath = path.join(peer.peerDir, `result-${seq}.md`);
  return [
    "",
    "---",
    "",
    "## atelier 执行契约（必须遵守）",
    "",
    `这是 atelier 编排层下发的第 ${seq} 号任务。完成后：`,
    "",
    `1. 把本次任务的最终报告写入 \`${resultPath}\`，顶部必须是 Return Header：`,
    "",
    "   ```",
    "   **Status**: success | partial | failed | blocked",
    "   **Summary**: <一句话结果>",
    "",
    "   <实际交付内容>",
    "",
    "   **Files touched**: <逗号分隔路径或 (none)>",
    "   **Findings worth promoting**: <要点或 (none)>",
    "   ```",
    "",
    `2. 覆写 \`${statusPath}\`（写文件工具或 shell 均可）：`,
    "",
    `   \`{"status":"completed","msgSeq":${seq},"finishedAt":<unix毫秒>}\``,
    `   失败写 \`"status":"failed"\` + \`"error":"<原因>"\`，`,
    `   被卡住写 \`"status":"blocked"\`（权限/依赖/需要决策）。`,
    "",
    "3. **不要退出或关闭当前会话**——之后可能还会收到新指令（追问/纠偏）。",
    "4. 两个文件都写完才算交付；父会话按 status.json 判定完成。",
  ].join("\n");
}

/**
 * 构造 brief-N.md 内容。
 * seq=1 注入 agent persona（methodology body）；后续消息只带任务+契约
 * （peer 上下文里已有 persona）。
 */
export function buildBrief(
  peer: PeerInfo,
  seq: number,
  task: string,
  images?: string[],
): string {
  const parts: string[] = [];
  if (seq === 1 && peer.agent && peer.agent !== peer.harness) {
    const persona = readPersona(peer.agent, peer.peerDir);
    if (persona) parts.push(persona, "");
  }
  parts.push(`# 任务（msg ${seq}）`, "", task, "");
  if (images && images.length > 0) {
    parts.push(
      "## 附件（图片文件路径，直接读取分析）",
      "",
      ...images.map((p) => `- ${p}`),
      "",
    );
  }
  parts.push(contractBlock(peer, seq));
  return parts.join("\n");
}

/**
 * 读 agent persona：复用 launcher.prepareAgentPrompt 的产物（含
 * CAPABILITY_SELF_CHECK + Return Header 指令 + agent body）再读回。
 * Return Header 指令与契约段各出现一次——重复注入无害（模型更稳地
 * 遵守），能力自检是设计决策（所有 subagent 无条件获得）。
 */
function readPersona(agentName: string, runDir: string): string | null {
  const promptPath = prepareAgentPrompt(agentName, runDir);
  if (!promptPath) return null;
  try {
    return fs.readFileSync(promptPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

/** 送进 TUI 的提交消息（devin 会话实测格式：指向 brief 文件的一句话指令） */
function submissionText(peer: PeerInfo, seq: number, task: string): string {
  const briefPath = path.join(peer.peerDir, `brief-${seq}.md`);
  const hint = task.replace(/\s+/g, " ").slice(0, 80);
  return (
    `读取并严格执行 ${briefPath} —— ${hint}` +
    `。完成后按文末「atelier 执行契约」写回文件。开始。`
  );
}

// ─── 生命周期 ────────────────────────────────────────────────────────────────

export interface OpenPeerOpts {
  agent: AgentConfig;
  route: RouteCandidate;
  adapter: HarnessAdapter;
  config: SubagentConfig;
  cwd: string;
  /** 同页布局：在已有 peer 右侧分割（与 newTab 互斥，anchor 优先） */
  rightOfPaneId?: string;
  splitRatio?: number;
  /** 新开标签页派发：值为页标题；仅无 anchor 时生效，失败回退同页分割 */
  newTab?: string;
  isSystemSpawned?: boolean;
  parentRunId?: string;
}

 * 开一个新 peer：新标签页（或同页 splitShell）→ 写 peer.json → 启动 harness TUI → 等待就绪。
 *
 * 布局：newTab + 无 anchor → 新标签页（批次入口，焦点不抢）；有 anchor →
 * 同页在 anchor 右侧分割（批次内后续 peer）；两者都无 → 同页下方分割（兼容老行为）。
 * openTab 失败（后端不支持/抛错）→ 回退 splitShell，保证派发总能进行。
export async function openPeer(opts: OpenPeerOpts): Promise<PeerInfo> {
  const { agent, route, adapter, config, cwd } = opts;
  const backend: MultiplexerBackend = detectBackend();

  // peer 池上限（0 = 不限）
  if (config.maxPeers > 0 && listPeers().length >= config.maxPeers) {
    throw new Error(
      `peer 数已达上限 maxPeers=${config.maxPeers}（action:"close" 退役后再派）`,
    );
  }

  // 开新 peer 前清理过期 run 目录（keepResults 上限；存活 peer 目录受保护）
  cleanupOldRuns(config);

  const peerId = `sa-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const peerDir = path.join(getSubagentsDir(), peerId);
  fs.mkdirSync(peerDir, { recursive: true });

  const shellEnv = {
    PI_SUBAGENT: "1",
    ATELIER_PEER_DIR: peerDir,
    ATELIER_PEER_ID: peerId,
  };

  // 批次入口开新页；anchor 复用同页分割；openTab 失败回退同页分割
  let paneId: string;
  let tabId: string | undefined;
  if (opts.newTab && !opts.rightOfPaneId) {
    try {
      const opened = backend.openTab({ label: opts.newTab, cwd, env: shellEnv });
      paneId = opened.paneId;
      tabId = opened.tabId;
    } catch (err) {
      console.warn(`[atelier:peer] openTab 失败，回退同页分割: ${(err as Error).message}`);
      paneId = backend.splitShell({
        direction: "down",
        ratio: opts.splitRatio ?? 0.4,
        cwd,
        env: shellEnv,
      });
    }
  } else {
    paneId = backend.splitShell({
      direction: opts.rightOfPaneId ? "right" : "down",
      ratio: opts.splitRatio ?? 0.4,
      targetPaneId: opts.rightOfPaneId,
      cwd,
      env: shellEnv,
    });
  }

  const peer: PeerInfo = {
    peerId,
    paneId,
    ...(tabId ? { tabId } : {}),
    mux: backend.name,
    harness: adapter.id,
    agent: agent.name,
    model: route.model,
    cwd,
    peerDir,
    msgSeq: 0,
    createdAt: Date.now(),
    alive: true,
    sessionId: piSession.id ?? undefined,
  };
  writePeerJson(peer);
  peers.set(peerId, peer);
  registerPeer(peer, {
    isSystemSpawned: opts.isSystemSpawned ?? isSystemAgent(agent.name),
    parentRunId: opts.parentRunId,
  });

  // pane 标题 = 角色@harness + peerId 尾段：人类可读（谁在干活），
  // 尾段又能与主会话拿到的 peerId 句柄对上（同名 peer 可区分）
  backend.setTitle(
    paneId,
    `${config.panePrefix}${agent.name}@${adapter.id}#${peerId.slice(-4)}`,
  );

  // 启动 harness TUI
  const launch = adapter.launchCommand({
    model: route.model,
    approval: config.peerApproval,
    extraArgs: config.harnessArgs[adapter.id],
  });
  backend.sendText(paneId, launch);

  await waitPeerReady(peer, backend, config.peerReadyTimeoutMs);
  return peer;
}

/**
 * 等 harness TUI 就绪：
 *  - herdr + 已识别 agent：agent_status 变成 idle/working/blocked 之一即就绪
 *  - 其余（tmux / generic / integration 未装）：固定等待 4s 后放行
 *    （TUI 输入会排队，过早输入进 shell 才危险；4s 覆盖常见启动耗时）
 */
async function waitPeerReady(
  peer: PeerInfo,
  backend: MultiplexerBackend,
  timeoutMs: number,
): Promise<void> {
  if (!backend.agentStatus) {
    await sleep(Math.min(4000, timeoutMs));
    return;
  }
  const deadline = Date.now() + timeoutMs;
  let sawAgent = false;
  while (Date.now() < deadline) {
    const status = backend.agentStatus(peer.paneId);
    if (status === "idle" || status === "working" || status === "blocked") {
      return;
    }
    if (status === "unknown") sawAgent = true;
    await sleep(500);
  }
  // 超时仍放行，但记诊断（submission 会排队或进 shell）
  console.warn(
    `[atelier:peer] ${peer.peerId} harness TUI 就绪等待超时` +
      (sawAgent ? "（agent_status 一直是 unknown，integration 可能未装）" : ""),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 消息原语 ────────────────────────────────────────────────────────────────

export interface SendResult {
  peerId: string;
  /** 本次消息的 runId（registry 键）：<peerId>-m<seq>；steer 时为当前 seq */
  msgId: string;
  seq: number;
  /** true=新任务（seq 递增）；false=舵手消息（塞进 working peer） */
  isNewTask: boolean;
}

/**
 * 向 peer 发消息。
 *
 * peer 空闲（上条消息已终态或从没发过）→ 新任务：msgSeq++、写 brief、
 * 重置 status.json、注册 run、发送提交文本。
 * peer 忙 → 舵手：只 sendText，不动文件契约（消息由 harness 排队/打断）。
 */
export function sendToPeer(
  peer: PeerInfo,
  task: string,
  opts: {
    images?: string[];
    parentRunId?: string;
    /** registry mode 字段（chain/parallel 步骤归组）；默认 "single" */
    mode?: "single" | "parallel" | "chain";
  } = {},
): SendResult {
  const backend = detectBackend();
  const busy = peerBusy(peer);

  if (busy) {
    // 舵手：直接注入文本，不打断当前 turn（harness 自行排队/消化）。
    backend.sendText(peer.paneId, task);
    peer.lastStatus = "working";
    writePeerJson(peer);
    updatePeerMeta(peer.peerId, { lastStatus: "working" });
    return {
      peerId: peer.peerId,
      msgId: `${peer.peerId}-m${peer.msgSeq}`,
      seq: peer.msgSeq,
      isNewTask: false,
    };
  }

  const seq = peer.msgSeq + 1;
  const brief = buildBrief(peer, seq, task, opts.images);
  fs.writeFileSync(
    path.join(peer.peerDir, `brief-${seq}.md`),
    brief,
    "utf-8",
  );
  // 重置终态信号（peer 会覆写）
  fs.writeFileSync(
    path.join(peer.peerDir, "status.json"),
    JSON.stringify({
      status: "running",
      msgSeq: seq,
      startedAt: Date.now(),
    }),
    "utf-8",
  );
  // task.md 维护成最新任务摘要（list/status 旧路径兼容）
  fs.writeFileSync(path.join(peer.peerDir, "task.md"), task, "utf-8");

  const msgId = `${peer.peerId}-m${seq}`;
  registerRun({
    runId: msgId,
    agent: peer.agent,
    mode: opts.mode ?? "single",
    runDir: peer.peerDir,
    taskExcerpt: task.slice(0, 200),
    parentRunId: opts.parentRunId,
    peerId: peer.peerId,
    msgSeq: seq,
    harness: peer.harness,
  });

  backend.sendText(peer.paneId, submissionText(peer, seq, task));

  peer.msgSeq = seq;
  peer.lastStatus = "working";
  writePeerJson(peer);
  updatePeerMeta(peer.peerId, { msgSeq: seq, lastStatus: "working" });
  const session = backend.agentSession?.(peer.paneId);
  if (session && session !== peer.nativeSessionId) {
    peer.nativeSessionId = session;
    writePeerJson(peer);
    updatePeerMeta(peer.peerId, { nativeSessionId: session });
  }

  return { peerId: peer.peerId, msgId, seq, isNewTask: true };
}

/** 读 peer transcript 尾部（实时查看/结果兜底提取） */
export function readPeer(peer: PeerInfo, lines = 120): string {
  return detectBackend().readPane?.(peer.paneId, lines) ?? "";
}

/** 退役 peer：关 pane + 标记不再存活；同页最后一个 peer 关闭时顺手回收空标签页 */
export function closePeer(peer: PeerInfo): void {
  detectBackend().kill(peer.paneId);
  peer.alive = false;
  peer.lastStatus = "closed";
  writePeerJson(peer);
  peers.delete(peer.peerId);
  markPeerClosed(peer.peerId);
  // 空页回收：同 tabId 下无其他存活 peer → 关页（tmux 末 pane 自闭页时 closeTab 静默无操作）
  if (peer.tabId) {
    const tabId = peer.tabId;
    let siblingAlive = false;
    for (const p of peers.values()) {
      if (p.tabId === tabId && p.alive) {
        siblingAlive = true;
        break;
      }
    }
    if (!siblingAlive) {
      try {
        detectBackend().closeTab(tabId);
      } catch {
        /* best-effort：页可能已被用户手动关闭 */
      }
    }
  }
}
