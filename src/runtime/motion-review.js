import path from "node:path";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateText } from "../llm/qwen.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const motionReviewDir = path.resolve(repoRoot, "data/motion-review");
const sampleLogPath = path.resolve(motionReviewDir, "motion-review-samples.jsonl");
const reviewLogPath = path.resolve(motionReviewDir, "motion-review-results.jsonl");
const artifactDir = path.resolve(motionReviewDir, "artifacts");
const latestReviewPath = path.resolve(motionReviewDir, "latest-review-summary.json");

let reviewDrainPromise = null;

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonLines(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function ensureDirs() {
  await mkdir(motionReviewDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
}

async function appendJsonLine(targetPath, payload) {
  await ensureDirs();
  await appendFile(targetPath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function writeArtifact(sampleId, artifact) {
  if (!artifact?.framesBase64) {
    return null;
  }

  await ensureDirs();
  const artifactPath = path.resolve(artifactDir, `${sampleId}.npz`);
  await writeFile(artifactPath, Buffer.from(artifact.framesBase64, "base64"));
  return artifactPath;
}

function toReviewSample({
  instruction,
  source,
  scene,
  plan,
  perception,
  step
}) {
  const verification = step?.input?.verification;

  if (!verification || verification.decision !== "review") {
    return null;
  }

  return {
    id: createId("motion"),
    createdAt: new Date().toISOString(),
    reviewStatus: "pending",
    instruction,
    source,
    scene,
    selectedStrategy: plan?.selectedStrategy || "",
    sceneLabel: perception?.sceneLabel || "",
    perceptionSummary: perception?.summary || "",
    actionType: step?.input?.actionType || "",
    sourceType: step?.sourceType || null,
    title: step?.title || "",
    resultStatus: step?.status || "review_required",
    verification: verification,
    artifact: verification.reviewArtifact || null
  };
}

function extractReviewCandidateSteps({ execution, error }) {
  const steps = [];

  for (const step of execution?.rawSteps || []) {
    if (step?.input?.verification?.decision === "review") {
      steps.push(step);
    }
  }

  const failedStep = error?.workerPayload?.failedStep;
  if (failedStep?.input?.verification?.decision === "review") {
    steps.push(failedStep);
  }

  return steps;
}

export function buildMotionReviewSamples({
  instruction,
  source,
  scene,
  plan,
  perception,
  execution,
  error = null
}) {
  return extractReviewCandidateSteps({ execution, error })
    .map((step) => toReviewSample({
      instruction,
      source,
      scene,
      plan,
      perception,
      step
    }))
    .filter(Boolean);
}

export async function appendMotionReviewSamples(samples) {
  const persisted = [];

  for (const sample of samples) {
    const artifactPath = await writeArtifact(sample.id, sample.artifact);
    const nextSample = {
      ...sample,
      artifactPath,
      artifact: sample.artifact
        ? {
            format: sample.artifact.format,
            encoding: sample.artifact.encoding,
            downsampleStep: sample.artifact.downsampleStep
          }
        : null
    };

    await appendJsonLine(sampleLogPath, nextSample);
    persisted.push(nextSample);
  }

  return persisted;
}

export async function appendMotionReviewResult(result) {
  await appendJsonLine(reviewLogPath, result);
  return result;
}

export async function readMotionReviewSamples() {
  if (!existsSync(sampleLogPath)) {
    return [];
  }

  const raw = await readFile(sampleLogPath, "utf8");
  return parseJsonLines(raw);
}

export async function readMotionReviewResults() {
  if (!existsSync(reviewLogPath)) {
    return [];
  }

  const raw = await readFile(reviewLogPath, "utf8");
  return parseJsonLines(raw);
}

export async function readPendingMotionReviewSamples() {
  const [samples, reviews] = await Promise.all([
    readMotionReviewSamples(),
    readMotionReviewResults()
  ]);
  const reviewedIds = new Set(reviews.map((item) => item.sampleId));
  return samples.filter((sample) => !reviewedIds.has(sample.id));
}

function buildReviewPrompt(sample) {
  const verification = sample.verification || {};
  return [
    "你在复核《天涯明月刀》本地动作规则留下的边界样本。",
    "你不是主判定 owner，只能基于下面的规则差分指标做低频复核。",
    "请输出 JSON，字段固定为 decision、reason、suggestion。",
    "decision 只能是 likely_success、likely_idle_noise、insufficient_signal 三选一。",
    "reason 用一句中文解释判断依据。",
    "suggestion 用一句中文给规则调参建议；如果没有建议就写“保持现状”。",
    `actionType=${sample.actionType}`,
    `title=${sample.title}`,
    `sceneLabel=${sample.sceneLabel || "unknown"}`,
    `perceptionSummary=${sample.perceptionSummary || "none"}`,
    `instruction=${sample.instruction || ""}`,
    `meanDelta=${verification.meanDelta}`,
    `changedRatio=${verification.changedRatio}`,
    `requiredMeanDelta=${verification.requiredMeanDelta}`,
    `requiredChangedRatio=${verification.requiredChangedRatio}`,
    `baselineMeanDelta=${verification.baselineMeanDelta}`,
    `baselineChangedRatio=${verification.baselineChangedRatio}`,
    `sampleGapMs=${verification.sampleGapMs}`,
    `settleMs=${verification.settleMs}`,
    "不要假装看见图片内容；如果这些指标不足以支持强判断，就返回 insufficient_signal。"
  ].join("\n");
}

function parseReviewJson(text) {
  const raw = String(text || "").trim();
  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  const candidate = fencedMatch ? fencedMatch[1].trim() : raw;
  return JSON.parse(candidate);
}

async function reviewSingleSample(sample) {
  try {
    const result = await generateText({
      userPrompt: buildReviewPrompt(sample),
      maxTokens: 180,
      temperature: 0.1
    });
    const parsed = parseReviewJson(result.text);
    return {
      id: createId("motion-review"),
      sampleId: sample.id,
      reviewedAt: new Date().toISOString(),
      decision: String(parsed.decision || "insufficient_signal"),
      reason: String(parsed.reason || "").trim(),
      suggestion: String(parsed.suggestion || "保持现状").trim(),
      modelText: String(result.text || "").trim()
    };
  } catch (error) {
    return {
      id: createId("motion-review"),
      sampleId: sample.id,
      reviewedAt: new Date().toISOString(),
      decision: "insufficient_signal",
      reason: `本地模型复核失败：${error.message}`,
      suggestion: "保持现状",
      modelText: ""
    };
  }
}

async function writeLatestReviewSummary(results) {
  const payload = {
    generatedAt: new Date().toISOString(),
    reviewCount: results.length,
    recentResults: results.slice(-20)
  };
  await ensureDirs();
  await writeFile(latestReviewPath, JSON.stringify(payload, null, 2), "utf8");
}

async function drainMotionReviewQueue() {
  const pendingSamples = await readPendingMotionReviewSamples();
  const results = [];

  for (const sample of pendingSamples) {
    const result = await reviewSingleSample(sample);
    await appendMotionReviewResult(result);
    results.push(result);
  }

  if (results.length > 0) {
    await writeLatestReviewSummary(results);
  }

  return results;
}

export function triggerMotionReviewPass() {
  if (!reviewDrainPromise) {
    reviewDrainPromise = drainMotionReviewQueue().finally(() => {
      reviewDrainPromise = null;
    });
  }

  return reviewDrainPromise;
}

export const motionReviewPaths = {
  motionReviewDir,
  sampleLogPath,
  reviewLogPath,
  artifactDir,
  latestReviewPath
};
