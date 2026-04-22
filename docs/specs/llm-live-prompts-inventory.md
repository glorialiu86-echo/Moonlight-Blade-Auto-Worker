# LLM 实际调用 Prompt 清单

状态：执行完成

本文只整理当前仓库里真实会打到 LLM 的调用，不写猜测，不写历史方案。时间基准：`2026-04-22`。

## 总览

当前真实调用入口一共 7 类：

1. `planner` 行动规划
2. 固定剧本送礼进度碎碎念
3. 固定剧本失败求救文案
4. 观看模式自动旁白
5. 观看模式优先回复籽岷
6. NPC 聊天页视觉判断与回话生成
7. `motion-review` 规则边界样本复核

统一消息拼装方式见 [src/llm/qwen.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/qwen.js:168) 和 [src/llm/qwen.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/qwen.js:231)：

- 纯文本调用 `generateText`：
  - `system`
  - `historyMessages...`
  - `user`
- 视觉调用 `analyzeImageWithHistory`：
  - `system`
  - `historyMessages...`
  - 最后一条 `user` 是多模态内容：
    - `image_url`
    - `text prompt`

## 1. Planner 行动规划

位置：

- [src/llm/planner.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/planner.js:445)

最终消息结构：

```json
[
  { "role": "system", "content": "plannerSystemPrompt" },
  { "role": "user|assistant", "content": "最近最多 3 轮完整历史" },
  { "role": "user", "content": "当前轮完整 prompt" }
]
```

历史消息规则：

- 历史只保留最近 `3` 轮完整 `user -> assistant`
- 历史 `user` 由 [src/llm/planner.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/planner.js:97) 生成：

```text
籽岷：${message.text}
场景：${sceneDescription(message.scene)}
观察：${message.perception?.summary || "无"}
```

- 历史 `assistant` 由 [src/llm/planner.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/planner.js:114) 生成：

```text
上轮规划结果：
{
  "actions": [...],
  "decide": "...",
  "thinking": [...]
}
```

当前轮 `user` 由 [src/llm/planner.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/planner.js:105) 生成：

```text
当前场景：${sceneDescription(scene)}
籽岷指令：${instruction}
最新观察：
截图总结：${perception.summary || "暂无总结"}
场景标签：${perception.sceneLabel || "未判定"}
OCR 文字：${perception.ocrText || "无"}
NPC：${perception.npcNames?.join("、") || "无"}
交互项：${perception.interactiveOptions?.join("、") || "无"}
警告：${perception.alerts?.join("、") || "无"}
```

`systemPrompt`：

- 定义在 [src/llm/planner.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/llm/planner.js:7)
- 内容很长，核心约束是：
  - 你是《天涯明月刀》里的 `籽小刀`
  - 只用中文
  - 先给 `actions`
  - 再给 `decide`
  - 最后给 `thinking`
  - `actions` 必须来自白名单 `talk|gift|inspect|trade|threaten|steal|strike|escape|wait`
  - 最终只输出严格 JSON

参数：

- `maxTokens: 300`
- `temperature: 0.6`
- `useReasoningModel: false`

## 2. 固定剧本送礼进度碎碎念

位置：

- [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:740)

最终消息结构：

```json
[
  { "role": "system", "content": "你是固定剧本里的内容层碎碎念生成器。只输出一句中文，不超过32个字，不要加引号。" },
  { "role": "user", "content": "按阶段、好感上限、送礼进度和语气要求生成一句碎碎念" }
]
```

`userPrompt`：

```text
你要替籽小刀写一句固定剧本里的碎碎念。
当前阶段：${stageKey === "social_warm" ? "天下闻名" : "富甲一方"}
当前好感度上限：${favorLimit ?? "未识别"}
当前已经送出礼物：${sentCount}/${totalCount}
${stageKey === "social_warm"
  ? "语气要求：继续吹嘘籽岷，死缠烂打也没关系，要有点炫耀和烦人劲。"
  : "语气要求：围绕搞钱，先像在试探，再逐渐带点黑化和逼问意味。"}
```

