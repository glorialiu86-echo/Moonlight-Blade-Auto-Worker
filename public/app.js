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
    queue: [],
    queueProcessing: false,
    flushTimerId: null,
    voiceDetectedAt: 0,
    lastVoiceAt: 0,
    maxChunkRms: 0,
    baseDraft: "",
    transcriptSegments: []
  }
};

const VOICE_ACTIVITY_RMS_THRESHOLD = 0.009;
const VOICE_MIN_ACTIVE_MS = 280;
const VOICE_SILENCE_HOLD_MS = 520;
const VOICE_MAX_SEGMENT_MS = 2600;
const VOICE_TICK_MS = 120;

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
    elements.voiceButton.textContent = state.voice.recording ? "停止听写" : "语音";
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

function appendTranscriptToComposer(text) {
  const transcript = String(text || "").trim();

  if (!transcript) {
    return;
  }

  state.voice.transcriptSegments.push(transcript);
  elements.instructionInput.value = `${state.voice.baseDraft}${state.voice.transcriptSegments.join("")}`;
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

function resetVoiceSegmentationState({ preserveDraft = false } = {}) {
  state.voice.pcmChunks = [];
  state.voice.voiceDetectedAt = 0;
  state.voice.lastVoiceAt = 0;
  state.voice.maxChunkRms = 0;

  if (!preserveDraft) {
    state.voice.baseDraft = "";
    state.voice.transcriptSegments = [];
  }
}

function queueVoiceSegment(chunks, inputSampleRate, durationMs) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return;
  }

  state.voice.queue.push({
    chunks,
    inputSampleRate,
    durationMs
  });
}

function flushVoiceSegment({ force = false } = {}) {
  if (state.voice.pcmChunks.length === 0 || !state.voice.voiceDetectedAt) {
    resetVoiceSegmentationState({ preserveDraft: true });
    return false;
  }

  const now = Date.now();
  const activeDuration = now - state.voice.voiceDetectedAt;
  if (!force && activeDuration < VOICE_MIN_ACTIVE_MS) {
    return false;
  }

  queueVoiceSegment(
    state.voice.pcmChunks.map((chunk) => new Float32Array(chunk)),
    state.voice.inputSampleRate,
    activeDuration
  );

  resetVoiceSegmentationState({ preserveDraft: true });
  return true;
}

async function processVoiceQueue() {
  if (state.voice.queueProcessing) {
    return;
  }

  state.voice.queueProcessing = true;

  while (state.voice.queue.length > 0) {
    const segment = state.voice.queue.shift();
    state.voice.transcribing = true;
    syncUiState();
    updateVoiceStatus(state.voice.recording ? "正在实时转写..." : "正在完成最后一段转写...");

    try {
      const merged = mergeFloat32Chunks(segment.chunks);
      const downsampled = downsampleBuffer(merged, segment.inputSampleRate, 16000);
      const wavBlob = encodeWav(downsampled, 16000);
      const audioDataUrl = await blobToDataUrl(wavBlob);
      const payload = await request("/api/voice/transcribe", {
        method: "POST",
        body: JSON.stringify({ audioDataUrl })
      });
      const transcript = String(payload.text || "").trim();

      if (!transcript) {
        continue;
      }

      appendTranscriptToComposer(transcript);
      updateVoiceStatus(state.voice.recording ? `实时转写中：${transcript}` : "语音转写完成");
    } catch (error) {
      updateVoiceStatus(`语音转写失败：${error.message}`);
    } finally {
      state.voice.transcribing = false;
      syncUiState();
    }
  }

  state.voice.queueProcessing = false;
}

async function stopVoiceRecording() {
  if (!state.voice.recording) {
    return;
  }

  state.voice.recording = false;
  window.clearInterval(state.voice.flushTimerId);
  state.voice.flushTimerId = null;
  syncUiState();
  updateVoiceStatus("正在收尾最后一段语音...");

  try {
    flushVoiceSegment({ force: true });
    await releaseVoiceCapture();
    await processVoiceQueue();
    updateVoiceStatus("语音输入已停止");
  } catch (error) {
    updateVoiceStatus(`语音转写失败：${error.message}`);
  } finally {
    resetVoiceSegmentationState();
    state.voice.transcribing = false;
    syncUiState();
  }
}

function maybeFlushVoiceSegment() {
  if (!state.voice.recording || !state.voice.voiceDetectedAt) {
    return;
  }

  const now = Date.now();
  const silentFor = state.voice.lastVoiceAt ? now - state.voice.lastVoiceAt : 0;
  const activeFor = now - state.voice.voiceDetectedAt;

  if (activeFor >= VOICE_MAX_SEGMENT_MS || silentFor >= VOICE_SILENCE_HOLD_MS) {
    const flushed = flushVoiceSegment();
    if (flushed) {
      processVoiceQueue().catch(() => {});
    }
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
    state.voice.queue = [];
    resetVoiceSegmentationState();
    state.voice.inputSampleRate = audioContext.sampleRate;
    state.voice.recording = true;
    state.voice.baseDraft = elements.instructionInput.value;

    processorNode.onaudioprocess = (event) => {
      if (!state.voice.recording) {
        return;
      }

      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      const rms = computeRms(samples);
      const now = Date.now();

      if (rms >= VOICE_ACTIVITY_RMS_THRESHOLD) {
        if (!state.voice.voiceDetectedAt) {
          state.voice.voiceDetectedAt = now;
          state.voice.pcmChunks = [];
        }

        state.voice.lastVoiceAt = now;
      }

      if (state.voice.voiceDetectedAt) {
        state.voice.pcmChunks.push(samples);
        state.voice.maxChunkRms = Math.max(state.voice.maxChunkRms, rms);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    window.clearInterval(state.voice.flushTimerId);
    state.voice.flushTimerId = window.setInterval(() => {
      if (!state.voice.recording) {
        return;
      }

      maybeFlushVoiceSegment();
      if (!state.voice.voiceDetectedAt && !state.voice.transcribing) {
        updateVoiceStatus("实时监听中，等待你说话...");
      }
    }, VOICE_TICK_MS);

    updateVoiceStatus("实时监听已开始，检测到完整短句后会写入输入框");
    syncUiState();
  } catch (error) {
    await releaseVoiceCapture();
    state.voice.recording = false;
    window.clearInterval(state.voice.flushTimerId);
    state.voice.flushTimerId = null;
    resetVoiceSegmentationState();
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
    await stopVoiceRecording();
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
