import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(__dirname, "../../scripts/capture-game-window.ps1");
const DEFAULT_WINDOW_TITLE_KEYWORD = "\u5929\u6daf\u660e\u6708\u5200\u624b\u6e38";

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== "object") {
    throw new Error("capture script returned invalid bounds");
  }

  return {
    left: Number(bounds.left),
    top: Number(bounds.top),
    width: Number(bounds.width),
    height: Number(bounds.height)
  };
}

export async function captureGameWindow(options = {}) {
  const {
    windowTitleKeyword = DEFAULT_WINDOW_TITLE_KEYWORD,
    minWidth = 640,
    minHeight = 360
  } = options;

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    scriptPath,
    "-WindowTitleKeyword",
    windowTitleKeyword,
    "-MinWidth",
    String(minWidth),
    "-MinHeight",
    String(minHeight)
  ];

  const { stdout, stderr } = await execFileAsync("powershell.exe", args, {
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024
  });

  if (stderr?.trim()) {
    throw new Error(stderr.trim());
  }

  const raw = String(stdout || "").trim();
  if (!raw) {
    throw new Error("capture script returned empty output");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`capture script returned non-JSON output: ${raw}`);
  }

  if (!parsed.ok) {
    const error = new Error(parsed.message || "capture failed");
    error.code = parsed.errorCode || "CAPTURE_FAILED";
    error.capturePayload = parsed;
    throw error;
  }

  if (typeof parsed.imageDataUrl !== "string" || !parsed.imageDataUrl.startsWith("data:image/")) {
    throw new Error("capture script returned invalid imageDataUrl");
  }

  return {
    windowTitle: String(parsed.windowTitle || windowTitleKeyword),
    bounds: normalizeBounds(parsed.bounds),
    imageDataUrl: parsed.imageDataUrl,
    capturedAt: String(parsed.capturedAt || new Date().toISOString())
  };
}
