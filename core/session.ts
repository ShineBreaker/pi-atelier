// SPDX-FileCopyrightText: 2026 BrokenShine <xchai404@gmail.com>
//
// SPDX-License-Identifier: MIT

/**
 * 当前 pi session 的共享锚点。
 *
 * pi 的 session 文件首条 entry 是 {type:"session", id}；index.ts 在
 * before_agent_start 首次触发时从 ctx.sessionManager.getEntries() 提取
 * 写入此处（resume 场景返回被恢复会话的原 ID，天然满足「进入了相同
 * 的会话」的归属判定）。runtime/peer.ts 派发时读取并记入 peer.json。
 * 放 core 层避免 index ↔ runtime 循环依赖。
 */
export const piSession: { id: string | null } = { id: null };
