const state = {
  submitting: false,
  voiceSupported: false,
  runtimeStatus: "idle",
  interactionMode: "act",
  externalInputGuardEnabled: true,
  actionCatalog: [],
  voice: {
    recording: false,
    transcribing: false,
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    pcmChunks: [],
    inputSampleRate: 48000
  }
};

const elements = {
  composerForm: document.querySelector("#composerForm"),
  instructionInput: document.querySelector("#instructionInput"),
  messageList: document.querySelector("#messageList"),
  runStatusText: document.querySelector("#runStatusText"),
  runStatusHint: document.querySelector("#runStatusHint"),
  runToggleButton: document.querySelector("#runToggleButton"),
  watchModeButton: document.querySelector("#watchModeButton"),
  actModeButton: document.querySelector("#actModeButton"),
  externalInputGuardButton: document.querySelector("#externalInputGuardButton"),
  assistantStatusSummary: document.querySelector("#assistantStatusSummary"),
  assistantModeText: document.querySelector("#assistantModeText"),
  assistantGuardText: document.querySelector("#assistantGuardText"),
  assistantObjectiveText: document.querySelector("#assistantObjectiveText"),
  assistantActionChainText: document.querySelector("#assistantActionChainText"),
  assistantActionCatalog: document.querySelector("#assistantActionCatalog"),
  voiceStartButton: document.querySelector("#voiceStartButton"),
  voiceStopButton: document.querySelector("#voiceStopButton"),
  voiceStatus: document.querySelector("#voiceStatus"),
  userMessageTemplate: document.querySelector("#userMessageTemplate"),
  assistantMessageTemplate: document.querySelector("#assistantMessageTemplate")
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json"
    },
    ...options
  });
  const payload = await response.json();

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "我这边没接稳。");
  }

  return payload;
}

function updateVoiceStatus(message) {
  elements.voiceStatus.textContent = message;
}

function isRunningStatus(status) {
  return status === "running";
}

function isWatchMode() {
  return state.interactionMode === "watch";
}

function isExternalInputGuardEnabled() {
  return Boolean(state.externalInputGuardEnabled);
}

function syncUiState() {
  const busy = state.submitting || state.voice.transcribing;
  const recording = state.voice.recording;
  const running = isRunningStatus(state.runtimeStatus);

  elements.instructionInput.disabled = busy;
  elements.composerForm.querySelector('button[type="submit"]').disabled = busy || recording;
  elements.voiceStartButton.disabled = !state.voiceSupported || busy || recording;
  elements.voiceStopButton.disabled = !recording;
  elements.runToggleButton.disabled = busy || recording || state.voice.transcribing;
  elements.watchModeButton.disabled = busy || recording || state.voice.transcribing;
  elements.actModeButton.disabled = busy || recording || state.voice.transcribing;
  elements.externalInputGuardButton.disabled = busy || recording || state.voice.transcribing || isWatchMode();
  elements.watchModeButton.classList.toggle("is-active", isWatchMode());
  elements.actModeButton.classList.toggle("is-active", !isWatchMode());
  elements.externalInputGuardButton.classList.toggle("is-active", isExternalInputGuardEnabled());
  elements.externalInputGuardButton.textContent = `人一碰我就停：${isExternalInputGuardEnabled() ? "开" : "关"}`;
  elements.runToggleButton.textContent = running ? "先让我停手" : "让我开工";
}

function scrollMessagesToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderEmptyState() {
  const modeText = isWatchMode()
    ? "我现在只看局面，先陪籽岷盯画面，不乱动手。"
    : "只要籽岷一句话，我就能按行动模式往下推。";

  elements.messageList.innerHTML = `
    <article class="chat-message chat-message-assistant chat-empty">
      <div class="chat-role">籽小刀</div>
      <p class="chat-text">${modeText}</p>
      <p class="chat-meta">我要是说得还不够细，可以去 \`/debug\` 看我更完整的链路。</p>
    </article>
  `;
}

