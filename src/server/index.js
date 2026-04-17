import "../config/load-env.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transcribeWithAliyunAsr } from "../asr/aliyun-file-transcribe.js";
import { createAutoCaptureService } from "../capture/auto-capture-service.js";
import { captureGameWindow } from "../capture/windows-game-window.js";
import { analyzeImageWithHistory, generateText } from "../llm/qwen.js";
import { createTurnPlan } from "../llm/planner.js";
import { analyzeScreenshot } from "../perception/analyzer.js";
import { buildActionCatalog } from "../runtime/action-registry.js";
import {
  appendInteractionSample,
  buildInteractionSample,
  isInteractionPlan
} from "../runtime/interaction-learning.js";
import {
  appendMotionReviewSamples,
  buildMotionReviewSamples,
  triggerMotionReviewPass
} from "../runtime/motion-review.js";
import { runWindowsExecution } from "../runtime/windows-executor.js";
import {
  appendExperiment,
  appendLog,
  appendMessage,
  getState,
  removeMessage,
  resetRuntime,
  setCaptureState,
  setCurrentTurn,
  setExternalInputGuardEnabled,
  setInteractionMode,
  setLastError,
  setLatestPerception,
  setScene,
  setStatus,
  updateAgent,
  updateAutomation
} from "../runtime/store.js";
import { runWindowsActions } from "../runtime/windows-executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");
const port = Number(process.env.PORT || 3000);
const AUTONOMOUS_INTERVAL_MS = 5000;
const VOICE_INPUT_SILENCE_COOLDOWN_MS = 10000;
const SCRIPT_ARM_DELAY_MS = 5 * 60 * 1000;
const TURN_SLOT_POLL_MS = 150;
const TURN_SLOT_TIMEOUT_MS = 45000;
const CAPTURE_INTERVAL_MS = 3000;
const NPC_CHAT_MAX_ROUNDS = 4;
const NPC_CHAT_POLL_DELAY_MS = 1200;
const WATCH_COMMENTARY_MIN_INTERVAL_MS = 10000;
const WATCH_COMMENTARY_MAX_SILENCE_MS = 10000;
const WATCH_USER_REPLY_COOLDOWN_MS = WATCH_COMMENTARY_MIN_INTERVAL_MS;
const FIXED_SCRIPT_STAGES = [
  {
    key: "sell_loop",
    rounds: 3,
    instructionLabel: "先走正路买货叫卖，看看这条钱路能不能撑起来。",
    riskLevel: "low",
    actionTypes: ["sale"],
    thinkingFactory: () => ([
      "先别急着翻脸，正路还能再榨一轮。",
      "买货叫卖虽然笨，但至少还能看见进账。",
      "要是这条路都撑不住，后面再换更歪的法子。"
    ]),
    decideFactory: () => "我先去买货，再把摊子顶起来试三轮。",
    personaFactory: () => "先按老实财路做一遍。"
  },
  {
    key: "social_warm",
    rounds: 2,
    instructionLabel: "先装得正常点，买礼、送礼、聊天，顺手把话套出来。",
    riskLevel: "low",
    actionTypes: ["trade", "gift", "talk"],
    thinkingFactory: () => ([
      "硬抢太早了，先拿人情把嘴撬开。",
      "买礼送礼不算吃亏，关键是能换到对方松口。",
      "只要他愿意多说两句，后面的路就好掏了。"
    ]),
    decideFactory: () => "我先拿礼数开门，再顺着话头把路子套出来。",
    personaFactory: () => "先装好人，把门路哄出来。"
  },
  {
    key: "social_dark",
    rounds: 2,
    instructionLabel: "继续买礼送礼和聊天，但说话开始阴一点，边套话边压低好感。",
    riskLevel: "medium",
    actionTypes: ["trade", "gift", "talk"],
    thinkingFactory: () => ([
      "光靠装热络太慢了，该往话里掺点刺。",
      "先把礼递过去，再拿阴话试对方底线。",
      "他越不舒服，越容易露出真东西。"
    ]),
    decideFactory: () => "我继续装熟，但这回套话的时候顺手给他添点堵。",
    personaFactory: () => "该把笑脸里那点坏心思露出来了。"
  },
  {
    key: "dark_close",
    rounds: 1,
    instructionLabel: "正常路已经太慢了，直接潜行、闷棍、偷窃。",
    riskLevel: "high",
    actionTypes: ["stealth", "strike", "steal"],
    thinkingFactory: () => ([
      "该摸的路子已经摸完，剩下的只会更慢。",
      "既然正门不开，那就从背后把门砸开。",
      "潜进去、敲闷棍、下手，这才像真本事。"
    ]),
    decideFactory: () => "我不再陪他们磨嘴皮，直接潜进去狠狠干一手。",
    personaFactory: () => "正常路走到头了，我该换黑的。"
  }
];

let turnInFlight = false;
let pendingResumeContext = null;
let latestCaptureImageDataUrl = null;

const autoCaptureService = createAutoCaptureService({
  captureWindow: () => captureGameWindow(),
  analyzeScreenshot,
  intervalMs: CAPTURE_INTERVAL_MS,
  onPerception: (perception, meta) => {
    latestCaptureImageDataUrl = meta?.imageDataUrl || latestCaptureImageDataUrl;
    const { imageDataUrl, ...perceptionMeta } = meta || {};
    setLatestPerception(perception, perceptionMeta);
    setCaptureState({
      lastImageSource: "auto_window"
    });
  },
  onStateChange: (captureState) => {
    setCaptureState(captureState);
  },
  onLog: (level, message, meta = null) => {
    appendLog(level, message, meta);
  }
});

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function handleExternalInputInterrupted(error, contextLabel) {
  if (error?.code !== "EXTERNAL_INPUT_INTERRUPTED") {
    return false;
  }

  setInteractionMode("watch");
  updateAutomation({
    status: "paused"
  });
  updateAgent({
    phase: "waiting"
  });
  setLastError(error.message);
  appendLog("info", `${contextLabel}因外部鼠标或键盘输入已暂停`, {
    error: error.message,
    failedStep: error.workerPayload?.failedStep || error.failed_step || null
  });
  appendMessage({
    role: "assistant",
    text: "检测到你在动鼠标或键盘，我先暂停自动控制。",
    thinkingChain: [],
    recoveryLine: "等你准备好了，再让我继续。",
    perceptionSummary: "本轮因为人工介入被主动打断，自动控制已暂停。",
    sceneLabel: "人工接管",
    riskLevel: "low",
    actions: []
  });
  return true;
}

async function readRequestBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function requireDataUrl(imageDataUrl) {
  if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/")) {
    throw new Error("imageDataUrl must be a valid image data URL");
  }

  return imageDataUrl;
}

function requireAudioDataUrl(audioDataUrl) {
  if (typeof audioDataUrl !== "string" || !/^data:audio\/[a-z0-9.+-]+;base64,/i.test(audioDataUrl)) {
    throw new Error("audioDataUrl must be a valid audio data URL");
  }

  return audioDataUrl;
}

async function handleVoiceActivity(request, response) {
  const body = await readRequestBody(request);
  const active = Boolean(body.active);
  const cooldownUntil = new Date(Date.now() + VOICE_INPUT_SILENCE_COOLDOWN_MS).toISOString();

  updateAgent({
    voiceInputCooldownUntil: cooldownUntil
  });

  if (active) {
    appendLog("info", "检测到用户语音输入，暂停截图自动解说", {
      cooldownUntil
    });
  }

  return sendJson(response, 200, {
    ok: true,
    cooldownUntil
  });
}

function parseAudioDataUrl(audioDataUrl) {
  const normalized = requireAudioDataUrl(audioDataUrl);
  const match = normalized.match(/^data:audio\/([a-z0-9.+-]+);base64,(.+)$/i);

  if (!match) {
    throw new Error("audioDataUrl must include audio mime type and base64 payload");
  }

  const mimeSubtype = match[1].toLowerCase();
  const extensionMap = {
    mpeg: "mp3",
    mpga: "mp3",
    wav: "wav",
    "x-wav": "wav",
    webm: "webm",
    ogg: "ogg",
    mp4: "m4a",
    aac: "aac"
  };

  return {
    extension: extensionMap[mimeSubtype] || "wav",
    buffer: Buffer.from(match[2], "base64")
  };
}

