function createInitialCaptureState(intervalMs) {
  return {
    enabled: false,
    status: "idle",
    intervalMs,
    lastCaptureAt: null,
    lastAnalyzeAt: null,
    lastWindowTitle: null,
    lastBounds: null,
    lastImageSource: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorMessage: null
  };
}

export function createAutoCaptureService({
  captureWindow,
  analyzeScreenshot,
  onPerception,
  onStateChange,
  onLog,
  intervalMs = 3000,
  maxConsecutiveFailures = 3
}) {
  let timer = null;
  let cycleInFlight = false;
  let captureState = createInitialCaptureState(intervalMs);

  function emitState(patch) {
    captureState = {
      ...captureState,
      ...patch
    };
    onStateChange?.(captureState);
    return captureState;
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleNextTick() {
    clearTimer();

    if (!captureState.enabled || captureState.status !== "running") {
      return;
    }

    timer = setTimeout(() => {
      runCycle().catch((error) => {
        onLog?.("error", "自动截图调度失败", {
          error: error.message
        });
      });
    }, captureState.intervalMs);
  }

  async function runCycle() {
    if (cycleInFlight || !captureState.enabled || captureState.status !== "running") {
      return captureState;
    }

    cycleInFlight = true;

    try {
      const capture = await captureWindow();
      emitState({
        lastCaptureAt: capture.capturedAt,
        lastWindowTitle: capture.windowTitle,
        lastBounds: capture.bounds
      });

      const perception = await analyzeScreenshot({
        imageInput: capture.imageDataUrl
      });

      const analyzedAt = new Date().toISOString();
      onPerception?.(perception, {
        source: "auto_window",
        windowTitle: capture.windowTitle,
        bounds: capture.bounds,
        analyzedAt
      });

      emitState({
        status: "running",
        lastImageSource: "auto_window",
        consecutiveFailures: 0,
        lastAnalyzeAt: analyzedAt,
        lastErrorCode: null,
        lastErrorMessage: null
      });

      onLog?.("info", "自动窗口截图分析完成", {
        sceneType: perception.sceneType,
        windowTitle: capture.windowTitle
      });
    } catch (error) {
      const consecutiveFailures = captureState.consecutiveFailures + 1;
      const nextStatus = consecutiveFailures >= maxConsecutiveFailures ? "error" : captureState.status;
      const errorCode = error.code || "CAPTURE_FAILED";

      emitState({
        status: nextStatus,
        consecutiveFailures,
        lastErrorCode: errorCode,
        lastErrorMessage: error.message
      });

      onLog?.("error", "自动窗口截图失败", {
        error: error.message,
        errorCode,
        consecutiveFailures
      });
    } finally {
      cycleInFlight = false;
      scheduleNextTick();
    }

    return captureState;
  }

  async function triggerOnce() {
    if (cycleInFlight) {
      return captureState;
    }

    const wasEnabled = captureState.enabled;
    const wasStatus = captureState.status;

    emitState({
      enabled: true,
      status: "running"
    });

    clearTimer();
    await runCycle();

    if (!wasEnabled) {
      emitState({
        enabled: false,
        status: captureState.status === "error" ? "error" : "idle"
      });
      clearTimer();
    } else if (wasStatus !== "running" && captureState.status !== "error") {
      emitState({
        status: wasStatus
      });
      clearTimer();
    }

    return captureState;
  }

  function start() {
    emitState({
      enabled: true,
      status: "running",
      intervalMs: captureState.intervalMs || intervalMs,
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastErrorMessage: null
    });

    onLog?.("info", "自动窗口截图已启动", {
      intervalMs: captureState.intervalMs
    });

    clearTimer();
    runCycle().catch((error) => {
      onLog?.("error", "自动窗口截图启动失败", {
        error: error.message
      });
    });

    return captureState;
  }

  function pause() {
    emitState({
      enabled: false,
      status: "paused"
    });
    clearTimer();
    onLog?.("info", "自动窗口截图已暂停");
    return captureState;
  }

  function resume() {
    emitState({
      enabled: true,
      status: "running",
      consecutiveFailures: 0,
      lastErrorCode: null,
      lastErrorMessage: null
    });

    onLog?.("info", "自动窗口截图已恢复");
    clearTimer();
    runCycle().catch((error) => {
      onLog?.("error", "自动窗口截图恢复失败", {
        error: error.message
      });
    });

    return captureState;
  }

  function stop() {
    clearTimer();
    emitState(createInitialCaptureState(captureState.intervalMs || intervalMs));
    onLog?.("info", "自动窗口截图已停止");
    return captureState;
  }

  function getStatus() {
    return {
      ...captureState
    };
  }

  return {
    start,
    stop,
    pause,
    resume,
    getStatus,
    triggerOnce
  };
}
