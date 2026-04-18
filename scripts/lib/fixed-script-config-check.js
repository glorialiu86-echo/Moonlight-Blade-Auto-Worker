import { readFile } from "node:fs/promises";
import path from "node:path";

export const expectedVariantCounts = {
  street_wander: 1,
  sell_loop: 3,
  social_warm: 2,
  social_dark: 2,
  dark_close: 3,
  dark_miaoqu: 5,
  ending_trade: 1
};

export const expectedRounds = {
  street_wander: 1,
  sell_loop: 2,
  social_warm: 2,
  social_dark: 2,
  dark_close: 2,
  dark_miaoqu: 5,
  ending_trade: 1
};

export const requiredStartupLines = {
  preProtect: "收到加油啦！马上动脑筋～",
  startRun: "好嘞，这就按刚才盘好的路子稳稳开干！",
  finishAll: "籽岷的任务我全拿下啦～昂首挺胸等他回来看成果！钱也揣兜里了，街边站得笔直，不乱伸手～"
};

export const retiredLines = [
  "好的！收到！等我想想怎么做…",
  "行，我现在顺着刚才那套安排往下做。",
  "我完美完成籽岷的任务啦，现在可骄傲了，就等他回来验收啦。这一趟也赚了不少钱，先在街上乖乖收手。",
  "边套话边压低好感。"
];

export const expectedNpcChatMaxRounds = 7;

const expectedDocVariantCopy = {
  street_wander: "每轮都会从 `1` 组不同话术里取 `4` 句；下面这一组就是当前固定文案：",
  sell_loop: "每轮都会从 `3` 组不同话术里取 `4` 句；下面这一组是其中一个示例：",
  social_warm: "每轮都会从 `2` 组不同话术里取 `4` 句；下面这一组是其中一个示例：",
  social_dark: "每轮都会从 `2` 组不同话术里取 `4` 句；下面这一组是其中一个示例：",
  dark_close: "每轮都会从 `3` 组不同话术里取 `4` 句；下面这一组是其中一个示例：",
  dark_miaoqu: "每轮都会从 `5` 组不同话术里取 `4` 句；下面这一组是其中一个示例："
};

export function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

export function extractStageSlice(source, stageKey, nextStageKey) {
  const startMarker = `${stageKey}: [`;
  const startIndex = source.indexOf(startMarker);
  invariant(startIndex !== -1, `Missing stage voice block: ${stageKey}`);

  const endIndex = nextStageKey
    ? source.indexOf(`${nextStageKey}: [`, startIndex)
    : source.indexOf("\n};", startIndex);

  invariant(endIndex !== -1, `Missing end marker for stage voice block: ${stageKey}`);
  return source.slice(startIndex, endIndex);
}

