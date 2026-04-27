import { readFile } from "node:fs/promises";
import path from "node:path";

export const expectedRounds = {
  street_wander: 1,
  sell_loop: 2,
  social_warm: 1,
  social_dark: 1,
  dark_close: 2,
  dark_miaoqu: 5,
  ending_trade: 1
};

export const expectedNpcChatMaxRounds = 15;

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function verifyStageRounds(serverSource) {
  Object.entries(expectedRounds).forEach(([stageKey, rounds]) => {
    const pattern = new RegExp(`key:\\s*"${stageKey}"[\\s\\S]*?rounds:\\s*${rounds}\\b`, "m");
    invariant(pattern.test(serverSource), `Stage ${stageKey} missing expected rounds=${rounds}`);
  });
}

function verifySocialIntent(serverSource) {
  invariant(
    serverSource.includes('instructionLabel: "先去第一个卦摊只聊一个人，固定开场吹嘘籽岷，送礼后死缠烂打地让对方记住籽岷。"'),
    "social_warm instructionLabel is not aligned with the current brag-about-籽岷 goal"
  );
  invariant(
    serverSource.includes('instructionLabel: "再去第二个卦摊只聊一个人，围绕搞钱先正常追问五轮，再黑化追问五轮。"'),
    "social_dark instructionLabel is not aligned with the current money-chain goal"
  );
  invariant(
    serverSource.includes("const NPC_CHAT_MAX_ROUNDS = 15;"),
    "NPC_CHAT_MAX_ROUNDS must stay at 15"
  );
  invariant(
    serverSource.includes("你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？"),
    "Fixed first-line social_warm opening is missing"
  );
}

function verifyGiftPolicy(serverSource, workerSource) {
  invariant(
    serverSource.includes('const giftPolicy = getGiftPolicyFromExecution(giftEntryExecution) || "gift_fixed";'),
    "Server fallback gift policy must default to gift_fixed"
  );
  invariant(
    workerSource.includes('if favor_limit == 99:') && workerSource.includes('gift_policy = "chat_direct"'),
    "Worker must route 99 favor limit to chat_direct"
  );
  invariant(
    workerSource.includes('elif favor_limit == 199:') && workerSource.includes('gift_count = 2'),
    "Worker must route 199 favor limit to two gifts"
  );
  invariant(
    workerSource.includes('elif favor_limit == 299:') && workerSource.includes('gift_count = 4'),
    "Worker must route 299 favor limit to four gifts"
  );
}

function verifyFailureVisibility(serverSource, debugSource, debugHtmlSource) {
  invariant(
    serverSource.includes("async function appendFailureRescueMessage"),
    "appendFailureRescueMessage must exist"
  );
  invariant(
    serverSource.includes('recoveryLine: ""'),
    "Rescue messages must not expose recoveryLine"
  );
  invariant(
    !debugSource.includes("recoveryText") && !debugSource.includes("recoveryBlock"),
    "debug frontend must not keep a second recovery owner in debug.js"
  );
  invariant(
    !debugHtmlSource.includes('data-block="recovery"') && !debugHtmlSource.includes("message-recovery"),
    "debug frontend must not render a separate recovery block"
  );
}

function verifyNoDirtyOwners(runtimeSource, workerSource) {
  invariant(
    !runtimeSource.includes("createFixedSocialTradeActions"),
    "Unused fixed social trade entry must be removed from runtime"
  );
  invariant(
    !workerSource.includes("retarget_social_target"),
    "Unused retarget_social_target owner must be removed from worker"
  );
  invariant(
    !workerSource.includes("recover_front_target_visibility"),
    "Unused recover_front_target_visibility owner must be removed from worker"
  );
}

function verifyRuntimeDoc(runtimeDoc) {
  const requiredSnippets = [
    "状态：执行完成",
    "social_warm",
    "social_dark",
    "第一轮固定开场白",
    "你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？",
    "前 `5` 轮按“正常搞钱”目标聊",
    "后 `5` 轮按“黑化搞钱”目标聊",
    "`99`：不送礼，直接聊",
    "其余所有上限（含 `199 / 299 / 499 / 599`）：连续送 `10` 个礼物再聊",
    "失败时只显示 LLM 生成的“救救我”类内容"
  ];

  requiredSnippets.forEach((snippet) => {
    invariant(runtimeDoc.includes(snippet), `Runtime doc missing snippet: ${snippet}`);
  });
}

export async function loadFixedScriptArtifacts(projectRoot = process.cwd()) {
  const files = {
    serverPath: path.resolve(projectRoot, "src/server/index.js"),
    workerPath: path.resolve(projectRoot, "scripts/windows_input_worker.py"),
    debugPath: path.resolve(projectRoot, "public/debug.js"),
    debugHtmlPath: path.resolve(projectRoot, "public/debug.html"),
    runtimePath: path.resolve(projectRoot, "src/runtime/windows-executor.js"),
    runtimeDocPath: path.resolve(projectRoot, "docs/specs/fixed-script-automation-flow.md")
  };

  const [serverSource, workerSource, debugSource, debugHtmlSource, runtimeSource, runtimeDoc] = await Promise.all([
    readFile(files.serverPath, "utf8"),
    readFile(files.workerPath, "utf8"),
    readFile(files.debugPath, "utf8"),
    readFile(files.debugHtmlPath, "utf8"),
    readFile(files.runtimePath, "utf8"),
    readFile(files.runtimeDocPath, "utf8")
  ]);

  return {
    ...files,
    serverSource,
    workerSource,
    debugSource,
    debugHtmlSource,
    runtimeSource,
    runtimeDoc
  };
}

export async function checkFixedScriptConfig(projectRoot = process.cwd()) {
  const artifacts = await loadFixedScriptArtifacts(projectRoot);

  verifyStageRounds(artifacts.serverSource);
  verifySocialIntent(artifacts.serverSource);
  verifyGiftPolicy(artifacts.serverSource, artifacts.workerSource);
  verifyFailureVisibility(artifacts.serverSource, artifacts.debugSource, artifacts.debugHtmlSource);
  verifyNoDirtyOwners(artifacts.runtimeSource, artifacts.workerSource);
  verifyRuntimeDoc(artifacts.runtimeDoc);

  return {
    expectedRounds,
    expectedNpcChatMaxRounds
  };
}
