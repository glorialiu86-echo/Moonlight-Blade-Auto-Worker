import path from "node:path";
import readline from "node:readline";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getLocalPerceptionConfig } from "../config/env.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "../../");
const workerScriptPath = path.resolve(projectRoot, "scripts/local_ocr_worker.py");

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
      "py",
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
  const config = getLocalPerceptionConfig();

  if (config.pythonPath) {
    return config.pythonPath;
  }

  return defaultPythonCandidates().find((candidate) => ["py", "python", "python3"].includes(candidate) || existsSync(candidate)) || "python3";
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
    workerReadyReject(error || new Error("Local OCR worker stopped unexpectedly"));
  }

  workerReadyPromise = null;
  workerReadyResolve = null;
  workerReadyReject = null;
  rejectPendingRequests(error || new Error("Local OCR worker stopped unexpectedly"));
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
    const error = new Error(payload.error || "Local OCR worker failed to start");

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
    resolve({
      text: payload.text || "",
      lines: Array.isArray(payload.lines) ? payload.lines : []
    });
    return;
  }

  reject(new Error(payload.error || "Local OCR worker request failed"));
}

function ensureWorker() {
  if (workerReadyPromise) {
    return workerReadyPromise;
  }

  workerReadyPromise = new Promise((resolve, reject) => {
    workerReadyResolve = resolve;
    workerReadyReject = reject;
  });

  const config = getLocalPerceptionConfig();
  const pythonPath = resolvePythonPath();
  const args = pythonPath === "py"
    ? ["-3", workerScriptPath]
    : [workerScriptPath];

  const child = spawn(pythonPath, args, {
    cwd: projectRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCAL_OCR_MAX_IMAGE_SIDE: String(config.maxImageSide)
    }
  });

  workerProcess = child;

  readline.createInterface({ input: child.stdout }).on("line", handleWorkerMessage);

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();

    if (message) {
      console.error(`[local-ocr] ${message}`);
    }
  });

  child.on("error", (error) => {
    resetWorkerState(error);
  });

  child.on("exit", (code, signal) => {
    const reason = signal
      ? new Error(`Local OCR worker exited via signal ${signal}`)
      : new Error(`Local OCR worker exited with code ${code}`);
    resetWorkerState(reason);
  });

  return workerReadyPromise;
}

export async function extractTextFromImageLocal({ imageInput }) {
  await ensureWorker();

  if (!workerProcess?.stdin) {
    throw new Error("Local OCR worker is not available");
  }

  const requestId = `ocr-${nextRequestId}`;
  nextRequestId += 1;

  const promise = new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
  });

  workerProcess.stdin.write(`${JSON.stringify({
    type: "ocr",
    id: requestId,
    image_input: imageInput
  })}\n`);

  return promise;
}
