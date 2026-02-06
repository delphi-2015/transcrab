---
title: "解锁 Codex Harness：我们如何构建 App Server"
date: "2026-02-06"
sourceUrl: "https://openai.com/index/unlocking-the-codex-harness/"
lang: "zh"
model: "openai-codex/gpt-5.2"
---

本文将介绍 Codex App Server，并分享我们迄今为止关于如何将 Codex 的能力引入你的产品、帮助用户显著提升工作流效率的一些经验。我们会讲解 App Server 的架构与协议、它如何与不同 Codex 使用界面（surface）集成，以及如何更好地利用 Codex——无论你想把 Codex 变成代码审查员、SRE 代理，还是编码助手。

## App Server 的起源

在深入架构之前，了解 App Server 的“前世今生”会更有帮助。最初，App Server 只是一个在多个产品之间复用 Codex harness 的实用方案，随后逐渐演变为我们今天的标准协议。

Codex CLI 最初是一个 TUI（terminal user interface，终端用户界面），也就是说你通过终端来使用 Codex。当我们构建 VS Code 扩展（更适合 IDE 的方式来与 Codex 代理交互）时，我们需要一种方法，在不重新实现 agent loop 的情况下，让 IDE UI 也能驱动同一套 harness。这意味着要支持比“请求/响应”更丰富的交互模式，例如：探索工作区、在代理推理过程中持续流式输出进度、以及发出 diff 等。

