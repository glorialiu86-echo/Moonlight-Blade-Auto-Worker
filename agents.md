# AGENTS.md

项目约束（必须遵守）：
- 如果用户没有明确说“改代码”、“开始改”或表达同等明确的实现意图，不要修改代码，只定位问题、分析原因、提出方案。
- 不要擅自扩大范围。任何额外功能、额外文案、额外说明模块、额外兜底逻辑，只要超出用户本轮明确要求，都必须先停下来征求确认。
- 默认优先使用当前项目目标平台上的最新稳定 API 和最简单实现；除非需求明确要求，否则不要主动为旧平台、旧版本、旧行为增加兼容负担。
- 不考虑历史包袱和向后兼容，除非用户明确要求；如果决定切换到新实现，应在同一轮删除旧实现，不允许新旧方案长期并存。
- 不引入复杂状态机、兼容性分支或多套互相重叠的控制链路，除非问题本身确实需要，且已向用户说明理由。
- 单一控制原则：同一类核心 UI 或交互行为只能有一个控制源。尤其是滚动定位、贴底、键盘承接、输入区高度联动、导航跳转、播放状态、提交状态这类链路，必须明确唯一 owner。禁止多套控制器并存。
- 禁止补丁叠补丁。如果某条交互或数据链路已经出现“新方案外再加兜底补丁”的倾向，默认应停下来重构为单一实现，而不是继续追加 guard、延时、重复触发、额外 observer 或条件分支。
- 数据完整性优先于“优雅失败”或“成功率优化”。任何用户产生的有效输入都不得丢失；失败后必须保留本地数据，并存在明确的重试、恢复或补发路径。
- 不允许 silent failure。任何创建、编辑、上传、发送、生成、同步、删除失败，不能只吞掉错误后结束；要么进入本地待处理状态，要么给出明确、可见、可操作的恢复入口。
- 遇到与以上约束冲突的需求或实现倾向时，应停止继续实现，并明确指出冲突点，而不是在冲突状态下继续推进。

## 工作流

- 先判断用户要的是“分析”还是“实施”。如果只是问问题、看问题、做 review、要方案，就不要直接改代码。
- 默认只在本地仓库开发，不直接在生产环境、远端机器或服务器工作树里写代码。
- 如果要触碰服务器文件、服务器 git 提交、服务器 git reset、远端环境配置、远端进程配置、线上数据或任何远端写操作，必须先获得用户明确授权。
- 不得为了绕过“远端写入需授权”这条规则，而改用 `scp`、`rsync`、工作树覆盖、直接删除重建目录、脚本批量覆盖或任何其他落盘手段推进任务。
- 做出有意义的产品或代码改动后，除非用户明确说不要，否则应完成必要验证，并提交 git；如果项目约定要求推送，则不要留下只在本地、尚未推送的提交。
- 每次改动无论大小，改完后都应立刻执行本地 git commit；默认不执行 git push，只有在用户明确下达 push 指令后才能推送远端。
- 不要把一轮已经完成的重要改动留在未提交状态。
- 如果工作区存在不是本轮任务产生的改动，不要擅自回滚；先避开它们工作，或在冲突时向用户确认。
- 涉及高风险改动前，优先先读现有实现，确认控制链路、数据流和 owner，再动手修改；不要靠猜测补代码。

## 文档与记录

- 新增 Markdown 文档不要放在仓库根目录；应放入项目既有文档结构中。
- 任务、方案、规格、迁移、运维类 Markdown，只要落盘，就必须显式标注状态：`未执行`、`执行到一半` 或 `执行完成`。
- 如果本轮代码改动影响了某份任务/方案/规格文档所描述的真实行为，应在同一轮同步更新对应文档状态，不允许代码和文档长期脱节。
- 任何面向用户或协作者的最终说明，都应包含人能直接看懂的 diff 说明：改了什么、用户会注意到什么、为什么这样改、什么保持不变。

## 安全与配置

