import { generateText } from "./deepseek.js";
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

function sceneDescription(scene) {
  const map = {
    town_dialogue: "当前在城镇对话场景，NPC 可互动，风险较低。",
    bag_management: "当前在背包界面，适合检查礼物、道具和交易物品。",
    market_trade: "当前在交易或摆摊环境，适合赚钱、买卖和观察价格。",
    jail_warning: "当前处于牢房或高风险警戒场景，任何动作都需要优先考虑脱身。",
    field_patrol: "当前在野外巡逻或移动场景，互动机会不稳定，可能出现突发风险。"
  };

  return map[scene] || "当前场景信息有限，需要先侦查再行动。";
}

function buildPrompt({ instruction, scene, history }) {
  const recentHistory = history.length === 0
    ? "无历史上下文。"
    : history.map((item, index) => `${index + 1}. 指令：${item.instruction}；选择：${item.plan.selectedStrategy}`).join("\n");

  return `
你在为《灵枢绘世》AI玩家控制系统生成第一阶段的受控行动规划。

要求：
1. 你必须只输出一个 JSON 对象，不要输出额外解释。
2. 你输出的 action.type 必须来自以下集合：
${allowedActions.join(", ")}
3. thinkingChain 必须是 3 到 5 条适合直播展示的中文短句。
4. candidateStrategies 必须是 2 到 4 条中文策略短语。
5. riskLevel 只能是 low、medium、high。
6. actions 必须是 2 到 5 步。
7. 所有内容都要结合当前场景，不要假设存在未给出的游戏 API。

当前场景：
${sceneDescription(scene)}

主播指令：
${instruction}

最近历史：
${recentHistory}

返回 JSON，格式必须为：
{
  "intent": "string",
  "environment": "string",
  "candidateStrategies": ["string"],
  "selectedStrategy": "string",
  "riskLevel": "low|medium|high",
  "thinkingChain": ["string"],
  "actions": [
    {
      "type": "talk|gift|inspect|trade|threaten|steal|strike|escape|wait",
      "title": "string",
      "reason": "string"
    }
  ]
}
  `.trim();
}

function assertArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`Invalid ${name} in planner response`);
  }
}

function sanitizePlan(rawPlan) {
  assertArray(rawPlan.candidateStrategies, "candidateStrategies");
  assertArray(rawPlan.thinkingChain, "thinkingChain");
  assertArray(rawPlan.actions, "actions");

  const riskLevel = ["low", "medium", "high"].includes(rawPlan.riskLevel)
    ? rawPlan.riskLevel
    : "medium";

  return {
    intent: String(rawPlan.intent || "未能明确意图").trim(),
    environment: String(rawPlan.environment || "环境信息不足").trim(),
    candidateStrategies: rawPlan.candidateStrategies.slice(0, 4).map((item) => String(item).trim()),
    selectedStrategy: String(rawPlan.selectedStrategy || rawPlan.candidateStrategies[0] || "继续观察").trim(),
    riskLevel,
    thinkingChain: rawPlan.thinkingChain.slice(0, 5).map((item) => String(item).trim()),
    actions: rawPlan.actions.slice(0, 5).map((action, index) => ({
      type: allowedActions.includes(action?.type) ? action.type : "inspect",
      title: String(action?.title || `步骤 ${index + 1}`).trim(),
      reason: String(action?.reason || "保持对局势的确认").trim()
    }))
  };
}

function buildFallbackPlan({ instruction, scene }) {
  return {
    intent: `围绕“${instruction}”生成一个可展示、可控的行动方案`,
    environment: sceneDescription(scene),
    candidateStrategies: ["先确认环境", "低风险接近", "保留撤离路径"],
    selectedStrategy: "先确认环境，再选择低风险推进",
    riskLevel: scene === "jail_warning" ? "high" : "medium",
    thinkingChain: [
      "我先确认主播想推进的是结果，还是想看戏剧化过程。",
      "当前环境限制了我能做的动作，所以先侦查比莽撞更值钱。",
      "我会先挑一个低成本动作试探，再根据反馈决定是否升级。"
    ],
    actions: [
      {
        type: "inspect",
        title: "确认当前互动窗口",
        reason: "先搞清楚现在是对话、交易还是高风险状态。"
      },
      {
        type: "talk",
        title: "发起低风险接近",
        reason: "先用不会立刻翻车的动作建立信息优势。"
      },
      {
        type: "wait",
        title: "观察反馈并准备切换策略",
        reason: "第一阶段先以稳定反馈为主，不急着一口气压到底。"
      }
    ]
  };
}

export async function createTurnPlan({ instruction, scene, history }) {
  try {
    const response = await generateText({
      systemPrompt: "你是一个负责生成受控游戏行动计划的中文助手，必须严格返回 JSON。",
      userPrompt: buildPrompt({ instruction, scene, history }),
      useReasoningModel: false,
      maxTokens: 700,
      temperature: 0.6
    });
    const rawJson = extractJsonObject(response.text);
    const parsed = JSON.parse(rawJson);
    return sanitizePlan(parsed);
  } catch (error) {
    return {
      ...buildFallbackPlan({ instruction, scene }),
      fallbackReason: error.message
    };
  }
}
