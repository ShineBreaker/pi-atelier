// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 参数 Schema — 使用 TypeBox 定义 subagent 工具的输入参数类型
 *
 * PR-12 peer 化：派发返回异步句柄（peerId），显式 action:wait 收结果；
 * action:send 向存活 peer 随时追加指令（追问/纠偏/解堵）。
 */

import { Type } from "typebox";

/** 单个任务条目：agent 名 + 任务描述 + 可选 cwd */
const TaskItem = Type.Object({
  agent: Type.String({ description: "Agent 名称" }),
  task: Type.String({ description: "任务描述" }),
  cwd: Type.Optional(Type.String({ description: "工作目录" })),
});

/** subagent 工具的完整参数 schema */
export const SubagentParams = Type.Object({
  agent: Type.Optional(
    Type.String({
      description:
        "Agent 名称（single 派发）；send 时作为复用目标——找该角色的空闲 peer",
    }),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "任务/消息文本（single 派发、send、chain 根任务）",
    }),
  ),
  tasks: Type.Optional(
    Type.Array(TaskItem, { description: "并行任务数组（每任务一个新 peer）" }),
  ),
  chain: Type.Optional(
    Type.Array(TaskItem, {
      description:
        "串行任务链；task 中可用 {previous}/{task}。同 agent+同 harness 的步骤复用同一 peer（上下文零损耗）",
    }),
  ),
  action: Type.Optional(
    Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("peers"),
        Type.Literal("send"),
        Type.Literal("wait"),
        Type.Literal("read"),
        Type.Literal("close"),
      ],
      {
        description:
          "管理动作：list=agent/harness 清单；peers=存活 peer 池；" +
          "send=向 peer 追加指令（忙碌时=舵手纠偏，空闲时=新任务）；" +
          "wait=收某 peer 当前消息结果；read=看 peer 实时 transcript；" +
          "close=退役 peer；status=查 run/peer 状态",
      },
    ),
  ),
  id: Type.Optional(
    Type.String({
      description:
        "peerId（send/wait/read/close）或 runId（status）。send 可与 agent 二选一",
    }),
  ),
  peer: Type.Optional(
    Type.String({
      description:
        "派发时复用的 peerId；缺省总是新开 peer（隔离上下文）",
    }),
  ),
  harness: Type.Optional(
    Type.String({
      description:
        "harness 覆盖（pi/claude/codex/hermes/任意 PATH binary 名）",
    }),
  ),
  wait: Type.Optional(
    Type.Boolean({
      description:
        "true=阻塞到本条消息完成并返回结果（仅后续工具强依赖本结果时用）；" +
        "false/缺省=立即返回句柄，结果完成后自动推送新消息，无需轮询或手动 wait",
    }),
  ),
  lines: Type.Optional(
    Type.Number({ description: "action:read 的 transcript 尾部行数" }),
  ),
  cwd: Type.Optional(Type.String({ description: "工作目录覆盖" })),
  model: Type.Optional(Type.String({ description: "模型覆盖" })),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: "图片文件路径数组，传递给 visual agent 分析",
    }),
  ),
  // PR-9: 系统子 agent 标记。系统命令（如 /atelier-dream）调用时设为 true，
  // 默认 false。spawn 时透传到 registerRun 的 isSystemSpawned 字段。
  isSystemSpawned: Type.Optional(
    Type.Boolean({ description: "PR-9: 系统子 agent 标记（默认 false）" }),
  ),
  // PR-10: 长程任务 checkpoint + resume 选项
  action_ext: Type.Optional(
    Type.String({
      description: "PR-10: 扩展动作（resume <runId>）",
    }),
  ),
});