function renderUserMessage(message) {
  const node = elements.userMessageTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".chat-text").textContent = message.text || "";
  return node;
}

function buildAssistantText(message) {
  const thinkingChain = Array.isArray(message.thinkingChain)
    ? message.thinkingChain
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 6)
    : [];

  const lines = [];

  if (thinkingChain.length > 0) {
    lines.push(...thinkingChain);
  }

  if (message.decide) {
    lines.push(String(message.decide).trim());
  } else if (message.text) {
    lines.push(String(message.text).trim());
  }

  return lines.filter(Boolean).join("\n");
}

function renderAssistantMessage(message) {
  const node = elements.assistantMessageTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".chat-text").textContent = buildAssistantText(message);
  node.querySelector(".chat-meta").textContent = message.perceptionSummary || `我这轮判断的风险是：${message.riskLevel || "-"}`;
  return node;
}

function buildObjectiveText(runtimeState) {
  const currentTurn = runtimeState.currentTurn || null;
  const currentObjective = runtimeState.agent?.currentObjective || "";

  if (currentTurn?.instruction) {
    return `我这轮盯着的是：${currentTurn.instruction}`;
  }

  if (currentObjective) {
    return `我现在挂着的目标是：${currentObjective}`;
  }

  return "我还没接到这一轮的目标。";
}

function buildActionChainText(runtimeState) {
  const actions = Array.isArray(runtimeState.currentTurn?.plan?.actions)
    ? runtimeState.currentTurn.plan.actions
    : [];

  if (actions.length === 0) {
    return isWatchMode()
      ? "我现在只看局面，不往下落动作。"
      : "我手里还没落下动作链。";
  }

  const labels = actions.map((actionKey) => {
    const actionType = typeof actionKey === "string" ? actionKey : actionKey?.type;
    const definition = state.actionCatalog.find((item) => item.key === actionType);
    return definition?.label || actionType || "未命名动作";
  });

  return `我准备按这条顺序往下走：${labels.join(" -> ")}`;
}

function buildStatusSummary(runtimeState) {
  const automationStatus = runtimeState.automation?.status || "idle";

  if (automationStatus === "armed") {
    return "我已经接住这套安排了，先等籽岷走开，再自己往下做。";
  }

  if (automationStatus === "paused") {
    return "你一碰鼠标键盘，我就先把手收住了。";
  }

  if (automationStatus === "completed") {
    return "这套安排我已经顺着做完了，现在先收手等你。";
  }

  if (runtimeState.status !== "running") {
    return "我先稳着，等籽岷一句话。";
  }

  if (isWatchMode()) {
    return "我现在只盯屏幕和局面，先陪籽岷看，不乱动手。";
  }

  if (runtimeState.lastError) {
    return `我刚刚这轮没接稳：${runtimeState.lastError}`;
  }

  if (runtimeState.currentTurn?.execution?.outcome) {
    return `我刚落完一轮动作：${runtimeState.currentTurn.execution.outcome}`;
  }

  return isExternalInputGuardEnabled()
    ? "我现在能动手，但籽岷一碰鼠标键盘，我就立刻让手。"
    : "我现在能动手，会顺着动作链继续往下推。";
}

function renderActionCatalog() {
  elements.assistantActionCatalog.innerHTML = "";

  state.actionCatalog.forEach((action) => {
    const item = document.createElement("article");
    item.className = "assistant-action-item";
    item.dataset.availability = action.availability || "partial";
    item.innerHTML = `
      <p class="assistant-action-name">${action.label}</p>
      <p class="assistant-action-note">${action.note}</p>
    `;
    elements.assistantActionCatalog.appendChild(item);
  });
}

