import path from "node:path";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getLocalAsrConfig } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const workerScriptPath = path.resolve(projectRoot, "scripts/local_asr_worker.py");

let workerProcess = null;
let workerReadyPromise = null;
let workerReadyResolve = null;
let workerReadyReject = null;
let nextRequestId = 1;
const pendingRequests = new Map();

function defaultPythonCandidates() {
  if (process.platform === "win32") {
    return [
      path.resolve(projectRoot, ".venv/Scripts/python.exe"),
      "python"
    ];
  }

  return [
    path.resolve(projectRoot, ".venv/bin/python3"),
    path.resolve(projectRoot, ".venv/bin/python"),
    "python3"
  ];
}

function resolvePythonPath() {
  const config = getLocalAsrConfig();

  if (config.pythonPath) {
    return config.pythonPath;
  }

  return defaultPythonCandidates().find((candidate) => candidate === "python3" || candidate === "python" || existsSync(candidate)) || "python3";
}

function rejectPendingRequests(error) {
  for (const { reject } of pendingRequests.values()) {
    reject(error);
  }

  pendingRequests.clear();
}

function resetWorkerState(error = null) {
  workerProcess = null;

  if (workerReadyReject) {
    workerReadyReject(error || new Error("Local ASR worker stopped unexpectedly"));
  }

  workerReadyPromise = null;
  workerReadyResolve = null;
  workerReadyReject = null;
  rejectPendingRequests(error || new Error("Local ASR worker stopped unexpectedly"));
}

function handleWorkerMessage(rawLine) {
  if (!rawLine.trim()) {
    return;
  }

  let payload;

  try {
    payload = JSON.parse(rawLine);
  } catch {
    return;
  }

  if (payload.type === "ready") {
    if (workerReadyResolve) {
      workerReadyResolve(payload);
      workerReadyResolve = null;
      workerReadyReject = null;
    }

    return;
  }

  if (payload.type === "fatal") {
    const error = new Error(payload.error || "Local ASR worker failed to start");

    if (workerReadyReject) {
      workerReadyReject(error);
    }

    resetWorkerState(error);
    return;
  }

  if (!payload.id || !pendingRequests.has(payload.id)) {
    return;
  }

  const { resolve, reject } = pendingRequests.get(payload.id);
  pendingRequests.delete(payload.id);

  if (payload.type === "result") {
    resolve(payload.text || "");
    return;
  }

  reject(new Error(payload.error || "Local ASR worker request failed"));
}

function ensureWorker() {
  if (workerReadyPromise) {
    return workerReadyPromise;
  }

  workerReadyPromise = new Promise((resolve, reject) => {
    workerReadyResolve = resolve;
    workerReadyReject = reject;
  });

  const config = getLocalAsrConfig();
  const pythonPath = resolvePythonPath();
  const child = spawn(pythonPath, [workerScriptPath], {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCAL_ASR_MODEL: config.model,
      LOCAL_ASR_LANGUAGE: config.language,
      LOCAL_ASR_COMPUTE_TYPE: config.computeType,
      LOCAL_ASR_CPU_THREADS: String(config.cpuThreads),
      LOCAL_ASR_INITIAL_PROMPT: config.initialPrompt,
      LOCAL_ASR_MODEL_CACHE_DIR: config.modelCacheDir
    }
  });

  workerProcess = child;

  readline.createInterface({ input: child.stdout }).on("line", handleWorkerMessage);

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();

    if (message) {
      console.error(`[local-asr] ${message}`);
    }
  });

  child.on("error", (error) => {
    resetWorkerState(error);
  });

  child.on("exit", (code, signal) => {
    const reason = signal
      ? new Error(`Local ASR worker exited via signal ${signal}`)
      : new Error(`Local ASR worker exited with code ${code}`);
    resetWorkerState(reason);
  });

  return workerReadyPromise;
}

export async function transcribeWithLocalWhisper({ audioPath, language }) {
  await ensureWorker();

  if (!workerProcess?.stdin) {
    throw new Error("Local ASR worker is not available");
  }

  const requestId = `asr-${nextRequestId}`;
  nextRequestId += 1;

  const promise = new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
  });

  workerProcess.stdin.write(`${JSON.stringify({
    type: "transcribe",
    id: requestId,
    audio_path: audioPath,
    language
  })}\n`);

  return promise;
}
