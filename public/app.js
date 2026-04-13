const state = {
  speechRecognition: null,
  speechSupported: false,
  submitting: false
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

function setVoiceButtons({ listening }) {
  elements.voiceStartButton.disabled = listening || !state.speechSupported || state.submitting;
  elements.voiceStopButton.disabled = !listening || state.submitting;
}

function setSubmitting(submitting) {
  state.submitting = submitting;
  elements.instructionInput.disabled = submitting;
  elements.composerForm.querySelector('button[type="submit"]').disabled = submitting;
  setVoiceButtons({ listening: submitting ? false : false });
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

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    updateVoiceStatus("当前浏览器不支持语音输入 demo。建议用支持 Web Speech API 的浏览器测试。");
    setVoiceButtons({ listening: false });
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = true;
  state.speechRecognition = recognition;
  state.speechSupported = true;
  updateVoiceStatus("语音输入可用。点击“开始语音”后，识别文本会直接写入对话输入框。");
  setVoiceButtons({ listening: false });

  recognition.onstart = () => {
    updateVoiceStatus("语音输入进行中。浏览器正在监听麦克风。");
    elements.voiceStartButton.disabled = true;
    elements.voiceStopButton.disabled = false;
  };

  recognition.onend = () => {
    updateVoiceStatus("语音输入已停止。");
    setVoiceButtons({ listening: false });
  };

  recognition.onerror = (event) => {
    updateVoiceStatus(`语音输入失败：${event.error}`);
    setVoiceButtons({ listening: false });
  };

  recognition.onresult = (event) => {
    let finalText = "";
    let interimText = "";

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const transcript = event.results[index][0]?.transcript || "";

      if (event.results[index].isFinal) {
        finalText += transcript;
      } else {
        interimText += transcript;
      }
    }

    if (finalText) {
      const current = elements.instructionInput.value.trim();
      elements.instructionInput.value = current
        ? `${current}${current.endsWith("。") ? "" : "，"}${finalText}`
        : finalText;
    }

    updateVoiceStatus(interimText ? `语音识别中：${interimText}` : "语音输入进行中。浏览器正在监听麦克风。");
  };
}

elements.composerForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const instruction = elements.instructionInput.value.trim();

  if (!instruction || state.submitting) {
    return;
  }

  setSubmitting(true);
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
    setSubmitting(false);
  }
});

elements.voiceStartButton.addEventListener("click", () => {
  if (!state.speechRecognition || state.submitting) {
    return;
  }

  state.speechRecognition.start();
});

elements.voiceStopButton.addEventListener("click", () => {
  if (!state.speechRecognition || state.submitting) {
    return;
  }

  state.speechRecognition.stop();
});

initSpeechRecognition();

refresh().catch((error) => {
  updateVoiceStatus(`初始化失败：${error.message}`);
});
