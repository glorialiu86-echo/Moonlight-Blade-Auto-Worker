import path from "node:path";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const learningDir = path.resolve(repoRoot, "data/interaction-learning");
const sampleLogPath = path.resolve(learningDir, "npc-interaction-samples.jsonl");
const summaryJsonPath = path.resolve(learningDir, "latest-summary.json");
const summaryMarkdownPath = path.resolve(learningDir, "latest-summary.md");

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isInteractionPlan(plan) {
  return Array.isArray(plan?.actions)
    && plan.actions.some((action) => ["talk", "gift", "trade", "threaten", "steal", "strike"].includes(action?.type));
}

export async function appendInteractionSample(sample) {
  await mkdir(learningDir, { recursive: true });
  await appendFile(sampleLogPath, `${JSON.stringify(sample)}\n`, "utf8");
  return sampleLogPath;
}

export async function readInteractionSamples() {
  if (!existsSync(sampleLogPath)) {
    return [];
  }

  const raw = await readFile(sampleLogPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function summarizeInteractionSamples(samples) {
  const relevant = samples.filter((sample) => sample?.actionFamily === "npc_interaction");
  const successSamples = relevant.filter((sample) => sample.success);
  const failureSamples = relevant.filter((sample) => !sample.success);

  const clickPointStats = new Map();
  const failureReasons = new Map();

  for (const sample of relevant) {
    for (const point of sample.clickPointAttempts || []) {
      const key = `${point.xRatio},${point.yRatio}`;
      const current = clickPointStats.get(key) || {
        xRatio: point.xRatio,
        yRatio: point.yRatio,
        attempts: 0,
        successes: 0
      };
      current.attempts += 1;
      if (sample.success) {
        current.successes += 1;
      }
      clickPointStats.set(key, current);
    }

    if (!sample.success) {
      const key = sample.result || "unknown_failure";
      failureReasons.set(key, (failureReasons.get(key) || 0) + 1);
    }
  }

  const topClickPoints = Array.from(clickPointStats.values())
    .map((item) => ({
      ...item,
      successRate: item.attempts > 0 ? round(item.successes / item.attempts, 4) : 0
    }))
    .sort((left, right) => right.successRate - left.successRate || right.attempts - left.attempts)
    .slice(0, 6);

  const averageClickAttempts = successSamples.length > 0
    ? round(successSamples.reduce((total, sample) => total + (sample.clickAttempts || 0), 0) / successSamples.length, 2)
    : null;
  const averageMoveAttempts = successSamples.length > 0
    ? round(successSamples.reduce((total, sample) => total + (sample.moveAttempts || 0), 0) / successSamples.length, 2)
    : null;
  const averageDurationMs = successSamples.length > 0
    ? round(successSamples.reduce((total, sample) => total + (sample.durationMs || 0), 0) / successSamples.length, 2)
    : null;

  return {
    generatedAt: new Date().toISOString(),
    sampleCount: relevant.length,
    successCount: successSamples.length,
    failureCount: failureSamples.length,
    successRate: relevant.length > 0 ? round(successSamples.length / relevant.length, 4) : 0,
    averageClickAttempts,
    averageMoveAttempts,
    averageDurationMs,
    topClickPoints,
    failureReasons: Array.from(failureReasons.entries())
      .map(([reason, count]) => ({ reason, count }))
      .sort((left, right) => right.count - left.count),
    recentSamples: relevant.slice(-10)
  };
}

function buildSummaryMarkdown(summary, narrative) {
  const lines = [
    "# NPC Interaction Summary",
    "状态：执行完成",
    "",
    `生成时间：${summary.generatedAt}`,
    `样本总数：${summary.sampleCount}`,
    `成功次数：${summary.successCount}`,
    `失败次数：${summary.failureCount}`,
    `成功率：${summary.successRate}`,
    `成功样本平均点击次数：${summary.averageClickAttempts ?? "暂无"}`,
    `成功样本平均移动次数：${summary.averageMoveAttempts ?? "暂无"}`,
    `成功样本平均耗时(ms)：${summary.averageDurationMs ?? "暂无"}`,
    ""
  ];

  if (narrative) {
    lines.push("## 自动总结", "", narrative, "");
  }

  if (summary.topClickPoints.length > 0) {
    lines.push("## 候选点击点表现", "");
    for (const point of summary.topClickPoints) {
      lines.push(`- (${point.xRatio}, ${point.yRatio})：尝试 ${point.attempts} 次，成功率 ${point.successRate}`);
    }
    lines.push("");
  }

  if (summary.failureReasons.length > 0) {
    lines.push("## 常见失败原因", "");
    for (const item of summary.failureReasons) {
      lines.push(`- ${item.reason}: ${item.count}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export async function writeInteractionSummary({ summary, narrative = "" }) {
  await mkdir(learningDir, { recursive: true });
  await writeFile(summaryJsonPath, JSON.stringify({ ...summary, narrative }, null, 2), "utf8");
  await writeFile(summaryMarkdownPath, buildSummaryMarkdown(summary, narrative), "utf8");
  return {
    summaryJsonPath,
    summaryMarkdownPath
  };
}

export function buildInteractionSample({
  instruction,
  source,
  scene,
  plan,
  perception,
  execution,
  error = null
}) {
  const relevantStep = [...(execution?.rawSteps || [])]
    .reverse()
    .find((step) => {
      const stage = step?.input?.stage;
      return [
        "npc_selected",
        "npc_action_menu",
        "small_talk_menu",
        "small_talk_confirm",
        "chat_ready",
        "gift_screen",
        "trade_screen"
      ].includes(stage)
        || typeof step?.input?.dialogText === "string"
        || step?.input?.favorAfter != null
        || step?.input?.favorBefore != null;
    });
  const stepInput = relevantStep?.input || {};
  const actionTypes = Array.isArray(plan?.actions) ? plan.actions.map((action) => action.type) : [];

  return {
    id: `npc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    actionFamily: "npc_interaction",
    instruction,
    source,
    scene,
    selectedStrategy: plan?.selectedStrategy || "",
    actionTypes,
    sceneLabel: perception?.sceneLabel || "",
    perceptionSummary: perception?.summary || "",
    success: !error,
    result: error ? (error.code || "execution_failed") : (stepInput.stage || "dialog_detected"),
    errorMessage: error?.message || "",
    durationMs: execution?.durationMs || null,
    clickAttempts: stepInput.clickAttempts || 0,
    moveAttempts: stepInput.moveAttempts || 0,
    clickPointAttempts: Array.isArray(stepInput.clickPointAttempts) ? stepInput.clickPointAttempts : [],
    lastClick: stepInput.lastClick || null,
    dialogText: stepInput.dialogText || "",
    favorBefore: stepInput.favorBefore ?? null,
    favorAfter: stepInput.favorAfter ?? null,
    giftAttempts: stepInput.giftAttempts || 0,
    tradeAttempted: Boolean(stepInput.tradeAttempted),
    tradeCompleted: Boolean(stepInput.tradeCompleted),
    giftCompleted: Boolean(stepInput.giftCompleted),
    targetThreshold: stepInput.targetThreshold ?? null,
    isSpecialNpc: Boolean(stepInput.isSpecialNpc),
    workerMode: stepInput.mode || "",
    workerPayload: error?.workerPayload || null
  };
}
