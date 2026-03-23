<img src="docs/icon-readme.png" width="32" height="32" alt="CodePilot" style="vertical-align: middle; margin-right: 8px;" /> CodePilot
===

**一个面向中文用户和远程桥接场景强化过的 CodePilot 分支。**

本仓库基于上游 [op7418/CodePilot](https://github.com/op7418/CodePilot) 持续同步，当前分支已吸收上游 `v0.38.5` 的能力，并保留这一分支针对飞书桥接、多 Provider 接入、企业网关适配和本地打包发布做的定制增强。

[![GitHub release](https://img.shields.io/github/v/release/Leondav1s/CodePilot)](https://github.com/Leondav1s/CodePilot/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](https://github.com/Leondav1s/CodePilot/releases)
[![License](https://img.shields.io/badge/license-BSL--1.1-orange)](LICENSE)

![CodePilot](docs/screenshot.png)

---

[下载](#下载与安装) | [快速开始](#快速开始) | [与原版不同](#与原版不同) | [开发说明](#开发说明) | [致谢](#致谢)

---

## 项目定位

这个 fork 适合两类使用方式：

- 想把 `CodePilot` 当作本地桌面端的 Claude Code / 多模型工作台来用
- 想把飞书、Telegram 等桥接通道当成“远程入口”，让消息落回本机执行，再把结果回传

如果你只是想体验上游原汁原味的能力，可以直接使用原版；如果你更关注中文场景、企业网关、自定义 Provider、飞书桥接和更顺手的本地发布，这个分支会更合适。

## 与原版不同

### 1. 更强调桥接作为“本地执行入口”

- 保留上游 Bridge 体系，同时增强了桥接会话对 Provider / Model 的绑定与切换逻辑
- 更适合把飞书、Telegram 等通道当成远程控制面板，而不是纯聊天机器人
- 对桥接会话的模型切换、工作目录、自愈逻辑和本地执行链路做了兼容整理

### 2. 扩展了非 Claude Provider 的聊天接入

- 对 Gemini、OpenAI-compatible、OpenRouter 一类文本模型补了标准文本链路分流
- 避免所有 Provider 都被强行走 Claude Code 进程，减少 `PROCESS_CRASH` 一类错误
- 让“文本聊天模型”和“本地可执行模型”在行为上区分得更清楚

### 3. 强化了飞书场景

- 针对飞书 Bridge 的模型切换、消息渲染和表格展示做了额外处理
- Markdown 表格会优先转换成更适合飞书展示的卡片/结构化内容，减少内容丢失
- 保留了飞书作为企业 IM 入口时更常见的中文工作流

### 4. 更适合企业内网或自定义网关

- 更方便接入 Anthropic-compatible / OpenAI-compatible 的自定义网关
- 对企业内网模型网关、模型别名映射和多 Provider 并存场景做了更多兼容
- 更适合同时混用 Claude、Gemini、企业代理模型和自定义模型列表

### 5. 修过一轮本地打包与发布链路

- 修复了 Electron 打包后 standalone 输出路径嵌套导致的 `server.js` 缺失问题
- 补通了 macOS 本地构建和 GitHub Actions 发布流程
- 让这一分支更容易直接产出可安装的 DMG / 桌面应用

## 核心能力

### 桌面工作台

- Claude Code 风格的本地桌面客户端
- Code / Plan / Ask 多种交互模式
- 会话暂停、恢复、回退、归档
- 双会话分屏
- 项目文件浏览、附件和多模态输入

### 扩展能力

- 多 Provider 支持
- MCP 服务器接入
- Skills 技能体系
- CLI 会话导入
- 本地 SQLite 存储

### 桥接能力

- Telegram / 飞书 / Discord / QQ
- 桥接会话与桌面会话共用模型体系
- 更适合把外部 IM 当成本地执行入口

## 下载与安装

直接从本仓库的 [Releases](https://github.com/Leondav1s/CodePilot/releases) 页面下载对应平台的安装包。

支持平台：

- macOS：`.dmg`
- Windows：`.exe`
- Linux：`.AppImage` / `.deb` / `.rpm`

首次使用前，建议先确保本机已安装并可运行：

```bash
npm install -g @anthropic-ai/claude-code
claude login
```

如果你主要依赖自定义 Provider，也可以在应用内自行配置对应的网关地址、模型和认证信息。

## 快速开始

### 方式一：直接运行发布版

1. 安装 Claude Code CLI
2. 运行 `claude login`
3. 从 [Releases](https://github.com/Leondav1s/CodePilot/releases) 下载安装包
4. 打开 CodePilot
5. 在应用内配置你要使用的 Provider、Bridge 和工作目录

### 方式二：从源码启动

```bash
git clone https://github.com/Leondav1s/CodePilot.git
cd CodePilot
npm install
npm run dev
# 或
npm run electron:dev
```

## 使用建议

### 如果你主要想本地执行任务

- 优先使用 Claude Code / Anthropic-compatible Provider
- 这类 Provider 更适合作为真正可读写文件、调用工具、执行命令的本地执行链路

### 如果你主要想接更多聊天模型

- 可以配置 Gemini、OpenAI-compatible、OpenRouter 等文本模型
- 这类模型更适合问答、总结、解释，不一定具备本地执行能力

### 如果你主要想在飞书里使用

- 先在桌面端把 Bridge 配好
- 再根据需要为桥接会话选择更适合的 Provider / Model
- 对结构化结果、表格类输出，优先使用这个 fork 的飞书渲染增强

## 开发说明

常用命令：

```bash
npm install
npm run dev
npm run electron:dev
npm run lint
npm run test
```

如果你要打包桌面应用：

```bash
npm run electron:build
```

这个 fork 对 Electron 打包链路做过额外修正，主要是为了确保 Next standalone 输出能被 Electron 正确识别并启动内部 server。

## 与上游同步策略

- 这个分支不是脱离上游重写，而是持续基于上游版本演进
- 同步上游时，优先保留这一分支在 Bridge、Provider、飞书渲染和打包链路上的定制
- 如果你要继续二次开发，建议在同步上游时重点关注：
  - `src/app/api/chat/route.ts`
  - `src/lib/bridge/conversation-engine.ts`
  - `src/lib/bridge/bridge-manager.ts`
  - `src/lib/channels/feishu/`
  - `scripts/build-electron.mjs`
  - `next.config.ts`

## 适合谁

- 希望把 CodePilot 作为中文桌面工作台使用的人
- 需要飞书桥接而不是只用 Telegram 的团队
- 需要接企业内网模型网关或自定义 Provider 的团队
- 想把远程 IM 消息真正落到本地执行的人

## 致谢

这个分支建立在原版 [op7418/CodePilot](https://github.com/op7418/CodePilot) 的优秀工作之上。

感谢原版作者和社区把 CodePilot 打造成一个已经非常完整、可扩展、可持续演进的桌面客户端；这个 fork 所做的工作，本质上是在尊重原版设计的基础上，针对中文团队、飞书桥接和企业使用场景做进一步定制。
