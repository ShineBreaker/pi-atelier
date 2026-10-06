// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 类型定义 — atelier 扩展的所有接口和常量
 *
 * 包含：Agent/Prompt/Run 相关接口、默认配置、分屏百分比常量
 */

// ─── Agent & Prompt 配置 ────────────────────────────────────────────────────

/** 从 .md 文件发现的 agent 配置 */
export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  /**
   * 模型档次（来自 frontmatter `tier:` 字段）：
   *   - "ultra" | "pro" | "quick" | "visual" → 查 settings.json `atelier.tiers` 配置
   *   - "inherit" → 不传 --model，让 pi 用前台 defaultModel（worker 默认行为）
   *   - undefined → 用 settings.json `atelier.defaultTier`
   */
  tier?: string;
  /**
   * PR-12: harness pin（来自 frontmatter `harness:` 字段）。
   * 指定后该 agent 只在该 harness 上运行（如 reviewer → claude）。
   * 未指定时走 tier routes 解析。
   */
  harness?: string;
  systemPrompt: string;
  filePath: string;
}

/**
 * 模型配置：首选 + fallback 链（tier 系统的底层结构）。
 *
 * PR-12: 新增 `routes` 字段——harness/model 混合路由列表。每个条目形如：
 *   - "claude/sonnet"      → harness=claude, model=sonnet
 *   - "codex"              → harness=codex, model=继承默认
 *   - "pi/zai/GLM-5.2"     → harness=pi, model=zai/GLM-5.2（首个 / 分隔 harness）
 *   - "zai/GLM-5.2"        → 首段不是已知 harness → pi/zai/GLM-5.2（向后兼容）
 * routes 存在时优先于 model+fallback；否则 [model, ...fallback] 即路由列表。
 */
export interface AgentModelConfig {
  /** 首选模型（旧式；routes 存在时忽略） */
  model: string;
  /** fallback 模型链，按顺序尝试 */
  fallback: string[];
  /** PR-12: harness/model 混合路由列表（优先） */
  routes?: string[];
}

/** PR-12: 路由解析后的单次尝试目标 */
export interface RouteCandidate {
  /** harness id（"pi" | "claude" | "codex" | "hermes" | 其他 binary 名） */
  harness: string;
  /** 模型名（undefined = harness 默认/继承） */
  model?: string;
}

/** 从 .md 文件发现的 prompt 模板配置 */
export interface PromptConfig {
  name: string;
  mode: "single" | "parallel" | "chain";
  param: string;
  description: string;
  /** 解析后的 {agent, task} 列表 */
  entries: Array<{ agent: string; task: string }>;
}

// ─── 运行时数据 ─────────────────────────────────────────────────────────────

/** atelier 运行时配置（从 settings.json 的 atelier 字段加载） */
export interface SubagentConfig {
  pollIntervalMs: number;
  panePrefix: string;
  keepResults: number;
  timeoutMs: number;
  maxTasks: number;
  maxConcurrency: number;
  /** tier 字段缺失时的默认 tier；解析不到时回退到 "inherit" */
  defaultTier: string;
  /** tier 名 → model + fallback 链的映射 */
  tiers: Record<string, AgentModelConfig>;
  /**
   * 模型/harness 使用时段限制（按名索引，跨 tier 生效）。
   *
   * 形状：`{ "zai/GLM-5.2": {...}, "claude/sonnet": {...}, "codex": {...} }`。
   * 键可以是裸模型名、harness 名或 "harness/model" 复合键——
   * resolveRouteChain 对每个 RouteCandidate 依次查
   * `harness/model` → `model` → `harness` 三种键。
   * 命中禁用窗口的候选被跳过（每个 warn 一次）；未列出项不受限。
   */
  modelSchedules: Record<string, { allow?: string[]; deny?: string[] }>;