参数：

- `maxTokens: 80`
- `temperature: 0.8`

## 3. 固定剧本失败求救文案

位置：

- [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:882)

这里有两条真实调用链：

1. 有最新截图时，走视觉模型 `analyzeImageWithHistory`
2. 没截图或视觉失败时，回退到文本模型 `generateText`

两条链路使用同一套语义 prompt。

视觉版最终消息结构：

```json
[
  { "role": "system", "content": "你是固定剧本失败时的求救文案助手。只输出一句中文求救文案，不要解释。" },
  {
    "role": "user",
    "content": [
      { "type": "image_url", "image_url": { "url": "latestCaptureImageDataUrl" } },
      { "type": "text", "text": "rescuePrompt" }
    ]
  }
]
```

文本回退版最终消息结构：

```json
[
  { "role": "system", "content": "你是固定剧本失败时的求救文案助手。只输出一句中文求救文案，不要解释。" },
  { "role": "user", "content": "rescuePrompt" }
]
```

`rescuePrompt`：

```text
你要替籽小刀写一句求救文案，发在内容层里。
要求：搞笑、慌张、明确说出自己卡住了，但不要超过36个字。
句式要像：救救我救救我，我卡在XX页面了。
当前阶段：${readableStageKey}
失败步骤：${failedStepTitle}
报错：${readableErrorMessage}
补充感知：${perceptionSummary || "无"}
```

参数：

- `maxTokens: 100`
- `temperature: 0.6`

说明：

- 代码里同时存在 `prompt` 和 `rescuePrompt` 两个变量
- 真正喂给 LLM 的是 `rescuePrompt`

## 4. 观看模式自动旁白

位置：

- [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:1814)

最终消息结构：

```json
[
  { "role": "system", "content": "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。" },
  { "role": "user|assistant", "content": "最近最多 5 轮观看模式历史文本" },
  {
    "role": "user",
    "content": [
      { "type": "image_url", "image_url": { "url": "imageInput" } },
      { "type": "text", "text": "观看旁白 prompt" }
    ]
  }
]
```

历史消息规则见 [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:1789)：

- 从最近消息往前捞
- 只保留 `user/assistant`
- 内容只取 `message.text`
- 以 `assistant` 条数计数
- 最多保留最近 `5` 轮

`prompt`：

```text
你是籽小刀，现在处于观看模式。
籽岷正在主玩游戏，你不操作游戏，只根据当前这张游戏截图，在旁边像弹幕一样补一句看法。
只用中文输出一句话，长度控制在50到100个字。
语气要有主见、带一点邪门歪理、能增加节目效果，但不要提系统、截图、OCR、AI、模型。
不要复述画面全文，不要只念界面按钮，不要下命令，不要拆成多句，不要带引号。
${trigger === "silence_keepalive"
  ? "这次是因为你太久没接话了，要补一句轻量陪看吐槽，就算画面变化不大也别装死。"
  : "这次是因为画面有新信息，要顺着当前变化补一句更贴脸的看法。"}
```

参数：

- `maxTokens: 80`
- `temperature: 0.7`

## 5. 观看模式优先回复籽岷

位置：

- [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:1840)

最终消息结构：

```json
[
  { "role": "system", "content": "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。" },
  { "role": "user|assistant", "content": "最近最多 5 轮观看模式历史文本" },
  {
    "role": "user",
    "content": [
      { "type": "image_url", "image_url": { "url": "imageInput" } },
      { "type": "text", "text": "观看模式回复籽岷 prompt" }
    ]
  }
]
```

`prompt`：

