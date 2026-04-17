const state = {
  submitting: false,
  runtimeStatus: "idle",
  interactionMode: "watch",
  resumeAvailable: false,
  voiceSupported: false,
  voice: {
    recording: false,
    transcribing: false,
    mediaStream: null,
    audioContext: null,
    sourceNode: null,
    processorNode: null,
    pcmChunks: [],
    inputSampleRate: 48000,
    silenceTimerId: null,
    speechDetected: false,
    lastVoiceAt: 0
  }
};

const VOICE_ACTIVITY_RMS_THRESHOLD = 0.009;
const VOICE_AUTO_SEND_SILENCE_MS = 3000;

const elements = {
  composerForm: document.querySelector("#composerForm"),
  instructionInput: document.querySelector("#instructionInput"),
  messageList: document.querySelector("#messageList"),
  resumeFailedStepButton: document.querySelector("#resumeFailedStepButton"),
  voiceButton: document.querySelector("#voiceButton"),
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

function detectInteractionMode(instruction) {
  return String(instruction || "").includes("加油") ? "act" : "watch";
}

function updateVoiceStatus(message = "") {
  if (!elements.voiceStatus) {
    return;
  }

  const text = String(message || "").trim();
  elements.voiceStatus.textContent = text;
  elements.voiceStatus.hidden = !text;
}

function syncUiState() {
  const busy = state.submitting || state.voice.transcribing;
  elements.instructionInput.disabled = state.submitting;
  elements.composerForm.querySelector('button[type="submit"]').disabled = busy || state.voice.recording;
  if (elements.resumeFailedStepButton) {
    elements.resumeFailedStepButton.disabled = busy || state.voice.recording || !state.resumeAvailable;
  }

  if (elements.voiceButton) {
    elements.voiceButton.disabled = !state.voiceSupported || (!state.voice.recording && (state.submitting || state.voice.transcribing));
    elements.voiceButton.textContent = state.voice.recording ? "停止语音" : "语音";
  }
}

function scrollMessagesToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderEmptyState() {
  elements.messageList.innerHTML = `
    <article class="chat-message chat-message-assistant chat-empty">
      <div class="chat-role">籽小刀</div>
      <p class="chat-text">你说，我听着。</p>
    </article>
  `;
  scrollMessagesToBottom();
}

function replaceAssistantViewerReferences(text) {
  return String(text || "")
    .replaceAll("籽岷团队", "你")
    .replaceAll("籽岷", "你");
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

  return replaceAssistantViewerReferences(lines.filter(Boolean).join("\n"));
}

function renderUserMessage(message) {
  const node = elements.userMessageTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".chat-text").textContent = message.text || "";
  return node;
}

function renderAssistantMessage(message) {
  const node = elements.assistantMessageTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".chat-text").textContent = buildAssistantText(message);
  return node;
}

function renderMessages(messages) {
  elements.messageList.innerHTML = "";

  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmptyState();
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

function renderRuntimeState(runtimeState) {
  state.runtimeStatus = runtimeState.status || "idle";
  state.interactionMode = runtimeState.interactionMode || "watch";
  state.resumeAvailable = Boolean(runtimeState.automation?.resumeAvailable);
  renderMessages(runtimeState.messages);
  syncUiState();
}

function applyPayload(payload) {
  renderRuntimeState(payload.state);
}

async function refresh() {
  const payload = await request("/api/state");
  applyPayload(payload);
}

async function submitInstruction({ allowDuringTranscription = false } = {}) {
  const instruction = elements.instructionInput.value.trim();

  if (!instruction || state.submitting || state.voice.recording || (state.voice.transcribing && !allowDuringTranscription)) {
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    const payload = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        instruction,
        interactionMode: detectInteractionMode(instruction),
        externalInputGuardEnabled: true
      })
    });

    elements.instructionInput.value = "";
    applyPayload(payload);
    updateVoiceStatus("");
  } catch (error) {
    await refresh().catch(() => {});
    window.alert(error.message);
  } finally {
    state.submitting = false;
    syncUiState();
  }
}

async function submitVoiceInstruction(instruction) {
  const text = String(instruction || "").trim();
  if (!text) {
    updateVoiceStatus("没有识别到有效语音，请重试。");
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    const payload = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        instruction: text,
        interactionMode: detectInteractionMode(text),
        externalInputGuardEnabled: true
      })
    });

    applyPayload(payload);
    updateVoiceStatus("");
  } catch (error) {
    await refresh().catch(() => {});
    updateVoiceStatus(`语音发送失败：${error.message}`);
  } finally {
    state.submitting = false;
    syncUiState();
  }
}

