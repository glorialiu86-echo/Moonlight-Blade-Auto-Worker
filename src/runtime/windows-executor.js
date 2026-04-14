import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const workerScript = path.resolve(repoRoot, "scripts/windows_input_worker.py");

function resolvePythonPath() {
  const candidate = process.env.CONTROL_PYTHON?.trim()
    || process.env.LOCAL_ASR_PYTHON?.trim();

  if (candidate) {
    return candidate;
  }

  return path.resolve(repoRoot, ".venv/Scripts/python.exe");
}

function createWorkerActions(plan) {
  return plan.actions.map((action, index) => {
    const baseAction = {
      id: `input-${index + 1}`,
      title: action.title,
      sourceType: action.type
    };

    switch (action.type) {
      case "talk":
      case "gift":
      case "threaten":
      case "steal":
      case "strike":
        return {
          ...baseAction,
          type: "click_npc_interact",
          timeoutMs: 4500,
          movePulseMs: 160,
          scanIntervalMs: 180
        };
      case "trade":
        return {
          ...baseAction,
          type: "click_npc_interact",
          timeoutMs: 5000,
          movePulseMs: 180,
          scanIntervalMs: 180
        };
      case "escape":
        return {
          ...baseAction,
          type: "press_key",
          key: "esc",
          postDelayMs: 500
        };
      case "wait":
        return {
          ...baseAction,
          type: "sleep",
          durationMs: 1200
        };
      case "inspect":
      default:
        return {
          ...baseAction,
          type: "focus_window",
          postDelayMs: 200
        };
    }
  });
}

function parseWorkerResponse(rawStdout, rawStderr, exitCode) {
  const stderr = String(rawStderr || "").trim();
  const stdout = String(rawStdout || "").trim();

  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `Windows input worker exited with code ${exitCode}`);
  }

  if (!stdout) {
    throw new Error(stderr || "Windows input worker returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Windows input worker returned non-JSON output: ${stdout}`);
  }

  if (!parsed.ok) {
    const error = new Error(parsed.message || "Windows input execution failed");
    error.code = parsed.errorCode || "INPUT_EXECUTION_FAILED";
    throw error;
  }

  return parsed;
}

export async function runWindowsExecution(plan) {
  const pythonPath = resolvePythonPath();
  const workerPayload = {
    windowTitleKeyword: process.env.GAME_WINDOW_TITLE?.trim() || "天涯明月刀手游",
    actions: createWorkerActions(plan)
  };

  const workerResult = await new Promise((resolve, reject) => {
    const child = spawn(pythonPath, [workerScript], {
      cwd: repoRoot,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve(parseWorkerResponse(stdout, stderr, code));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(JSON.stringify(workerPayload));
    child.stdin.end();
  });

  const steps = workerResult.steps.map((step, index) => ({
    id: step.id || `input-${index + 1}`,
    title: step.title || plan.actions[index]?.title || `步骤 ${index + 1}`,
    detail: step.detail || "已执行输入动作",
    status: step.status || "performed"
  }));

  const performedCount = steps.filter((step) => step.status === "performed").length;
  const outcome = performedCount === 0
    ? "这轮没有成功打出任何实际输入。"
    : `这轮已向游戏窗口发送 ${performedCount} 个实际输入动作。`;

  return {
    executor: workerResult.executor || "WindowsInputExecutor",
    steps,
    outcome
  };
}
