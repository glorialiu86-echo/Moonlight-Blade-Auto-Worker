import { analyzeImage, extractTextFromImage } from "../llm/qwen.js";
import { extractJsonObject } from "../lib/json.js";

const sceneAliases = {
  town_dialogue: "城镇对话",
  bag_management: "背包管理",
  market_trade: "交易市场",
  jail_warning: "牢房或高风险",
  field_patrol: "野外巡逻"
};

function fallbackPerception(ocrText, visionText) {
  return {
    sceneType: "unknown",
    sceneLabel: "未判定",
    summary: "模型返回了描述，但未能稳定结构化，已保留 OCR 与视觉原文供后续规划使用。",
    npcNames: [],
    interactiveOptions: [],
    alerts: [],
    visibleTexts: ocrText ? [ocrText] : [],
    visionNotes: visionText ? [visionText] : [],
    ocrText,
    visionText
  };
}

function sanitizeList(value, limit = 8) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function sanitizePerception(raw, ocrText, visionText) {
  const sceneType = typeof raw.sceneType === "string" ? raw.sceneType.trim() : "unknown";

  return {
    sceneType,
    sceneLabel: sceneAliases[sceneType] || String(raw.sceneLabel || "未判定").trim(),
    summary: String(raw.summary || "暂无总结").trim(),
    npcNames: sanitizeList(raw.npcNames, 6),
    interactiveOptions: sanitizeList(raw.interactiveOptions, 8),
    alerts: sanitizeList(raw.alerts, 6),
    visibleTexts: sanitizeList(raw.visibleTexts, 12),
    visionNotes: sanitizeList(raw.visionNotes, 8),
    ocrText,
    visionText
  };
}

function buildVisionPrompt() {
  return `
你在分析一张游戏截图，用于《天涯明月刀》AI玩家控制系统的第二阶段视觉感知。

请严格只输出一个 JSON 对象，不要输出额外解释。

sceneType 只能是以下值之一：
- town_dialogue
- bag_management
- market_trade
- jail_warning
- field_patrol
- unknown

请结合图片内容判断：
1. 当前界面属于哪种场景
2. 是否出现 NPC 名称
3. 是否出现可交互选项
4. 是否出现高风险警告、通缉、牢房、失败提示等异常信息
5. 用一句中文总结当前画面

返回 JSON 格式：
{
  "sceneType": "town_dialogue|bag_management|market_trade|jail_warning|field_patrol|unknown",
  "sceneLabel": "string",
  "summary": "string",
  "npcNames": ["string"],
  "interactiveOptions": ["string"],
  "alerts": ["string"],
  "visibleTexts": ["string"],
  "visionNotes": ["string"]
}
  `.trim();
}

export async function analyzeScreenshot({ imageInput }) {
  const [ocrResult, visionResult] = await Promise.all([
    extractTextFromImage({ imageInput }),
    analyzeImage({
      imageInput,
      prompt: buildVisionPrompt(),
      maxTokens: 700,
      temperature: 0.1
    })
  ]);

  try {
    const rawJson = extractJsonObject(visionResult.text);
    const parsed = JSON.parse(rawJson);
    return sanitizePerception(parsed, ocrResult.text, visionResult.text);
  } catch {
    return fallbackPerception(ocrResult.text, visionResult.text);
  }
}
