import "../config/load-env.js";
import http from "node:http";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createTurnPlan } from "../llm/planner.js";
import { analyzeScreenshot } from "../perception/analyzer.js";
import { transcribeAudio } from "../llm/qwen.js";
import { runMockExecution } from "../runtime/mock-executor.js";
import {
  appendLog,
  appendMessage,
  getState,
  pushHistory,
  resetRuntime,
  setCurrentTurn,
  setLastError,
  setLatestPerception,
  setScene,
  setStatus
} from "../runtime/store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../../public");
const port = Number(process.env.PORT || 3000);

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

function statePayload() {
  return { ok: true, state: getState() };
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
  appendLog("info", `收到新指令：${instruction}`, { instruction, scene });

  try {
    const nextState = getState();
    const plan = await createTurnPlan({
      instruction,
      scene,
      history: nextState.history,
      perception: nextState.latestPerception
    });
    const execution = runMockExecution(plan);
    const turn = {
      id: `turn-${Date.now()}`,
      instruction,
      scene,
      createdAt: new Date().toISOString(),
      plan,
      execution
    };

    setCurrentTurn(turn);
    pushHistory({
      instruction,
      scene,
      plan: {
        selectedStrategy: plan.selectedStrategy,
        riskLevel: plan.riskLevel
      }
    });

    appendLog("info", "意图解析完成", {
      intent: plan.intent,
      strategy: plan.selectedStrategy
    });
    appendLog("info", "行为计划已生成", {
      actionCount: plan.actions.length,
      riskLevel: plan.riskLevel
    });
    appendLog("info", "模拟执行器返回结果", {
      executor: execution.executor,
      outcome: execution.outcome
    });

    if (plan.fallbackReason) {
      appendLog("warn", "本轮使用了回退规划", {
        reason: plan.fallbackReason
      });
    }

    return sendJson(response, 200, {
      ok: true,
      state: getState()
    });
  } catch (error) {
    setLastError(error.message);
    appendLog("error", "本轮执行失败", { error: error.message });
    return sendJson(response, 500, {
      ok: false,
      error: error.message,
      state: getState()
    });
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

  appendLog("info", "收到语音转写请求");

  try {
    const result = await transcribeAudio({
      audioInput: audioDataUrl
    });

    appendLog("info", "语音转写完成", {
      textLength: result.text.length
    });

    return sendJson(response, 200, {
      ok: true,
      text: result.text
    });
  } catch (error) {
    appendLog("error", "语音转写失败", {
      error: error.message
    });
    return sendJson(response, 500, {
      ok: false,
      error: error.message
    });
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
  appendMessage({
    role: "user",
    text: instruction
  });
  appendLog("info", `收到对话输入：${instruction}`);

  try {
    const state = getState();
    const scene = state.scene;

    setScene(scene);

    const plan = await createTurnPlan({
      instruction,
      scene,
      history: state.history,
      perception: null
    });
    const execution = runMockExecution(plan);
    const turn = {
      id: `turn-${Date.now()}`,
      instruction,
      scene,
      createdAt: new Date().toISOString(),
      plan,
      execution,
      perception: null
    };

    setCurrentTurn(turn);
    pushHistory({
      instruction,
      scene,
      plan: {
        selectedStrategy: plan.selectedStrategy,
        riskLevel: plan.riskLevel
      }
    });

    appendLog("info", "意图解析完成", {
      intent: plan.intent,
      strategy: plan.selectedStrategy
    });
    appendLog("info", "行为计划已生成", {
      actionCount: plan.actions.length,
      riskLevel: plan.riskLevel
    });
    appendLog("info", "模拟执行器返回结果", {
      executor: execution.executor,
      outcome: execution.outcome
    });

    if (plan.fallbackReason) {
      appendLog("warn", "本轮使用了回退规划", {
        reason: plan.fallbackReason
      });
    }

    appendMessage(buildAssistantMessage({
      plan,
      execution,
      perceptionSummary: "截图识别暂未接入当前对话主链，当前回复基于文本指令和既有上下文生成。"
    }));

    return sendJson(response, 200, {
      ok: true,
      state: getState()
    });
  } catch (error) {
    setLastError(error.message);
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
});