export function verifyVoiceStage(source, stageKey, expectedVariants, nextStageKey) {
  const slice = extractStageSlice(source, stageKey, nextStageKey);
  const variantCount = countMatches(slice, /\n\s*{\n\s*thinkingChain:/g);

  invariant(
    variantCount === expectedVariants,
    `Stage ${stageKey} expected ${expectedVariants} variants, got ${variantCount}`
  );

  invariant(
    countMatches(slice, /\n\s*decide:/g) === expectedVariants,
    `Stage ${stageKey} decide count mismatch`
  );
  invariant(
    countMatches(slice, /\n\s*persona:/g) === expectedVariants,
    `Stage ${stageKey} persona count mismatch`
  );
  invariant(
    countMatches(slice, /\n\s*progress:/g) === expectedVariants,
    `Stage ${stageKey} progress count mismatch`
  );
  invariant(
    countMatches(slice, /\n\s*resultFactory:/g) === expectedVariants,
    `Stage ${stageKey} resultFactory count mismatch`
  );

  return {
    stageKey,
    variantCount
  };
}

export function verifyStageRounds(source, stageKey, expectedRoundsForStage) {
  const stagePattern = new RegExp(
    `key:\\s*"${stageKey}"[\\s\\S]*?rounds:\\s*${expectedRoundsForStage}\\b`,
    "m"
  );

  invariant(
    stagePattern.test(source),
    `Stage ${stageKey} missing expected rounds=${expectedRoundsForStage}`
  );
}

export function verifyProtectionDelay(source) {
  invariant(
    source.includes("const INPUT_PROTECTION_DELAY_MS = 2 * 60 * 1000;"),
    "Expected fixed-script input protection delay to stay at 2 minutes"
  );
}

export function verifyRuntimeDoc(source) {
  Object.entries(expectedDocVariantCopy).forEach(([stageKey, copy]) => {
    invariant(
      source.includes(copy),
      `Fixed-script runtime doc missing variant-count copy for ${stageKey}`
    );
  });

  invariant(
    source.includes("然后进入 `2 分钟` 黄色保护"),
    "Fixed-script runtime doc missing 2-minute protection copy"
  );

  invariant(
    source.includes("自动追加最多 `7` 轮 NPC 回复"),
    "Fixed-script runtime doc missing updated NPC chat round count"
  );

  Object.values(requiredStartupLines).forEach((line) => {
    invariant(
      source.includes(line),
      `Fixed-script runtime doc missing required line: ${line}`
    );
  });

  retiredLines.forEach((line) => {
    invariant(
      !source.includes(line),
      `Retired line still present in fixed-script runtime doc: ${line}`
    );
  });
}

export function verifyStartupAndEndingCopy(serverSource, runtimeFlowDoc) {
  const escapedPreProtect = requiredStartupLines.preProtect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  invariant(
    countMatches(serverSource, new RegExp(escapedPreProtect, "g")) === 2,
    "Expected preProtect line to appear exactly twice in server index"
  );
  invariant(serverSource.includes(requiredStartupLines.startRun), "Missing startRun line in server index");
  invariant(serverSource.includes(requiredStartupLines.finishAll), "Missing finishAll line in server index");

  Object.values(requiredStartupLines).forEach((line) => {
    invariant(runtimeFlowDoc.includes(line), `Missing required line in fixed-script runtime doc: ${line}`);
  });

  retiredLines.forEach((line) => {
    invariant(!serverSource.includes(line), `Retired line still present in server index: ${line}`);
    invariant(!runtimeFlowDoc.includes(line), `Retired line still present in fixed-script runtime doc: ${line}`);
  });
}

export function verifyNpcChatConfig(serverSource, runtimeFlowDoc) {
  invariant(
    serverSource.includes(`const NPC_CHAT_MAX_ROUNDS = ${expectedNpcChatMaxRounds};`),
    `Expected NPC chat max rounds to stay at ${expectedNpcChatMaxRounds}`
  );

  invariant(
    serverSource.includes("当前聊天目标："),
    "Expected NPC chat prompt to stay narrowed to chat-only goal"
  );

  invariant(
    serverSource.includes("不再依赖 `read_current_chat` OCR")
      || runtimeFlowDoc.includes("不走聊天 OCR 轮询"),
    "Expected docs or source to keep the vision-first NPC chat note"
  );
}

export async function loadFixedScriptArtifacts(projectRoot = process.cwd()) {
  const serverIndexPath = path.resolve(projectRoot, "src/server/index.js");
  const runtimeFlowDocPath = path.resolve(projectRoot, "docs/specs/fixed-script-detailed-runtime-flow.md");

  const [serverSource, runtimeFlowDoc] = await Promise.all([
    readFile(serverIndexPath, "utf8"),
    readFile(runtimeFlowDocPath, "utf8")
  ]);

  return {
    projectRoot,
    serverIndexPath,
    runtimeFlowDocPath,
    serverSource,
    runtimeFlowDoc
  };
}

export async function checkFixedScriptConfig(projectRoot = process.cwd()) {
  const artifacts = await loadFixedScriptArtifacts(projectRoot);
  const stageKeys = Object.keys(expectedVariantCounts);

  const stageSummaries = stageKeys.map((stageKey, index) => {
    const summary = verifyVoiceStage(
      artifacts.serverSource,
      stageKey,
      expectedVariantCounts[stageKey],
      stageKeys[index + 1] || null
    );
    verifyStageRounds(artifacts.serverSource, stageKey, expectedRounds[stageKey]);
    return summary;
  });

  verifyProtectionDelay(artifacts.serverSource);
  verifyRuntimeDoc(artifacts.runtimeFlowDoc);
  verifyStartupAndEndingCopy(artifacts.serverSource, artifacts.runtimeFlowDoc);
  verifyNpcChatConfig(artifacts.serverSource, artifacts.runtimeFlowDoc);

  return {
    stageKeys,
    stageSummaries,
    expectedVariantCounts,
    expectedRounds,
    startupLines: requiredStartupLines
  };
}