  /**
   * PR-12: peer 模式下 harness 的自治级别。
   *   - "full":   各 harness 的最大自治 flag（claude --dangerously-skip-permissions、
   *               codex --full-auto 等）。peer 无人值守运行的前提。
   *   - "safe":   各 harness 的保守自动接受（如 claude --permission-mode acceptEdits），
   *               bash 等危险操作仍会 blocked。
   *   - "off":    不加自治 flag，harness 默认权限策略（容易 blocked，
   *               主 agent 需用 send 解堵）。
   */
  peerApproval: "full" | "safe" | "off";
  /**
   * PR-12: peer 被 harness 权限门卡住（herdr agent_status=blocked）时的容忍时长。
   * 超过后 wait 返回失败并提示主 agent 用 send 解堵。0 = 立即返回。
   */
  blockedGraceMs: number;
  /**
   * PR-12: peer 模式 harness TUI 的就绪等待上限（等待 agent_status=idle）。
   * 超时仍尝试发送（TUI 输入会排队），但记 stderr 警告。
   */
  peerReadyTimeoutMs: number;
  /** PR-12: peer 池上限（存活 peer 数）。超出时新 dispatch 拒绝。0 = 不限。 */
  maxPeers: number;
  /**
   * PR-12: harness 专属追加参数（按 harness id 索引）。
   * 形状：`{ "hermes": ["--model","x"], "mcode": ["--fast"] }`。
   * 追加在 adapter launchCommand 产物末尾。
   */
  harnessArgs: Record<string, string[]>;
}

/** 单次 agent 运行的最终结果 */
export interface RunResult {
  runId: string;
  agent: string;
  status: "completed" | "failed" | "running";
  exitCode: number;
  output: string;
  durationMs: number;
  tmuxPane: string;
  error?: string;
  workfilePath?: string;
  /** PR-12: 执行该 run 的 peer id（peer 模式下 = 承载 pane 的稳定句柄） */
  peerId?: string;
  /** PR-12: 该 run 使用的 harness id */
  harness?: string;
}

/**
 * PR-12: 持久 peer 的元数据（peerDir/peer.json 的磁盘形态 + 内存形态）。
 *
 * peer = pane + 活的 harness 会话 + 角色 + 累积上下文。task 只是发给它的
 * 一条消息（msgSeq 递增），peer 生命周期与 task 解耦。
 */
export interface PeerInfo {
  peerId: string;
  paneId: string;
  /** 所在多路复用器后端名 */
  mux: "tmux" | "herdr";
  /** harness id（pi/claude/codex/hermes/<binary>） */
  harness: string;
  /** 角色（agent .md 名；纯 harness peer 可为 harness 名本身） */
  agent: string;
  model?: string;
  cwd: string;
  peerDir: string;
  /** 已派发的消息序号（brief-N/result-N 对齐） */
  msgSeq: number;
  /** 创建时间 */
  createdAt: number;
  /** 是否存活（closePeer 或 pane 死亡时置 false） */
  alive: boolean;
  /** 派发该 peer 的 pi session id（孤儿认领按 session 归属判定） */
  sessionId?: string;
  /** herdr agent_session 里报告的原生 session 标识（如有） */
  nativeSessionId?: string;
  /** 最后一次观测到的 agent_status（herdr）或推断状态 */
  lastStatus?: string;
}

/** 返回给 tool caller 的 details 结构 */
export interface SubagentDetails {
  mode:
    | "single"
    | "parallel"
    | "chain"
    | "list"
    | "status"
    // PR-12: peer 管理动作
    | "peers"
    | "send"
    | "wait"
    | "read"
    | "close";
  results: RunResult[];
}

/** run 目录下的 status.json 文件结构 */
export interface StatusFile {
  status: "running" | "completed" | "failed";
  exitCode?: number;
  finishedAt?: number;
  startedAt?: number;
  error?: string;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** 默认运行时配置 */
export const DEFAULT_CONFIG: SubagentConfig = {
  pollIntervalMs: 2000,
  panePrefix: "sub:",
  keepResults: 24,
  timeoutMs: 30 * 60 * 1000,
  maxTasks: 8,
  maxConcurrency: 4,
  defaultTier: "pro",
  tiers: {},
  modelSchedules: {},
  peerApproval: "full",
  blockedGraceMs: 120 * 1000,
  peerReadyTimeoutMs: 30 * 1000,
  maxPeers: 8,
  harnessArgs: {},
};
