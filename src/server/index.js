import "../config/load-env.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transcribeWithLocalWhisper } from "../asr/local-whisper-client.js";
import { createAutoCaptureService } from "../capture/auto-capture-service.js";
import { captureGameWindow } from "../capture/windows-game-window.js";
import { generateText } from "../llm/qwen.js";
import { createTurnPlan } from "../llm/planner.js";
import { analyzeScreenshot } from "../perception/analyzer.js";
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
  resetRuntime,
  setCaptureState,
  setCurrentTurn,
  setExternalInputGuardEnabled,
  setInteractionMode,
  setLastError,
  setLatestPerception,
  setScene,
  setStatus,
  updateAgent
} from "../runtime/store.js";
import { runWindowsActions } from "../runtime/windows-executor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");
const port = Number(process.env.PORT || 3000);
const AUTONOMOUS_INTERVAL_MS = 35000;
const AUTONOMOUS_START_DELAY_MS = 6000;
const USER_PRIORITY_COOLDOWN_MS = 60000;
const TURN_SLOT_POLL_MS = 150;
const TURN_SLOT_TIMEOUT_MS = 45000;
const CAPTURE_INTERVAL_MS = 3000;
const AUTONOMOUS_OBJECTIVE_POOL = [
  "去找一个看起来最容易闹出后果的 NPC，先试探对方底线。",
  "找一个能把‘一技之长’理解歪掉的切入口，先观察再出手。",
  "看看附近有没有能快速制造秩序变化、关系变化或利益变化的机会。",
  "别原地发呆，去找一个能拍出反差感的互动场景。"
];

let turnInFlight = false;