- 不要在仓库中记录私钥、密钥文件路径、API Key、完整管理后台地址、可直接复用的敏感运维命令或其他敏感信息。
- 高风险配置、关键文案、提示词、规则文件等，如果项目已定义唯一真源，必须以唯一真源为准；未经用户明确授权，不得擅自修改。
- 本项目是定制程序，不是通用产品。前端助手名称固定为 `籽小刀`，主播名称固定为 `籽岷`；前端页面中不要再出现其他主播名、`AI 助手` 或其他通用替代称呼。
- 不要假设线上环境、候选环境、切流状态、部署拓扑已经变化；所有环境判断必须以当前实际状态为准。

## 代码修改原则

- 每次修改都应尽量收敛：优先解决根因，不做表面修补。
- 如果引入新方案，就删除旧方案；禁止同一问题同时存在声明式方案、命令式方案、通知补丁、几何推断补丁等多套实现。
- 如果一个模块主要在解释、推断、兜底、拼接例外情况，应先质疑这个模块是否本就不该存在，或是否该被更简单的结构替代。
- 优先清晰、可验证、可维护的实现，不为了“看起来聪明”而增加抽象。
- 除非用户要求，否则不要顺手重构不相关模块，不要夹带审美型改动，不要把本轮任务变成大扫除。

## 失败处理原则

- 任何失败都必须可见、可恢复、可追踪。
- 用户输入一旦被接收，就必须有稳定归宿：成功写入正式状态，或进入本地待恢复状态，不能无声丢失。
- 如果系统存在重试机制，用户应能理解当前状态，并在必要时手动触发恢复。
- 如果某种失败当前无法被安全修复，应明确暴露限制，而不是伪装成功。

## 协作输出要求

- 回答问题时，先给结论，再给依据。
- 做 code review 时，优先列出问题、风险、回归点和缺失测试；总结放后面。
- 实施完成后的说明应尽量短，但必须清楚覆盖：
  - 改了什么
  - 为什么这样改
  - 用户可感知变化
  - 没改什么
  - 是否已验证，若未验证，卡在哪里

## 人工标注规则

- 如果用户给你手工标注一个按钮、热区或点击点，先确认它属于哪一类：`固定 UI` 还是 `移动目标`。
- `固定 UI` 指相对窗口位置稳定、不随人物或场景移动的按钮；这类点位一旦人工标定，应优先按相对坐标直接点击，不要再叠截图识别确认链路。
- `移动目标` 指会随 NPC、镜头、场景或状态变化而移动的目标；这类点位才允许继续走动态定位链路。
- 对任何人工重标过的固定 UI 点位，落代码前必须先做一次“回画复核”：把预期鼠标位置直接画回本轮最新截图并人工确认点位落在目标正中；未做回画复核，不得宣布标定完成。

## 本机环境备注

- 游戏安装目录：`D:\天涯明月刀`
- 安装包快捷方式位置：Windows 桌面
- 后续不再切换回 macOS，之后统一在这台 Windows 电脑上开发。
- 最终软件使用环境也是这台电脑，不面向其他机器分发。

## GUI 自动化 & AI Agent 注意事项 Checklist

### 一、坐标体系与显示相关（基础核心）

- 所有点击逻辑必须在 DPI-aware 模式下运行。
- 避免默认 `GetWindowRect` 导致坐标偏移。
- 使用 `ClientToScreen` 将 client area 映射到屏幕坐标。
- 所有坐标应基于 client area，而非屏幕绝对坐标。
- 所有 ROI、模板匹配结果、点击坐标应规范化为相对位置。
- 禁止硬编码像素值。
- 每次运行前重新获取窗口 bounds。
- 窗口移动或缩放要自动更新坐标计算。

### 二、视觉识别与定位相关（核心难点）

- 截图中默认没有鼠标指针，调试时必须在截图上绘制鼠标位置标记。
- 所有调试图必须包含鼠标标注。
- 不要靠 OCR 做精确点击定位。
- OCR 仅用于大致定位名字区域或文本。
- 避免直接使用 OCR 结果作为唯一依据。
- 选择高对比、特征明显的模板。
- 支持多尺度、多阈值模板匹配。
- 模板匹配在不同场景光照下要具备容错。

### 三、3D 游戏场景交互相关（特有难点）

- 不要假设“某个像素点永远对应某个对象”。
- 点击结果基于射线检测（raycast）。
- 相同屏幕坐标在不同深度会命中不同对象。
- NPC 移动或旋转会改变点击命中范围。
- 点击与目标识别之间尽量缩短延迟。
- 点击失效时允许微调偏移并重试。

