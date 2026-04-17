import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = process.cwd();
const serverIndexPath = path.resolve(projectRoot, "src/server/index.js");
const runtimeFlowDocPath = path.resolve(projectRoot, "docs/specs/fixed-script-detailed-runtime-flow.md");

const expectedVariantCounts = {
  sell_loop: 3,
  social_warm: 2,
  social_dark: 2,
  dark_close: 3,
  dark_miaoqu: 5,
  ending_trade: 1
};

const expectedRounds = {
  sell_loop: 3,
  social_warm: 2,
  social_dark: 2,
  dark_close: 3,
  dark_miaoqu: 5,
  ending_trade: 1
};

const requiredStartupLines = {
  preProtect: "收到加油啦！马上动脑筋～",
  startRun: "好嘞，这就按刚才盘好的路子稳稳开干！",
  finishAll: "籽岷的任务我全拿下啦～昂首挺胸等他回来看成果！钱也揣兜里了，街边站得笔直，不乱伸手～"
};

const retiredLines = [
  "好的！收到！等我想想怎么做…",
  "行，我现在顺着刚才那套安排往下做。",
  "我完美完成籽岷的任务啦，现在可骄傲了，就等他回来验收啦。这一趟也赚了不少钱，先在街上乖乖收手。"
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function extractStageSlice(source, stageKey, nextStageKey) {
  const startMarker = `${stageKey}: [`;
  const startIndex = source.indexOf(startMarker);
  assert(startIndex !== -1, `Missing stage voice block: ${stageKey}`);

  const endIndex = nextStageKey
    ? source.indexOf(`${nextStageKey}: [`, startIndex)
    : source.indexOf("\n};", startIndex);

  assert(endIndex !== -1, `Missing end marker for stage voice block: ${stageKey}`);
  return source.slice(startIndex, endIndex);
}

function verifyVoiceStage(source, stageKey, expectedVariants, nextStageKey) {
  const slice = extractStageSlice(source, stageKey, nextStageKey);
  const variantCount = countMatches(slice, /\n\s*{\n\s*thinkingChain:/g);

  assert(
    variantCount === expectedVariants,
    `Stage ${stageKey} expected ${expectedVariants} variants, got ${variantCount}`
  );

  assert(
    countMatches(slice, /\n\s*decide:/g) === expectedVariants,
    `Stage ${stageKey} decide count mismatch`
  );
  assert(
    countMatches(slice, /\n\s*persona:/g) === expectedVariants,
    `Stage ${stageKey} persona count mismatch`
  );
  assert(
    countMatches(slice, /\n\s*progress:/g) === expectedVariants,
    `Stage ${stageKey} progress count mismatch`
  );
  assert(
    countMatches(slice, /\n\s*resultFactory:/g) === expectedVariants,
    `Stage ${stageKey} resultFactory count mismatch`
  );
}

function verifyStageRounds(source, stageKey, expectedRoundsForStage) {
  const stagePattern = new RegExp(
    `key:\\s*"${stageKey}"[\\s\\S]*?rounds:\\s*${expectedRoundsForStage}\\b`,
    "m"
  );

  assert(
    stagePattern.test(source),
    `Stage ${stageKey} missing expected rounds=${expectedRoundsForStage}`
  );
}

async function main() {
  const [serverSource, runtimeFlowDoc] = await Promise.all([
    readFile(serverIndexPath, "utf8"),
    readFile(runtimeFlowDocPath, "utf8")
  ]);

  const stageKeys = Object.keys(expectedVariantCounts);
  stageKeys.forEach((stageKey, index) => {
    verifyVoiceStage(
      serverSource,
      stageKey,
      expectedVariantCounts[stageKey],
      stageKeys[index + 1] || null
    );
    verifyStageRounds(serverSource, stageKey, expectedRounds[stageKey]);
  });

  assert(
    countMatches(serverSource, new RegExp(requiredStartupLines.preProtect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) === 2,
    "Expected preProtect line to appear exactly twice in server index"
  );
  assert(serverSource.includes(requiredStartupLines.startRun), "Missing startRun line in server index");
  assert(serverSource.includes(requiredStartupLines.finishAll), "Missing finishAll line in server index");

  assert(runtimeFlowDoc.includes(requiredStartupLines.preProtect), "Missing preProtect line in fixed-script runtime doc");
  assert(runtimeFlowDoc.includes(requiredStartupLines.startRun), "Missing startRun line in fixed-script runtime doc");
  assert(runtimeFlowDoc.includes(requiredStartupLines.finishAll), "Missing finishAll line in fixed-script runtime doc");

  retiredLines.forEach((line) => {
    assert(!serverSource.includes(line), `Retired line still present in server index: ${line}`);
  });

  console.log("fixed-script config check passed");
  console.log(JSON.stringify({
    stageKeys,
    expectedVariantCounts,
    expectedRounds,
    startupLines: requiredStartupLines
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
