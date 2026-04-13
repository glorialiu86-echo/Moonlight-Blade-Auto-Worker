const state = {
  revealedThoughts: []
};

const elements = {
  commandForm: document.querySelector("#commandForm"),
  perceptionForm: document.querySelector("#perceptionForm"),
  instructionInput: document.querySelector("#instructionInput"),
  sceneSelect: document.querySelector("#sceneSelect"),
  imageInput: document.querySelector("#imageInput"),
  imagePreview: document.querySelector("#imagePreview"),
  imageHint: document.querySelector("#imageHint"),
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
    return;
  }

  elements.recognizedSceneValue.textContent = `${perception.sceneLabel} (${perception.sceneType})`;
  elements.recognizedSummaryValue.textContent = perception.summary || "-";
  elements.recognizedNpcValue.textContent = perception.npcNames.join(" / ") || "-";
  elements.recognizedOptionsValue.textContent = perception.interactiveOptions.join(" / ") || "-";
  elements.recognizedAlertsValue.textContent = perception.alerts.join(" / ") || "-";
  elements.recognizedOcrValue.textContent = perception.ocrText || "-";
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("读取截图失败"));
    reader.readAsDataURL(file);
  });
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

refresh().catch((error) => {
  window.alert(error.message);
});
