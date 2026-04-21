const state = {
  submitting: false,
  uploadingImage: false,
  voiceSupported: false,
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
  headerPill: document.querySelector("#headerPill"),
  instructionInput: document.querySelector("#instructionInput"),
  agentStatusValue: document.querySelector("#agentStatusValue"),
  agentModeValue: document.querySelector("#agentModeValue"),
  agentObjectiveValue: document.querySelector("#agentObjectiveValue"),
  agentSourceValue: document.querySelector("#agentSourceValue"),
  agentQueueValue: document.querySelector("#agentQueueValue"),
  captureSummaryCard: document.querySelector("#captureSummaryCard"),
  captureStartButton: document.querySelector("#captureStartButton"),
  capturePauseButton: document.querySelector("#capturePauseButton"),
  captureTriggerButton: document.querySelector("#captureTriggerButton"),
  captureStopButton: document.querySelector("#captureStopButton"),
  messageList: document.querySelector("#messageList"),
  experimentList: document.querySelector("#experimentList"),
  perceptionSummaryCard: document.querySelector("#perceptionSummaryCard"),
  screenshotInput: document.querySelector("#screenshotInput"),
  imageStatus: document.querySelector("#imageStatus"),
  voiceStartButton: document.querySelector("#voiceStartButton"),
  voiceStopButton: document.querySelector("#voiceStopButton"),
  voiceStatus: document.querySelector("#voiceStatus"),
  userMessageTemplate: document.querySelector("#userMessageTemplate"),
  assistantMessageTemplate: document.querySelector("#assistantMessageTemplate"),
  actionTemplate: document.querySelector("#actionTemplate"),
  experimentTemplate: document.querySelector("#experimentTemplate")
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

function updateImageStatus(message) {
  elements.imageStatus.textContent = message;
}

function syncUiState() {
  const { recording, transcribing } = state.voice;
  const busy = state.submitting || transcribing || state.uploadingImage;

  elements.instructionInput.disabled = busy;
  elements.composerForm.querySelector('button[type="submit"]').disabled = busy || recording;
  elements.voiceStartButton.disabled = !state.voiceSupported || busy || recording;
  elements.voiceStopButton.disabled = !recording;
  elements.captureStartButton.disabled = busy;
  elements.capturePauseButton.disabled = busy;
  elements.captureTriggerButton.disabled = busy;
  elements.captureStopButton.disabled = busy;
}

function scrollMessagesToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderEmptyState() {
  elements.messageList.innerHTML = `
    <article class="message message-assistant empty-state">
      <div class="message-role">籽小刀</div>
      <p class="message-text">这里保留完整调试视图。你可以在籽岷页发任务，也可以在这里直接发调试指令。</p>
      <p class="message-meta">建议先启用自动窗口截图，再观察识别结果。</p>
    </article>
  `;
}

function formatAgentMode(mode, phase) {
  if (mode === "user_priority") {
    return phase === "queued" ? "等待籽岷插队生效" : "籽岷优先";
  }

  if (phase === "cooldown") {
    return "刚处理完籽岷命令";
  }

  if (phase === "waiting") {
    return "待机";
  }

  return "自主实验";
}

function formatTurnSource(source) {
  if (source === "user") {
    return "籽岷发起";
  }

  if (source === "agent") {
    return "籽小刀自主";
  }

  return "-";
}

function formatCaptureStatus(status) {
  if (status === "running") {
    return "运行中";
  }

  if (status === "paused") {
    return "已暂停";
  }

  if (status === "error") {
    return "错误";
  }

  return "未启动";
}

function renderAgentPanel(runtimeState) {
  const agent = runtimeState.agent || {};
  elements.agentStatusValue.textContent = runtimeState.status || "idle";
  elements.agentModeValue.textContent = formatAgentMode(agent.mode, agent.phase);
  elements.agentObjectiveValue.textContent = agent.currentObjective || "等待目标";
  elements.agentSourceValue.textContent = formatTurnSource(agent.lastTurnSource);
  elements.agentQueueValue.textContent = agent.queuedUserObjective || "暂无";
  elements.headerPill.textContent = `当前模式：${formatAgentMode(agent.mode, agent.phase)}`;
}

function renderAssistantMessage(message) {
  const node = elements.assistantMessageTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".message-text").textContent = message.text || "本轮暂无回复。";
  node.querySelector(".message-meta").textContent = `环境：${message.sceneLabel || "未判定"} | 风险：${message.riskLevel || "-"}`;
  node.querySelector(".message-perception").textContent = message.perceptionSummary || "本轮还没有环境输入。";

  const interpretationBlock = node.querySelector('[data-block="interpretation"]');
  const thinkingBlock = node.querySelector('[data-block="thinking"]');
  const actionBlock = node.querySelector('[data-block="actions"]');
  const interpretationText = node.querySelector(".message-interpretation");
  const thinkingList = node.querySelector(".thinking-list");
  const actionList = node.querySelector(".action-list");

  if (message.personaInterpretation) {
    interpretationText.textContent = message.personaInterpretation;
  } else {
    interpretationBlock.hidden = true;
  }

  if (Array.isArray(message.thinkingChain) && message.thinkingChain.length > 0) {
    message.thinkingChain.forEach((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      thinkingList.appendChild(li);
    });
  } else {
    thinkingBlock.hidden = true;
  }

  if (Array.isArray(message.actions) && message.actions.length > 0) {
    message.actions.forEach((action) => {
      const actionNode = elements.actionTemplate.content.firstElementChild.cloneNode(true);
      actionNode.querySelector(".action-title").textContent = action.title || "未命名动作";
      actionNode.querySelector(".action-detail").textContent = action.detail || action.reason || "";
      actionList.appendChild(actionNode);
    });
  } else {
    actionBlock.hidden = true;
  }

  return node;
}

