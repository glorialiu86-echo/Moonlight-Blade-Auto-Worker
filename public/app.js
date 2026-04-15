const state = {
  submitting: false,
  voiceSupported: false,
  runtimeStatus: "idle",
  interactionMode: "act",
  externalInputGuardEnabled: true,
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
    throw new Error(payload.error || "请求失败");
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

  elements.instructionInput.disabled = busy || !running;
  elements.composerForm.querySelector('button[type="submit"]').disabled = busy || recording || !running;
  elements.voiceStartButton.disabled = !state.voiceSupported || busy || recording || !running;
  elements.voiceStopButton.disabled = !recording;
  elements.runToggleButton.disabled = busy || recording || state.voice.transcribing;
  elements.watchModeButton.disabled = busy || recording || state.voice.transcribing;
  elements.actModeButton.disabled = busy || recording || state.voice.transcribing;
  elements.externalInputGuardButton.disabled = busy || recording || state.voice.transcribing || isWatchMode();
  elements.watchModeButton.classList.toggle("is-active", isWatchMode());
  elements.actModeButton.classList.toggle("is-active", !isWatchMode());
  elements.externalInputGuardButton.classList.toggle("is-active", isExternalInputGuardEnabled());
  elements.externalInputGuardButton.textContent = `人一碰就停：${isExternalInputGuardEnabled() ? "开" : "关"}`;
  elements.runToggleButton.textContent = running ? "停止执行任务" : "开始执行任务";
}

function scrollMessagesToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderEmptyState() {
  const modeText = isWatchMode()
    ? "切到观看模式后，籽小刀会只根据屏幕内容和籽岷互动。"
    : "点“开始执行任务”后，籽岷就可以直接给籽小刀下任务了。";

  elements.messageList.innerHTML = `
    <article class="chat-message chat-message-assistant chat-empty">
      <div class="chat-role">籽小刀</div>
      <p class="chat-text">${modeText}</p>
      <p class="chat-meta">更完整的思考链和调试信息可以在 \`/debug\` 页面里看。</p>
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
  node.querySelector(".chat-meta").textContent = message.perceptionSummary || `风险：${message.riskLevel || "-"}`;
  return node;
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

  elements.runStatusText.textContent = running
    ? "执行中"
    : state.runtimeStatus === "paused"
      ? "已暂停"
      : "待机";

  elements.runStatusHint.textContent = running
    ? (isWatchMode()
      ? "当前是观看模式：籽小刀只看屏幕并和籽岷互动，不执行动作。"
      : `当前是行动模式：籽小刀会按规划链路执行动作。${isExternalInputGuardEnabled() ? " 检测到籽岷动鼠标或键盘时会自动停手。" : ""}`)
    : "当前整套本地程序处于停止或待机状态。";
}

function renderRuntimeState(runtimeState) {
  renderRunState(runtimeState);
  renderMessages(runtimeState.messages);
  syncUiState();
}

async function refresh() {
  const payload = await request("/api/state");
  renderRuntimeState(payload.state);
}

async function sendControlAction(action) {
  const payload = await request("/api/control", {
    method: "POST",
    body: JSON.stringify({ action })
  });
  renderRuntimeState(payload.state);
}

async function setInteractionMode(mode) {
  const payload = await request("/api/control", {
    method: "POST",
    body: JSON.stringify({ interactionMode: mode })
  });
  renderRuntimeState(payload.state);
}

async function setExternalInputGuardEnabled(enabled) {
  const payload = await request("/api/control", {
    method: "POST",
    body: JSON.stringify({ externalInputGuardEnabled: enabled })
  });
  renderRuntimeState(payload.state);
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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("文件读取失败"));
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
  updateVoiceStatus("录音结束，正在转写。");

  try {
    const pcmChunks = [...state.voice.pcmChunks];
    const inputSampleRate = state.voice.inputSampleRate;
    await releaseVoiceCapture();
    state.voice.pcmChunks = [];

    if (pcmChunks.length === 0) {
      throw new Error("没有采集到有效语音，请重试。");
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
    updateVoiceStatus("语音转写完成，结果已写入输入框。");
  } catch (error) {
    updateVoiceStatus(`语音转写失败：${error.message}`);
  } finally {
    state.voice.transcribing = false;
    syncUiState();
  }
}

async function startVoiceRecording() {
  if (!state.voiceSupported || state.submitting || state.voice.transcribing || state.voice.recording || !isRunningStatus(state.runtimeStatus)) {
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

    updateVoiceStatus("录音中。点“停止语音”后会自动转写到输入框。");
    syncUiState();
  } catch (error) {
    await releaseVoiceCapture();
    state.voice.recording = false;
    state.voice.pcmChunks = [];
    syncUiState();
    updateVoiceStatus(`无法开始录音：${error.message}`);
  }
}

function initVoiceInput() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const mediaDevices = navigator.mediaDevices;

  if (!AudioContextClass || !mediaDevices?.getUserMedia) {
    updateVoiceStatus("当前浏览器不支持语音输入。");
    syncUiState();
    return;
  }

  state.voiceSupported = true;
  updateVoiceStatus("语音输入已接入。");
  syncUiState();
}

elements.runToggleButton.addEventListener("click", async () => {
  const running = isRunningStatus(state.runtimeStatus);
  state.submitting = true;
  syncUiState();

  try {
    await sendControlAction(running ? "stop" : "start");
    updateVoiceStatus(running ? "系统已停止。" : "系统已启动，可以开始下达任务。");
    await refresh();
  } catch (error) {
    updateVoiceStatus(`切换运行状态失败：${error.message}`);
  } finally {
    state.submitting = false;
    syncUiState();
  }
});

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const instruction = elements.instructionInput.value.trim();

  if (!instruction || state.submitting || state.voice.recording || state.voice.transcribing || !isRunningStatus(state.runtimeStatus)) {
    return;
  }

  state.submitting = true;
  syncUiState();
  updateVoiceStatus(isWatchMode() ? "正在按观看模式生成回复。" : "正在按行动模式执行这一轮任务。");

  try {
    const payload = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        instruction,
        interactionMode: state.interactionMode,
        externalInputGuardEnabled: state.externalInputGuardEnabled
      })
    });

    elements.instructionInput.value = "";
    renderRuntimeState(payload.state);
    updateVoiceStatus("本轮任务完成。");
  } catch (error) {
    updateVoiceStatus(`本轮处理失败：${error.message}`);
    await refresh().catch(() => {});
  } finally {
    state.submitting = false;
    syncUiState();
  }
});

elements.watchModeButton.addEventListener("click", async () => {
  if (state.submitting || state.voice.recording || state.voice.transcribing || isWatchMode()) {
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    await setInteractionMode("watch");
    updateVoiceStatus("已切到观看模式，当前只观察和回复。");
  } catch (error) {
    updateVoiceStatus(`切换观看模式失败：${error.message}`);
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
    updateVoiceStatus("已切到行动模式，后续会执行动作。");
  } catch (error) {
    updateVoiceStatus(`切换行动模式失败：${error.message}`);
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
      ? "已开启人类介入保护，籽岷一动鼠标或键盘就会停掉行动。"
      : "已关闭人类介入保护，行动模式下不会因外界输入自动停止。");
  } catch (error) {
    updateVoiceStatus(`切换人类介入保护失败：${error.message}`);
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
  updateVoiceStatus(`初始化失败：${error.message}`);
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 5000);