我们最开始尝试将 [Codex 暴露为一个 MCP server⁠(opens in a new window)](https://github.com/openai/codex/pull/2264)，但要在 VS Code 语境下维持一套合理的 MCP 语义被证明非常困难。于是我们转而引入了一个镜像 TUI 循环的 JSON-RPC 协议，它成为 App Server 的 [非正式首个版本⁠(opens in a new window)](https://github.com/openai/codex/pull/4471)。当时我们并不预期会有其他客户端依赖 App Server，所以它也并没有被设计成稳定 API。

随着接下来几个月 Codex 的采用率持续增长，内部团队和外部合作伙伴都希望能把同一套 harness 嵌入到他们自己的产品中，以加速用户的软件开发工作流。例如，JetBrains 和 Xcode 想要 IDE 级的 agent 体验，而 Codex 桌面应用需要并行编排多个 Codex agent。这些需求推动我们设计一个平台能力（platform surface），让我们的产品与合作伙伴的集成都能长期、可靠地依赖它。

这个平台需要“易集成、并且向后兼容”，也就是说我们可以演进协议，而不至于破坏现有客户端。接下来我们将介绍，我们是如何设计架构与协议，让不同客户端都能使用同一套 harness。

## Codex harness 内部是什么

先把镜头拉近：Codex harness 里到底有什么，以及 Codex App Server 如何把它暴露给客户端。在我们上一篇 Codex [博客](/index/unrolling-the-codex-agent-loop/) 里，我们拆解了驱动用户、模型与工具交互的核心 agent loop。这确实是 Codex harness 的核心逻辑，但完整的 agent 体验还包括更多内容：

1. **Thread 生命周期与持久化。**Thread 是用户与 agent 之间的一段 Codex 对话。Codex 会创建、恢复、分叉（fork）与归档 thread，并持久化事件历史，以便客户端可以重连并渲染一致的时间线。
2. **配置与鉴权。**Codex 会加载配置、管理默认值，并运行诸如 “Sign in with ChatGPT” 这样的认证流程（包括凭据状态）。
3. **工具执行与扩展。**Codex 会在沙箱中执行 shell/file 工具，并接入 MCP server 与 skills 等集成，让它们在统一的策略模型下参与 agent loop。

我们在这里提到的所有 agent 逻辑（包括核心 agent loop）都位于 Codex CLI 代码库中的一个部分，称为 “[Codex core⁠(opens in a new window)](https://github.com/openai/codex/tree/main/codex-rs/core)”。Codex core 既是承载所有 agent 代码的库，也是一套运行时：它可以被启动来运行 agent loop，并管理单个 Codex thread（对话）的持久化。

要让 harness 变得有用，它必须能被客户端访问——这就是 App Server 的用武之地。

App Server 既指客户端与服务器之间的 JSON-RPC 协议，也指一个长期运行的进程：它托管 Codex core 的各个 thread。根据上方示意，一个 App Server 进程包含四个主要组件：**stdio reader、Codex message processor、thread manager，以及 core threads**。thread manager 会为每个 thread 启动一个 core session；随后 Codex message processor 与每个 core session 直接通信，提交来自客户端的请求并接收更新。

一个客户端请求可能会产生大量事件更新，而这些细粒度事件正是我们能够在 App Server 之上构建丰富 UI 的原因。进一步来说，stdio reader 与 Codex message processor 还承担了“翻译层”的角色：它们把客户端的 JSON-RPC 请求转换为 Codex core 的操作，监听 Codex core 的内部事件流，并将底层事件再转换成一小组稳定、面向 UI 的 JSON-RPC 通知。

客户端与 App Server 之间的 JSON-RPC 协议是**完全双向**的：一个典型的 thread 会包含一次客户端请求与多次服务器通知；此外，当 agent 需要输入（例如审批）时，服务器也能主动发起请求，并暂停该 turn，直到客户端响应。

## 对话的基本原语（primitives）

接下来我们拆解对话 primitives——它们是 App Server 协议的构建块。为 agent loop 设计 API 很棘手，因为用户/agent 的交互并不是简单的请求/响应：一次用户请求可能展开为一段结构化的动作序列，客户端需要忠实地呈现——包括用户输入、agent 的增量进度，以及过程中产生的工件（例如 diffs）。为了让这种交互流易于集成、并能跨 UI 表现得更稳定，我们最终确定了三种核心 primitive，它们有清晰的边界与生命周期：

1. **Item：**Item 是 Codex 中输入/输出的原子单位。Item 有类型（例如 user message、agent message、tool execution、approval request、diff），并且每个 item 都有明确的生命周期：

- `item/started`：item 开始
- 可选的 `item/*/delta` 事件：内容在流式传输过程中逐步到达（用于支持流式的 item 类型）
- `item/completed`：item 以最终负载（terminal payload）定格

这个生命周期让客户端可以在 started 时立刻开始渲染，在 delta 上流式更新，并在 completed 时最终定稿。

2. **Turn：**Turn 是由用户输入触发的一次 agent 工作单元。它从客户端提交输入开始（例如“运行测试并总结失败原因”），到 agent 为这次输入完成输出为止。一个 turn 包含一系列 items，它们表示过程中产生的中间步骤与最终输出。

3. **Thread：**Thread 是用户与 agent 之间持续 Codex 会话的持久容器，它包含多个 turns。Thread 可被创建、恢复、分叉与归档。Thread 历史会被持久化，以便客户端可以重连并渲染一致的时间线。

接下来我们用一个简化示例，展示客户端与 agent 之间的对话如何由这些 primitives 表示。

在对话开始时，客户端与服务器需要先完成 `initialize` 握手。客户端必须在调用任何其它方法之前发送一次 `initialize` 请求，服务器随后返回响应。这让服务器可以声明能力（capabilities），也让双方在真正开始工作之前，就协议版本、功能开关、默认行为等达成一致。下面是 OpenAI 的 VS Code 扩展中的一个示例 payload：

这是服务器返回的内容：

当客户端发起一次新的请求时，它会先创建一个 thread，然后创建一个 turn。服务器会发送进度通知（`thread/started` 与 `turn/started`），并且把它注册到的输入作为 items 发回客户端，例如这里的 user message。

工具调用也会作为 items 回传给客户端。此外，服务器还可能在执行某个动作前要求客户端审批：它会发送一次 server request。审批会暂停这个 turn，直到客户端用 “allow” 或 “deny” 回复。下面是 VS Code 扩展中审批流程的样子：

最终，服务器会发送一条 agent message，并以 `turn/completed` 结束该 turn。agent message 的 delta 事件会把消息分片流式回传，直到以 `item/completed` 定格。

为便于阅读，图里的消息被做了简化。如果你想查看一个完整 turn 的 JSON，你可以从 Codex CLI 仓库运行测试客户端。

## 与客户端集成

接下来看看不同客户端界面如何通过 App Server 嵌入 Codex。我们会介绍三种模式：本地应用与 IDE、Codex Web 运行时、以及 TUI。

这三者都使用同一种传输方式：**基于 stdio 的 JSON-RPC（JSONL）**。JSON-RPC 让你可以很直接地用自己选择的语言构建客户端绑定。Codex 的各类界面与合作伙伴集成已经用多种语言实现了 App Server 客户端，包括 Go、Python、TypeScript、Swift 与 Kotlin。对于 TypeScript，你可以通过运行以下命令，直接从 Rust 协议生成定义：

对于其它语言，你可以生成一个 JSON Schema bundle，然后把它交给你偏好的代码生成器：

本地客户端通常会捆绑或拉取一个平台特定的 App Server 二进制，作为长期运行的子进程启动，并保持一条双向的 stdio JSON-RPC 通道。例如在我们的 VS Code 扩展与桌面应用中，发布产物里包含了平台特定的 Codex 二进制，并固定到一个经过验证的版本，以确保客户端始终运行的是我们测试过的“那一套 bit”。

并不是每一种集成都能频繁发布客户端更新。一些合作伙伴（例如 Xcode）会通过保持客户端稳定，并允许它在需要时指向更新版本的 App Server 二进制，从而解耦发布节奏。这样他们就能采用服务端改进（例如 Codex core 中更好的自动压缩，或新增支持的配置键），并在不等待客户端发布的情况下推出 bug 修复。App Server 的 JSON-RPC 表面被设计为向后兼容，因此旧客户端也能安全地与新服务器通信。

Codex Web 也使用 Codex harness，但它运行在容器环境里：一个 worker 会拉起带有已检出工作区的容器，在容器内启动 App Server 二进制，并维护一条长期运行的基于 stdio 的 JSON-RPC 通道[2](#citation-bottom-2)。Web 应用（运行在用户浏览器标签页中）通过 HTTP 与 SSE 与 Codex 后端通信，后者流式传输由 worker 产生的任务事件。这样可以让浏览器侧 UI 保持轻量，同时在桌面与 web 上都拥有一致的运行时。

由于 web 会话是短暂的（标签页关闭、网络断开），web 应用不能作为长任务的“真相源”。把状态与进度留在服务器端意味着：即使标签页消失，工作仍能继续。流式协议与保存的 thread 会话让新的会话能够轻松重连、从断点继续，并在无需重建客户端状态的情况下追上进度。

从历史上看，TUI 是一个“原生”客户端：它与 agent loop 在同一进程内运行，并直接与 Rust 的 core 类型通信，而不是走 app-server 协议。这让早期迭代更快，但也使得 TUI 成为一个特殊的 surface。

随着 App Server 的出现，我们计划 [重构 TUI⁠(opens in a new window)](https://github.com/openai/codex/pull/10192) 以使用它——从而让 TUI 像其它客户端一样：启动 App Server 子进程、通过 stdio 讲 JSON-RPC，并渲染同样的流式事件与审批流程。这也将解锁一种工作流：TUI 可以连接到运行在远端机器上的 Codex server，让 agent 更贴近算力，即使笔记本休眠或断线，工作也能继续；同时在本地仍能获得实时更新与控制。

## 选择合适的协议

未来我们会把 Codex App Server 作为第一优先级维护的集成方式，但也存在其它功能较受限的方法。默认情况下，我们建议客户端使用 Codex App Server 来集成 Codex，不过也值得了解不同集成方式的优缺点。下面列出了驱动 Codex 的常见方法，以及它们适用的场景：

运行 [codex mcp-server⁠(opens in a new window)](https://developers.openai.com/codex/guides/agents-sdk/) 并从任何支持 stdio server 的 MCP 客户端连接（例如 [OpenAI Agents SDK⁠(opens in a new window)](https://openai.github.io/openai-agents-js/)）。如果你已经有基于 MCP 的工作流，并希望把 Codex 当作可调用工具来使用，这会很合适。缺点是你只能使用 MCP 暴露的能力，因此依赖更丰富会话语义的 Codex 交互（例如 diff 更新）不一定能很好地映射到 MCP 端点上。

有些生态会提供一个可移植的接口，以便面向多个模型提供方与运行时。这在你希望用一个抽象来协调多个 agent 时很合适。但代价是，这些协议往往收敛到“共同子集”的能力，导致更丰富的交互更难表达，特别是当某些能力依赖提供方特有的工具或会话语义时。这个领域仍在快速演进，我们预计随着对真实世界 agent 工作流 primitive 的不断探索，会逐步出现更多通用标准（[skills⁠(opens in a new window)](https://agentskills.io/home) 是一个很好的例子）。

当你希望把完整 Codex harness 以稳定、对 UI 友好的事件流暴露出来时，选择 App Server。你既能获得 agent loop 的完整功能，也能获得诸如 “Sign in with ChatGPT”、模型发现与配置管理等配套能力。主要成本在于集成工作：你需要用你的语言构建 JSON-RPC 绑定。不过在实践中，如果你把 JSON schema 与文档交给 Codex，它能完成很多繁重的工作。我们合作过的许多团队都能借助 Codex 很快做出可用的集成原型。

一种轻量、可脚本化的 CLI 模式，适合一次性任务与 CI 跑批。它适用于自动化与流水线：你希望用一个命令非交互地运行至完成、把结构化输出流式写入日志，并以明确的成功/失败信号退出。

一个 TypeScript 库，用于在你自己的应用中以编程方式控制本地 Codex agent。它适合你希望直接使用原生库接口来实现服务端工具与工作流、而不想构建一套单独 JSON-RPC 客户端的场景。由于它比 App Server 更早发布，目前支持的语言更少、表面能力也更小。如果开发者对它有兴趣，我们可能会增加额外的 SDK 来封装 App Server 协议，让团队无需手写 JSON-RPC 绑定就能覆盖 harness 的更多能力。

## 展望

本文分享了我们在设计与 agent 交互的新标准时的思路，以及如何将 Codex harness 打造成一个稳定、对客户端友好的协议。我们介绍了 App Server 如何暴露 Codex core、让客户端驱动完整 agent loop，并支撑包括 TUI、本地 IDE 集成与 web 运行时在内的多种界面形态。

如果这篇文章让你产生了把 Codex 集成到自己工作流中的想法，值得尝试一下 App Server。所有源代码都在 Codex CLI 的开源 [仓库⁠(opens in a new window)](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 中。欢迎分享你的反馈与功能需求。我们很期待听到你的想法，并持续让 agent 更容易被所有人使用。
