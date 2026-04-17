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
    segmentChunks: [],
    segmentActive: false,
    speechStartedAt: 0,
    lastVoiceAt: 0,
    queue: [],
    queueProcessing: false
  }
};

const VOICE_ACTIVITY_THRESHOLD = 0.015;
const VOICE_SILENCE_MS = 1000;
const VOICE_MIN_SEGMENT_MS = 700;

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
  const text = String(message || "").trim();
  elements.voiceStatus.textContent = text;
  elements.voiceStatus.hidden = !text;
}

function syncUiState() {
  const busy = state.submitting || state.voice.transcribing;
  elements.instructionInput.disabled = busy || state.voice.recording;
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

async function submitVoiceTranscript(transcript) {
  const instruction = String(transcript || "").trim();

  if (!instruction) {
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

    applyPayload(payload);
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

function appendTranscriptToComposer(text) {
  const transcript = String(text || "").trim();

  if (!transcript) {
    return;
  }

  const current = elements.instructionInput.value.trim();
  elements.instructionInput.value = current
    ? `${current}${current.endsWith("。") ? "" : "，"}${transcript}`
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

function resetVoiceSegmentationState() {
  state.voice.pcmChunks = [];
  state.voice.segmentChunks = [];
  state.voice.segmentActive = false;
  state.voice.speechStartedAt = 0;
  state.voice.lastVoiceAt = 0;
}

function queueVoiceSegment(chunks, inputSampleRate) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return;
  }

  state.voice.queue.push({
    chunks,
    inputSampleRate
  });
}

function flushVoiceSegment(reason = "silence") {
  if (!state.voice.segmentActive || state.voice.segmentChunks.length === 0) {
    return false;
  }

  const segmentDuration = Date.now() - state.voice.speechStartedAt;

  if (reason !== "stop" && segmentDuration < VOICE_MIN_SEGMENT_MS) {
    resetVoiceSegmentationState();
    return false;
  }

  queueVoiceSegment(
    state.voice.segmentChunks.map((chunk) => new Float32Array(chunk)),
    state.voice.inputSampleRate
  );
  resetVoiceSegmentationState();
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
    updateVoiceStatus(state.voice.recording ? "持续听写中，正在识别上一句…" : "正在完成最后一句识别…");

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

      await submitVoiceTranscript(transcript);
      updateVoiceStatus(state.voice.recording ? "持续听写中…" : "听写完成");
    } catch (error) {
      updateVoiceStatus(`语音失败：${error.message}`);
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
  syncUiState();
  updateVoiceStatus("Stopping voice...");

  try {
    flushVoiceSegment("stop");
    await releaseVoiceCapture();
    await processVoiceQueue();
    updateVoiceStatus("Voice stopped");
  } catch (error) {
    updateVoiceStatus(`Voice failed: ${error.message}`);
  } finally {
    resetVoiceSegmentationState();
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
    resetVoiceSegmentationState();
    state.voice.queue = [];
    state.voice.inputSampleRate = audioContext.sampleRate;
    state.voice.recording = true;

    processorNode.onaudioprocess = (event) => {
      if (!state.voice.recording) {
        return;
      }

      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      const rms = computeRms(samples);
      const now = Date.now();
      const isVoiceActive = rms >= VOICE_ACTIVITY_THRESHOLD;

      if (isVoiceActive) {
        if (!state.voice.segmentActive) {
          state.voice.segmentActive = true;
          state.voice.speechStartedAt = now;
          state.voice.segmentChunks = [];
        }

        state.voice.lastVoiceAt = now;
      }

      if (state.voice.segmentActive) {
        state.voice.segmentChunks.push(samples);
      }

      if (state.voice.segmentActive && state.voice.lastVoiceAt && now - state.voice.lastVoiceAt >= VOICE_SILENCE_MS) {
        const flushed = flushVoiceSegment("silence");
        if (flushed) {
          processVoiceQueue().catch(() => {});
        }
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    updateVoiceStatus("Listening continuously... pauses around 1s will auto-send");
    syncUiState();
  } catch (error) {
    await releaseVoiceCapture();
    state.voice.recording = false;
    resetVoiceSegmentationState();
    syncUiState();
    updateVoiceStatus(`Unable to start recording: ${error.message}`);
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
