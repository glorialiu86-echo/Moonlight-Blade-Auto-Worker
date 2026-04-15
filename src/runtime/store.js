function createInitialAgentState() {
  return {
    autonomousEnabled: true,
    mode: "autonomous",
    phase: "waiting",
    currentObjective: "等待自主目标",
    queuedUserObjective: null,
    lastUserInstruction: null,
    lastAutonomousInstruction: null,
    lastTurnSource: null,
    lastTurnAt: null,
    autonomousTurnCount: 0
  };
}

function createInitialCaptureState() {
  return {
    enabled: false,
    status: "idle",
    intervalMs: 3000,
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

function createInitialState() {
  return {
    status: "idle",
    scene: "town_dialogue",
    interactionMode: "act",
    externalInputGuardEnabled: true,
    currentTurn: null,
    latestPerception: null,
    capture: createInitialCaptureState(),
    experiments: [],
    agent: createInitialAgentState(),
    messages: [],
    logs: [],
    lastError: null
  };
}

const state = createInitialState();

function createLog(level, message, meta = null) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    level,
    message,
    meta
  };
}

export function getState() {
  return structuredClone(state);
}

export function appendLog(level, message, meta = null) {
  const entry = createLog(level, message, meta);
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 120);
  return entry;
}

export function setStatus(status) {
  state.status = status;
  return state.status;
}

export function setScene(scene) {
  state.scene = scene;
  return state.scene;
}

export function setInteractionMode(mode) {
  state.interactionMode = mode;
  return state.interactionMode;
}

export function setExternalInputGuardEnabled(enabled) {
  state.externalInputGuardEnabled = Boolean(enabled);
  return state.externalInputGuardEnabled;
}

export function setCurrentTurn(turn) {
  state.currentTurn = turn;
}

export function setLatestPerception(perception, meta = null) {
  state.latestPerception = meta
    ? {
      ...perception,
      ...meta
    }
    : perception;
}

export function setCaptureState(patch) {
  state.capture = {
    ...state.capture,
    ...patch
  };

  return state.capture;
}

export function appendExperiment(experiment) {
  state.experiments.unshift({
    id: experiment.id || `exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: experiment.createdAt || new Date().toISOString(),
    ...experiment
  });
  state.experiments = state.experiments.slice(0, 20);
  return state.experiments[0];
}

export function updateAgent(patch) {
  state.agent = {
    ...state.agent,
    ...patch
  };

  return state.agent;
}

export function appendMessage(message) {
  state.messages.push({
    id: message.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: message.createdAt || new Date().toISOString(),
    ...message
  });
  state.messages = state.messages.slice(-40);
  return state.messages[state.messages.length - 1];
}

export function setLastError(errorMessage) {
  state.lastError = errorMessage;
}

export function resetRuntime() {
  const next = createInitialState();
  state.status = next.status;
  state.scene = next.scene;
  state.interactionMode = next.interactionMode;
  state.externalInputGuardEnabled = next.externalInputGuardEnabled;
  state.currentTurn = next.currentTurn;
  state.latestPerception = next.latestPerception;
  state.capture = next.capture;
  state.experiments = [];
  state.agent = next.agent;
  state.messages = [];
  state.logs = [];
  state.lastError = null;
}
