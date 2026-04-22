const state = {
  submitting: false,
  runtimeStatus: "idle",
  interactionMode: "watch",
  resumeAvailable: false,
  resumeFailureCode: "",
  inputProtectionUntil: "",
  inputProtectionButton: "",
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
    healthTimerId: null,
    speechDetected: false,
    speechStartedAt: 0,
    listeningStartedAt: 0,
    lastAudibleAt: 0,
    autoCaptureReleased: false,
    lastVoiceAt: 0,
    lastProcessAt: 0,
    activityNotified: false,
    sending: false,
    noiseFloorRms: 0
  }
};

const VOICE_ACTIVITY_RMS_THRESHOLD = 0.002;
const VOICE_ACTIVITY_DYNAMIC_THRESHOLD_MULTIPLIER = 1.22;
const VOICE_AUTO_SEND_SILENCE_MS = 1000;
const VOICE_MIN_SPEECH_MS = 450;
const VOICE_CAPTURE_STALL_MS = 1800;
const VOICE_AUTO_CAPTURE_RESUME_IDLE_MS = 20000;

const elements = {
  composerForm: document.querySelector("#composerForm"),
  instructionInput: document.querySelector("#instructionInput"),
  messageList: document.querySelector("#messageList"),
  submitButton: document.querySelector('#composerForm button[type="submit"]'),
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
  const protectionUntilMs = state.inputProtectionUntil ? new Date(state.inputProtectionUntil).getTime() : 0;
  const protectionActive = Boolean(protectionUntilMs) && Date.now() < protectionUntilMs;

  if (elements.submitButton) {
    const submitProtected = protectionActive && state.inputProtectionButton === "submit";
    elements.submitButton.disabled = busy || state.voice.recording || submitProtected;
    elements.submitButton.classList.toggle("button-input-protected", submitProtected);
  }

  if (elements.resumeFailedStepButton) {
    const resumeProtected = protectionActive && state.inputProtectionButton === "resume";
    elements.resumeFailedStepButton.disabled = busy || state.voice.recording || !state.resumeAvailable || resumeProtected;
    elements.resumeFailedStepButton.classList.toggle(
      "resume-triangle-alert",
      state.resumeAvailable && Boolean(state.resumeFailureCode)
    );
    elements.resumeFailedStepButton.classList.toggle("button-input-protected", resumeProtected);
    elements.resumeFailedStepButton.setAttribute(
      "aria-label",
      resumeProtected
        ? "正在等待两分钟鼠标脱离保护结束"
        : state.resumeAvailable && state.resumeFailureCode
        ? "存在失败恢复动作，点击继续"
        : "从失败步骤继续"
    );
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
  return String(text || "");
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
  state.resumeFailureCode = String(runtimeState.automation?.lastFailureCode || "");
  state.inputProtectionUntil = String(runtimeState.automation?.inputProtectionUntil || "");
  state.inputProtectionButton = String(runtimeState.automation?.inputProtectionButton || "");
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
    console.error("resume_failed_step failed", error);
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

async function notifyVoiceActivity() {
  try {
    await request("/api/voice/activity", {
      method: "POST",
      body: JSON.stringify({ active: true, reason: "speech" })
    });
  } catch {
    // Keep listening even if the pause signal fails.
  }
}

async function updateVoiceCaptureGate({ active, reason }) {
  try {
    await request("/api/voice/activity", {
      method: "POST",
      body: JSON.stringify({ active, reason })
    });
  } catch {
    // Keep voice capture working even if the server-side gate update fails.
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
    console.error("resume_failed_step failed", error);
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

function clearVoiceHealthTimer() {
  if (!state.voice.healthTimerId) {
    return;
  }

  window.clearInterval(state.voice.healthTimerId);
  state.voice.healthTimerId = null;
}

function resetVoiceState() {
  state.voice.pcmChunks = [];
  state.voice.speechDetected = false;
  state.voice.speechStartedAt = 0;
  state.voice.lastVoiceAt = 0;
  state.voice.lastProcessAt = 0;
  state.voice.activityNotified = false;
  state.voice.noiseFloorRms = 0;
}

function maybeReleaseAutoCaptureForVoiceIdle() {
  const lastAudibleAt = state.voice.lastAudibleAt || state.voice.listeningStartedAt;
  if (
    !state.voice.recording
    || state.voice.autoCaptureReleased
    || !lastAudibleAt
    || Date.now() - lastAudibleAt < VOICE_AUTO_CAPTURE_RESUME_IDLE_MS
  ) {
    return;
  }

  state.voice.autoCaptureReleased = true;
  updateVoiceCaptureGate({ active: false, reason: "idle_timeout" }).catch(() => {});
}

function getVoiceActivityThreshold() {
  const baseline = state.voice.noiseFloorRms > 0
    ? state.voice.noiseFloorRms * VOICE_ACTIVITY_DYNAMIC_THRESHOLD_MULTIPLIER
    : 0;
  return Math.max(VOICE_ACTIVITY_RMS_THRESHOLD, baseline);
}

function buildListeningVoiceStatus() {
  if (!state.voice.recording || state.voice.sending || state.voice.transcribing) {
    return "";
  }

  if (state.voice.speechDetected && state.voice.lastVoiceAt) {
    return "听到你在说话了，你停一下我就自动发送。";
  }

  const listeningFor = state.voice.listeningStartedAt
    ? Date.now() - state.voice.listeningStartedAt
    : 0;

  if (listeningFor >= 3000) {
    return "我还在听，但这段声音还没形成可发送内容。你可以再说完整一点，或按停止语音结束。";
  }

  return "正在听你说话，说完整一句后我会自动发送。";
}

async function releaseVoiceCapture() {
  const { sourceNode, processorNode, mediaStream, audioContext } = state.voice;

  clearVoiceHealthTimer();

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

async function handleVoiceCaptureInterrupted(message) {
  if (!state.voice.recording) {
    return;
  }

  clearVoiceSilenceTimer();
  state.voice.recording = false;
  state.voice.sending = false;
  state.voice.transcribing = false;
  state.voice.listeningStartedAt = 0;
  state.voice.lastAudibleAt = 0;
  state.voice.autoCaptureReleased = false;
  resetVoiceState();
  await releaseVoiceCapture();
  await updateVoiceCaptureGate({ active: false, reason: "interrupted" });
  updateVoiceStatus(message);
  syncUiState();
}

function startVoiceHealthTimer() {
  clearVoiceHealthTimer();
  state.voice.healthTimerId = window.setInterval(() => {
    if (!state.voice.recording || state.voice.sending || state.voice.transcribing) {
      return;
    }

    if (!state.voice.lastProcessAt) {
      return;
    }

    if (Date.now() - state.voice.lastProcessAt >= VOICE_CAPTURE_STALL_MS) {
      handleVoiceCaptureInterrupted("语音监听已中断，请重新开启").catch(() => {});
    }
  }, 300);
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

async function flushVoiceSegment({ autoSend = false, stopListening = false } = {}) {
  if (state.voice.sending || state.voice.transcribing) {
    return;
  }

  const capturedChunks = state.voice.pcmChunks.map((chunk) => new Float32Array(chunk));
  const inputSampleRate = state.voice.inputSampleRate;
  const hadSpeech = state.voice.speechDetected;
  const speechStartedAt = state.voice.speechStartedAt;
  const lastVoiceAt = state.voice.lastVoiceAt;
  const speechDuration = speechStartedAt && lastVoiceAt ? Math.max(0, lastVoiceAt - speechStartedAt) : 0;

  clearVoiceSilenceTimer();
  resetVoiceState();
  syncUiState();

  if (!hadSpeech || capturedChunks.length === 0 || speechDuration < VOICE_MIN_SPEECH_MS) {
    if (stopListening) {
      state.voice.recording = false;
      state.voice.listeningStartedAt = 0;
      state.voice.lastAudibleAt = 0;
      state.voice.autoCaptureReleased = false;
      await releaseVoiceCapture();
      await updateVoiceCaptureGate({ active: false, reason: "manual_stop" });
      updateVoiceStatus(
        hadSpeech || capturedChunks.length > 0
          ? "这段声音太短或太轻，还没形成可发送内容，语音监听已停止。"
          : "没有收到可发送的语音内容，语音监听已停止。"
      );
      syncUiState();
    } else if (hadSpeech && speechDuration > 0) {
      updateVoiceStatus("刚才那段太短了，我先不发，继续听你后面的内容。");
      state.voice.silenceTimerId = window.setInterval(() => {
        if (!state.voice.recording || state.voice.sending || !state.voice.speechDetected || !state.voice.lastVoiceAt) {
          return;
        }

        const silentFor = Date.now() - state.voice.lastVoiceAt;
        if (silentFor >= VOICE_AUTO_SEND_SILENCE_MS) {
          flushVoiceSegment({ autoSend: true, stopListening: false }).catch(() => {});
        }
        maybeReleaseAutoCaptureForVoiceIdle();
      }, 120);
      syncUiState();
    }
    return;
  }

  state.voice.sending = true;
  state.voice.transcribing = true;
  syncUiState();
  updateVoiceStatus(
    autoSend
      ? "正在识别并发送语音..."
      : "正在识别你停止前的最后一段语音..."
  );
  let finalStopStatus = "语音监听已停止";

  try {
    const transcript = await transcribeRecordedVoice(capturedChunks, inputSampleRate);
    state.voice.transcribing = false;
    syncUiState();

    if (autoSend) {
      updateVoiceStatus("识别完成，正在发送...");
      await submitVoiceInstruction(transcript);
    } else {
      finalStopStatus = "最后一段语音已识别，语音监听已停止。";
      updateVoiceStatus(finalStopStatus);
    }
  } catch (error) {
    state.voice.transcribing = false;
    syncUiState();
    finalStopStatus = `最后一段语音识别失败：${error.message}`;
    updateVoiceStatus(finalStopStatus);
  } finally {
    state.voice.sending = false;
    state.voice.transcribing = false;
    if (stopListening) {
      state.voice.recording = false;
      state.voice.listeningStartedAt = 0;
      state.voice.lastAudibleAt = 0;
      state.voice.autoCaptureReleased = false;
      await releaseVoiceCapture();
      await updateVoiceCaptureGate({ active: false, reason: "manual_stop" });
      updateVoiceStatus(finalStopStatus);
    } else if (state.voice.recording) {
      state.voice.silenceTimerId = window.setInterval(() => {
        if (!state.voice.recording || state.voice.sending) {
          return;
        }

        if (state.voice.speechDetected && state.voice.lastVoiceAt) {
          const silentFor = Date.now() - state.voice.lastVoiceAt;
          if (silentFor >= VOICE_AUTO_SEND_SILENCE_MS) {
            flushVoiceSegment({ autoSend: true, stopListening: false }).catch(() => {});
            return;
          }
        }
        updateVoiceStatus(buildListeningVoiceStatus());
        maybeReleaseAutoCaptureForVoiceIdle();
      }, 120);
      updateVoiceStatus(buildListeningVoiceStatus());
    }
    syncUiState();
  }
}

async function stopVoiceRecording() {
  if (!state.voice.recording) {
    return;
  }

  await flushVoiceSegment({ autoSend: false, stopListening: true });
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
    state.voice.listeningStartedAt = Date.now();
    state.voice.lastAudibleAt = 0;
    state.voice.autoCaptureReleased = false;
    resetVoiceState();
    state.voice.lastProcessAt = Date.now();
    await updateVoiceCaptureGate({ active: true, reason: "listening_start" });

    const [audioTrack] = mediaStream.getAudioTracks();
    if (audioTrack) {
      audioTrack.onended = () => {
        handleVoiceCaptureInterrupted("语音监听已结束，请重新开启").catch(() => {});
      };
      audioTrack.onmute = () => {
        if (!state.voice.recording) {
          return;
        }

        window.setTimeout(() => {
          if (state.voice.recording && audioTrack.muted) {
            handleVoiceCaptureInterrupted("语音输入已被系统挂起，请重新开启").catch(() => {});
          }
        }, VOICE_CAPTURE_STALL_MS);
      };
    }

    audioContext.onstatechange = () => {
      if (!state.voice.recording) {
        return;
      }

      if (audioContext.state !== "running") {
        handleVoiceCaptureInterrupted("语音监听已暂停，请重新开启").catch(() => {});
      }
    };

    processorNode.onaudioprocess = (event) => {
      if (!state.voice.recording) {
        return;
      }

      state.voice.lastProcessAt = Date.now();
      const samples = new Float32Array(event.inputBuffer.getChannelData(0));
      const rms = computeRms(samples);
      if (!state.voice.speechDetected) {
        if (state.voice.noiseFloorRms > 0) {
          state.voice.noiseFloorRms = (state.voice.noiseFloorRms * 0.92) + (rms * 0.08);
        } else {
          state.voice.noiseFloorRms = rms;
        }
      }

      if (rms >= getVoiceActivityThreshold()) {
        if (!state.voice.speechDetected) {
          state.voice.speechStartedAt = Date.now();
        }
        state.voice.speechDetected = true;
        state.voice.lastVoiceAt = Date.now();
        state.voice.lastAudibleAt = state.voice.lastVoiceAt;
        state.voice.autoCaptureReleased = false;
        if (!state.voice.activityNotified) {
          state.voice.activityNotified = true;
          notifyVoiceActivity().catch(() => {});
        }
      }

      if (state.voice.speechDetected) {
        state.voice.pcmChunks.push(samples);
      }
    };

    sourceNode.connect(processorNode);
    processorNode.connect(audioContext.destination);

    clearVoiceSilenceTimer();
    state.voice.silenceTimerId = window.setInterval(() => {
      if (!state.voice.recording || state.voice.sending) {
        return;
      }

      if (state.voice.speechDetected && state.voice.lastVoiceAt) {
        const silentFor = Date.now() - state.voice.lastVoiceAt;
        if (silentFor >= VOICE_AUTO_SEND_SILENCE_MS) {
          flushVoiceSegment({ autoSend: true, stopListening: false }).catch(() => {});
          return;
        }
      }
      updateVoiceStatus(buildListeningVoiceStatus());
      maybeReleaseAutoCaptureForVoiceIdle();
    }, 120);

    startVoiceHealthTimer();
    updateVoiceStatus(buildListeningVoiceStatus());
    syncUiState();
  } catch (error) {
    await releaseVoiceCapture();
    state.voice.recording = false;
    state.voice.listeningStartedAt = 0;
    state.voice.lastAudibleAt = 0;
    state.voice.autoCaptureReleased = false;
    clearVoiceSilenceTimer();
    resetVoiceState();
    await updateVoiceCaptureGate({ active: false, reason: "start_failed" });
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
  syncUiState();
}, 500);

setInterval(() => {
  refresh().catch(() => {});
}, 10000);