function renderUserMessage(message) {
  const node = elements.userMessageTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.origin = message.origin || "user";
  node.querySelector(".message-role").textContent = message.origin === "agent" ? "自主实验目标" : "籽岷输入";
  node.querySelector(".message-text").textContent = message.text || "";
  return node;
}

function renderMessages(messages) {
  elements.messageList.innerHTML = "";

  if (!Array.isArray(messages) || messages.length === 0) {
    renderEmptyState();
    scrollMessagesToBottom();
    return;
  }

  messages.forEach((message) => {
    const node = message.role === "assistant"
      ? renderAssistantMessage(message)
      : renderUserMessage(message);
    elements.messageList.appendChild(node);
  });

  scrollMessagesToBottom();
}

function renderPerception(perception) {
  if (!perception) {
    elements.perceptionSummaryCard.innerHTML = `
      <p class="summary-title">暂无截图</p>
      <p class="summary-body">启用自动窗口截图后，这里会显示场景、NPC、交互项和风险提示。</p>
    `;
    return;
  }

  const npcText = perception.npcNames?.join("、") || "无";
  const optionText = perception.interactiveOptions?.join("、") || "无";
  const alertText = perception.alerts?.join("、") || "无";
  const sourceText = perception.source === "auto_window" ? "自动窗口截图" : "手动上传截图";

  elements.perceptionSummaryCard.innerHTML = `
    <p class="summary-title">${perception.sceneLabel || "未判定"}</p>
    <p class="summary-body">${perception.summary || "暂无总结"}</p>
    <p class="summary-line"><strong>来源：</strong>${sourceText}</p>
    <p class="summary-line"><strong>NPC：</strong>${npcText}</p>
    <p class="summary-line"><strong>交互项：</strong>${optionText}</p>
    <p class="summary-line"><strong>风险：</strong>${alertText}</p>
  `;
}

function renderCapturePanel(capture) {
  if (!capture) {
    elements.captureSummaryCard.innerHTML = `
      <p class="summary-title">未启动</p>
      <p class="summary-body">自动截图状态暂不可用。</p>
    `;
    return;
  }

  const boundsText = capture.lastBounds
    ? `${capture.lastBounds.width} x ${capture.lastBounds.height} @ (${capture.lastBounds.left}, ${capture.lastBounds.top})`
    : "暂无";
  const errorText = capture.lastErrorMessage || "无";
  const sourceText = capture.lastImageSource === "auto_window"
    ? "自动窗口截图"
    : capture.lastImageSource === "manual_upload"
      ? "手动上传截图"
      : "暂无";

  elements.captureSummaryCard.innerHTML = `
    <p class="summary-title">${formatCaptureStatus(capture.status)}</p>
    <p class="summary-body">当前感知 owner：自动窗口截图。手动上传仍可调试，但不会改变自动截图状态机。</p>
    <p class="summary-line"><strong>窗口：</strong>${capture.lastWindowTitle || "暂无"}</p>
    <p class="summary-line"><strong>最近截图：</strong>${capture.lastCaptureAt || "暂无"}</p>
    <p class="summary-line"><strong>最近分析：</strong>${capture.lastAnalyzeAt || "暂无"}</p>
    <p class="summary-line"><strong>窗口尺寸：</strong>${boundsText}</p>
    <p class="summary-line"><strong>最近来源：</strong>${sourceText}</p>
    <p class="summary-line"><strong>错误：</strong>${errorText}</p>
  `;
}