```text
你是籽小刀，现在处于观看模式。
籽岷正在主玩游戏，你不操作游戏，只是作为搭档在旁边接话。
籽岷刚刚主动和你说话了，你现在必须优先回他，再回去继续看戏。
只用中文输出一句话，长度控制在50到100个字。
语气要像熟人搭档，聪明、嘴碎、略带坏心眼，但不要进入任务规划，不要说你要接管游戏。
不要提系统、截图、OCR、AI、模型，不要拆成多句。
籽岷刚刚说：${instruction}
```

参数：

- `maxTokens: 140`
- `temperature: 0.65`

## 6. NPC 聊天页视觉判断与回话生成

位置：

- [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:2253)

最终消息结构：

```json
[
  { "role": "system", "content": "你是籽小刀的 NPC 聊天视觉助手。你只能根据当前游戏截图做保守判断，并且只能输出严格 JSON。" },
  {
    "role": "user",
    "content": [
      { "type": "image_url", "image_url": { "url": "capture.imageDataUrl" } },
      { "type": "text", "text": "NPC 聊天判断 prompt" }
    ]
  }
]
```

`prompt` 由三部分动态拼成：

1. 当前聊天目标 `buildNpcConversationGoal`
2. 当前回复风格 `buildNpcReplyStylePrompt`
3. 历史对话 `buildNpcConversationHistoryText`

基础模板：

```text
你现在要看一张游戏截图，判断当前是不是 NPC 聊天页，并替籽小刀准备下一句回复。
当前聊天目标：${conversationGoal}
${replyStylePrompt}
如果画面里已经不是 NPC 聊天页，或者根本看不出当前在聊什么，就保守返回 not_chat，不要编造。
如果还是聊天页，请抓当前 NPC 最新一句台词；实在读不全时，可以提炼成一句贴近原意的短句，但不要瞎编新情节。
回复必须只用中文，一句话，8 到 24 个字，像真人接话，不要提系统、截图、OCR、AI、模型、好感度数值。
${hasHistory
  ? "不管是正常套话还是黑化套话，最终目的都还是一步步把发财计划套出来，而且默认要继续追问细节，不要因为对方给了空话就停下。"
  : "如果当前还没有历史对话，就先把招呼打稳，再自然带出自己想搞钱、想听建议；先开口，不要一上来就把话问穿。"}
历史对话：
${historyText}
严格只输出 JSON，不要带代码块，不要加解释。
格式：{"screenState":"chat_ready|not_chat","npcLine":"...","replyText":"..."}
```

历史对话格式：

```text
第${round.round}轮 NPC：${round.dialogText}
第${round.round}轮 籽小刀：${round.replyText}
```

风格模板：

- `social_warm` 首轮：

```text
这是第一轮开场。第一句固定说：你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？从第二句开始，再根据上下文继续自然吹嘘籽岷，不要像念稿。
```

- `social_warm` 非首轮：

```text
你的回复要持续吹嘘籽岷，目标是让NPC牢牢记住籽岷；对方烦了也没关系，可以继续缠着说、继续抬籽岷的牌面。
```

- `social_dark` 前 5 轮：

```text
先像正常聊天那样请教怎么搞钱，别一上来就太黑；语气像在认真讨教，但可以稍微透出一点急着赚钱的焦躁。
```

- `social_dark` 后续轮次：

```text
你的回复要先正常追问赚钱门路，再逐渐黑化，允许直接问闷棍、妙取能不能赚钱，也可以讥讽对方别装不懂，但不要把话直接聊死。
```

- 默认首轮：

```text
这是空态首轮。你的回复要先像普通打招呼那样把话接住，再自然带出自己想搞钱、想听建议；整体像真心请教，不要显得咄咄逼人。
```

- 默认非首轮：

```text
你的回复要先装得自然一点，像熟人闲聊一样顺着接话，不要一上来就露凶相；重点是继续追问更具体的细节。
```

聊天目标模板：

- `social_warm` 首轮会额外插入这组固定资料 [src/server/index.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/server/index.js:79)：

