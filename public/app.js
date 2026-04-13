const state = {
  submitting: false,
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
  instructionInput: document.querySelector("#instructionInput"),
  messageList: document.querySelector("#messageList"),
  voiceStartButton: document.querySelector("#voiceStartButton"),
  voiceStopButton: document.querySelector("#voiceStopButton"),
  voiceStatus: document.querySelector("#voiceStatus"),
  userMessageTemplate: document.querySelector("#userMessageTemplate"),
  assistantMessageTemplate: document.querySelector("#assistantMessageTemplate"),
  actionTemplate: document.querySelector("#actionTemplate")
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

function syncUiState() {
  const { recording, transcribing } = state.voice;
  const busy = state.submitting || transcribing;
  elements.instructionInput.disabled = busy;
  elements.composerForm.querySelector('button[type="submit"]').disabled = busy || recording;
  elements.voiceStartButton.disabled = !state.voiceSupported || busy || recording;
  elements.voiceStopButton.disabled = !recording;
}

function scrollMessagesToBottom() {
  elements.messageList.scrollTop = elements.messageList.scrollHeight;
}

function renderEmptyState() {
  elements.messageList.innerHTML = `
    <article class="message message-assistant empty-state">
      <div class="message-role">AI 助手</div>
      <p class="message-text">可以直接开始对话。当前只验证文字 / 语音输入、AI 回复、思考链条和动作规划。</p>
      <p class="message-meta">当前只保留对话框，不暴露手动截图、场景切换或控制按钮；截图识别会在后续 Windows 链路里再接入。</p>
    </article>
  `;
}

function renderAssistantMessage(message) {
  const node = elements.assistantMessageTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".message-text").textContent = message.text || "本轮暂无回复。";
  node.querySelector(".message-meta").textContent = `环境：${message.sceneLabel || "未判定"} | 风险：${message.riskLevel || "-"}`;
  node.querySelector(".message-perception").textContent = message.perceptionSummary || "未挂上截图识别结果。";

  const thinkingBlock = node.querySelector('[data-block="thinking"]');
  const actionBlock = node.querySelector('[data-block="actions"]');
  const thinkingList = node.querySelector(".thinking-list");
  const actionList = node.querySelector(".action-list");

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
      actionNode.querySelector(".action-detail").textContent = action.detail || "";
      actionList.appendChild(actionNode);
    });
  } else {
    actionBlock.hidden = true;
  }

  return node;
}

function renderUserMessage(message) {
  const node = elements.userMessageTemplate.content.firstElementChild.cloneNode(true);
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

async function refresh() {
  const payload = await request("/api/state");
  renderMessages(payload.state.messages);
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
    reader.onerror = () => reject(new Error("录音文件读取失败"));
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
  updateVoiceStatus("录音结束，正在上传到服务端做语音转写。");

  try {
    const pcmChunks = [...state.voice.pcmChunks];
    const inputSampleRate = state.voice.inputSampleRate;
    await releaseVoiceCapture();
    state.voice.pcmChunks = [];

    if (pcmChunks.length === 0) {
      throw new Error("未采集到有效语音，请重试。");
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

    updateVoiceStatus("录音中。再次点击“停止语音”后，会把录音上传到服务端转写。");
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
    updateVoiceStatus("当前浏览器不支持正式语音输入。需要麦克风权限、MediaDevices 和 Web Audio API。");
    syncUiState();
    return;
  }

  state.voiceSupported = true;
  updateVoiceStatus("语音输入已正式接入。点击“开始语音”录音，停止后会调用服务端转写。");
  syncUiState();
}

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const instruction = elements.instructionInput.value.trim();

  if (!instruction || state.submitting || state.voice.recording || state.voice.transcribing) {
    return;
  }

  state.submitting = true;
  syncUiState();
  updateVoiceStatus("正在处理本轮对话。");

  try {
    const payload = await request("/api/chat", {
      method: "POST",
      body: JSON.stringify({ instruction })
    });

    elements.instructionInput.value = "";
    renderMessages(payload.state.messages);
    updateVoiceStatus("本轮处理完成，可以继续输入文字或语音。");
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

initVoiceInput();

refresh().catch((error) => {
  updateVoiceStatus(`初始化失败：${error.message}`);
});
