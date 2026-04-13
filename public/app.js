const state = {
  revealedThoughts: []
};

const elements = {
  commandForm: document.querySelector("#commandForm"),
  instructionInput: document.querySelector("#instructionInput"),
  sceneSelect: document.querySelector("#sceneSelect"),
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
