# RepoPilot

**本地部署的 GitHub 仓库规范检查、自动化测试与修复 Agent。**

通过 Codex SDK 分析 PR 代码和描述，加载目标分支规范，运行基线与变更测试；发现可验证的问题后提出修复，验证通过再建立独立分支与草稿 PR。不会自动合并。

## 当前进度

0.1 开发预览已经包含 CLI、GitHub 轮询、可信规则检查、历史问题去重、Docker 测试执行器、Codex 容器适配器、修复验证及 GitHub 发布接口。

控制器与关键边界已有自动化测试。**首次交付环境没有 Docker，尚未完成真实 Codex 调用和 GitHub 自动修复 PR 的全链路验收。** 不应理解为已经可以无人值守用于生产。

## 启动

```powershell
npm ci
npm run build
Copy-Item repopilot.example.json config.local.json
```

修改配置中的 `repository`、测试镜像和命令，然后运行：

```powershell
npm run dev -- check --config config.local.json --repo D:/projects/example --base main --head feature
npm run dev -- watch --config config.local.json --once
```

- `check`：检查本地 Git 提交快照，不修改源工作区、不发布 GitHub 内容。
- `watch`：读取 GitHub PR，支持持续轮询；开启 `publish` 后才推送修复分支、创建草稿 PR。
- 结果：默认写入 `.repopilot-data/`，每个任务一个 JSON 报告。
- 缺少测试配置时明确显示 `not_run`，不能视为通过。

配置文件由本地维护者控制，不读取 PR 中的控制器配置。测试需要 Linux Docker 容器，默认禁止联网。依赖应预装到可信测试镜像中。示例使用无需外部依赖的 `node --test`。

## 规范检查

在被检查仓库的目标分支提交 `.repopilot/policy.json`，格式参考 [规则示例](examples/policy.json)。静态规则支持目录、扩展名、禁止文本及大小写选项；首版是字面文本匹配，尚不是 AST 分析器。

启用 Agent 后会额外按变更路径加载目标分支的根及嵌套 `AGENTS.md`。语义问题必须提供规则文件、代码位置和说明；证据不足或只有语义判断的问题不自动修复。

PR 中修改规则不影响本次检查使用的可信版本，且触发人工处理状态。修改行号不把旧违规误认为新违规；新增同类违规仍会报告。

## Codex 与自动修复

```powershell
docker build -f Dockerfile.agent -t repopilot-agent:local .
```

通过本地环境变量配置 `OPENAI_API_KEY`；GitHub 认证使用 `GITHUB_TOKEN` 或 `GH_TOKEN`。不要写入提交文件。首版 Agent 使用 API 认证，不读取桌面 ChatGPT 登录凭据。

依次开启配置项：

1. `agent.enabled`：启用语义检查。
2. `agent.repair`：允许有限轮次的修复建议与验证。
3. `publish`：允许 watcher 发布验证通过的分支和草稿 PR。

Agent 返回结构化文件替换建议；控制器验证路径后应用到独立快照，再由执行器运行测试。已有测试、规范、清单、锁文件、CI 配置均不允许被自动修改。GitHub 写入凭据不会交给测试或 Agent 容器。

修复分支格式：`autofix/pr-编号/任务ID`。发布前重新核验 base/head SHA，源 PR 更新则任务作废。同仓库 PR 的修复 PR 指向原功能分支。

## 已知限制与后续

- 首版仅支持公开、文本型、同仓库 PR；不接收 fork PR 自动执行。
- 不支持二进制、非 UTF-8、符号链接或子模块，遇到时明确报错。
- 单进程串行任务；使用原子 JSON 状态文件，后续按需求迁移 SQLite。
- 崩溃锁需要确认旧进程已停止后手动清理；报告和工作目录保留以便调查。
- 首版回归证据是测试套件级，尚未核验某一新增测试是否被发现、具体失败原因是否一致。
- 修复轮次与时间有限制，尚无 Token/金额预算、规则豁免管理、Web 界面或浏览器 E2E。

详细说明见 [英文 README](README.md)、[架构](docs/ARCHITECTURE.md) 和 [验证记录](docs/VERIFICATION.md)。
