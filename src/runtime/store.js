function createInitialState() {
  return {
    status: "idle",
    scene: "town_dialogue",
    currentTurn: null,
    logs: [],
    history: [],
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

export function pushHistory(item) {
  state.history.push(item);
  state.history = state.history.slice(-12);
}

export function setLastError(errorMessage) {
  state.lastError = errorMessage;
}

export function resetRuntime() {
  const next = createInitialState();
  state.status = next.status;
  state.scene = next.scene;
  state.currentTurn = next.currentTurn;
  state.logs = [];
  state.history = [];
  state.lastError = null;
}