function renderAssistantStatus(runtimeState) {
  elements.assistantStatusSummary.textContent = buildStatusSummary(runtimeState);
  elements.assistantModeText.textContent = isWatchMode() ? "我现在在观看" : "我现在在行动";
  elements.assistantGuardText.textContent = isWatchMode()
    ? "我现在不动手，所以不用护手。"
    : (isExternalInputGuardEnabled()
      ? "籽岷一碰我就停手。"
      : "现在是直推，我不会因外界输入自动停手。");
  elements.assistantObjectiveText.textContent = buildObjectiveText(runtimeState);
  elements.assistantActionChainText.textContent = buildActionChainText(runtimeState);
  renderActionCatalog();
}

function renderMessages(messages) {
  elements.messageList.innerHTML = "";

  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmptyState();
    scrollMessagesToBottom();
    return;
  }

  messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .forEach((message) => {
      const node = message.role === "assistant"
        ? renderAssistantMessage(message)
        : renderUserMessage(message);
      elements.messageList.appendChild(node);
    });

  scrollMessagesToBottom();
}

function renderRunState(runtimeState) {
  state.runtimeStatus = runtimeState.status || "idle";
  state.interactionMode = runtimeState.interactionMode || "act";
  state.externalInputGuardEnabled = runtimeState.externalInputGuardEnabled !== false;
  const running = isRunningStatus(state.runtimeStatus);
  const automationStatus = runtimeState.automation?.status || "idle";

  elements.runStatusText.textContent = automationStatus === "armed"
    ? "我先含着"
    : automationStatus === "paused" || state.runtimeStatus === "paused"
      ? "我先停着"
      : automationStatus === "completed"
        ? "我做完了"
        : running
          ? "我已开工"
          : "我在待命";

  elements.runStatusHint.textContent = automationStatus === "armed"
    ? "我已经把整套安排收住了，等籽岷走开后再自己往下做。"
    : automationStatus === "completed"
      ? "这套安排已经走完，我现在不再继续乱动。"
      : running
        ? (isWatchMode()
          ? "我现在只看屏幕和局面，先陪籽岷看，不往下动手。"
          : `我现在会顺着已经接住的安排往下推。${isExternalInputGuardEnabled() ? " 籽岷一碰鼠标或键盘，我就立刻停手。" : ""}`)
        : "我现在还没接到要往下做的整套安排。";
}

function renderRuntimeState(runtimeState) {
  renderRunState(runtimeState);
  renderAssistantStatus(runtimeState);
  renderMessages(runtimeState.messages);
  syncUiState();
}

function applyPayload(payload) {
  state.actionCatalog = Array.isArray(payload.actionCatalog) ? payload.actionCatalog : state.actionCatalog;
  renderRuntimeState(payload.state);
}

async function refresh() {
  const payload = await request("/api/state");
  applyPayload(payload);
}

async function sendControlAction(action) {
  const payload = await request("/api/control", {
    method: "POST",
    body: JSON.stringify({ action })
  });
  applyPayload(payload);
}

async function setInteractionMode(mode) {
  const payload = await request("/api/control", {
    method: "POST",
    body: JSON.stringify({ interactionMode: mode })
  });
  applyPayload(payload);
}

async function setExternalInputGuardEnabled(enabled) {
  const payload = await request("/api/control", {
    method: "POST",
    body: JSON.stringify({ externalInputGuardEnabled: enabled })
  });
  applyPayload(payload);
}

function appendTranscriptToComposer(text) {
  const transcript = String(text || "").trim();

  if (!transcript) {
    return;
  }

  const current = elements.instructionInput.value.trim();
  elements.instructionInput.value = current
    ? `${current}${/[。！？]$/.test(current) ? "" : "，"}${transcript}`
    : transcript;
}

