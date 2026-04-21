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

export const expectedNpcChatMaxRounds = 10;

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
    serverSource.includes('const NPC_CHAT_MAX_ROUNDS = 10;'),
    "NPC_CHAT_MAX_ROUNDS must stay at 10"
  );
  invariant(
    serverSource.includes('你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？'),
    "Fixed first-line social_warm opening is missing"
  );
}

function verifyGiftPolicy(serverSource, workerSource) {
  invariant(
    serverSource.includes('const giftPolicy = getGiftPolicyFromExecution(giftEntryExecution) || "gift_ten";'),
    "Server fallback gift policy must default to gift_ten"
  );
  invariant(
    workerSource.includes('if favor_limit == 99:') && workerSource.includes('gift_policy = "chat_direct"'),
    "Worker must route 99 favor limit to chat_direct"
  );
  invariant(
    workerSource.includes('gift_policy = "gift_ten"'),
    "Worker must route non-99 favor limit to gift_ten"
  );
  invariant(
    workerSource.includes("for round_index in range(10):"),
    "Worker gift_ten flow must send ten times"
  );
}

function verifyFailureVisibility(serverSource, debugSource) {
  invariant(
    serverSource.includes("async function appendFailureRescueMessage"),
    "appendFailureRescueMessage must exist"
  );
  invariant(
    serverSource.includes('recoveryLine: ""'),
    "Rescue messages must not expose recoveryLine"
  );
  invariant(
    debugSource.includes("recoveryBlock.hidden = true;"),
    "debug frontend must keep recoveryLine hidden"
  );
}

function verifyRuntimeDoc(runtimeDoc) {
  const requiredSnippets = [
    "状态：执行完成",
    "social_warm",
    "social_dark",
    "第一句固定发：",
    "你好呀！我是籽小刀，我爸爸叫籽岷。他超级无敌有名的！你认识他吗？",
    "前 `5` 轮：正常问搞钱门路。",
    "后 `5` 轮：黑化追问",
    "`99`：不送礼，直接聊天。",
    "其他一律按高门槛处理，连续送 `10` 个礼物。",
    "任何失败都不再静默吞掉"
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
    runtimeDocPath: path.resolve(projectRoot, "docs/specs/fixed-script-detailed-runtime-flow.md")
  };

  const [serverSource, workerSource, debugSource, runtimeDoc] = await Promise.all([
    readFile(files.serverPath, "utf8"),
    readFile(files.workerPath, "utf8"),
    readFile(files.debugPath, "utf8"),
    readFile(files.runtimeDocPath, "utf8")
  ]);

  return {
    ...files,
    serverSource,
    workerSource,
    debugSource,
    runtimeDoc
  };
}

export async function checkFixedScriptConfig(projectRoot = process.cwd()) {
  const artifacts = await loadFixedScriptArtifacts(projectRoot);

  verifyStageRounds(artifacts.serverSource);
  verifySocialIntent(artifacts.serverSource);
  verifyGiftPolicy(artifacts.serverSource, artifacts.workerSource);
  verifyFailureVisibility(artifacts.serverSource, artifacts.debugSource);
  verifyRuntimeDoc(artifacts.runtimeDoc);

  return {
    expectedRounds,
    expectedNpcChatMaxRounds
  };
}
