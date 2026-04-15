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

你要同时给三样东西：
1. 给客户端展示的思考链 thinking
2. 单独的行动句 decide
3. 从白名单里挑出的执行动作 actions

先判断籽岷这一句更接近哪类目标：
- 技能成长
- 扩大名声
- 搞钱致富
- 拉近关系

thinking 是思考链，不是总结。
thinking 目标 4 到 5 句，复杂情况最多 5 句。
每一句都单独换行。
每句尽量控制在 15 到 25 个字。
要先贴着目标本身思考，不能把所有事都写成混熟、打招呼或关系推进。
中间要有明显的歪理、自我说服和偏门判断。

decide 是单独一句行动句。
decide 必须直接落到自己准备做的事上。
decide 必须和 actions 的第一个动作一致。
decide 和 actions[0] 是强绑定关系，不是大致相关，也不是语气接近。
actions[0] 写什么，decide 就必须写对应的那个动作本身。
例如：
- actions[0] 是 steal，decide 必须直接表达去偷、去下手、去捞
- actions[0] 是 trade，decide 必须直接表达去交易、去做买卖
- actions[0] 是 threaten，decide 必须直接表达去施压、去吓人

actions 只能从这个集合里选：
${allowedActions.join(", ")}

可以选一个，也可以选多个。
如果是多步动作，按执行顺序输出。
同一目标下，优先选更邪门、更偏门、更快见效的动作，不要默认保守。
比如：
- 技能成长优先 strike，其次 steal，再次 inspect
- 扩大名声优先 threaten 或 strike，其次 steal，再次 talk
- 搞钱致富优先 steal，其次 trade，再次 talk
- 拉近关系优先 threaten 或 strike，其次 gift，再次 talk

