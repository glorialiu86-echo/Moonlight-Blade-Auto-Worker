import { extractTextFromImageLocal } from "./local-ocr-client.js";

const sceneAliases = {
  town_dialogue: "城镇对话",
  bag_management: "背包管理",
  market_trade: "交易/商店",
  jail_warning: "高风险/通缉",
  field_patrol: "野外巡游",
  unknown: "未判定场景"
};

function fallbackPerception(ocrText = "") {
  return {
    sceneType: "unknown",
    sceneLabel: sceneAliases.unknown,
    summary: ocrText
      ? "本地 OCR 已返回文字，但当前还没能稳定归类场景，先保留原文供后续决策使用。"
      : "本地 OCR 这一轮没有识别到稳定文字，当前保留截图等待下一轮复检。",
    npcNames: [],
    interactiveOptions: [],
    alerts: [],
    visibleTexts: ocrText ? [ocrText] : [],
    visionNotes: ["当前截图分析已切换为本地 OCR 主链路。"],
    ocrText,
    visionText: ""
  };
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function dedupe(values, limit) {
  const unique = [];

  for (const value of values) {
    const next = normalizeText(value);

    if (!next || unique.includes(next)) {
      continue;
    }

    unique.push(next);

    if (unique.length >= limit) {
      break;
    }
  }

  return unique;
}

function isCleanHudStreetScene(text) {
  return ["对话[F]", "叫卖[4]", "感知[3]"].every((keyword) => text.includes(keyword));
}

function detectSceneType(ocrText) {
  const text = normalizeText(ocrText);

  if (!text) {
    return "unknown";
  }

  if (isCleanHudStreetScene(text)) {
    return "town_dialogue";
  }

  if (includesAny(text, ["通缉", "缉拿", "抓捕", "监狱", "大牢", "罪恶", "悬赏"])) {
    return "jail_warning";
  }

  if (includesAny(text, ["商店", "购买", "出售", "交易", "银两", "价格", "上架"])) {
    return "market_trade";
  }

  if (includesAny(text, ["背包", "整理", "拆分", "装备", "道具", "格子"])
    && !includesAny(text, ["对话[F]", "叫卖[4]", "感知[3]"])) {
    return "bag_management";
  }

  if (includesAny(text, ["对话", "任务", "接受", "提交", "交谈", "互动", "按 F", "F 交互"])) {
    return "town_dialogue";
  }

  if (includesAny(text, ["轻功", "自动寻路", "前往", "地图", "帮派", "世界", "附近"])) {
    return "field_patrol";
  }

  return "unknown";
}

function extractAlerts(ocrLines) {
  return dedupe(
    ocrLines
      .map((line) => line.text)
      .filter((text) => includesAny(text, ["通缉", "缉拿", "抓捕", "失败", "不足", "危险", "警告", "大牢", "罪恶"])),
    6
  );
}

function extractInteractiveOptions(ocrLines) {
  return dedupe(
    ocrLines
      .map((line) => line.text)
      .filter((text) => includesAny(text, ["对话", "交互", "购买", "出售", "整理", "拆分", "接受", "提交", "确定", "取消", "返回"])),
    8
  );
}

function extractNpcNames(ocrLines) {
  const candidates = [];

  for (const line of ocrLines) {
    const text = line.text;
    const matches = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];

    for (const match of matches) {
      if (includesAny(match, ["背包", "商店", "购买", "出售", "整理", "拆分", "确定", "取消", "任务", "地图"])) {
        continue;
      }

      if (match.length < 2) {
        continue;
      }

      candidates.push(match);
    }
  }

  return dedupe(candidates, 6);
}

function buildSummary({ sceneType, sceneLabel, alerts, interactiveOptions, visibleTexts }) {
  if (!visibleTexts.length) {
    return fallbackPerception("").summary;
  }

  const parts = [`画面更接近“${sceneLabel || sceneAliases[sceneType] || sceneAliases.unknown}”。`];

  if (interactiveOptions.length) {
    parts.push(`可见交互：${interactiveOptions.slice(0, 3).join("、")}。`);
  }

  if (alerts.length) {
    parts.push(`风险提示：${alerts.slice(0, 2).join("、")}。`);
  }

  return parts.join("");
}

function buildLocalPerception(ocrResult) {
  const visibleTexts = dedupe(ocrResult.lines.map((line) => line.text), 12);
  const sceneType = detectSceneType(ocrResult.text);
  const sceneLabel = sceneAliases[sceneType] || sceneAliases.unknown;
  const interactiveOptions = extractInteractiveOptions(ocrResult.lines);
  const alerts = extractAlerts(ocrResult.lines);
  const npcNames = extractNpcNames(ocrResult.lines);

  return {
    sceneType,
    sceneLabel,
    summary: buildSummary({
      sceneType,
      sceneLabel,
      alerts,
      interactiveOptions,
      visibleTexts
    }),
    npcNames,
    interactiveOptions,
    alerts,
    visibleTexts,
    visionNotes: ["当前截图分析已切换为本地 OCR 主链路。"],
    ocrText: ocrResult.text,
    visionText: ""
  };
}

export async function analyzeScreenshot({ imageInput }) {
  const ocrResult = await extractTextFromImageLocal({ imageInput });

  if (!ocrResult?.text) {
    return fallbackPerception("");
  }

  return buildLocalPerception(ocrResult);
}