async function submitComposerInstruction({ source = "text" } = {}) {
  const instruction = elements.instructionInput.value.trim();

  if (!instruction || state.submitting || state.voice.recording || state.voice.transcribing) {
    return false;
  }

  state.submitting = true;
  syncUiState();
  updateVoiceStatus(source === "voice"
    ? (isWatchMode() ? "我先把这段语音按观看模式接住。" : "我先把这段语音按行动模式往下推。")
    : (isWatchMode() ? "我先按观看模式把这轮想明白。" : "我先按行动模式把这轮往下推。"));

  try {
    const payload = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        instruction,
        interactionMode: state.interactionMode,
        externalInputGuardEnabled: state.externalInputGuardEnabled
      })
    });

    applyPayload(payload);
    elements.instructionInput.value = "";
    updateVoiceStatus(source === "voice" ? "这段话我已经替籽岷递进去了。" : "这轮我已经接住了。");
    return true;
  } catch (error) {
    updateVoiceStatus(`我这轮没接稳：${error.message}`);
    await refresh().catch(() => {});
    return false;
  } finally {
    state.submitting = false;
    syncUiState();
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("我这边没读出这段音频。"));
    reader.readAsDataURL(blob);
  });
}

function mergeFloat32Chunks(chunks) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(totalLength);
  let offset = 0;

  chunks.forEach((chunk) => {
    merged.set(chunk, offset);
    offset += chunk.length;
  });

  return merged;
}

function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
  if (outputSampleRate >= inputSampleRate) {
    return buffer;
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const newLength = Math.round(buffer.length / sampleRateRatio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;

    for (let index = offsetBuffer; index < nextOffsetBuffer && index < buffer.length; index += 1) {
      accum += buffer[index];
      count += 1;
    }

    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }

  return result;
}

function encodeWav(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
  const view = new DataView(buffer);
  let offset = 0;

  function writeString(value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index));
      offset += 1;
    }
  }

  writeString("RIFF");
  view.setUint32(offset, 36 + samples.length * bytesPerSample, true);
  offset += 4;
  writeString("WAVE");
  writeString("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint32(offset, sampleRate, true);
  offset += 4;
  view.setUint32(offset, sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeString("data");
  view.setUint32(offset, samples.length * bytesPerSample, true);
  offset += 4;

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  return new Blob([buffer], { type: "audio/wav" });
}

async function releaseVoiceCapture() {
  const { sourceNode, processorNode, mediaStream, audioContext } = state.voice;

  if (sourceNode) {
    sourceNode.disconnect();
  }

  if (processorNode) {
    processorNode.disconnect();
    processorNode.onaudioprocess = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
  }

  if (audioContext) {
    await audioContext.close().catch(() => {});
  }

  state.voice.mediaStream = null;
  state.voice.audioContext = null;
  state.voice.sourceNode = null;
  state.voice.processorNode = null;
}

async function stopVoiceRecording() {
  if (!state.voice.recording) {
    return;
  }

  state.voice.recording = false;
  state.voice.transcribing = true;
  syncUiState();
  updateVoiceStatus("我先把这段声音听完，马上转成字。");

  try {
    const pcmChunks = [...state.voice.pcmChunks];
    const inputSampleRate = state.voice.inputSampleRate;
    await releaseVoiceCapture();
    state.voice.pcmChunks = [];

    if (pcmChunks.length === 0) {
      throw new Error("我还没听到能用的声音。");
    }

    const merged = mergeFloat32Chunks(pcmChunks);
    const downsampled = downsampleBuffer(merged, inputSampleRate, 16000);
    const wavBlob = encodeWav(downsampled, 16000);
    const audioDataUrl = await blobToDataUrl(wavBlob);
    const payload = await request("/api/voice/transcribe", {
      method: "POST",
      body: JSON.stringify({ audioDataUrl })
    });

    appendTranscriptToComposer(payload.text);
    state.voice.transcribing = false;
    syncUiState();
    updateVoiceStatus("我听清了，马上替籽岷递出去。");
    await submitComposerInstruction({ source: "voice" });
  } catch (error) {
    updateVoiceStatus(`我这次没听稳：${error.message}`);
  } finally {
    state.voice.transcribing = false;
    syncUiState();
  }
}

async function startVoiceRecording() {
  if (!state.voiceSupported || state.submitting || state.voice.transcribing || state.voice.recording) {
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;

  try {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });
    const audioContext = new AudioContextClass();
    await audioContext.resume();
    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const processorNode = audioContext.createScriptProcessor(4096, 1, 1);

    state.voice.mediaStream = mediaStream;
    state.voice.audioContext = audioContext;
    state.voice.sourceNode = sourceNode;
    state.voice.processorNode = processorNode;
    state.voice.pcmChunks = [];
    state.voice.inputSampleRate = audioContext.sampleRate;
    state.voice.recording = true;

    processorNode.onaudioprocess = (event) => {
      if (!state.voice.recording) {
        return;
      }

      const channelData = event.inputBuffer.getChannelData(0);
      state.voice.pcmChunks.push(new Float32Array(channelData));
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    updateVoiceStatus("我在听，籽岷说完就点一下“我先收声”。");
    syncUiState();
  } catch (error) {
    await releaseVoiceCapture();
    state.voice.recording = false;
    state.voice.pcmChunks = [];
    syncUiState();
    updateVoiceStatus(`我这边没把耳朵打开：${error.message}`);
  }
}

function initVoiceInput() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const mediaDevices = navigator.mediaDevices;

  if (!AudioContextClass || !mediaDevices?.getUserMedia) {
    updateVoiceStatus("这会儿我的耳朵还接不上。");
    syncUiState();
    return;
  }

  state.voiceSupported = true;
  updateVoiceStatus("我的耳朵已经开了，籽岷可以直接说。");
  syncUiState();
}

