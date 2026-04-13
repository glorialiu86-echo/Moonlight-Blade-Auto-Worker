import "../config/load-env.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { transcribeWithLocalWhisper } from "../asr/local-whisper-client.js";
import { createTurnPlan } from "../llm/planner.js";
import { analyzeScreenshot } from "../perception/analyzer.js";
import { runMockExecution } from "../runtime/mock-executor.js";
import {
  appendLog,
  appendMessage,
  getState,
  resetRuntime,
  setCurrentTurn,
  setLastError,
  setLatestPerception,
  setScene,
  setStatus,
  updateAgent
} from "../runtime/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");
const port = Number(process.env.PORT || 3000);
const AUTONOMOUS_INTERVAL_MS = 35000;
const AUTONOMOUS_START_DELAY_MS = 6000;
const USER_PRIORITY_COOLDOWN_MS = 60000;
const TURN_SLOT_POLL_MS = 150;
const TURN_SLOT_TIMEOUT_MS = 45000;
const AUTONOMOUS_OBJECTIVE_POOL = [
  "先去主城里找一个看起来最有故事的 NPC，试着套近乎并观察他会不会给出任务线索。",
  "去看看有没有适合顺手接下来的轻量任务，优先选能稳定推进等级或声望的路线。",
  "先用不太高调的方式赚一点快钱，观察有没有交易、跑腿或低风险社交机会。",
  "在附近转一圈，找找值得主动互动的 NPC、任务点或资源点，别原地发呆。"
];

let turnInFlight = false;

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
    "mpeg": "mp3",
    "mpga": "mp3",
    "wav": "wav",
    "x-wav": "wav",
    "webm": "webm",
    "ogg": "ogg",
    "mp4": "m4a",
    "aac": "aac"
  };

  return {
    extension: extensionMap[mimeSubtype] || "wav",
    buffer: Buffer.from(match[2], "base64")
  };
}

async function writeTempAudioFile(audioDataUrl) {
  const { extension, buffer } = parseAudioDataUrl(audioDataUrl);
  const filePath = path.join(os.tmpdir(), `moonlight-blade-voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`);
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
  const target = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(publicDir, target);
  const ext = path.extname(filePath);
  const content = await readFile(filePath);

  response.writeHead(200, {
    "Content-Type": contentTypes[ext] || "application/octet-stream"
  });
  response.end(content);
}

function buildAssistantMessage({ plan, execution, perceptionSummary }) {
  return {
    role: "assistant",
    text: `我会先按“${plan.selectedStrategy}”推进。${execution.outcome}`,
    thinkingChain: plan.thinkingChain,
    perceptionSummary,
    sceneLabel: plan.environment,
    riskLevel: plan.riskLevel,
    actions: execution.steps
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
    environment: plan.environment,
    candidateStrategies: plan.candidateStrategies,
    selectedStrategy: plan.selectedStrategy,
    riskLevel: plan.riskLevel,
    thinkingChain: plan.thinkingChain,
    actions: plan.actions
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

function pickAutonomousObjective(runtimeState) {
  const nextIndex = runtimeState.agent.autonomousTurnCount % AUTONOMOUS_OBJECTIVE_POOL.length;
  return AUTONOMOUS_OBJECTIVE_POOL[nextIndex];
}

function shouldRunAutonomousTurn(runtimeState) {
  if (!runtimeState.agent.autonomousEnabled) {
    return false;
  }

  if (runtimeState.status === "paused" || runtimeState.status === "stopped") {
    return false;
  }

  if (!runtimeState.agent.lastTurnAt) {
    return true;
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
  perceptionSummary
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
    source
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
  const execution = runMockExecution(plan);
  const turn = {
    id: `turn-${Date.now()}`,
    instruction,
    scene,
    createdAt: new Date().toISOString(),
    source,
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
  appendLog("info", "行为计划已生成", {
    actionCount: plan.actions.length,
    riskLevel: plan.riskLevel,
    source
  });
  appendLog("info", "模拟执行器返回结果", {
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

  const agentBeforeUpdate = getState().agent;
  updateAgent({
    mode: "autonomous",
    phase: source === "user" ? "cooldown" : "autonomous",
    currentObjective: plan.selectedStrategy,
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
      perceptionSummary: runtimeState.latestPerception
        ? "本轮自主目标结合了最新截图识别结果。"
        : "当前处于自主运行骨架阶段，尚未接入近实时截图识别。"
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
      throw new Error("当前已有回合在执行，等待超时。");
    }

    await sleep(TURN_SLOT_POLL_MS);
  }

  turnInFlight = true;
}

async function handleControl(request, response) {
  const { action, scene } = await readRequestBody(request);

  if (scene) {
    setScene(scene);
    appendLog("info", `场景已切换为 ${scene}`, { scene });
  }

  const transitions = {
    start: () => setStatus("running"),
    pause: () => setStatus("paused"),
    resume: () => setStatus("running"),
    stop: () => setStatus("stopped"),
    reset: () => {
      resetRuntime();
      appendLog("info", "运行上下文已清空");
    }
  };

  if (!transitions[action]) {
    return sendJson(response, 400, { ok: false, error: "Unsupported control action" });
  }

  transitions[action]();

  if (action !== "reset") {
    appendLog("info", `控制动作执行：${action}`);
  }

  return sendJson(response, 200, statePayload());
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
    return sendJson(response, 409, { ok: false, error: "当前系统已急停，请先重新开始。" });
  }

  if (state.status === "idle") {
    setStatus("running");
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
      perceptionSummary: state.latestPerception
        ? "本轮结合最新截图识别结果生成。"
        : "截图识别暂未接入当前对话主链，当前回复基于文本指令和既有上下文生成。"
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
      text: `这轮处理失败了：${error.message}`,
      thinkingChain: [],
      perceptionSummary: "截图识别暂未接入当前对话主链。",
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

    setLatestPerception({
      ...perception,
      imageName,
      analyzedAt: new Date().toISOString()
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

  if (!instruction) {
    return sendJson(response, 400, { ok: false, error: "Instruction is required" });
  }

  setStatus("running");
  setLastError(null);
  updateAgent({
    mode: "user_priority",
    phase: turnInFlight ? "queued" : "user_priority",
    queuedUserObjective: instruction,
    currentObjective: instruction
  });

  try {
    const state = getState();
    const scene = state.scene;

    setScene(scene);
    await waitForTurnSlot();
    const nextState = await runPlannedTurn({
      instruction,
      scene,
      perception: null,
      source: "user",
      perceptionSummary: "截图识别暂未接入当前对话主链，当前回复基于文本指令和既有上下文生成。"
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
      perceptionSummary: "截图识别暂未接入当前对话主链。",
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

    if (request.method === "POST" && url.pathname === "/api/control") {
      return handleControl(request, response);
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
  appendLog("info", "第一阶段对话框服务已启动", { port });
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
