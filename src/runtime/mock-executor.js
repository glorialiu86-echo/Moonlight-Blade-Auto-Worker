function actionVerb(action) {
  const map = {
    talk: "打开交互并发起对话",
    gift: "检查背包并准备赠礼",
    inspect: "确认目标状态与周边风险",
    trade: "尝试进入交易流程",
    threaten: "切换到威慑路径并观察反馈",
    steal: "寻找可下手窗口并压低暴露风险",
    strike: "准备一次强刺激行为",
    escape: "退出高风险区域并脱离视野",
    wait: "短暂停留等待状态变化"
  };

  return map[action] || "执行通用交互动作";
}

function outcomeByRisk(riskLevel) {
  if (riskLevel === "high") {
    return "高风险动作被模拟执行，系统建议主播随时准备人工接管。";
  }

  if (riskLevel === "medium") {
    return "动作完成，系统保持观察以确认是否需要切换策略。";
  }

  return "动作完成，当前路径稳定，适合继续推进。";
}

export function runMockExecution(plan) {
  const steps = plan.actions.map((action, index) => ({
    id: `mock-${index + 1}`,
    title: action.title,
    detail: `${actionVerb(action.type)}：${action.reason}`,
    status: "simulated"
  }));

  return {
    executor: "MockExecutor",
    steps,
    outcome: outcomeByRisk(plan.riskLevel)
  };
}