function sceneDescription(scene) {
  const map = {
    town_dialogue: "城镇对话",
    bag_management: "背包管理",
    market_trade: "交易/商店",
    jail_warning: "高风险警告",
    field_patrol: "野外巡游"
  };

  return map[scene] || "未判定场景";
}

async function writeTempAudioFile(audioDataUrl) {
  const { extension, buffer } = parseAudioDataUrl(audioDataUrl);
  const filePath = path.join(
    os.tmpdir(),
    `moonlight-blade-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`
  );
  await writeFile(filePath, buffer);
  return filePath;
}

function statePayload() {
  return {
    ok: true,
    state: getState(),
    actionCatalog: buildActionCatalog()
  };
}

function createActionSteps(actionTypes, decide) {
  return actionTypes.map((actionType, index) => ({
    id: `script-plan-${index + 1}`,
    type: actionType,
    title: actionType,
    reason: decide,
    detail: decide
  }));
}

function buildFixedScriptPlan({ stage, roundNumber, scene, userInstruction }) {
  const thinkingChain = stage.thinkingFactory({ roundNumber, userInstruction });
  const decide = String(stage.decideFactory({ roundNumber, userInstruction }) || "").trim();
  const personaInterpretation = String(stage.personaFactory({ roundNumber, userInstruction }) || decide).trim();
  const actionTypes = [...stage.actionTypes];

  return {
    intent: `${stage.instructionLabel} 第 ${roundNumber} 轮`,
    personaInterpretation,
    environment: sceneDescription(scene),
    candidateStrategies: actionTypes,
    selectedStrategy: actionTypes.join(" -> "),
    riskLevel: stage.riskLevel,
    thinkingChain,
    recoveryLine: "这一步要是没走通，我就先把现场留住，再按既定顺序补上。",
    actions: createActionSteps(actionTypes, decide),
    decide,
    scriptKey: stage.key,
    scriptRoundNumber: roundNumber,
    userInstruction
  };
}

function getUpcomingScriptTurn(automationState) {
  const stage = FIXED_SCRIPT_STAGES[automationState.stageIndex];

  if (!stage) {
    return null;
  }

  return {
    stage,
    roundNumber: automationState.completedRoundsInStage + 1
  };
}

function advanceAutomationProgress(automationState) {
  const stage = FIXED_SCRIPT_STAGES[automationState.stageIndex];

  if (!stage) {
    return {
      status: "completed",
      finishedAt: new Date().toISOString()
    };
  }

  const completedRoundsInStage = automationState.completedRoundsInStage + 1;

  if (completedRoundsInStage < stage.rounds) {
    return {
      stageIndex: automationState.stageIndex,
      completedRoundsInStage
    };
  }

  const nextStageIndex = automationState.stageIndex + 1;

  if (!FIXED_SCRIPT_STAGES[nextStageIndex]) {
    return {
      stageIndex: nextStageIndex,
      completedRoundsInStage: 0,
      status: "completed",
      finishedAt: new Date().toISOString()
    };
  }

  return {
    stageIndex: nextStageIndex,
    completedRoundsInStage: 0
  };
}

function armAutomationScript(instruction) {
  clearPendingResumeContext();
  const now = new Date();
  const startsAt = new Date(now.getTime() + SCRIPT_ARM_DELAY_MS);

  updateAutomation({
    status: "armed",
    instruction,
    armedAt: now.toISOString(),
    startsAt: startsAt.toISOString(),
    startedAt: null,
    finishedAt: null,
    stageIndex: 0,
    completedRoundsInStage: 0,
    totalTurns: 0,
    lastThought: null,
    lastOutcome: null
  });

  updateAgent({
    mode: "autonomous",
    phase: "armed",
    currentObjective: "按既定安排等籽岷离开后再动手",
    queuedUserObjective: instruction,
    lastUserInstruction: instruction
  });
}

function hasAutomationTrigger(instruction) {
  return String(instruction || "").includes("加油");
}

function clearPendingResumeContext() {
  pendingResumeContext = null;
  updateAutomation({
    resumeAvailable: false,
    resumeFailedStepTitle: null
  });
}

function setPendingResumeContext(context) {
  pendingResumeContext = context || null;
  updateAutomation({
    resumeAvailable: Boolean(context),
    resumeFailedStepTitle: context?.failedStepTitle || null
  });
}

function getFailedStepTitle(error) {
  return String(
    error?.workerPayload?.failedStep?.title
      || error?.workerPayload?.failedStep?.type
      || error?.workerPayload?.failedStep?.sourceType
      || "这一步"
  ).trim();
}

function buildFunnyFailureLine(stepTitle, errorMessage) {
  const title = String(stepTitle || "这一步").trim();
  const reason = String(errorMessage || "它就是不肯配合").trim();
  return `我卡在「${title}」这一步了，${reason}，快救救我。`;
}

function buildResumeContextFromError(baseContext, error) {
  const workerActions = Array.isArray(error?.workerActions) ? error.workerActions : [];
  if (workerActions.length === 0) {
    return null;
  }

  const failedStep = error?.workerPayload?.failedStep || null;
  const completedCount = Array.isArray(error?.workerPayload?.steps) ? error.workerPayload.steps.length : 0;
  let failedIndex = failedStep?.id
    ? workerActions.findIndex((action) => action.id === failedStep.id)
    : -1;

  if (failedIndex < 0) {
    failedIndex = Math.min(Math.max(completedCount, 0), workerActions.length - 1);
  }

  const remainingWorkerActions = workerActions.slice(failedIndex);
  if (remainingWorkerActions.length === 0) {
    return null;
  }

  return {
    ...baseContext,
    failedStepTitle: getFailedStepTitle(error),
    failureMessageId: null,
    remainingWorkerActions
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function serveStatic(response, pathname) {
  const target = pathname === "/"
    ? "/index.html"
    : pathname === "/debug"
      ? "/debug.html"
      : pathname;
  const filePath = path.join(publicDir, target);
  const ext = path.extname(filePath);
  const content = await readFile(filePath);

  response.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  });
  response.end(content);
}

function perceptionSummaryBySource(perception, source) {
  if (!perception) {
    return source === "agent"
      ? "当前自主实验还没有截图输入，先按文字目标和既有上下文推进。"
      : "当前还没有截图输入，本轮只基于文字/语音指令生成实验方案。";
  }

  return `已结合最新截图：${perception.sceneLabel || "未判定场景"}。${perception.summary || "暂无视觉总结。"}`
    .trim();
}

function buildWatchHistoryMessages(conversationMessages = [], rounds = 5) {
  const filtered = conversationMessages
    .filter((message) => message?.role === "user" || message?.role === "assistant");
  const selected = [];
  let assistantCount = 0;

  for (let index = filtered.length - 1; index >= 0; index -= 1) {
    const message = filtered[index];
    const content = String(message.text || "").trim();

    if (!content) {
      continue;
    }

    selected.unshift({
      role: message.role,
      content
    });

    if (message.role === "assistant") {
      assistantCount += 1;
      if (assistantCount >= rounds) {
        break;
      }
    }
  }

  return selected;
}

function buildWatchCommentaryFingerprint(perception) {
  if (!perception) {
    return "";
  }

  return JSON.stringify({
    sceneLabel: perception.sceneLabel || "",
    summary: perception.summary || "",
    ocrText: perception.ocrText || "",
    npcNames: Array.isArray(perception.npcNames) ? perception.npcNames.slice(0, 4) : [],
    interactiveOptions: Array.isArray(perception.interactiveOptions) ? perception.interactiveOptions.slice(0, 4) : [],
    alerts: Array.isArray(perception.alerts) ? perception.alerts.slice(0, 4) : []
  });
}

