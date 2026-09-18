# RepoPilot

**本地部署的 GitHub 仓库规范检查、自动化测试与修复 Agent。**

读取 PR 代码与描述，用 Codex SDK 审查规范和生成测试；在独立快照中验证问题、提出修复，验证通过后建立独立分支与草稿 PR。不会自动合并。

## 已实现的代码功能

- GitHub 轮询和本地提交比较；任务固定 base/head SHA、PR 标题及描述摘要。
- 从 base 读取规则，支持嵌套 AGENTS.md、静态文本规则、JS/TS AST 调用规则、规则冲突检查、历史问题去重及带有效期的规则豁免。
- 语义结论必须引用可信规范原文和对应代码证据。
- 根据 PR 需求主动生成测试计划和新测试文件；生成后冻结，修复阶段不能改动。
- Node 内置测试与 Vitest JSON 用例解析；零测试、全跳过、报告异常不能算通过。
- 使用文件路径和完整用例名定位测试，重复失败指纹一致才进入回归修复；修复后核验相同用例通过。
- 检查原始基线用例是否被删除、跳过或隐藏；拒绝通过修改测试、配置和规范来修复。
- 活跃任务过期检测、取消传递到子进程、任务总超时、模型调用次数与返回 Token 用量预算。
- 临时错误有限重试、持久化执行次数、重试退避、失败执行归档。
- GitHub 发布前重新校验输入，保留文件可执行权限，验证已有修复分支/PR 是否匹配本次证据。
- JSON 完整报告和 Markdown 摘要，记录测试计划、每次执行、修复候选及拒绝原因。

## 启动

需要 Node.js 22、Git，以及用于执行目标测试和 Agent 的 Linux Docker 容器。

```powershell
npm ci
npm run check
npm test
npm run build
Copy-Item repopilot.example.json config.local.json
```

修改 repository、测试镜像和命令：

```powershell
npm run dev -- check --config config.local.json --repo D:/projects/example --base main --head feature
npm run dev -- watch --config config.local.json --once
```

check 不修改源工作区、不发布 GitHub 内容。watch 持续或单次轮询；publish 开启时才发布修复 PR。控制器配置放在受审查快照之外。

默认使用 runner.reporter=node 和 node --test。Vitest 需要设置 reporter=vitest，命令使用可信镜像中已安装的 vitest run；依赖预装在镜像中，执行时禁止联网。reporter=command 仅收集命令输出，不能用于验证或发布。先执行 npm run build，生成可信 Node reporter。

## Codex 与凭据

```powershell
docker build -f Dockerfile.agent -t repopilot-agent:local .
```

OPENAI_API_KEY 只传给 Agent 容器；GITHUB_TOKEN 或 GH_TOKEN 留在控制器。使用 API 认证，不复用桌面 ChatGPT 登录凭据。

agent.enabled 开启语义审查和测试规划；agent.repair 开启有限轮次修复；publish 开启验证后发布。模型不获取 GitHub 写入凭据，也不直接操作原仓库。

## 自动修复判定

可信基线测试必须通过。新测试应在基线上执行并通过；变更版本失败时，还要重复执行并获得相同失败用例及指纹。修复候选必须让原始基线、原始 head 和冻结测试中的用例全部继续通过，且静态与语义复查没有新增错误。

新功能需求导致生成测试在基线失败时，当前实现保守转人工处理，不自动将新行为认定为回归。测试全部通过但存在可定位的规范错误，也可以尝试修复并独立复查。

修改规范的 PR 一律人工处理，使用 base 规范不会被 PR 中的修改覆盖。AST 规则支持直接调用及字符串属性访问，不做跨文件符号解析；自然语言冲突仍需人工判断。

## 配置和运行记录

参考 [配置示例](repopilot.example.json)、[规则示例](examples/policy.json) 和 [架构说明](docs/ARCHITECTURE.md)。

结果保存在 .repopilot-data 下的任务 JSON 和 Markdown 中。重试前把上一执行保存为 任务ID.execution-次数.json。任务结束后可复用终态报告；输入变更会产生新任务。

maxCalls 限制每次任务执行的模型调用数量。maxTokens 根据每次模型返回的用量累计，超限阻止后续调用；单次调用可能越过阈值，它不是预付费额度或金额硬上限。maxTaskExecutions 同时限制崩溃恢复和临时错误重跑。

## 当前边界

代码已增加离线回归验证；本轮不运行真实 Docker、Codex 推理或 GitHub 修复闭环。具体覆盖见 [验证记录](docs/VERIFICATION.md)。

首版处理公开、文本型、同仓库 PR；不自动执行 fork PR。二进制、符号链接、子模块及大小写冲突路径会报错。单控制器串行执行；崩溃遗留锁仍需确认旧进程停止后人工清理。没有 Web 界面、分布式队列、浏览器 E2E、自动安装依赖或自动合并。

报告可能包含代码和日志，请按项目的数据保留要求管理。JSON 保留完整的受大小限制输出，Markdown 和 PR 展示截短摘要。独立开源项目，非 OpenAI 官方产品。