elements.runToggleButton.addEventListener("click", async () => {
  const running = isRunningStatus(state.runtimeStatus);
  state.submitting = true;
  syncUiState();

  try {
    await sendControlAction(running ? "stop" : "start");
    updateVoiceStatus(running ? "我先把手收住了。" : "我已经就位，籽岷可以把整套安排递给我。");
    await refresh();
  } catch (error) {
    updateVoiceStatus(`我这次没切稳状态：${error.message}`);
  } finally {
    state.submitting = false;
    syncUiState();
  }
});

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitComposerInstruction({ source: "text" });
});

elements.watchModeButton.addEventListener("click", async () => {
  if (state.submitting || state.voice.recording || state.voice.transcribing || isWatchMode()) {
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    await setInteractionMode("watch");
    updateVoiceStatus("我先切到观看，只陪籽岷盯局面。");
  } catch (error) {
    updateVoiceStatus(`我这次没切到观看：${error.message}`);
  } finally {
    state.submitting = false;
    syncUiState();
  }
});

elements.actModeButton.addEventListener("click", async () => {
  if (state.submitting || state.voice.recording || state.voice.transcribing || !isWatchMode()) {
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    await setInteractionMode("act");
    updateVoiceStatus("我切回行动了，后面可以直接往下动手。");
  } catch (error) {
    updateVoiceStatus(`我这次没切回行动：${error.message}`);
  } finally {
    state.submitting = false;
    syncUiState();
  }
});

elements.externalInputGuardButton.addEventListener("click", async () => {
  if (state.submitting || state.voice.recording || state.voice.transcribing || isWatchMode()) {
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    const nextEnabled = !isExternalInputGuardEnabled();
    await setExternalInputGuardEnabled(nextEnabled);
    updateVoiceStatus(nextEnabled
      ? "我把护手抬起来了，籽岷一碰我就停。"
      : "我把护手放下了，这会儿不会自动让手。");
  } catch (error) {
    updateVoiceStatus(`我这次没切稳护手：${error.message}`);
  } finally {
    state.submitting = false;
    syncUiState();
  }
});

elements.voiceStartButton.addEventListener("click", async () => {
  await startVoiceRecording();
});

elements.voiceStopButton.addEventListener("click", async () => {
  await stopVoiceRecording();
});

initVoiceInput();

refresh().catch((error) => {
  updateVoiceStatus(`我这边刚起身就绊了一下：${error.message}`);
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 5000);