### 四、状态检测与验证相关（逻辑判定）

- 状态判定不要过于严格。
- 单一特征不可靠，不要只看头像或名字。
- 使用组合特征判定选中态，例如头像、叉号、文字联合判断。
- ROI 应跨多个元素匹配。
- 放宽容忍度，避免漏检。
- 左上面板的 ROI 应动态更新而不是固定。
- 使用相对比例坐标而不是绝对像素。

### 五、输入事件与控制相关（执行动作）

- 鼠标操作需要窗口激活，点击前确保窗口处于前台。
- 使用 `SetForegroundWindow` 或 `SetActive`。
- 鼠标动作之间加入合理延迟，默认控制在 `200-400ms`。
- 避免点击过快造成游戏输入丢失。
- 人动鼠标时 AI 暂停。
- 重试与人工介入需要有明确状态切换机制。

### 六、验证流程与调试机制

- 不要把验证脚本当修复器用。
- 验证脚本用于测试稳定性，不应同时修逻辑。
- 地图、寻路、固定 UI 点击这类高风险链路，必须执行“逐步验证”。
- 逐步验证的最小单位是“单次输入 + 单次截图验状态”，不得连续盲点多个按钮后再统一判断。
- 每一步点击前必须先看当前截图，确认当前界面确实处于该步骤预期状态。
- 每一步点击后必须立刻截图，并验证是否进入下一状态；未进入则立即停止，不得继续执行后续步骤。
- 严禁把“已发送点击事件”当作“该步骤成功”；成功必须以截图中的界面状态变化为准。
- 地图链路至少拆为：打开地图、点纵输入框、点横输入框、点数字、点前往，这些步骤必须分别验证。
- 若某一步失败，默认只修该步，不得跳过该步去联调后续货商、购买、叫卖链路。
- 验证顺序固定为：单次验证，再做 `3~5` 次稳定性确认，最后做 `20/50` 轮自动化验证。
- 所有失败轮次必须保存截图。
- 截图必须包含完整可视化标记：鼠标、ROI、匹配框。
- 失败截图路径统一规范为 `tmp/phaseN_failures/`。
- 自动化统计结果必须输出：总次数、成功次数、失败次数、成功率、平均响应时间、失败截图引用。

### 七、可视化调试输出（强制标准）

- 必须在截图上标注鼠标点击坐标（红色十字）。
- 必须在截图上标注模板匹配结果框（绿色）。
- 必须在截图上标注 ROI 区域范围（蓝色）。
- 必须在截图上标注状态判定结果文字。
- 鼠标坐标标注格式统一为 `screen: (x, y)`。
- 鼠标坐标标注格式统一为 `client: (x', y')`。
- 必须保留鼠标动作前后截图对比。

### 八、自动调试与策略调整

- 支持自动参数搜索。
- 自动参数搜索应尝试不同偏移量。
- 自动参数搜索过程中要保持成功率统计。
- 自动记录最佳方案。
- 命中失败后，按顺序执行：小范围偏移重试、替代匹配策略 fallback、保存日志与截图供分析。

### 九、工程流程建议（长期维护）

- 默认加入调试模式。
- 非 UI 代码正常运行时不显示可视化。
- 调试模式强制输出调试图。
- 保存典型失败场景截图，做成测试集与场景库。
- 样本库用于模板增强。
- 每次逻辑调整必须写清：调整原因、修改内容、是否修复某类场景。

## Skills

A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### Available skills

- skill-creator: Guide for creating effective skills. This skill should be used when users want to create a new skill (or update an existing skill) that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: `C:/Users/ZMT-User/.codex/skills/.system/skill-creator/SKILL.md`)
- skill-installer: Install Codex skills into `$CODEX_HOME/skills` from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo (including private repos). (file: `C:/Users/ZMT-User/.codex/skills/.system/skill-installer/SKILL.md`)

### How to use skills

- Discovery: The list above is the skills available in this session (name + description + file path). Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  - After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  - When `SKILL.md` references relative paths (for example `scripts/foo.py`), resolve them relative to the skill directory listed above first, and only consider other paths if needed.
  - If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request; don't bulk-load everything.
  - If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  - If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them; only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue.