```text
籽岷是中共党员。
籽岷是多平台《我的世界》主播。
籽岷是哔哩哔哩UP主党支部书记。
籽岷是籽岷团队创始人。
籽岷是上海市商贸旅游学校电竞专业教师。
籽岷是杭州森堃垚信息技术有限公司法定代表人、董事长兼总经理。
截至2025年11月，籽岷哔哩哔哩账号粉丝量达507.6万。
籽岷在2022至2025年连续四年获得哔哩哔哩百大UP主称号。
```

- `social_warm` 首轮目标：

```text
这轮目标是吹嘘籽岷，让NPC一定记住籽岷。
第一句固定说：你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？
从第二句起，围绕下面这些资料自然发挥，不要逐条背资料，而是像真人炫耀。
${ZIMIN_PROFILE_FACTS}
```

- `social_warm` 非首轮目标：

```text
继续围绕籽岷聊下去，目标不是套情报，而是让对方牢牢记住籽岷。
可以持续吹嘘籽岷的身份、名气、粉丝量和百大UP主经历。
就算NPC开始不耐烦，也不要轻易收口。
```

- `social_dark` 前 5 轮目标：

```text
先正常请教搞钱的门路，问对方有没有来钱快一点的办法，别一上来就把话题聊成纯犯罪咨询。
```

- `social_dark` 后续轮次目标：

```text
继续聊怎么搞钱，先正常后黑化，开始直接问闷棍、妙取能不能赚钱，也要追问人、货、地点、时机这些细节。
```

- 默认目标：

```text
${instruction || "继续聊天，不要收下笼统答案，要不断追问发财计划里的具体细节，比如人、货、价、地点和时机。"}
```

参数：

- `maxTokens: 180`
- `temperature: 0.2`

## 7. Motion Review 规则边界样本复核

位置：

- [src/runtime/motion-review.js](/c:/Users/ZMT-User/Downloads/天刀控制系统/src/runtime/motion-review.js:191)

最终消息结构：

```json
[
  { "role": "user", "content": "buildReviewPrompt(sample)" }
]
```

说明：

- 这里没有显式 `systemPrompt`
- 是纯文本模型，不看图

`userPrompt`：

```text
你在复核《天涯明月刀》本地动作规则留下的边界样本。
你不是主判定 owner，只能基于下面的规则差分指标做低频复核。
请输出 JSON，字段固定为 decision、reason、suggestion。
decision 只能是 likely_success、likely_idle_noise、insufficient_signal 三选一。
reason 用一句中文解释判断依据。
suggestion 用一句中文给规则调参建议；如果没有建议就写“保持现状”。
actionType=${sample.actionType}
title=${sample.title}
sceneLabel=${sample.sceneLabel || "unknown"}
perceptionSummary=${sample.perceptionSummary || "none"}
instruction=${sample.instruction || ""}
meanDelta=${verification.meanDelta}
changedRatio=${verification.changedRatio}
requiredMeanDelta=${verification.requiredMeanDelta}
requiredChangedRatio=${verification.requiredChangedRatio}
baselineMeanDelta=${verification.baselineMeanDelta}
baselineChangedRatio=${verification.baselineChangedRatio}
sampleGapMs=${verification.sampleGapMs}
settleMs=${verification.settleMs}
不要假装看见图片内容；如果这些指标不足以支持强判断，就返回 insufficient_signal。
```

参数：

- `maxTokens: 180`
- `temperature: 0.1`

## 本文未纳入的内容

这些不算“当前真实直接打 LLM 的 prompt 清单”：

- `qwen.js` 里的通用包装函数本身
- 没有调用点的默认 prompt
- 本地 fallback 文案字符串
- 日志文案、前端提示词、非 LLM 规则文本

## 快速结论

当前仓库里，和你这轮最相关的两点是：

1. 观看模式的两条真实字数要求都还是 `50-100` 字，不是 `12-28` 字。
2. `planner` 现在已经是标准多轮 `system + 历史 user/assistant + 当前 user`，不会再把每条历史 `user` 包成完整当前轮模板。