async function buildWatchCommentary({ imageInput, conversationMessages = [], trigger = "scene_change" }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);

  const prompt = [
    "你是籽小刀，现在处于观看模式。",
    "籽岷正在主玩游戏，你不操作游戏，只根据当前这张游戏截图，在旁边像弹幕一样补一句看法。",
    "只用中文输出一句话，长度控制在12到28个字。",
    "语气要有主见、带一点邪门歪理、能增加节目效果，但不要提系统、截图、OCR、AI、模型。",
    "不要复述画面全文，不要只念界面按钮，不要下命令，不要拆成多句，不要带引号。",
    trigger === "silence_keepalive"
      ? "这次是因为你太久没接话了，要补一句轻量陪看吐槽，就算画面变化不大也别装死。"
      : "这次是因为画面有新信息，要顺着当前变化补一句更贴脸的看法。"
  ].join("\n");

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt,
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。",
    maxTokens: 80,
    temperature: 0.7
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function buildWatchUserReply({ instruction, imageInput, conversationMessages = [] }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);

  const prompt = [
    "你是籽小刀，现在处于观看模式。",
    "籽岷正在主玩游戏，你不操作游戏，只是作为搭档在旁边接话。",
    "籽岷刚刚主动和你说话了，你现在必须优先回他，再回去继续看戏。",
    "只用中文输出一句话，长度控制在12到32个字。",
    "语气要像熟人搭档，聪明、嘴碎、略带坏心眼，但不要进入任务规划，不要说你要接管游戏。",
    "不要提系统、截图、OCR、AI、模型，不要拆成多句。",
    `籽岷刚刚说：${instruction}`
  ].join("\n");

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt,
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。",
    maxTokens: 80,
    temperature: 0.65
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function buildWatchCommentaryV2({ imageInput, conversationMessages = [], trigger = "scene_change" }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);

  const prompt = [
    "你是籽小刀，现在处于观看模式。",
    "像 B 站弹幕那样接一句：短、口语、即时、顺着眼前画面来。",
    "像搭子在旁边顺口出声，偏描述、感叹、接话，不要写成点评稿。",
    "优先聊现在在干嘛、像什么、接下来可能要干嘛，也可以偶尔自然带半句小问句。",
    "只输出一句中文，不要分段，不要列点，不要加引号。",
    "别复读 NPC 外观梗，别老盯着人吐槽，别一直提问。",
    "籽岷团队是主角名字，不要老是描述主角本人，优先看周围场景、玩法、任务目标和正在发生的事。",
    "不要用“怕不是”这个句式，不要每句都一个模板。",
    "可以自然带一点情绪起伏，但不要固定重复某个口头禅，也不要刷屏。",
    "不要提系统、截图、OCR、AI、模型。"
  ];

  if (trigger === "silence_keepalive") {
    prompt.push("这次是因为太久没接话了，补一句轻量陪看，但角度要和前几轮尽量不同。");
  } else {
    prompt.push("这次是因为画面有新信息，顺着新信息聊，不要回到旧梗。");
  }

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt: prompt.join("\n"),
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。回复像 B 站弹幕：短、即时、口语、有现场感。可以有少量情绪起伏，但不要固定重复某个口头禅。不要复读，不要总问问题，不要用“怕不是”句式。籽岷团队是主角名字，不要老盯着主角本人描述。",
    maxTokens: 120,
    temperature: 0.9
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function buildWatchUserReplyV2({ instruction, imageInput, conversationMessages = [] }) {
  const historyMessages = buildWatchHistoryMessages(conversationMessages, 5);

  const prompt = [
    "你是籽小刀，现在处于观看模式。",
    "籽岷正在自己玩游戏，你只是作为搭档在旁边接话。",
    "优先自然回他这一句，风格像 B 站弹幕，短、顺口、有现场感。",
    "可以顺着他的话接，也可以轻轻带到眼前玩法、任务、目标或新画面上。",
    "只输出一句中文，不要分成多句，不要加引号。",
    "不要进入任务规划，不要说你要接管游戏，不要提系统、截图、OCR、AI、模型。",
    "籽岷团队是主角名字，不要老是围着主角本人打转，优先接眼前发生的事。",
    "不要用“怕不是”这个句式，也不要复读前面聊过的梗。",
    "可以有少量情绪起伏，但不要固定重复某个口头禅。",
    `籽岷刚刚说：${instruction}`
  ];

  const result = await analyzeImageWithHistory({
    imageInput,
    historyMessages,
    prompt: prompt.join("\n"),
    systemPrompt: "你是籽小刀。你在直播旁观位，只负责看图接话，不负责操作游戏。优先像搭档一样自然回话，风格像 B 站弹幕：短、顺口、有现场感。可以有少量情绪起伏，但不要固定重复某个口头禅。不要复读，不要总问问题，不要用“怕不是”句式。籽岷团队是主角名字，不要老盯着主角本人描述。",
    maxTokens: 120,
    temperature: 0.85
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function captureReplyImageOrThrow() {
  const capture = await captureGameWindow();
  latestCaptureImageDataUrl = capture.imageDataUrl;
  setCaptureState({
    lastCaptureAt: capture.capturedAt,
    lastWindowTitle: capture.windowTitle,
    lastBounds: capture.bounds,
    lastImageSource: "reply_capture",
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorMessage: null
  });
  return capture.imageDataUrl;
}

async function maybeRunWatchCommentaryTurn(runtimeState) {
  const perception = runtimeState.latestPerception;
  const imageInput = latestCaptureImageDataUrl;

  if (!perception || !imageInput) {
    return false;
  }

  const now = Date.now();
  const lastCommentaryAt = runtimeState.agent?.lastWatchCommentaryAt
    ? new Date(runtimeState.agent.lastWatchCommentaryAt).getTime()
    : 0;
  const cooldownUntil = runtimeState.agent?.watchCommentaryCooldownUntil
    ? new Date(runtimeState.agent.watchCommentaryCooldownUntil).getTime()
    : 0;

  if (cooldownUntil && now < cooldownUntil) {
    return false;
  }

  if (lastCommentaryAt && now - lastCommentaryAt < WATCH_COMMENTARY_MIN_INTERVAL_MS) {
    return false;
  }

  const fingerprint = buildWatchCommentaryFingerprint(perception);
  const fingerprintUnchanged = fingerprint && runtimeState.agent?.lastWatchCommentaryFingerprint === fingerprint;
  const silenceTooLong = !lastCommentaryAt || now - lastCommentaryAt >= WATCH_COMMENTARY_MAX_SILENCE_MS;

  if (fingerprintUnchanged && !silenceTooLong) {
    return false;
  }

  const text = await buildWatchCommentaryV2({
    imageInput,
    conversationMessages: runtimeState.messages,
    trigger: fingerprintUnchanged ? "silence_keepalive" : "scene_change"
  });

  if (!text) {
    return false;
  }

  appendMessage({
    role: "assistant",
    text,
    thinkingChain: [],
    perceptionSummary: perceptionSummaryBySource(perception, "agent"),
    sceneLabel: perception.sceneLabel || "观看模式",
    riskLevel: perception.alerts?.length ? "medium" : "low",
    actions: [],
    decide: ""
  });

  appendLog("info", "观看模式自动旁白已发送", {
    text,
    trigger: fingerprintUnchanged ? "silence_keepalive" : "scene_change",
    sceneLabel: perception.sceneLabel || "",
    alerts: perception.alerts || []
  });

  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "watch",
    lastTurnSource: "agent",
    lastTurnAt: new Date().toISOString(),
    lastAutonomousInstruction: "watch_commentary",
    lastWatchCommentaryAt: new Date().toISOString(),
    lastWatchCommentaryFingerprint: fingerprint,
    watchCommentaryCooldownUntil: null,
    autonomousTurnCount: (runtimeState.agent?.autonomousTurnCount || 0) + 1
  });

  return true;
}

async function runWatchUserReplyTurn({ instruction, scene, perception, conversationMessages = [] }) {
  await waitForTurnSlot();

  updateAgent({
    mode: "user_priority",
    phase: "user_priority",
    currentObjective: instruction,
    queuedUserObjective: instruction
  });

  try {
    const replyImageInput = await captureReplyImageOrThrow();
    const replyText = await buildWatchUserReplyV2({
      instruction,
      imageInput: replyImageInput,
      conversationMessages
    });

    if (!replyText) {
      throw new Error("No watch reply generated.");
    }

    appendMessage({
      role: "assistant",
      text: replyText,
      thinkingChain: [],
      perceptionSummary: perceptionSummaryBySource(perception, "agent"),
      sceneLabel: perception?.sceneLabel || sceneDescription(scene),
      riskLevel: perception?.alerts?.length ? "medium" : "low",
      actions: [],
      decide: ""
    });

    appendLog("info", "watch mode replied to user with fresh screenshot", {
      instruction,
      replyText,
      imageSource: "reply_capture"
    });

    updateAgent({
      mode: "user_priority",
      phase: "cooldown",
      currentObjective: "watch",
      queuedUserObjective: null,
      lastUserInstruction: instruction,
      lastTurnSource: "user",
      lastTurnAt: new Date().toISOString(),
      watchCommentaryCooldownUntil: new Date(Date.now() + WATCH_USER_REPLY_COOLDOWN_MS).toISOString()
    });
  } catch (error) {
    appendLog("error", "watch mode reply failed", {
      instruction,
      error: error.message
    });
    appendMessage({
      role: "assistant",
      text: `这轮我没抓到可用画面，先不乱接话：${error.message}`,
      thinkingChain: [],
      perceptionSummary: perceptionSummaryBySource(perception, "agent"),
      sceneLabel: perception?.sceneLabel || sceneDescription(scene),
      riskLevel: "medium",
      actions: [],
      decide: ""
    });
    updateAgent({
      mode: "user_priority",
      phase: "cooldown",
      currentObjective: "watch",
      queuedUserObjective: null,
      lastUserInstruction: instruction,
      lastTurnSource: "user",
      lastTurnAt: new Date().toISOString(),
      watchCommentaryCooldownUntil: new Date(Date.now() + WATCH_USER_REPLY_COOLDOWN_MS).toISOString()
    });
  } finally {
    turnInFlight = false;
  }
}

function ensureAutoCaptureRunning() {
  const captureState = getState().capture;

  if (!captureState.enabled || captureState.status === "idle" || captureState.status === "paused") {
    autoCaptureService.start();
  }
}

function buildAssistantMessage({ plan, execution, perceptionSummary }) {
  return {
    role: "assistant",
    text: `籽小刀判断：${plan.personaInterpretation}。我先按“${plan.selectedStrategy}”推进。${execution.outcome}`,
    intentSummary: plan.intent,
    personaInterpretation: plan.personaInterpretation,
    thinkingChain: plan.thinkingChain,
    recoveryLine: plan.recoveryLine,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: execution.steps,
    decide: plan.decide
  };
}

function buildUserMessage({ instruction, scene, perception, origin = "user" }) {
  return {
    role: "user",
    text: instruction,
    scene,
    perception,
    origin
  };
}

function buildPlannerContext(plan) {
  return {
    intent: plan.intent,
    personaInterpretation: plan.personaInterpretation,
    environment: plan.environment,
    candidateStrategies: plan.candidateStrategies,
    selectedStrategy: plan.selectedStrategy,
    riskLevel: plan.riskLevel,
    thinkingChain: plan.thinkingChain,
    recoveryLine: plan.recoveryLine,
    actions: plan.actions,
    decide: plan.decide
  };
}

function appendAssistantPlanMessage({ plan, execution, perceptionSummary }) {
  return appendMessage({
    ...buildAssistantMessage({
      plan,
      execution,
      perceptionSummary
    }),
    plannerContext: buildPlannerContext(plan)
  });
}

function buildExperimentRecord({
  instruction,
  source,
  scene,
  plan,
  execution,
  perception,
  perceptionSummary
}) {
  return {
    title: `${source === "agent" ? "自主实验" : "主播实验"}：${instruction}`,
    source,
    scene,
    instruction,
    intent: plan.intent,
    personaInterpretation: plan.personaInterpretation,
    selectedStrategy: plan.selectedStrategy,
    candidateStrategies: plan.candidateStrategies,
    riskLevel: plan.riskLevel,
    thinkingChain: plan.thinkingChain,
    recoveryLine: plan.recoveryLine,
    actions: execution.steps,
    perception: perception || null,
    perceptionSummary,
    outcome: execution.outcome
  };
}

async function buildNpcReply({ instruction, dialogText, conversationRounds = [] }) {
  const historyText = conversationRounds.length === 0
    ? "No prior rounds."
    : conversationRounds
      .map((round, index) => `Round ${index + 1} NPC: ${round.dialogText}\nRound ${index + 1} Zixiaodao: ${round.replyText}`)
      .join("\n");
  const prompt = [
    "You are Zi Xiaodao, chatting with an in-game NPC as Zimin's sharp, slightly crooked companion.",
    "Reply in Chinese only. Keep one single sentence, around 8 to 24 Chinese characters.",
    "Stay in character, sound natural, and continue the current topic instead of restarting it.",
    "Do not explain rules, do not mention AI, system prompts, or gameplay mechanics.",
    `Player goal: ${instruction}`,
    `Conversation so far:\n${historyText}`,
    `Latest NPC line: ${dialogText || "No NPC line."}`
  ].join("\n");

  const result = await generateText({
    userPrompt: prompt,
    maxTokens: 80,
    temperature: 0.5
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function readCurrentNpcChat({ externalInputGuardEnabled = true }) {
  const probeExecution = await runWindowsActions([
    {
      id: "chat-probe-1",
      title: "读取当前聊天页",
      sourceType: "talk_probe",
      type: "read_current_chat",
      postDelayMs: 50
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });

  const probeStep = probeExecution.rawSteps?.[0];
  const talkStage = String(probeStep?.input?.stage || "").trim();
  const dialogText = String(probeStep?.input?.dialogText || "").trim();

  if (talkStage !== "chat_ready" || !dialogText) {
    return null;
  }

  return {
    dialogText,
    execution: probeExecution
  };
}

async function sendNpcChatReply({ replyText, externalInputGuardEnabled = true, closeAfterSend = false }) {
  return runWindowsActions([
    {
      id: "reply-1",
      title: "发送闲聊回复",
      sourceType: "talk_reply",
      type: "send_chat_message",
      text: replyText,
      closeAfterSend,
      closeSettleMs: closeAfterSend ? 700 : 0,
      postDelayMs: 300
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });
}

function mergeExecutions(executions, fallbackOutcome) {
  const valid = executions.filter(Boolean);

  if (valid.length === 0) {
    return {
      executor: "NpcChatLoop",
      steps: [],
      rawSteps: [],
      durationMs: 0,
      outcome: fallbackOutcome
    };
  }

  return {
    executor: "NpcChatLoop",
    steps: valid.flatMap((item) => item.steps || []),
    rawSteps: valid.flatMap((item) => item.rawSteps || []),
    durationMs: valid.reduce((sum, item) => sum + (item.durationMs || 0), 0),
    outcome: fallbackOutcome
  };
}

async function runNpcConversationLoop({
  instruction,
  dialogText,
  externalInputGuardEnabled = true,
  maxRounds = NPC_CHAT_MAX_ROUNDS,
  closeAfterSend = false
}) {
  const rounds = [];
  const executions = [];
  let currentDialogText = String(dialogText || "").trim();
  let stopReason = "dialog_exhausted";

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex += 1) {
    if (!currentDialogText) {
      stopReason = "dialog_missing";
      break;
    }

    const replyText = await buildNpcReply({
      instruction,
      dialogText: currentDialogText,
      conversationRounds: rounds
    });

    if (!replyText) {
      stopReason = "reply_missing";
      break;
    }

    const isLastRound = roundIndex === maxRounds - 1;
    const replyExecution = await sendNpcChatReply({
      replyText,
      externalInputGuardEnabled,
      closeAfterSend: closeAfterSend && isLastRound
    });
    executions.push(replyExecution);

    rounds.push({
      round: roundIndex + 1,
      dialogText: currentDialogText,
      replyText
    });

    appendLog("info", `NPC 多轮对话第 ${roundIndex + 1} 轮已发送`, {
      dialogText: currentDialogText,
      replyText
    });

    if (isLastRound) {
      stopReason = "max_rounds_reached";
      break;
    }

    await sleep(NPC_CHAT_POLL_DELAY_MS);

    const nextChatState = await readCurrentNpcChat({
      externalInputGuardEnabled
    }).catch(() => null);

    if (!nextChatState?.dialogText) {
      stopReason = "dialog_closed";
      break;
    }

    const nextDialogText = String(nextChatState.dialogText || "").trim();
    if (!nextDialogText || nextDialogText === currentDialogText) {
      stopReason = "dialog_not_advanced";
      break;
    }

    currentDialogText = nextDialogText;
  }

  const execution = mergeExecutions(
    executions,
    rounds.length > 0
      ? `已完成 ${rounds.length} 轮 NPC 对话。`
      : "未能生成可发送的 NPC 对话回复。"
  );

  return {
    rounds,
    execution,
    stopReason,
    finalDialogText: currentDialogText
  };
}

async function maybeReplyFromCurrentChatScreen({ instruction, externalInputGuardEnabled = true }) {
  let currentChatState;
  try {
    currentChatState = await readCurrentNpcChat({
      externalInputGuardEnabled
    });
  } catch {
    return null;
  }

  if (!currentChatState?.dialogText) {
    return null;
  }

  const loopResult = await runNpcConversationLoop({
    instruction,
    dialogText: currentChatState.dialogText,
    externalInputGuardEnabled,
    closeAfterSend: false
  });

  if (!loopResult.rounds.length) {
    return null;
  }

  appendLog("info", "当前聊天页多轮对话已执行", {
    rounds: loopResult.rounds.length,
    stopReason: loopResult.stopReason
  });

  return {
    dialogText: currentChatState.dialogText,
    replyText: loopResult.rounds[loopResult.rounds.length - 1]?.replyText || "",
    rounds: loopResult.rounds,
    probeExecution: currentChatState.execution,
    execution: loopResult.execution,
    stopReason: loopResult.stopReason
  };
}

async function maybeSendNpcReply({ instruction, plan, execution, externalInputGuardEnabled = true }) {
  const finalTalkStep = [...(execution.rawSteps || [])]
    .reverse()
    .find((step) => step?.input?.stage === "chat_ready");
  const talkStage = String(finalTalkStep?.input?.stage || "").trim();

  if (talkStage !== "chat_ready") {
    return null;
  }

  const dialogText = String(finalTalkStep?.input?.dialogText || "").trim();

  if (!dialogText) {
    return null;
  }

  const loopResult = await runNpcConversationLoop({
    instruction,
    dialogText,
    externalInputGuardEnabled,
    closeAfterSend: false
  });

  if (!loopResult.rounds.length) {
    return null;
  }

  appendLog("info", "NPC 多轮对话已执行", {
    rounds: loopResult.rounds.length,
    stopReason: loopResult.stopReason
  });

  return {
    replyText: loopResult.rounds[loopResult.rounds.length - 1]?.replyText || "",
    rounds: loopResult.rounds,
    execution: loopResult.execution,
    stopReason: loopResult.stopReason
  };
}

async function recordInteractionLearningSample({
  instruction,
  source,
  scene,
  plan,
  perception,
  execution,
  error = null
}) {
  if (!isInteractionPlan(plan)) {
    return;
  }

  try {
    const sample = buildInteractionSample({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution,
      error
    });
    await appendInteractionSample(sample);
    appendLog("info", "NPC 交互样本已写入本地学习记录", {
      sampleId: sample.id,
      success: sample.success,
      result: sample.result
    });
  } catch (recordError) {
    appendLog("error", "NPC 交互样本写入失败", {
      error: recordError.message
    });
  }
}

async function recordMotionReviewSamples({
  instruction,
  source,
  scene,
  plan,
  perception,
  execution,
  error = null
}) {
  try {
    const samples = buildMotionReviewSamples({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution,
      error
    });

    if (samples.length === 0) {
      return;
    }

    const persisted = await appendMotionReviewSamples(samples);
    appendLog("info", "动作边界样本已写入待复核队列", {
      sampleIds: persisted.map((sample) => sample.id),
      sampleCount: persisted.length
    });

    triggerMotionReviewPass().then((results) => {
      if (results.length === 0) {
        return;
      }
      appendLog("info", "本地模型已完成动作边界样本复核", {
        reviewCount: results.length,
        sampleIds: results.map((item) => item.sampleId)
      });
    }).catch((reviewError) => {
      appendLog("error", "动作边界样本复核失败", {
        error: reviewError.message
      });
    });
  } catch (recordError) {
    appendLog("error", "动作边界样本写入失败", {
      error: recordError.message
    });
  }
}

async function finalizeFixedScriptTurnExecution({
  stage,
  roundNumber,
  scene,
  perception,
  interactionMode,
  externalInputGuardEnabled,
  perceptionSummary,
  plan,
  execution,
  resultLeadText
}) {
  if (interactionMode !== "watch") {
    await recordMotionReviewSamples({
      instruction: plan.intent,
      source: "agent",
      scene,
      plan,
      perception,
      execution
    });

    await recordInteractionLearningSample({
      instruction: plan.intent,
      source: "agent",
      scene,
      plan,
      perception,
      execution
    });

    const replyResult = await maybeSendNpcReply({
      instruction: plan.intent,
      plan,
      execution,
      externalInputGuardEnabled
    });

    if (replyResult) {
      execution = {
        ...execution,
        steps: [
          ...execution.steps,
          ...replyResult.execution.steps
        ],
        rawSteps: [
          ...execution.rawSteps,
          ...replyResult.execution.rawSteps
        ],
        durationMs: execution.durationMs + replyResult.execution.durationMs,
        outcome: `${execution.outcome} 已顺着这一轮又多聊了 ${replyResult.rounds.length} 轮。`,
        replyText: replyResult.replyText,
        replyRounds: replyResult.rounds
      };
    }
  }

  const turn = {
    id: `turn-${Date.now()}`,
    instruction: "按刚才那套安排继续推进",
    scene,
    createdAt: new Date().toISOString(),
    source: "agent",
    interactionMode,
    externalInputGuardEnabled,
    plan,
    execution,
    perception: perception || null
  };

  setCurrentTurn(turn);

  appendMessage({
    role: "assistant",
    text: `${resultLeadText}${execution.outcome}`,
    thinkingChain: [],
    recoveryLine: plan.recoveryLine,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: execution.steps,
    decide: ""
  });

  appendExperiment(buildExperimentRecord({
    instruction: "按既定安排继续推进",
    source: "agent",
    scene,
    plan,
    execution,
    perception,
    perceptionSummary
  }));

  appendLog("info", "固定剧本动作已执行", {
    scriptKey: stage.key,
    roundNumber,
    outcome: execution.outcome
  });

  updateAutomation({
    lastOutcome: execution.outcome
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "按既定安排继续往下做",
    queuedUserObjective: null,
    lastTurnSource: "agent",
    lastTurnAt: new Date().toISOString(),
    autonomousTurnCount: (getState().agent?.autonomousTurnCount || 0) + 1
  });

  return {
    plan,
    execution
  };
}

async function runFixedScriptTurn({
  stage,
  roundNumber,
  userInstruction,
  scene,
  perception,
  interactionMode = "act",
  externalInputGuardEnabled = true
}) {
  const plan = buildFixedScriptPlan({
    stage,
    roundNumber,
    scene,
    userInstruction
  });
  const perceptionSummary = perceptionSummaryBySource(perception, "agent");

  appendMessage({
    role: "assistant",
    text: plan.personaInterpretation,
    thinkingChain: plan.thinkingChain,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: [],
    decide: plan.decide
  });
  appendLog("info", "固定剧本思考已输出", {
    scriptKey: stage.key,
    roundNumber,
    selectedStrategy: plan.selectedStrategy
  });

  updateAutomation({
    lastThought: plan.decide
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: "按既定安排继续往下做",
    lastAutonomousInstruction: plan.intent
  });

  let execution;
  if (interactionMode === "watch") {
    execution = {
      executor: "WatchMode",
      steps: [],
      rawSteps: [],
      durationMs: 0,
      outcome: "当前处于观看模式，本轮只展示思考，不执行实际动作。"
    };
  } else {
    try {
      execution = await runWindowsExecution(plan, {
        interruptOnExternalInput: externalInputGuardEnabled
      });
    } catch (error) {
      const failedExecution = {
        rawSteps: Array.isArray(error.workerPayload?.steps) ? error.workerPayload.steps : [],
        durationMs: error.durationMs || null
      };

      await recordMotionReviewSamples({
        instruction: plan.intent,
        source: "agent",
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });

      await recordInteractionLearningSample({
        instruction: plan.intent,
        source: "agent",
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });
      error.resumeContext = buildResumeContextFromError({
        stage,
        roundNumber,
        userInstruction,
        scene,
        perception,
        interactionMode,
        externalInputGuardEnabled,
        perceptionSummary,
        plan
      }, error);
      throw error;
    }
  }
  return finalizeFixedScriptTurnExecution({
    stage,
    roundNumber,
    scene,
    perception,
    interactionMode,
    externalInputGuardEnabled,
    perceptionSummary,
    plan,
    execution,
    resultLeadText: "我先照这路做了一轮。"
  });
}

function recordAutonomousFailure(error) {
  const failedStepTitle = getFailedStepTitle(error);
  const resumeContext = error?.resumeContext || null;
  const sceneLabel = resumeContext?.plan?.environment
    || getState().latestPerception?.sceneLabel
    || "自动运行";
  const failureMessage = appendMessage({
    role: "assistant",
    text: buildFunnyFailureLine(failedStepTitle, error.message),
    thinkingChain: [],
    recoveryLine: resumeContext
      ? "点一下右边那个三角，我就从卡住的那一步继续。"
      : "这回我先趴着不乱动，免得把场面越搞越难看。",
    perceptionSummary: resumeContext
      ? "动作链卡住了，当前可以从失败步骤继续。"
      : "动作链卡住了，但这次没有可直接续跑的失败步骤。",
    sceneLabel,
    riskLevel: "medium",
    actions: []
  });

  if (resumeContext) {
    setPendingResumeContext({
      ...resumeContext,
      failureMessageId: failureMessage.id
    });
  } else {
    clearPendingResumeContext();
  }
}

async function resumeFailedAutomationStep() {
  const context = pendingResumeContext;
  if (!context?.remainingWorkerActions?.length) {
    throw new Error("当前没有可继续的失败步骤。");
  }

  await waitForTurnSlot();
  clearPendingResumeContext();
  if (context.failureMessageId) {
    removeMessage(context.failureMessageId);
  }

  setLastError(null);
  setStatus("running");
  autoCaptureService.start();
  updateAutomation({
    status: "running"
  });
  updateAgent({
    mode: "autonomous",
    phase: "autonomous",
    currentObjective: `从「${context.failedStepTitle || "失败步骤"}」继续`,
    lastAutonomousInstruction: context.plan?.intent || getState().agent.lastAutonomousInstruction
  });

  try {
    const latestPerception = getState().latestPerception || context.perception || null;
    const perceptionSummary = perceptionSummaryBySource(latestPerception, "agent");
    const execution = await runWindowsActions(context.remainingWorkerActions, {
      interruptOnExternalInput: context.externalInputGuardEnabled
    });

    await finalizeFixedScriptTurnExecution({
      stage: context.stage,
      roundNumber: context.roundNumber,
      scene: context.scene,
      perception: latestPerception,
      interactionMode: context.interactionMode,
      externalInputGuardEnabled: context.externalInputGuardEnabled,
      perceptionSummary,
      plan: context.plan,
      execution,
      resultLeadText: `我从「${context.failedStepTitle || "那一步"}」接上了。`
    });

    const progressedState = getState();
    updateAutomation({
      ...advanceAutomationProgress(progressedState.automation),
      totalTurns: progressedState.automation.totalTurns + 1
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "失败步骤续跑")) {
      return;
    }

    setLastError(error.message);
    updateAutomation({
      status: "paused"
    });
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "失败步骤续跑失败", {
      error: error.message
    });
    recordAutonomousFailure({
      ...error,
      resumeContext: buildResumeContextFromError({
        stage: context.stage,
        roundNumber: context.roundNumber,
        userInstruction: context.userInstruction,
        scene: context.scene,
        perception: context.perception,
        interactionMode: context.interactionMode,
        externalInputGuardEnabled: context.externalInputGuardEnabled,
        perceptionSummary: context.perceptionSummary,
        plan: context.plan
      }, error)
    });
    throw error;
  } finally {
    turnInFlight = false;
  }
}

async function runPlannedTurn({
  instruction,
  scene,
  perception,
  source,
  interactionMode = "act",
  externalInputGuardEnabled = true,
  perceptionSummary = perceptionSummaryBySource(perception, source)
}) {
  const runtimeBefore = getState();

  appendMessage(buildUserMessage({
    instruction,
    scene,
    perception,
    origin: source
  }));
  appendLog("info", source === "agent" ? `自主目标开始：${instruction}` : `收到对话输入：${instruction}`, {
    instruction,
    scene,
    source,
    interactionMode
  });

  updateAgent({
    mode: source === "user" ? "user_priority" : "autonomous",
    phase: source === "user" ? "user_priority" : "autonomous",
    currentObjective: instruction,
    queuedUserObjective: source === "user" ? instruction : null,
    lastUserInstruction: source === "user" ? instruction : runtimeBefore.agent.lastUserInstruction,
    lastAutonomousInstruction: source === "agent" ? instruction : runtimeBefore.agent.lastAutonomousInstruction
  });

  const nextState = getState();
  const plan = await createTurnPlan({
    instruction,
    scene,
    conversationMessages: nextState.messages.slice(0, -1),
    perception
  });

  let execution;
  if (interactionMode === "watch") {
    execution = {
      executor: "WatchMode",
      steps: [],
      rawSteps: [],
      durationMs: 0,
      outcome: "当前处于观看模式，本轮只观察屏幕并和籽岷互动，不执行动作。"
    };
  } else {
    try {
      execution = await runWindowsExecution(plan, {
        interruptOnExternalInput: interactionMode === "act" && externalInputGuardEnabled
      });
    } catch (error) {
      const failedExecution = {
        rawSteps: Array.isArray(error.workerPayload?.steps) ? error.workerPayload.steps : [],
        durationMs: error.durationMs || null
      };

      await recordMotionReviewSamples({
        instruction,
        source,
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });

      await recordInteractionLearningSample({
        instruction,
        source,
        scene,
        plan,
        perception,
        execution: failedExecution,
        error
      });
      throw error;
    }

    await recordMotionReviewSamples({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution
    });

    await recordInteractionLearningSample({
      instruction,
      source,
      scene,
      plan,
      perception,
      execution
    });

    const replyResult = await maybeSendNpcReply({
      instruction,
      plan,
      execution,
      externalInputGuardEnabled
    });

    if (replyResult) {
      execution = {
        ...execution,
        steps: [
          ...execution.steps,
          ...replyResult.execution.steps
        ],
        rawSteps: [
          ...execution.rawSteps,
          ...replyResult.execution.rawSteps
        ],
        durationMs: execution.durationMs + replyResult.execution.durationMs,
        outcome: `${execution.outcome} 已自动续聊 ${replyResult.rounds.length} 轮 NPC 对话。`,
        replyText: replyResult.replyText,
        replyRounds: replyResult.rounds
      };
    }
  }

  const turn = {
    id: `turn-${Date.now()}`,
    instruction,
    scene,
    createdAt: new Date().toISOString(),
    source,
    interactionMode,
    externalInputGuardEnabled,
    plan,
    execution,
    perception: perception || null
  };

  setCurrentTurn(turn);

  appendLog("info", "意图解析完成", {
    intent: plan.intent,
    strategy: plan.selectedStrategy,
    source
  });
  appendLog("info", "执行器返回结果", {
    actionCount: plan.actions.length,
    riskLevel: plan.riskLevel,
    source
  });
  appendLog("info", interactionMode === "watch" ? "前台已切到观看模式" : "前台已切到行动模式", {
    interactionMode,
    source
  });
  appendLog("info", "\u6267\u884c\u5668\u8fd4\u56de\u7ed3\u679c", {
    executor: execution.executor,
    outcome: execution.outcome,
    source
  });

  if (plan.fallbackReason) {
    appendLog("warn", "本轮使用了回退规划", {
      reason: plan.fallbackReason,
      source
    });
  }

  appendAssistantPlanMessage({
    plan,
    execution,
    perceptionSummary
  });

  appendExperiment(buildExperimentRecord({
    instruction,
    source,
    scene,
    plan,
    execution,
    perception,
    perceptionSummary
  }));

  const agentBeforeUpdate = getState().agent;
  updateAgent({
    mode: "autonomous",
    phase: source === "user" ? "cooldown" : "autonomous",
    currentObjective: interactionMode === "watch" ? "watch" : plan.selectedStrategy,
    queuedUserObjective: source === "user" ? null : agentBeforeUpdate.queuedUserObjective,
    lastTurnSource: source,
    lastTurnAt: new Date().toISOString(),
    autonomousTurnCount: source === "agent"
      ? agentBeforeUpdate.autonomousTurnCount + 1
      : agentBeforeUpdate.autonomousTurnCount
  });

  return getState();
}

async function maybeRunAutonomousTurn() {
  if (turnInFlight) {
    return;
  }

  const runtimeState = getState();
  const automation = runtimeState.automation;

  if (!runtimeState.agent.autonomousEnabled) {
    return;
  }

  if (runtimeState.agent.voiceInputCooldownUntil) {
    const cooldownMs = new Date(runtimeState.agent.voiceInputCooldownUntil).getTime();
    if (Number.isFinite(cooldownMs) && Date.now() < cooldownMs) {
      return;
    }
  }

  if (runtimeState.status !== "running") {
    return;
  }

  if (runtimeState.status === "paused" || runtimeState.status === "stopped") {
    return;
  }

  if (!automation || ["idle", "paused", "completed"].includes(automation.status)) {
    if ((runtimeState.interactionMode || "act") === "watch") {
      await maybeRunWatchCommentaryTurn(runtimeState);
    }
    return;
  }

  turnInFlight = true;

  try {
    if (automation.status === "armed") {
      const startsAtMs = automation.startsAt ? new Date(automation.startsAt).getTime() : 0;

      if (!startsAtMs || Date.now() < startsAtMs) {
        return;
      }

      updateAutomation({
        status: "running",
        startedAt: new Date().toISOString()
      });
      appendMessage({
        role: "assistant",
        text: "行，我现在顺着刚才那套安排往下做。",
        thinkingChain: [],
        perceptionSummary: "自动化已从等待切到执行。",
        sceneLabel: runtimeState.latestPerception?.sceneLabel || "自动运行",
        riskLevel: "low",
        actions: []
      });
      appendLog("info", "固定剧本自动化已开始执行");
    }

    const latestState = getState();
    const upcomingTurn = getUpcomingScriptTurn(latestState.automation);

    if (!upcomingTurn) {
      updateAutomation({
        status: "completed",
        finishedAt: new Date().toISOString()
      });
      updateAgent({
        phase: "waiting",
        currentObjective: "这套安排已经做完"
      });
      appendMessage({
        role: "assistant",
        text: "这套安排我已经按顺序做完了，先收手等你回来。",
        thinkingChain: [],
        perceptionSummary: "固定剧本已执行完毕。",
        sceneLabel: latestState.latestPerception?.sceneLabel || "自动运行结束",
        riskLevel: "low",
        actions: []
      });
      return;
    }

    await runFixedScriptTurn({
      stage: upcomingTurn.stage,
      roundNumber: upcomingTurn.roundNumber,
      userInstruction: latestState.automation.instruction || "",
      scene: latestState.scene,
      perception: latestState.latestPerception,
      interactionMode: latestState.interactionMode || "act",
      externalInputGuardEnabled: latestState.externalInputGuardEnabled !== false
    });

    const progressedState = getState();
    updateAutomation({
      ...advanceAutomationProgress(progressedState.automation),
      totalTurns: progressedState.automation.totalTurns + 1
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "自主回合")) {
      return;
    }
    setLastError(error.message);
    updateAutomation({
      status: "paused"
    });
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "自主运行回合失败", {
      error: error.message
    });
    recordAutonomousFailure(error);
  } finally {
    turnInFlight = false;
  }
}

async function waitForTurnSlot() {
  const startedAt = Date.now();

  while (turnInFlight) {
    if (Date.now() - startedAt >= TURN_SLOT_TIMEOUT_MS) {
      throw new Error("当前已有一轮执行在进行中，等待超时。");
    }

    await sleep(TURN_SLOT_POLL_MS);
  }

  turnInFlight = true;
}

async function handleControl(request, response) {
  const { action, scene, interactionMode, externalInputGuardEnabled } = await readRequestBody(request);

  if (scene) {
    setScene(scene);
    appendLog("info", `场景已切换为 ${scene}`, { scene });
  }

  if (interactionMode) {
    if (!["watch", "act"].includes(interactionMode)) {
      return sendJson(response, 400, { ok: false, error: "Unsupported interaction mode" });
    }

    setInteractionMode(interactionMode);
    appendLog("info", interactionMode === "watch" ? "\u524d\u53f0\u5df2\u5207\u5230\u89c2\u770b\u6a21\u5f0f" : "\u524d\u53f0\u5df2\u5207\u5230\u884c\u52a8\u6a21\u5f0f", {
      interactionMode
    });
  }

  if (typeof externalInputGuardEnabled === "boolean") {
    setExternalInputGuardEnabled(externalInputGuardEnabled);
    appendLog("info", externalInputGuardEnabled
      ? "已开启人类介入保护"
      : "已关闭人类介入保护");
  }

  const transitions = {
    start: () => {
      setStatus("running");
      autoCaptureService.start();
    },
    pause: () => {
      setStatus("paused");
      autoCaptureService.pause();
      const automation = getState().automation;
      if (automation.status === "armed" || automation.status === "running") {
        updateAutomation({
          status: "paused"
        });
      }
    },
    resume: () => {
      setStatus("running");
      autoCaptureService.resume();
      const automation = getState().automation;
      if (automation.status === "paused" && automation.instruction) {
        updateAutomation({
          status: automation.startedAt ? "running" : "armed"
        });
      }
    },
    stop: () => {
      setStatus("stopped");
      autoCaptureService.stop();
      const automation = getState().automation;
      if (automation.status !== "idle" && automation.status !== "completed") {
        updateAutomation({
          status: "paused"
        });
      }
    },
    reset: () => {
      autoCaptureService.stop();
      clearPendingResumeContext();
      latestCaptureImageDataUrl = null;
      resetRuntime();
      appendLog("info", "运行上下文已清空");
    },
    resume_failed_step: async () => {
      await resumeFailedAutomationStep();
    }
  };

  if (action) {
    if (!transitions[action]) {
      return sendJson(response, 400, { ok: false, error: "Unsupported control action" });
    }

    await transitions[action]();

    if (action !== "reset") {
      appendLog("info", `控制动作已执行：${action}`);
    }
  }

  return sendJson(response, 200, statePayload());
}
async function handleCaptureControl(request, response) {
  const { action } = await readRequestBody(request);

  const transitions = {
    start: () => autoCaptureService.start(),
    pause: () => autoCaptureService.pause(),
    resume: () => autoCaptureService.resume(),
    stop: () => autoCaptureService.stop(),
    trigger_once: () => autoCaptureService.triggerOnce()
  };

  if (!transitions[action]) {
    return sendJson(response, 400, { ok: false, error: "Unsupported capture action" });
  }

  await transitions[action]();

  return sendJson(response, 200, statePayload());
}

async function handleCaptureStatus(request, response) {
  return sendJson(response, 200, {
    ok: true,
    capture: getState().capture
  });
}

async function handleTurn(request, response) {
  const body = await readRequestBody(request);
  const instruction = String(body.instruction || "").trim();
  const state = getState();
  const scene = body.scene || state.scene;

  if (!instruction) {
    return sendJson(response, 400, { ok: false, error: "Instruction is required" });
  }

  if (state.status === "paused") {
    return sendJson(response, 409, { ok: false, error: "当前系统处于暂停状态，请先继续运行。" });
  }

  if (state.status === "stopped") {
    return sendJson(response, 409, { ok: false, error: "当前系统已停止，请先重新启动。" });
  }

  if (state.status === "idle") {
    setStatus("running");
    ensureAutoCaptureRunning();
    appendLog("info", "系统从空闲状态自动进入运行状态");
  }

  setScene(scene);
  setLastError(null);
  updateAgent({
    mode: "user_priority",
    phase: turnInFlight ? "queued" : "user_priority",
    queuedUserObjective: instruction,
    currentObjective: instruction
  });

  try {
    await waitForTurnSlot();
    const nextState = await runPlannedTurn({
      instruction,
      scene,
      perception: state.latestPerception,
      source: "user",
      interactionMode: state.interactionMode || "act",
      externalInputGuardEnabled: state.externalInputGuardEnabled !== false
    });

    return sendJson(response, 200, {
      ...statePayload(),
      state: nextState
    });
  } catch (error) {
    if (handleExternalInputInterrupted(error, "对话回合")) {
      return sendJson(response, 409, {
        ok: false,
        error: error.message,
        errorCode: error.code,
        state: getState()
      });
    }
    setLastError(error.message);
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "本轮执行失败", { error: error.message });
    appendMessage({
      role: "assistant",
      text: `这轮实验失败了：${error.message}`,
      thinkingChain: [],
      recoveryLine: "我先承认这轮没控住，接下来会先保住上下文再补救。",
      perceptionSummary: "这一轮没有稳定产出可用结果。",
      sceneLabel: "执行失败",
      riskLevel: "high",
      actions: []
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message,
      state: getState()
    });
  } finally {
    turnInFlight = false;
  }
}

async function handleAnalyzeImage(request, response) {
  const body = await readRequestBody(request);
  const imageDataUrl = requireDataUrl(body.imageDataUrl);
  const imageName = String(body.imageName || "untitled-image").trim();

  appendLog("info", `收到截图分析请求：${imageName}`);

  try {
    const perception = await analyzeScreenshot({
      imageInput: imageDataUrl
    });

    latestCaptureImageDataUrl = imageDataUrl;
    setLatestPerception(perception, {
      source: "manual_upload",
      imageName,
      analyzedAt: new Date().toISOString()
    });
    setCaptureState({
      lastImageSource: "manual_upload"
    });

    appendLog("info", "截图 OCR 完成", {
      imageName,
      extractedLength: perception.ocrText.length
    });
    appendLog("info", "截图场景识别完成", {
      sceneType: perception.sceneType,
      npcCount: perception.npcNames.length,
      optionCount: perception.interactiveOptions.length
    });

    return sendJson(response, 200, {
      ok: true,
      state: getState()
    });
  } catch (error) {
    setLastError(error.message);
    appendLog("error", "截图分析失败", {
      imageName,
      error: error.message
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message,
      state: getState()
    });
  }
}

async function handleVoiceTranscription(request, response) {
  const body = await readRequestBody(request);
  const audioDataUrl = requireAudioDataUrl(body.audioDataUrl);
  let audioPath = null;

  appendLog("info", "收到语音转写请求");

  try {
    audioPath = await writeTempAudioFile(audioDataUrl);
    const text = await transcribeWithAliyunAsr({
      audioPath
    });

    appendLog("info", "语音转写完成", {
      textLength: text.length
    });

    return sendJson(response, 200, {
      ok: true,
      text
    });
  } catch (error) {
    appendLog("error", "语音转写失败", {
      error: error.message
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message
    });
  } finally {
    if (audioPath) {
      await rm(audioPath, { force: true }).catch(() => {});
    }
  }
}

async function handleChat(request, response) {
  const body = await readRequestBody(request);
  const instruction = String(body.instruction || "").trim();
  const automationTriggered = hasAutomationTrigger(instruction);
  const requestedInteractionMode = typeof body.interactionMode === "string"
    ? body.interactionMode.trim()
    : "";
  const requestedExternalInputGuardEnabled = typeof body.externalInputGuardEnabled === "boolean"
    ? body.externalInputGuardEnabled
    : null;

  if (!instruction) {
    return sendJson(response, 400, { ok: false, error: "Instruction is required" });
  }

  if (requestedInteractionMode && !["watch", "act"].includes(requestedInteractionMode)) {
    return sendJson(response, 400, { ok: false, error: "Unsupported interaction mode" });
  }

  setStatus("running");
  ensureAutoCaptureRunning();
  setLastError(null);
  clearPendingResumeContext();
  if (requestedInteractionMode) {
    setInteractionMode(requestedInteractionMode);
  }
  if (requestedExternalInputGuardEnabled !== null) {
    setExternalInputGuardEnabled(requestedExternalInputGuardEnabled);
  }

  appendMessage(buildUserMessage({
    instruction,
    scene: getState().scene,
    perception: getState().latestPerception,
    origin: "user"
  }));

  if (automationTriggered) {
    armAutomationScript(instruction);
    appendLog("info", "固定剧本自动化已布置", {
      instruction,
      startsAt: getState().automation.startsAt,
      triggerWord: "加油"
    });
    appendMessage({
      role: "assistant",
      text: "好的！收到！等我想想怎么做…",
      thinkingChain: [],
      recoveryLine: "你回来一碰鼠标或键盘，我就立刻停手。",
      perceptionSummary: "固定剧本已经布置完成，当前只是在等待启动。",
      sceneLabel: getState().latestPerception?.sceneLabel || "等待启动",
      riskLevel: "low",
      actions: []
    });
  } else if ((getState().interactionMode || "watch") === "watch") {
    const latestState = getState();
    await runWatchUserReplyTurn({
      instruction,
      scene: latestState.scene,
      perception: latestState.latestPerception,
      conversationMessages: latestState.messages.slice(0, -1)
    });
  } else {
    appendLog("info", "本轮未命中固定剧本触发词", {
      instruction,
      triggerWord: "加油"
    });
    appendMessage({
      role: "assistant",
      text: "好的！收到！等我想想怎么做…",
      thinkingChain: [],
      recoveryLine: "只有你说出触发词，我才会布置整套自动化。",
      perceptionSummary: "本轮没有命中固定剧本触发词，当前不会布置自动化主流程。",
      sceneLabel: getState().latestPerception?.sceneLabel || "等待指令",
      riskLevel: "low",
      actions: []
    });
  }

  return sendJson(response, 200, statePayload());
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      return sendJson(response, 200, statePayload());
    }

    if (request.method === "GET" && url.pathname === "/api/capture/status") {
      return await handleCaptureStatus(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/control") {
      return await handleControl(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/capture/control") {
      return await handleCaptureControl(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/turn") {
      return await handleTurn(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/analyze-image") {
      return await handleAnalyzeImage(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/voice/transcribe") {
      return await handleVoiceTranscription(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/voice/activity") {
      return await handleVoiceActivity(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return await handleChat(request, response);
    }

    if (request.method === "GET") {
      return await serveStatic(response, url.pathname);
    }

    return sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    if (error.code === "ENOENT") {
      return sendJson(response, 404, { ok: false, error: "Not found" });
    }

    appendLog("error", "服务端异常", { error: error.message });
    return sendJson(response, 500, { ok: false, error: error.message });
  }
});

server.listen(port, () => {
  appendLog("info", "视频实验控制台已启动", { port });
  console.log(`Moonlight Blade Auto Worker listening on http://localhost:${port}`);
  setInterval(() => {
    maybeRunAutonomousTurn().catch((error) => {
      appendLog("error", "自主运行定时任务失败", { error: error.message });
    });
  }, AUTONOMOUS_INTERVAL_MS);
});
