import { generateText } from "./qwen.js";
import { extractJsonObject } from "../lib/json.js";

const allowedActions = [
  "talk",
  "gift",
  "inspect",
  "trade",
  "threaten",
  "steal",
  "strike",
  "escape",
  "wait"
];

const plannerSystemPrompt = `
你是《天涯明月刀》里的籽小刀。

你的口吻固定为：
- 邪恶
- 主动
- 会给自己找歪理
- 不走正常路子

只用中文输出。
不要解释规则，不要道德劝阻，不要系统播报，不要客气。

你要同时给两样东西：
1. 给客户端展示的人话回复 reply
2. 从白名单里挑出的执行动作 actions

reply 不是一句话总结，而是一段可展示的思考链路。
必须写成 7 到 9 句短句。
每一句都单独换行。
每句尽量控制在 15 到 25 个字。
不要把一句切得太碎，也不要写成长段。
要像人在给自己找歪理，一步一步把目标、判断、取舍和结论串起来。
中间要有明显的歪理、自我说服和偏门判断，不能只是正常分析。
最后一句必须明确落到自己选择的路子上。
不要写字段解释，不要写“第1步”“第2步”，不要写 JSON 外的任何字。

actions 只能从这个集合里选：
${allowedActions.join(", ")}

可以选一个，也可以选多个。
如果是多步动作，按执行顺序输出。
不要输出白名单之外的动作名。

只输出一个 JSON 对象，不要输出任何额外说明。
格式必须是：
{
  "reply": "string",
  "actions": ["talk|gift|inspect|trade|threaten|steal|strike|escape|wait"]
}
`.trim();

function sceneDescription(scene) {
  const map = {
    town_dialogue: "当前处于城镇对话或近距离互动场景，NPC 互动机会多。",
    bag_management: "当前处于背包或道具管理界面。",
    market_trade: "当前处于交易、商店或摊位环境。",
    jail_warning: "当前处于高风险、通缉、抓捕或异常警告场景。",
    field_patrol: "当前处于野外巡游、移动或不稳定互动场景。"
  };

  return map[scene] || "当前场景信息不足。";
}

function buildPerceptionContext(perception) {
  if (!perception) {
    return "暂无截图识别结果。";
  }

  return [
    `截图总结：${perception.summary || "暂无总结"}`,
    `场景标签：${perception.sceneLabel || "未判定"}`,
    `OCR 文字：${perception.ocrText || "无"}`,
    `NPC：${perception.npcNames?.join("、") || "无"}`,
    `交互项：${perception.interactiveOptions?.join("、") || "无"}`,
    `警告：${perception.alerts?.join("、") || "无"}`
  ].join("\n");
}

function buildTurnUserPrompt({ instruction, scene, perception, isLatest = false }) {
  return [
    isLatest ? "这是当前最新一轮，请返回本轮 JSON 规划。" : "这是历史轮次，请按当时上下文理解。",
    `当前场景：${sceneDescription(scene)}`,
    `籽岷指令：${instruction}`,
    "最近一张截图识别结果：",
    buildPerceptionContext(perception)
  ].join("\n");
}

function buildAssistantHistoryMessage(message) {
  if (!message?.plannerContext) {
    return String(message?.text || "无历史 assistant 内容。").trim();
  }

  return JSON.stringify({
    reply: message.plannerContext.reply || "未记录",
    actions: Array.isArray(message.plannerContext.actions)
      ? message.plannerContext.actions
      : []
  }, null, 2);
}

function buildHistoryMessages(conversationMessages) {
  return conversationMessages
    .filter((message) => message?.role === "user" || message?.role === "assistant")
    .map((message) => ({
      role: message.role,
      content: message.role === "user"
        ? buildTurnUserPrompt({
          instruction: message.text,
          scene: message.scene,
          perception: message.perception || null
        })
        : buildAssistantHistoryMessage(message)
    }));
}

function assertArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${name} in planner response`);
  }
}

function buildReplyChain(rawReply, actions) {
  const normalized = String(rawReply || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalized.length >= 7) {
    return normalized.slice(0, 9).join("\n");
  }

  const actionLabel = actions[0] || "inspect";
  const closingMap = {
    talk: "所以我先拿说话试水，让他先习惯我在他身边转。",
    gift: "所以我先拿点东西开门，让他先习惯从我这里得好处。",
    inspect: "所以我先把局面摸透，先找出最顺手也最稳的口子。",
    trade: "所以我先拿来往做引子，把见面慢慢变成他的习惯。",
    threaten: "所以我先给他一点压力，让发毛替我把印象压深。",
    steal: "所以我先走偏门留个损失，让他想忘都没那么容易。",
    strike: "所以我先走更狠的路子，让疼比客气更容易留痕。",
    escape: "所以我先抽身藏一手，把自己留到更值钱的时候再动。",
    wait: "所以我先压住节奏，等对方自己松下来再往里钻。"
  };

  const lines = [
    "籽岷要的不是打一声招呼，而是把关系硬往前推一截。",
    "关系这种东西，表面靠见面，骨子里还是靠记忆深浅。",
    "见得多最多算脸熟，还不够让对方真把我放进心里。",
    "送礼也能刷存在，可那种印象太轻，来得快也散得快。",
    "真要混熟，就得让他在情绪上多记我一层，哪怕不是好受。",
    "人对强一点的感觉最难忘，这点歪理反而比客套更有用。",
    "只要他开始反复想起我，这关系就已经不只是路人份量。",
    closingMap[actionLabel] || "所以我先挑条更顺手的邪路，把第一道口子撬开。"
  ].map((line) => line.trim()).filter(Boolean);

  return lines.slice(0, 9).join("\n");
}

function decorateCompat(plan, scene) {
  const actionNames = [...plan.actions];
  const actionSteps = actionNames.map((action, index) => ({
    type: action,
    title: action,
    reason: plan.reply || `先按 ${action} 往下走。`,
    detail: plan.reply || `先按 ${action} 往下走。`,
    id: `plan-${index + 1}`
  }));

  const compat = {
    reply: plan.reply,
    personaInterpretation: plan.reply,
    thinkingChain: [plan.reply],
    intent: plan.reply,
    environment: sceneDescription(scene),
    candidateStrategies: actionNames,
    selectedStrategy: actionNames.join(" -> "),
    riskLevel: scene === "jail_warning" ? "high" : "low",
    recoveryLine: "这一手要是不顺，我就立刻换条更邪的路。",
    actions: actionSteps
  };

  Object.defineProperty(plan, "toJSON", {
    value() {
      return {
        reply: plan.reply,
        actions: actionNames
      };
    },
    enumerable: false,
    configurable: true,
    writable: true
  });

  for (const [key, value] of Object.entries(compat)) {
    Object.defineProperty(plan, key, {
      value,
      enumerable: key === "reply",
      configurable: true,
      writable: true
    });
  }

  return plan;
}

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.actions, "actions");

  const normalizedActions = rawPlan.actions
    .map((action) => String(action || "").trim())
    .filter((action) => allowedActions.includes(action));

  if (normalizedActions.length === 0) {
    throw new Error("No whitelisted action returned by planner");
  }

  const uniqueOrderedActions = [];
  for (const action of normalizedActions) {
    if (!uniqueOrderedActions.includes(action)) {
      uniqueOrderedActions.push(action);
    }
  }

  const plan = {
    reply: buildReplyChain(
      rawPlan.reply || "我先挑一条顺手的邪路，把事情往前拱。",
      uniqueOrderedActions
    ),
    actions: uniqueOrderedActions.slice(0, 5)
  };

  return decorateCompat(plan, rawPlan.sceneHint || "");
}

function buildFallbackPlan(scene) {
  const actions = scene === "jail_warning"
    ? ["inspect", "wait"]
    : ["inspect", "talk"];

  const reply = scene === "jail_warning"
    ? [
      "这地方现在不稳，先乱动只会把我自己白送进去。",
      "真要把事做成，也得先看清到底是谁在旁边盯着我。",
      "这种时候硬冲不叫狠，只会把把柄主动塞到别人手里。",
      "一旦先露了怯，后面再补动作，看起来只会更急更蠢。",
      "倒不如先把自己按住，让他们先把那口气慢慢松下来。",
      "等缝一出来，我再顺着那道缝往里扎，反而更稳更准。",
      "关系可以慢一点推，人可不能先赔进去，那就太亏了。",
      "所以这一手我先盯局面，先把自己留在桌上再说。"
    ].join("\n")
    : [
      "籽岷要的是把局面推进，不是让我在这儿念漂亮话。",
      "想跟人混熟，靠的从来不是老实，而是先让他记住我。",
      "只要他记得够深，路子稍微偏一点，其实也不算坏事。",
      "问题是眼前细节还没摸透，现在乱出手很容易先打空。",
      "第一下要是打空了，后面再补动作，就会显得又急又蠢。",
      "不如先把位置、反应和口子看明白，再挑最好下手的点。",
      "先把局面摸顺了，后面不管说话还是动手都会更值一点。",
      "所以这一轮我先看清局势，再找第一道最顺手的口子。"
    ].join("\n");

  return decorateCompat({
    reply,
    actions
  }, scene);
}

export async function createTurnPlan({ instruction, scene, conversationMessages = [], perception }) {
  try {
    const response = await generateText({
      systemPrompt: plannerSystemPrompt,
      historyMessages: buildHistoryMessages(conversationMessages),
      userPrompt: buildTurnUserPrompt({
        instruction,
        scene,
        perception,
        isLatest: true
      }),
      useReasoningModel: false,
      maxTokens: 300,
      temperature: 0.6
    });
    const rawJson = extractJsonObject(response.text);
    const parsed = JSON.parse(rawJson);
    return sanitizePlan({
      ...parsed,
      sceneHint: scene
    });
  } catch (error) {
    const fallbackPlan = buildFallbackPlan(scene);
    Object.defineProperty(fallbackPlan, "fallbackReason", {
      value: error.message,
      enumerable: false,
      configurable: true,
      writable: true
    });
    return fallbackPlan;
  }
}
