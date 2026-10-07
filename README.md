# atelier

**把一个 coding agent 变成一支 agent 团队。**

atelier 是 pi 的 subagent 编排扩展：它不 spawn 跑完即死的一次性进程，
而是在你的终端里开出一间**工作室**——每个子 agent 是一个活的、可见的、
可以随时对话的 **peer**，跑在你眼皮底下的分屏 pane 里。

## 为什么不一样

市面上的 subagent 工具几乎都是同一个模型：发一个任务，等一个黑盒，收一段文本。
atelier 把这个模型整个换掉了：

- **它是活的**。子 agent 完成任务后不退出，上下文完整保留。
  reviewer 发现问题？直接 `send` 让它就地改，不用从头铺垫。
  跑偏了？随时注入纠偏指令，它会排队消化。卡住了？一句话解堵。
- **它不只属于 pi**。Claude Code、Codex、Hermes……任何 PATH 里的
  agent harness 都能被编排。每个 harness 对自家模型适配最好，
  atelier 按你声明的路由链优先外派，pi 退居兜底——谁强谁上。
- **它在你眼前干活**。每个 peer 住在一个真实的分屏 pane 里，
  不是日志文件，不是抽象状态——就是你能亲眼看到、亲手介入的
  交互式会话。
- **它摔不坏**。pi 崩了，peer 还活着接着干；文件契约 +
  语义级状态检测 + 兜底提取的四层完成判定，结果总能收回来；
  会话恢复后按归属自动认领孤儿，该收尾收尾，该放行的不动。

## 一分钟看懂工作方式

```text
subagent({agent:"scout", task:"调研这个模块的边界"})   → 开个 Claude pane
subagent({action:"send", task:"顺便看一下测试覆盖"})    → 同一个 peer 追问
subagent({action:"peers"})                             → 谁在干活一目了然
subagent({action:"read", id})                          → 实时围观 transcript
subagent({action:"close", id})                         → 活干完，退役
```

并行批量、串行链路（同 harness 自动复用 peer，上下文零损耗）、
异步派发 + 完成后自动推送（会话先 settled，推送到达自动恢复）、`/agentname` 快捷命令——主会话永远握着方向盘，
什么时候阻塞等（wait:true）、什么时候撒手并行，由它自己决定。

## 适合谁

- 想让**多个不同 harness 协同**干一件复杂任务的人
- 受够了 subagent 黑盒、想要**随时介入纠偏**的人
- 跑长任务、需要**崩溃可恢复、状态不丢**的人

## 使用前提

- [pi](https://github.com/earendil-works/pi-coding-agent) 作为宿主 agent
- 一个多路复用器：[herdr](https://github.com/ShineBreaker/herdr)
  （推荐，提供语义级 agent 状态检测）或 tmux
- 想外派任务就装对应 harness（`claude` / `codex` / `hermes` /
  任何 PATH 里的 TUI agent binary 均可）

## 文档

| 文档 | 内容 |
| ---- | ---- |
| [docs/atelier.md](docs/atelier.md) | 完整技术参考：peer 模型、路由、文件契约、工具面、配置 |
| [AGENTS.md](AGENTS.md) | 仓库内部架构、目录分层、修改约束（贡献者向） |
| [CHANGELOG.md](CHANGELOG.md) | 版本发布史 |

License: MIT
