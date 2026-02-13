---
title: SwiftUI 丝滑流畅的秘诀
date: '2026-02-13T08:15:31.195Z'
sourceUrl: 'https://www.swiftdifferently.com/blog/swiftui/swiftui-performance-article'
lang: zh
---
你是否好奇过，为什么有些 SwiftUI 视图用起来如丝般顺滑，而有些……却不尽如人意？最近我经常问自己这个问题。

我一直在做一个 [SwiftUI 的 agent skill——本质上](https://skills.sh/avdlee/swiftui-agent-skill/swiftui-expert-skill)是教 AI 用我自己的方式写出生产级质量的 SwiftUI 代码。

其中一个核心部分？如何以正确的方式组合你的视图。不是那种"能跑就行"的代码，而是从底层结构上就为性能而生的代码。

有趣的是：通过多年阅读书籍、文章和测试各种方法，我已经掌握了正确的模式。

但要把这些知识提炼成可以教给 AI 的内容？这迫使我必须真正深入理解背后的"为什么"。

说实话——虽然这些模式本身比你想象的要简单，但底层机制？那才是有趣的地方。

```swift
struct CounterView: View {
    @State private var value = 0
    var body: some View {
        Button("Increment: \(value)") {
            value += 1
        }
    }
}
```

看起来人畜无害，对吧？但在这个简单视图的底下，隐藏着一个可能决定你应用性能好坏的渲染机制。

今天，我们来探讨 SwiftUI 的渲染到底是如何工作的，更重要的是——你*组织*视图的方式如何显著影响它。让我们开始吧。

*   [SwiftUI 的渲染到底是如何工作的](#how-swiftuis-rendering-actually-works)
    *   [比较引擎](#the-comparison-engine)
*   [问题所在：巨型视图体](#the-problem-monster-view-bodies)
*   [虚假的解决方案](#the-false-solutions)
*   [真正的解决方案：独立的视图结构体](#the-real-solution-separate-view-structs)
*   [边界情况：当你需要 Equatable 时](#the-edge-case-when-you-need-equatable)
*   [总结](#conclusion)

## SwiftUI 的渲染到底是如何工作的

首先，让我们理解当状态改变时底层发生了什么。

当 `Counter` 第一次渲染时，SwiftUI 注意到视图体中访问了一个 `@State` 属性。

这创建了视图和该状态之间的**依赖关系**，结果呢？每次状态改变时，视图体都会*重新执行*。

这里有一个巧妙的小技巧来可视化这个过程——给你的视图一个随机背景色：

```swift
struct Counter: View {
    @State private var value = 0
    var body: some View {
        Button("Increment: \(value)") {
            value += 1
        }
        .background(Color.random)
    }
}

extension Color {
    static var random: Color {
        .init(
            red: .random(in: 0...1),
            green: .random(in: 0...1),
            blue: .random(in: 0...1)
        )
    }
}
```

![xcode-view](https://www.swiftdifferently.com/_next/image?url=%2Fstatic%2Fimages%2Fblogs%2Fswiftui-pre-1.gif&w=1920&q=75)

每次视图体重新执行时，颜色都会改变。这成了我们本文的调试超能力。

### 比较引擎

但这里有个关键点——SwiftUI 很聪明。当 SwiftUI 重新计算视图体时，它会将新结果与旧结果进行比较，只重新渲染那些*实际发生改变*的视图。

所以如果你添加一个带有静态字符串的 `Text` 视图并按下按钮？`Text` 不会有任何变化，因为 SwiftUI 发现新旧值之间没有差异。

但如果给那个 `Text` 加上 `.background(Color.random)` 呢？现在每次按钮点击背景都会改变。为什么？因为 `Color.random` 产生一个新值，SwiftUI 检测到差异并触发重新渲染。

可以这样理解：SwiftUI 不是盲目地重新渲染所有东西——它是在你的视图树上运行 diff 算法。

## 问题所在：巨型视图体

那么这和我们如何写 SwiftUI 代码有什么关系？

想象你有这样一个视图：

```swift
struct Counter: View {
    @State private var value = 0
    var body: some View {
        // 200 行基础视图代码 😮
    }
}
```

发生的事情很简单……性能炸了 😅。

每次 value 改变时，SwiftUI 都要重新执行整个 200 行的视图体，然后还要把所有内容与之前的结果进行比较。

这就是代价昂贵的地方：SwiftUI 的 diff 算法必须遍历所有那些基础视图来找出实际改变了什么。

让我拆解一下底层发生了什么：

*   当一个组合视图（如我们的 Counter）因状态改变需要重新计算其视图体时，diffing 开始
*   SwiftUI 现在有两个视图体需要比较——旧的和新的
*   昂贵的部分？SwiftUI 主要比较基础视图（Text、Button、Image 等）来找出改变了什么。那 200 行视图体中的每一个基础视图都需要被比较。

注意

`基础视图`是视图体类型为 `Never` 的视图，它们是 SwiftUI 视图的构建块，不是由其他视图组成的，如 `Text`、`Button`、`Image` 等。

你可能觉得"用户永远不会注意到。"

错了。大错特错。

这发生在我身上，QA 有一天来问我："为什么这个视图感觉比另一个更流畅？"说实话——当时我答不上来，但现在我知道了。

一个视图是一个充满基础视图的巨型视图体，在 `ScrollView` 里，每次属性改变时 SwiftUI 都要对它进行 diff；另一个则被拆解成子视图——神奇之处在于：组合视图充当了 diffing 的检查点。

如果 SwiftUI 看到一个组合子视图的属性没有改变，它根本不需要重新计算那个子视图的视图体。Diffing 在那里就停止了。

想想看：不是比较 200 个基础视图，SwiftUI 可能只需要检查少量组合视图而不用重新执行它们的视图体，就意识到"这里没什么改变，继续吧。"

这就是我们要追求的性能提升。

## 虚假的解决方案

一些开发者认为这样能解决问题：

*   创建 `@ViewBuilder` 函数
*   使用计算属性
*   将视图拆分成逻辑块

这些都不能真正解决问题。让我告诉你为什么，当你这样写时：

```swift
struct Counter: View {
    @State private var value = 0
    var body: some View {
        VStack(spacing: 20) {
            Button("Increment: \(value)") {
                value += 1
            }
            .background(Color.random)

            subView()
        }
    }

    @ViewBuilder
    func subView() -> some View {
        Text("Hellooo")
            .background(Color.random) // 每次 value 改变时都会改变
            // 因为每次 value 改变时方法都会被调用
    }
}
```

![xcode-view](https://www.swiftdifferently.com/_next/image?url=%2Fstatic%2Fimages%2Fblogs%2Fswiftui-pre-2.gif&w=1920&q=75)

在运行时，SwiftUI 看到的是这样：

```swift
var body: some View {
    VStack(spacing: 20) {
        Button("Increment: \(value)") {
            value += 1
        }
        .background(Color.random)

        Text("Hellooo")
            .background(Color.random)
    }
}
```

看起来眼熟吗？这和把所有东西写在一行完全一样。你让代码对人类来说*看起来*更整洁了，但在运行时呢？什么都没变，整个视图体仍然会重新执行。

计算属性的工作方式完全相同。

## 真正的解决方案：独立的视图结构体

修复方法很简单，将子视图提取到它们自己的 `struct` 中。

```swift
struct Counter: View {
    @State private var value = 0
    var body: some View {
        VStack(spacing: 20) {
            Button("Increment: \(value)") {
                value += 1
            }
            .background(Color.random)

            SubView()
        }
    }
}

struct SubView: View {
    var body: some View {
        Text("Hellooo")
            .background(Color.random)
    }
}
```

![xcode-view](https://www.swiftdifferently.com/_next/image?url=%2Fstatic%2Fimages%2Fblogs%2Fswiftui-pre-3.gif&w=1920&q=75)

现在当 `value` 改变时：

*   `Counter` 的视图体重新执行 → ✅
*   `SubView` 的视图体**不**重新执行 → ✅

为什么？因为 `SubView` 对 `value` 没有依赖。SwiftUI 看到 `SubView` 的输入没有任何改变，所以它完全跳过重新计算其视图体。

差异是天壤之别。在复杂视图中，这影响*巨大*。

## 边界情况：当你需要 Equatable 时

你可能会问："什么时候我应该为我的视图实现自定义 `Equatable` 一致性？"

答案是：当你的视图体在不应该重新计算时重新计算了。

这通常发生在你向视图传递闭包时。有时 SwiftUI 无法比较闭包的身份，这会触发不必要的重新计算。

在这种情况下，你需要 `Equatable` 一致性来告诉 SwiftUI 如何正确比较你的视图。否则？你不需要它。

最后一件事，如果你要做，至少要做对。很多开发者这样实现：

```swift
struct ContentView: View, Equatable {
    let closure: () -> Void  // 这可能会导致问题

    var body: some View {
        // ...
    }

    static func == (lhs: ContentView, rhs: ContentView) -> Bool {
        return true
    }
}

struct ContentMain: View {
    var body: some View {
        ContentView() // 这是错的
    }
}
```

这个实现是错误的，因为 SwiftUI 不知道 `ContentView` 是 equatable，这在 SwiftUI 进行 diffing 时可能会导致问题。

解决方案很简单，只需添加这个修饰符 `.equatable()`，它告诉 SwiftUI 这个视图是 equatable 的：

```swift
struct ContentMain: View {
    var body: some View {
        ContentView()
          .equatable()
    }
}
```

## 总结

SwiftUI 性能的关键不是魔法——而是理解渲染引擎的思维方式。

**规则很简单：**

*   状态改变触发视图体重新执行
*   SwiftUI 将结果与前一个视图体进行 diff
*   独立的结构体 = 独立的重新计算边界

下次你写 SwiftUI 视图时，花点时间想一想："当这个状态改变时，这个视图体会发生什么？"用随机颜色技巧来验证你的假设。

你不只是在写视图——你是在设计渲染树。让它高效。

♥️[在 GitHub 上赞助我](https://github.com/sponsors/EngOmarElsayed)