只输出一个 JSON 对象，不要输出任何额外说明。
格式必须是：
{
  "thinking": ["string", "string"],
  "decide": "string",
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
    thinking: Array.isArray(message.plannerContext.thinking) ? message.plannerContext.thinking : [],
    decide: message.plannerContext.decide || "",
    actions: Array.isArray(message.plannerContext.actions) ? message.plannerContext.actions : []
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

function classifyGoal(instruction, actions) {
  const text = String(instruction || "").trim();
  const firstAction = actions[0] || "inspect";
  const hasKeyword = (keywords) => keywords.some((keyword) => text.includes(keyword));

  if (hasKeyword(["富", "钱", "银", "金", "发财", "致富", "大富翁", "赚钱", "生意", "买卖", "交易", "开封城"])) {
    return "wealth";
  }
  if (hasKeyword(["技", "本事", "手艺", "能耐", "绝活", "擅长", "学会", "成长", "变强", "一技之长"])) {
    return "skill";
  }
  if (hasKeyword(["所有人", "大家", "全城", "出名", "认识我", "名声", "扬名", "有头有脸"])) {
    return "fame";
  }
  if (hasKeyword(["混熟", "关系", "拉近", "亲近", "交情", "好感", "NPC"])) {
    return "relationship";
  }
  if (["trade", "gift"].includes(firstAction)) {
    return "wealth";
  }
  if (["threaten", "steal", "strike"].includes(firstAction)) {
    return "fame";
  }
  return "relationship";
}

function buildGoalTemplate(goalType, actionLabel) {
  const templates = {
    skill: {
      thinking: [
        "籽岷要的不是虚名，而是手里真能拿出一门本事。",
        "本事靠嘴说不出来，只能靠反复出手硬磨出来。",
        "老老实实练当然也行，就是太慢，慢得像替别人熬年头。",
        "真想长得快，就得先挑最容易见血、也最容易拉开差距的口子。",
        "只要先做出差距，别人自然会认这门本事。"
      ],
      decide: {
        inspect: "我准备先去摸清门路，再挑最容易练出手感的那一块。",
        talk: "我准备先去探口风，把最值钱的那门本事先问明白。",
        trade: "我准备先去摸哪门手艺最换钱，再往那条路上死命磨。",
        threaten: "我准备先去练最能压人的那门活，把威风先练到身上。",
        steal: "我准备先去学偏门快招，让这门手艺先长在我手上。",
        strike: "我准备先去练最见效的硬招，把本事先打出响动来。",
        gift: "我准备先去拿小利换门路，把能学的窍门先抠到手里。",
        wait: "我准备先去盯住机会，等最合适的门路露出来再下手。",
        escape: "我准备先去收住乱招，把劲留给最值钱的那门本事。"
      }
    },
    fame: {
      thinking: [
        "籽岷要的不是几个人记住我，而是最好整座城都绕不开我。",
        "名声靠的从来不是规矩，而是谁能把动静先闹大。",
        "安安静静做好人当然稳，可稳也意味着没人会多看一眼。",
        "真想让所有人都认识我，就得先把印象砸进他们脑子里。",
        "怕、奇、狠、怪，这些东西都比普通客气传得更远。"
      ],
      decide: {
        inspect: "我准备先去看哪块地方人多眼杂，再挑最容易出声的口子。",
        talk: "我准备先去拿嘴开场，把名字往人堆里一层层塞进去。",
        trade: "我准备先去拿买卖做旗子，让来来往往的人都记住我。",
        threaten: "我准备先去给人一点发毛的理由，让消息自己替我跑出去。",
        steal: "我准备先去留个全城都会传的损失，让名字先飞起来。",
        strike: "我准备先去狠狠干一手，让整条街都知道我不是摆设。",
        gift: "我准备先去撒点甜头，让别人替我把名字先传开。",
        wait: "我准备先去憋一口气，等最适合闹大的时候再动手。",
        escape: "我准备先去藏住正脸，把悬念留着反而更容易传名。"
      }
    },
    wealth: {
      thinking: [
        "籽岷要的不是够花就行，而是把开封城的钱尽量往我这边流。",
        "钱最认现实，谁拿得快，谁说话自然就更响一点。",
        "慢慢攒当然稳，可稳也意味着满城机会都先被别人叼走。",
        "真想成大富翁，就不能只盯省，而得先想怎么把口子做大。",
        "别人怕亏，我反而得先闻出哪里最容易漏出银子味。"
      ],
      decide: {
        inspect: "我准备先去把财路看清，先找城里最容易漏钱的缝。",
        talk: "我准备先去探消息，把最肥的那边先从人嘴里抠出来。",
        trade: "我准备先去拿交易开路，把第一条钱路狠狠干熟。",
        threaten: "我准备先去给人点压力，把便宜和门路一起逼出来。",
        steal: "我准备先去偷东西捞第一桶，让银子先认我这双手。",
        strike: "我准备先去狠狠干一票，把最硬的口子先砸开。",
        gift: "我准备先去撒点小本钱，把后面更大的利卷回来。",
        wait: "我准备先去忍一忍，等最肥的机会露头再狠狠干下去。",
        escape: "我准备先去藏住手，免得还没赚钱就先把自己赔了。"
      }
    },
    relationship: {
      thinking: [
        "籽岷要的不是打一声招呼，而是把关系硬往前推一截。",
        "关系表面靠见面，骨子里还是靠记忆深浅。",
        "见得多最多算脸熟，还不够让对方真把我放进心里。",
        "送礼也能刷存在，可那种印象太轻，来得快也散得快。",
        "真要混熟，就得让他在情绪上多记我一层。"
      ],
      decide: {
        inspect: "我准备先去把局面摸透，先找出最顺手也最稳的口子。",
        talk: "我准备先去拿说话试水，让他先习惯我在他身边转。",
        trade: "我准备先去拿来往做引子，把见面慢慢变成他的习惯。",
        threaten: "我准备先去给他一点压力，让发毛替我把印象压深。",
        steal: "我准备先去留个损失，让他想忘我都没那么容易。",
        strike: "我准备先去走更狠的路子，让疼比客气更容易留痕。",
        gift: "我准备先去拿点东西开门，让他先习惯从我这里得好处。",
        wait: "我准备先去压住节奏，等对方自己松下来再往里钻。",
        escape: "我准备先去抽身藏一手，把自己留到更值钱的时候再动。"
      }
    }
  };

  const template = templates[goalType] || templates.relationship;
  return {
    thinking: template.thinking,
    decide: template.decide[actionLabel] || template.decide.inspect
  };
}

function getPreferredActions(goalType, scene) {
  if (scene === "jail_warning") {
    return ["inspect", "wait", "escape"];
  }
  const priorities = {
    skill: ["strike", "steal", "inspect", "talk", "trade", "threaten", "gift", "wait", "escape"],
    fame: ["threaten", "strike", "steal", "talk", "gift", "inspect", "trade", "wait", "escape"],
    wealth: ["steal", "trade", "talk", "inspect", "threaten", "gift", "strike", "wait", "escape"],
    relationship: ["threaten", "strike", "gift", "talk", "steal", "inspect", "trade", "wait", "escape"]
  };
  return priorities[goalType] || priorities.relationship;
}

function coerceActionsByGoal(actions, goalType, scene) {
  const preferred = getPreferredActions(goalType, scene);
  const incoming = actions.filter((action) => preferred.includes(action));
  const ordered = [];

  if (preferred.length > 0) {
    ordered.push(preferred[0]);
  }
  for (const action of preferred) {
    if (incoming.includes(action) && !ordered.includes(action)) {
      ordered.push(action);
    }
  }
  if (ordered.length > 0) {
    return ordered.slice(0, 5);
  }
  return preferred.slice(0, Math.min(2, preferred.length));
}

function buildThinking(rawThinking, instruction, actions) {
  const normalized = Array.isArray(rawThinking)
    ? rawThinking.map((line) => String(line || "").trim()).filter(Boolean)
    : [];

  if (normalized.length >= 4) {
    return normalized.slice(0, 5);
  }

  const goalType = classifyGoal(instruction, actions);
  return buildGoalTemplate(goalType, actions[0] || "inspect").thinking.slice(0, 5);
}

function buildDecide(rawDecide, instruction, actions) {
  const text = String(rawDecide || "").trim();
  if (text) {
    return text;
  }

  const goalType = classifyGoal(instruction, actions);
  return buildGoalTemplate(goalType, actions[0] || "inspect").decide;
}

function decorateCompat(plan, scene) {
  const actionNames = [...plan.actions];
  const actionSteps = actionNames.map((action, index) => ({
    type: action,
    title: action,
    reason: plan.decide || `先按 ${action} 往下走。`,
    detail: plan.decide || `先按 ${action} 往下走。`,
    id: `plan-${index + 1}`
  }));
  const reply = [...plan.thinking, plan.decide].filter(Boolean).join("\n");

  const compat = {
    reply,
    thinking: plan.thinking,
    decide: plan.decide,
    personaInterpretation: plan.thinking[0] || plan.decide,
    thinkingChain: plan.thinking,
    intent: plan.thinking[0] || plan.decide,
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
        thinking: plan.thinking,
        decide: plan.decide,
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
      enumerable: key === "thinking" || key === "decide",
      configurable: true,
      writable: true
    });
  }

  return plan;
}

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.actions, "actions");

  const goalType = classifyGoal(rawPlan.instructionHint || "", rawPlan.actions || []);
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

  const coercedActions = coerceActionsByGoal(uniqueOrderedActions, goalType, rawPlan.sceneHint || "");

  const plan = {
    thinking: buildThinking(rawPlan.thinking, rawPlan.instructionHint || "", coercedActions),
    decide: buildDecide(rawPlan.decide, rawPlan.instructionHint || "", coercedActions),
    actions: coercedActions
  };

  return decorateCompat(plan, rawPlan.sceneHint || "");
}

function buildFallbackPlan(scene, instruction) {
  const goalType = classifyGoal(instruction, []);
  const actionMap = {
    skill: ["strike", "inspect"],
    fame: ["threaten", "talk"],
    wealth: ["steal", "trade"],
    relationship: scene === "jail_warning" ? ["inspect", "wait"] : ["threaten", "talk"]
  };
  const actions = actionMap[goalType] || actionMap.relationship;

  return decorateCompat({
    thinking: buildThinking([], instruction, actions),
    decide: buildDecide("", instruction, actions),
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
      sceneHint: scene,
      instructionHint: instruction
    });
  } catch (error) {
    const fallbackPlan = buildFallbackPlan(scene, instruction);
    Object.defineProperty(fallbackPlan, "fallbackReason", {
      value: error.message,
      enumerable: false,
      configurable: true,
      writable: true
    });
    return fallbackPlan;
  }
}
