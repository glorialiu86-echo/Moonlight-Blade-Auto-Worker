const state = {
  revealedThoughts: [],
  recognition: null,
  speechRecognition: null,
  speechSupported: false
};

const elements = {
  commandForm: document.querySelector("#commandForm"),
  perceptionForm: document.querySelector("#perceptionForm"),
  instructionInput: document.querySelector("#instructionInput"),
  sceneSelect: document.querySelector("#sceneSelect"),
  imageInput: document.querySelector("#imageInput"),
  imagePreview: document.querySelector("#imagePreview"),
  imageHint: document.querySelector("#imageHint"),
  voiceStartButton: document.querySelector("#voiceStartButton"),
  voiceStopButton: document.querySelector("#voiceStopButton"),
  voiceStatus: document.querySelector("#voiceStatus"),
  adoptSceneButton: document.querySelector("#adoptSceneButton"),
  statusBadge: document.querySelector("#statusBadge"),
  sceneBadge: document.querySelector("#sceneBadge"),
  thoughtList: document.querySelector("#thoughtList"),
  intentValue: document.querySelector("#intentValue"),
  environmentValue: document.querySelector("#environmentValue"),
  strategiesValue: document.querySelector("#strategiesValue"),
  selectedStrategyValue: document.querySelector("#selectedStrategyValue"),
  riskValue: document.querySelector("#riskValue"),
  executorValue: document.querySelector("#executorValue"),
  actionsList: document.querySelector("#actionsList"),
  outcomeValue: document.querySelector("#outcomeValue"),
  recognizedSceneValue: document.querySelector("#recognizedSceneValue"),
  recognizedSummaryValue: document.querySelector("#recognizedSummaryValue"),
  recognizedNpcValue: document.querySelector("#recognizedNpcValue"),
  recognizedOptionsValue: document.querySelector("#recognizedOptionsValue"),
  recognizedAlertsValue: document.querySelector("#recognizedAlertsValue"),
  recognizedOcrValue: document.querySelector("#recognizedOcrValue"),
  logList: document.querySelector("#logList"),
  thoughtTemplate: document.querySelector("#thoughtTemplate"),
  actionTemplate: document.querySelector("#actionTemplate"),
  logTemplate: document.querySelector("#logTemplate")
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

function formatTime(isoString) {
  return new Date(isoString).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function renderStatus(runtimeState) {
  elements.statusBadge.textContent = runtimeState.status;
  elements.statusBadge.className = `badge badge-${runtimeState.status}`;
  elements.sceneBadge.textContent = runtimeState.scene;
  elements.sceneBadge.className = "badge badge-scene";
  elements.sceneSelect.value = runtimeState.scene;

  const turn = runtimeState.currentTurn;
  const perception = runtimeState.latestPerception;
  state.recognition = perception;

  renderPerception(perception);

  if (!turn) {
    elements.intentValue.textContent = "等待指令";
    elements.environmentValue.textContent = "等待输入";
    elements.strategiesValue.textContent = "-";
    elements.selectedStrategyValue.textContent = "-";
    elements.riskValue.textContent = runtimeState.lastError || "-";
    elements.executorValue.textContent = "MockExecutor";
    elements.actionsList.innerHTML = "";
    elements.outcomeValue.textContent = "等待计划生成";
    elements.thoughtList.innerHTML = "";
    return;
  }

  const { plan, execution } = turn;
  elements.intentValue.textContent = plan.intent;
  elements.environmentValue.textContent = plan.environment;
  elements.strategiesValue.textContent = plan.candidateStrategies.join(" / ");
  elements.selectedStrategyValue.textContent = plan.selectedStrategy;
  elements.riskValue.textContent = plan.riskLevel;
  elements.executorValue.textContent = execution.executor;
  elements.outcomeValue.textContent = execution.outcome;

  renderThoughts(plan.thinkingChain);
  renderActions(execution.steps);
}

function renderPerception(perception) {
  if (!perception) {
    elements.recognizedSceneValue.textContent = "未分析";
    elements.recognizedSummaryValue.textContent = "等待上传截图";
    elements.recognizedNpcValue.textContent = "-";
    elements.recognizedOptionsValue.textContent = "-";
    elements.recognizedAlertsValue.textContent = "-";
    elements.recognizedOcrValue.textContent = "-";
    elements.adoptSceneButton.disabled = true;
    return;
  }

  elements.recognizedSceneValue.textContent = `${perception.sceneLabel} (${perception.sceneType})`;
  elements.recognizedSummaryValue.textContent = perception.summary || "-";
  elements.recognizedNpcValue.textContent = perception.npcNames.join(" / ") || "-";
  elements.recognizedOptionsValue.textContent = perception.interactiveOptions.join(" / ") || "-";
  elements.recognizedAlertsValue.textContent = perception.alerts.join(" / ") || "-";
  elements.recognizedOcrValue.textContent = perception.ocrText || "-";
  elements.adoptSceneButton.disabled = ![
    "town_dialogue",
    "bag_management",
    "market_trade",
    "jail_warning",
    "field_patrol"
  ].includes(perception.sceneType);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取截图失败"));
    reader.readAsDataURL(file);
  });
}

function updateVoiceStatus(message) {
  elements.voiceStatus.textContent = message;
}