function renderExperiments(experiments) {
  elements.experimentList.innerHTML = "";

  if (!Array.isArray(experiments) || experiments.length === 0) {
    elements.experimentList.innerHTML = `
      <article class="experiment-item experiment-empty">
        <p class="experiment-title">还没有实验记录</p>
        <p class="experiment-meta">先准备环境感知，再发一条调试任务。</p>
      </article>
    `;
    return;
  }

  experiments.forEach((experiment) => {
    const node = elements.experimentTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".experiment-title").textContent = experiment.title || "未命名实验";
    node.querySelector(".experiment-meta").textContent =
      `${experiment.scene || "unknown"} | 风险 ${experiment.riskLevel || "-"} | ${experiment.selectedStrategy || "未记录策略"}`;
    node.querySelector(".experiment-outcome").textContent =
      experiment.outcome || experiment.perceptionSummary || "暂无结果总结";
    elements.experimentList.appendChild(node);
  });
}

function renderRuntimeState(runtimeState) {
  renderAgentPanel(runtimeState);
  renderMessages(runtimeState.messages);
  renderCapturePanel(runtimeState.capture);
  renderPerception(runtimeState.latestPerception);
  renderExperiments(runtimeState.experiments);
}

async function refresh() {
  const payload = await request("/api/state");
  renderRuntimeState(payload.state);
}

async function sendCaptureControl(action) {
  const payload = await request("/api/capture/control", {
    method: "POST",
    body: JSON.stringify({ action })
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
  updateVoiceStatus("录音结束，正在交给本地 Faster-Whisper 转写。");

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

    updateVoiceStatus("录音中。点击“停止语音”后会自动转写到输入框。");
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
    updateVoiceStatus("当前浏览器不支持正式语音输入。");
    syncUiState();
    return;
  }

  state.voiceSupported = true;
  updateVoiceStatus("语音输入已接入。录音完成后会写入同一个输入框。");
  syncUiState();
}

async function uploadScreenshot(file) {
  if (!file || state.uploadingImage) {
    return;
  }

  state.uploadingImage = true;
  syncUiState();
  updateImageStatus(`正在分析调试截图：${file.name}`);

  try {
    const imageDataUrl = await blobToDataUrl(file);
    const payload = await request("/api/analyze-image", {
      method: "POST",
      body: JSON.stringify({
        imageDataUrl,
        imageName: file.name
      })
    });

    renderRuntimeState(payload.state);
    updateImageStatus(`调试截图已接入：${file.name}`);
  } catch (error) {
    updateImageStatus(`调试截图分析失败：${error.message}`);
  } finally {
    state.uploadingImage = false;
    elements.screenshotInput.value = "";
    syncUiState();
  }
}

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const instruction = elements.instructionInput.value.trim();

  if (!instruction || state.submitting || state.voice.recording || state.voice.transcribing || state.uploadingImage) {
    return;
  }

  state.submitting = true;
  syncUiState();
  updateVoiceStatus("正在生成这一轮实验。");

  try {
    const payload = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ instruction })
    });

    elements.instructionInput.value = "";
    renderRuntimeState(payload.state);
    updateVoiceStatus("本轮实验完成。");
  } catch (error) {
    updateVoiceStatus(`本轮处理失败：${error.message}`);
    await refresh().catch(() => {});
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

elements.screenshotInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  await uploadScreenshot(file);
});

elements.captureStartButton.addEventListener("click", async () => {
  await sendCaptureControl("start");
});

elements.capturePauseButton.addEventListener("click", async () => {
  await sendCaptureControl("pause");
});

elements.captureTriggerButton.addEventListener("click", async () => {
  await sendCaptureControl("trigger_once");
});

elements.captureStopButton.addEventListener("click", async () => {
  await sendCaptureControl("stop");
});

initVoiceInput();

refresh().catch((error) => {
  updateVoiceStatus(`初始化失败：${error.message}`);
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 5000);
