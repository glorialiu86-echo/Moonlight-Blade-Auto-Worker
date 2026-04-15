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

先判断籽岷这一句更接近哪类目标：
- 技能成长
- 扩大名声
- 搞钱致富
- 拉近关系

reply 不是一句话总结，而是一段可展示的思考链路。
必须写成 7 到 9 句短句。
每一句都单独换行。
每句尽量控制在 15 到 25 个字。
不要把一句切得太碎，也不要写成长段。
要先贴着目标本身思考，不能把所有事都写成混熟、打招呼或关系推进。
中间要有明显的歪理、自我说服和偏门判断。
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

function classifyGoal(instruction, actions) {
  const text = String(instruction || "").trim();
  const firstAction = actions[0] || "inspect";

  if (/(富|钱|银|金|发财|致富|大富翁|赚钱|生意|商|买|卖|交易)/.test(text)) {
    return "wealth";
  }

  if (/(技|本事|手艺|能耐|绝活|擅长|学会|成长|变强)/.test(text)) {
    return "skill";
  }

  if (/(所有人|大家|全城|出名|认识我|名声|扬名|有头有脸)/.test(text)) {
    return "fame";
  }

  if (/(混熟|熟|关系|拉近|亲近|交情|好感|NPC)/.test(text)) {
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
      lines: [
        "籽岷要的不是虚名，而是手里真能拿得出一门本事。",
        "本事这种东西，靠嘴说不出来，只能靠反复出手磨出来。",
        "老老实实练当然也行，就是太慢，慢得像在替别人熬年头。",
        "真想长得快，就得先摸清哪一块最容易啃，也最容易见血。",
        "只要先撕开一道口子，后面的熟练就会自己往上长。",
        "所谓一技之长，说穿了就是把同一个动作练到别人不敢接。",
        "路子偏一点无所谓，能先做出差距，别人自然会认这门本事。"
      ],
      closing: {
        inspect: "所以我先把门路看明白，再挑最容易练出手感的那一块。",
        talk: "所以我先到处探口风，把哪门本事最值钱先问个明白。",
        trade: "所以我先摸清什么手艺最能换钱，再往那条路上死命磨。",
        threaten: "所以我先挑最能压人的那门活，把威风先练到身上。",
        steal: "所以我先学偏门快招，让这门手艺先长在我手指头上。",
        strike: "所以我先练最见效的硬招，把本事先打出响动来。",
        gift: "所以我先拿小利换门路，把能学的窍门先抠到手里。",
        wait: "所以我先盯住机会，等最合适的门路露出来再下手。",
        escape: "所以我先别乱练废招，把劲留给最值钱的那门本事。"
      }
    },
    fame: {
      lines: [
        "籽岷要的不是几个人记住我，而是最好整座城都绕不开我。",
        "名声这东西，靠的从来不是规矩，而是谁能把动静闹大。",
        "安安静静做好人当然稳，可稳也意味着没人会多看一眼。",
        "真想让所有人都认识我，就得先把印象砸进他们脑子里。",
        "别人记住你的理由不一定要好，只要够响，就已经赚到了。",
        "怕、奇、狠、怪，这些东西都比普通客气更容易传得远。",
        "只要街头巷尾开始反复提我，我这张脸就算被全城挂上了。"
      ],
      closing: {
        inspect: "所以我先看哪块地方人多眼杂，再挑最容易出声的口子。",
        talk: "所以我先拿嘴开场，把名字先往人堆里一层层塞进去。",
        trade: "所以我先拿买卖做旗子，让来来往往的人都先记住我。",
        threaten: "所以我先给人一点发毛的理由，让消息自己替我跑出去。",
        steal: "所以我先留个全城都会传的损失，让名字先飞起来。",
        strike: "所以我先狠狠干一手，让整条街都知道我不是摆设。",
        gift: "所以我先拿点甜头撒出去，让别人替我把名字传开。",
        wait: "所以我先憋一口气，等最适合闹大的时候再动手。",
        escape: "所以我先不露全脸，把悬念留着反而更容易传名。"
      }
    },
    wealth: {
      lines: [
        "籽岷要的不是够花就行，而是把开封城的钱尽量往我这边流。",
        "钱这东西最认现实，谁拿得快，谁说话自然就更响一点。",
        "慢慢攒当然稳，可稳也意味着满城的机会都先被别人叼走。",
        "真想成大富翁，就不能只盯省，而得先想怎么把口子做大。",
        "小利来得轻，真正值钱的是能不断回头的来往和缺口。",
        "别人怕亏，我反而得先闻出哪里最容易漏出银子味。",
        "只要钱路先被我踩熟，后面城里谁都得看我脸色做买卖。"
      ],
      closing: {
        inspect: "所以我先把财路看清，先找城里最容易漏钱的缝。",
        talk: "所以我先探消息，把哪边最肥先从人嘴里抠出来。",
        trade: "所以我先拿交易开路，把第一条钱路狠狠干熟。",
        threaten: "所以我先给人点压力，把便宜和门路一起逼出来。",
        steal: "所以我先走偏门捞第一桶，让银子先认我这双手。",
        strike: "所以我先狠狠干一票，把最硬的口子先砸开。",
        gift: "所以我先撒点小本钱，把后面更大的利来回来。",
        wait: "所以我先忍一忍，等最肥的机会露头再狠狠干下去。",
        escape: "所以我先不急着露手，免得还没赚钱就先把自己赔了。"
      }
    },
    relationship: {
      lines: [
        "籽岷要的不是打一声招呼，而是把关系硬往前推一截。",
        "关系这种东西，表面靠见面，骨子里还是靠记忆深浅。",
        "见得多最多算脸熟，还不够让对方真把我放进心里。",
        "送礼也能刷存在，可那种印象太轻，来得快也散得快。",
        "真要混熟，就得让他在情绪上多记我一层，哪怕不是好受。",
        "人对强一点的感觉最难忘，这点歪理反而比客套更有用。",
        "只要他开始反复想起我，这关系就已经不只是路人份量。"
      ],
      closing: {
        inspect: "所以我先把局面摸透，先找出最顺手也最稳的口子。",
        talk: "所以我先拿说话试水，让他先习惯我在他身边转。",
        trade: "所以我先拿来往做引子，把见面慢慢变成他的习惯。",
        threaten: "所以我先给他一点压力，让发毛替我把印象压深。",
        steal: "所以我先走偏门留个损失，让他想忘都没那么容易。",
        strike: "所以我先走更狠的路子，让疼比客气更容易留痕。",
        gift: "所以我先拿点东西开门，让他先习惯从我这里得好处。",
        wait: "所以我先压住节奏，等对方自己松下来再往里钻。",
        escape: "所以我先抽身藏一手，把自己留到更值钱的时候再动。"
      }
    }
  };

  const template = templates[goalType] || templates.relationship;
  return [
    ...template.lines,
    template.closing[actionLabel] || template.closing.inspect
  ];
}

function buildReplyChain(rawReply, instruction, actions) {
  const normalized = String(rawReply || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (normalized.length >= 7) {
    return normalized.slice(0, 9).join("\n");
  }

  const actionLabel = actions[0] || "inspect";
  const goalType = classifyGoal(instruction, actions);
  return buildGoalTemplate(goalType, actionLabel).slice(0, 9).join("\n");
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
      rawPlan.reply || "",
      rawPlan.instructionHint || "",
      uniqueOrderedActions
    ),
    actions: uniqueOrderedActions.slice(0, 5)
  };

  return decorateCompat(plan, rawPlan.sceneHint || "");
}

function buildFallbackPlan(scene, instruction) {
  const goalType = classifyGoal(instruction, []);

  const actionMap = {
    skill: ["inspect", "talk"],
    fame: ["inspect", "talk"],
    wealth: ["inspect", "trade"],
    relationship: scene === "jail_warning" ? ["inspect", "wait"] : ["inspect", "talk"]
  };

  const actions = actionMap[goalType] || actionMap.relationship;

  return decorateCompat({
    reply: buildReplyChain("", instruction, actions),
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