function setVoiceButtons({ listening }) {
  elements.voiceStartButton.disabled = listening || !state.speechSupported;
  elements.voiceStopButton.disabled = !listening;
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    updateVoiceStatus("当前浏览器不支持语音输入 demo。建议在支持 Web Speech API 的浏览器中测试。");
    setVoiceButtons({ listening: false });
    return;
  }

  const recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = true;
  state.speechRecognition = recognition;
  state.speechSupported = true;
  updateVoiceStatus("语音输入可用。点击“开始语音输入”后，可把识别文字写入指令框。");
  setVoiceButtons({ listening: false });

  recognition.onstart = () => {
    updateVoiceStatus("语音输入进行中。浏览器正在监听麦克风。");
    setVoiceButtons({ listening: true });
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
      elements.instructionInput.value = current ? `${current}${current.endsWith("。") ? "" : "，"}${finalText}` : finalText;
    }

    updateVoiceStatus(interimText ? `语音识别中：${interimText}` : "语音输入进行中。浏览器正在监听麦克风。");
  };
}

function renderThoughts(thoughts) {
  elements.thoughtList.innerHTML = "";
  state.revealedThoughts = [];

  thoughts.forEach((thought, index) => {
    window.setTimeout(() => {
      const node = elements.thoughtTemplate.content.firstElementChild.cloneNode(true);
      node.textContent = thought;
      node.style.animationDelay = `${index * 120}ms`;
      elements.thoughtList.appendChild(node);
    }, index * 180);
  });
}

function renderActions(actions) {
  elements.actionsList.innerHTML = "";

  actions.forEach((action) => {
    const node = elements.actionTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector(".action-type").textContent = action.status;
    node.querySelector(".action-title").textContent = action.title;
    node.querySelector(".action-detail").textContent = action.detail;
    elements.actionsList.appendChild(node);
  });
}

function renderLogs(logs) {
  elements.logList.innerHTML = "";

  logs.forEach((log) => {
    const node = elements.logTemplate.content.firstElementChild.cloneNode(true);
    const levelNode = node.querySelector(".log-level");
    levelNode.textContent = log.level;
    levelNode.dataset.level = log.level;
    node.querySelector(".log-time").textContent = formatTime(log.timestamp);
    node.querySelector(".log-message").textContent = log.message;
    elements.logList.appendChild(node);
  });
}

async function refresh() {
  const payload = await request("/api/state");
  renderStatus(payload.state);
  renderLogs(payload.state.logs);
}

elements.commandForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const instruction = elements.instructionInput.value.trim();
  const scene = elements.sceneSelect.value;

  if (!instruction) {
    return;
  }

  try {
    const payload = await request("/api/turn", {
      method: "POST",
      body: JSON.stringify({ instruction, scene })
    });

    renderStatus(payload.state);
    renderLogs(payload.state.logs);
  } catch (error) {
    window.alert(error.message);
    await refresh();
  }
});

elements.imageInput.addEventListener("change", async () => {
  const file = elements.imageInput.files?.[0];

  if (!file) {
    elements.imagePreview.hidden = true;
    elements.imageHint.textContent = "尚未选择截图。建议上传当前游戏窗口截图。";
    return;
  }

  const dataUrl = await readFileAsDataUrl(file);
  elements.imagePreview.src = dataUrl;
  elements.imagePreview.hidden = false;
  elements.imageHint.textContent = `已选择：${file.name}`;
});

elements.perceptionForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = elements.imageInput.files?.[0];

  if (!file) {
    window.alert("请先选择一张截图。");
    return;
  }

  try {
    const imageDataUrl = await readFileAsDataUrl(file);
    const payload = await request("/api/analyze-image", {
      method: "POST",
      body: JSON.stringify({
        imageName: file.name,
        imageDataUrl
      })
    });

    renderStatus(payload.state);
    renderLogs(payload.state.logs);
  } catch (error) {
    window.alert(error.message);
    await refresh();
  }
});

elements.adoptSceneButton.addEventListener("click", () => {
  const sceneType = state.recognition?.sceneType;

  if (!sceneType) {
    return;
  }

  const option = Array.from(elements.sceneSelect.options).find((item) => item.value === sceneType);

  if (!option) {
    window.alert("当前识别场景不在可用场景列表内。");
    return;
  }

  elements.sceneSelect.value = sceneType;
  updateVoiceStatus(`已采用识别场景：${option.textContent}`);
});

elements.voiceStartButton.addEventListener("click", () => {
  if (!state.speechRecognition) {
    return;
  }

  state.speechRecognition.start();
});

elements.voiceStopButton.addEventListener("click", () => {
  if (!state.speechRecognition) {
    return;
  }

  state.speechRecognition.stop();
});

document.querySelectorAll("[data-control]").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      const payload = await request("/api/control", {
        method: "POST",
        body: JSON.stringify({
          action: button.dataset.control,
          scene: elements.sceneSelect.value
        })
      });

      renderStatus(payload.state);
      renderLogs(payload.state.logs);
    } catch (error) {
      window.alert(error.message);
      await refresh();
    }
  });
});

initSpeechRecognition();

refresh().catch((error) => {
  window.alert(error.message);
});