async function resumeFailedStep() {
  if (state.submitting || state.voice.recording || !state.resumeAvailable) {
    return;
  }

  state.submitting = true;
  syncUiState();

  try {
    const payload = await request("/api/control", {
      method: "POST",
      body: JSON.stringify({
        action: "resume_failed_step"
      })
    });

    applyPayload(payload);
    updateVoiceStatus("");
  } catch (error) {
    await refresh().catch(() => {});
    window.alert(error.message);
  } finally {
    state.submitting = false;
    syncUiState();
  }
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

function computeRms(samples) {
  if (!samples?.length) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    sum += samples[index] * samples[index];
  }

  return Math.sqrt(sum / samples.length);
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

function clearVoiceSilenceTimer() {
  if (!state.voice.silenceTimerId) {
    return;
  }

  window.clearInterval(state.voice.silenceTimerId);
  state.voice.silenceTimerId = null;
}

function resetVoiceState() {
  state.voice.pcmChunks = [];
  state.voice.speechDetected = false;
  state.voice.lastVoiceAt = 0;
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

async function transcribeRecordedVoice(chunks, inputSampleRate) {
  if (!chunks.length) {
    throw new Error("没有采集到有效语音");
  }

  const merged = mergeFloat32Chunks(chunks);
  const downsampled = downsampleBuffer(merged, inputSampleRate, 16000);
  const wavBlob = encodeWav(downsampled, 16000);
  const audioDataUrl = await blobToDataUrl(wavBlob);
  const payload = await request("/api/voice/transcribe", {
    method: "POST",
    body: JSON.stringify({ audioDataUrl })
  });

  return String(payload.text || "").trim();
}

async function stopVoiceRecording({ autoSend = false } = {}) {
  if (!state.voice.recording) {
    return;
  }

  const capturedChunks = state.voice.pcmChunks.map((chunk) => new Float32Array(chunk));
  const inputSampleRate = state.voice.inputSampleRate;

  state.voice.recording = false;
  clearVoiceSilenceTimer();
  syncUiState();
  updateVoiceStatus("正在识别语音...");

  try {
    await releaseVoiceCapture();

    if (!state.voice.speechDetected || capturedChunks.length === 0) {
      updateVoiceStatus("没有检测到有效语音。");
      return;
    }

    state.voice.transcribing = true;
    syncUiState();
    const transcript = await transcribeRecordedVoice(capturedChunks, inputSampleRate);
    state.voice.transcribing = false;
    syncUiState();

    if (autoSend) {
      updateVoiceStatus("识别完成，正在发送...");
      await submitVoiceInstruction(transcript);
      return;
    }

    updateVoiceStatus("识别完成");
  } catch (error) {
    state.voice.transcribing = false;
    syncUiState();
    updateVoiceStatus(`语音识别失败：${error.message}`);
  } finally {
    resetVoiceState();
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
    state.voice.inputSampleRate = audioContext.sampleRate;
    state.voice.recording = true;
    resetVoiceState();

    processorNode.onaudioprocess = (event) => {
      if (!state.voice.recording) {
        return;
      }

      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      const rms = computeRms(samples);
      if (rms >= VOICE_ACTIVITY_RMS_THRESHOLD) {
        state.voice.speechDetected = true;
        state.voice.lastVoiceAt = Date.now();
      }

      if (state.voice.speechDetected) {
        state.voice.pcmChunks.push(samples);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    clearVoiceSilenceTimer();
    state.voice.silenceTimerId = window.setInterval(() => {
      if (!state.voice.recording || !state.voice.speechDetected || !state.voice.lastVoiceAt) {
        return;
      }

      const silentFor = Date.now() - state.voice.lastVoiceAt;
      if (silentFor >= VOICE_AUTO_SEND_SILENCE_MS) {
        stopVoiceRecording({ autoSend: true }).catch(() => {});
      }
    }, 120);

    updateVoiceStatus("正在听你说话，静音 3 秒会自动发送。");
    syncUiState();
  } catch (error) {
    await releaseVoiceCapture();
    state.voice.recording = false;
    clearVoiceSilenceTimer();
    resetVoiceState();
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
  syncUiState();
}

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await submitInstruction();
});

elements.instructionInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
    return;
  }

  event.preventDefault();
  await submitInstruction();
});

elements.resumeFailedStepButton?.addEventListener("click", async () => {
  await resumeFailedStep();
});

elements.voiceButton?.addEventListener("click", async () => {
  if (state.voice.recording) {
    await stopVoiceRecording({ autoSend: true });
    return;
  }

  await startVoiceRecording();
});

initVoiceInput();
refresh().catch(() => {
  renderEmptyState();
});

setInterval(() => {
  refresh().catch(() => {});
}, 3000);