const autoCaptureService = createAutoCaptureService({
  captureWindow: () => captureGameWindow(),
  analyzeScreenshot,
  intervalMs: CAPTURE_INTERVAL_MS,
  onPerception: (perception, meta) => {
    setLatestPerception(perception, meta);
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
  return { ok: true, state: getState() };
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

async function buildNpcReply({ instruction, dialogText }) {
  const prompt = [
    "你在为《天涯明月刀手游》里的主播实验生成一句 NPC 闲聊回复。",
    "要求：只输出一句中文短句，8到24个字，自然、口语化，不要解释。",
    `主播当前目标：${instruction}`,
    `NPC 当前对话内容：${dialogText || "暂无可读文本"}`
  ].join("\n");

  const result = await generateText({
    userPrompt: prompt,
    maxTokens: 80,
    temperature: 0.5
  });

  return String(result.text || "").replace(/\s+/g, " ").trim();
}

async function maybeReplyFromCurrentChatScreen({ instruction, externalInputGuardEnabled = true }) {
  let probeExecution;
  try {
    probeExecution = await runWindowsActions([
      {
        id: "chat-probe-1",
        title: "读取当前聊天页",
        sourceType: "talk_probe",
        type: "read_current_chat",
        postDelayMs: 50
      }
    ]);
  } catch {
    return null;
  }

  const probeStep = probeExecution.rawSteps?.[0];
  const talkStage = String(probeStep?.input?.stage || "").trim();
  const dialogText = String(probeStep?.input?.dialogText || "").trim();

  if (talkStage !== "chat_ready" || !dialogText) {
    return null;
  }

  const replyText = await buildNpcReply({
    instruction,
    dialogText
  });

  if (!replyText) {
    return null;
  }

  const replyExecution = await runWindowsActions([
    {
      id: "reply-1",
      title: "发送闲聊回复",
      sourceType: "talk_reply",
      type: "send_chat_message",
      text: replyText,
      closeAfterSend: true,
      closeSettleMs: 700,
      postDelayMs: 300
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });

  appendLog("info", "当前聊天页回复已发送", {
    replyText
  });

  return {
    dialogText,
    replyText,
    probeExecution,
    execution: replyExecution
  };
}

async function maybeSendNpcReply({ instruction, plan, execution, externalInputGuardEnabled = true }) {
  const talkStep = execution.rawSteps?.find((step) => step?.input?.mode === "click_npc_interact");
  const socialStep = execution.rawSteps?.find((step) => step?.input?.mode === "town_npc_social_loop");
  const finalTalkStep = socialStep || talkStep;
  const talkStage = String(finalTalkStep?.input?.stage || "").trim();

  if (talkStage !== "chat_ready") {
    return null;
  }

  const dialogText = String(finalTalkStep?.input?.dialogText || "").trim();

  if (!dialogText) {
    return null;
  }

  const replyText = await buildNpcReply({
    instruction,
    dialogText
  });

  if (!replyText) {
    return null;
  }

  const replyExecution = await runWindowsActions([
    {
      id: "reply-1",
      title: "发送闲聊回复",
      sourceType: "talk_reply",
      type: "send_chat_message",
      text: replyText,
      closeAfterSend: true,
      closeSettleMs: 700,
      postDelayMs: 300
    }
  ], {
    interruptOnExternalInput: externalInputGuardEnabled
  });

  appendLog("info", "NPC 闲聊回复已发送", {
    replyText
  });

  return {
    replyText,
    execution: replyExecution
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

function pickAutonomousObjective(runtimeState) {
  const nextIndex = runtimeState.agent.autonomousTurnCount % AUTONOMOUS_OBJECTIVE_POOL.length;
  return AUTONOMOUS_OBJECTIVE_POOL[nextIndex];
}

function shouldRunAutonomousTurn(runtimeState) {
  if (!runtimeState.agent.autonomousEnabled) {
    return false;
  }

  if (runtimeState.status !== "running") {
    return false;
  }

  if (runtimeState.status === "paused" || runtimeState.status === "stopped") {
    return false;
  }

  if (runtimeState.agent.lastTurnSource === "user") {
    return Date.now() - new Date(runtimeState.agent.lastTurnAt).getTime() >= USER_PRIORITY_COOLDOWN_MS;
  }

  return true;
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
        outcome: `${execution.outcome} 已自动发送一句闲聊回复。`,
        replyText: replyResult.replyText
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

  if (!shouldRunAutonomousTurn(runtimeState)) {
    return;
  }

  turnInFlight = true;

  try {
    if (runtimeState.status === "idle") {
      setStatus("running");
      ensureAutoCaptureRunning();
      appendLog("info", "系统进入自主运行模式");
    }

    const scene = runtimeState.scene;
    const instruction = pickAutonomousObjective(runtimeState);
    updateAgent({
      mode: "autonomous",
      phase: "autonomous",
      currentObjective: instruction
    });

    await runPlannedTurn({
      instruction,
      scene,
      perception: runtimeState.latestPerception,
      source: "agent",
      interactionMode: runtimeState.interactionMode || "act",
      externalInputGuardEnabled: runtimeState.externalInputGuardEnabled !== false
    });
  } catch (error) {
    setLastError(error.message);
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "自主运行回合失败", {
      error: error.message
    });
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
    pause: () => setStatus("paused"),
    resume: () => {
      setStatus("running");
      autoCaptureService.resume();
    },
    stop: () => {
      setStatus("stopped");
      autoCaptureService.stop();
    },
    reset: () => {
      autoCaptureService.stop();
      resetRuntime();
      appendLog("info", "运行上下文已清空");
    }
  };

  if (action) {
    if (!transitions[action]) {
      return sendJson(response, 400, { ok: false, error: "Unsupported control action" });
    }

    transitions[action]();

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
      ok: true,
      state: nextState
    });
  } catch (error) {
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
    const text = await transcribeWithLocalWhisper({
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
  if (requestedInteractionMode) {
    setInteractionMode(requestedInteractionMode);
  }
  if (requestedExternalInputGuardEnabled !== null) {
    setExternalInputGuardEnabled(requestedExternalInputGuardEnabled);
  }
  updateAgent({
    mode: "user_priority",
    phase: turnInFlight ? "queued" : "user_priority",
    queuedUserObjective: instruction,
    currentObjective: instruction
  });

  try {
    const runtimeState = getState();
    const interactionMode = runtimeState.interactionMode || "act";
    const externalInputGuardEnabled = runtimeState.externalInputGuardEnabled !== false;
    const directReply = interactionMode === "act"
      ? await maybeReplyFromCurrentChatScreen({
        instruction,
        externalInputGuardEnabled
      })
      : null;
    if (directReply) {
      appendMessage({
        role: "assistant",
        text: `已读取当前 NPC 对话并发送回复：${directReply.replyText}`,
        thinkingChain: [],
        recoveryLine: "当前聊天页已完成一次读取、回复和发送。",
        perceptionSummary: "本轮直接基于当前聊天页执行，没有重新找 NPC。",
        sceneLabel: "聊天页直连",
        riskLevel: "low",
        actions: directReply.execution.steps
      });

      return sendJson(response, 200, {
        ok: true,
        state: getState()
      });
    }

    const state = getState();
    const scene = state.scene;

    setScene(scene);
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
      ok: true,
      state: nextState
    });
  } catch (error) {
    setLastError(error.message);
    updateAgent({
      phase: "waiting"
    });
    appendLog("error", "本轮对话执行失败", { error: error.message });
    appendMessage({
      role: "assistant",
      text: `这轮处理失败了：${error.message}`,
      thinkingChain: [],
      recoveryLine: "我先把现场稳住，等你给我下一条更明确的指令。",
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
      return handleCaptureStatus(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/control") {
      return handleControl(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/capture/control") {
      return handleCaptureControl(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/turn") {
      return handleTurn(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/analyze-image") {
      return handleAnalyzeImage(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/voice/transcribe") {
      return handleVoiceTranscription(request, response);
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      return handleChat(request, response);
    }

    if (request.method === "GET") {
      return serveStatic(response, url.pathname);
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
  setTimeout(() => {
    maybeRunAutonomousTurn().catch((error) => {
      appendLog("error", "自主运行启动失败", { error: error.message });
    });
  }, AUTONOMOUS_START_DELAY_MS);
  setInterval(() => {
    maybeRunAutonomousTurn().catch((error) => {
      appendLog("error", "自主运行定时任务失败", { error: error.message });
    });
  }, AUTONOMOUS_INTERVAL_MS);
});
