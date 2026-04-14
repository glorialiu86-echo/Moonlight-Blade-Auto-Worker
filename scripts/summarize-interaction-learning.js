import "../src/config/load-env.js";
import { generateText } from "../src/llm/qwen.js";
import {
  readInteractionSamples,
  summarizeInteractionSamples,
  writeInteractionSummary
} from "../src/runtime/interaction-learning.js";

function buildPrompt(summary) {
  return [
    "你在总结本地《天涯明月刀手游》NPC 交互样本。",
    "请用中文输出 3 句以内的高信号总结，关注：成功率、最有效点击点、最常见失败原因。",
    `样本总数：${summary.sampleCount}`,
    `成功率：${summary.successRate}`,
    `平均点击次数：${summary.averageClickAttempts ?? "暂无"}`,
    `平均移动次数：${summary.averageMoveAttempts ?? "暂无"}`,
    `平均耗时(ms)：${summary.averageDurationMs ?? "暂无"}`,
    `最佳点击点：${JSON.stringify(summary.topClickPoints.slice(0, 3))}`,
    `失败原因：${JSON.stringify(summary.failureReasons.slice(0, 5))}`
  ].join("\n");
}

async function main() {
  const samples = await readInteractionSamples();
  const summary = summarizeInteractionSamples(samples);
  let narrative = "";

  if (summary.sampleCount > 0) {
    try {
      const result = await generateText({
        userPrompt: buildPrompt(summary),
        maxTokens: 220,
        temperature: 0.2
      });
      narrative = String(result.text || "").trim();
    } catch (error) {
      narrative = `自动总结暂时失败：${error.message}`;
    }
  }

  const paths = await writeInteractionSummary({
    summary,
    narrative
  });

  console.log(JSON.stringify({
    sampleCount: summary.sampleCount,
    successRate: summary.successRate,
    summaryJsonPath: paths.summaryJsonPath,
    summaryMarkdownPath: paths.summaryMarkdownPath,
    narrative
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
