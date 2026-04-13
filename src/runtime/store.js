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

function createInitialState() {
  return {
    status: "idle",
    scene: "town_dialogue",
    currentTurn: null,
    latestPerception: null,
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

export function setCurrentTurn(turn) {
  state.currentTurn = turn;
}

export function setLatestPerception(perception) {
  state.latestPerception = perception;
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
  state.currentTurn = next.currentTurn;
  state.latestPerception = next.latestPerception;
  state.agent = next.agent;
  state.messages = [];
  state.logs = [];
  state.lastError = null;
}
