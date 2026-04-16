export const ACTION_REGISTRY = {
  sale: {
    key: "sale",
    label: "叫卖赚钱",
    executorType: "primitive_sequence",
    availability: "ready",
    note: "我会按整条固定链路执行：开地图、找货商、进货、去大街、上货出摊。"
  },
  stealth: {
    key: "stealth",
    label: "潜行起手",
    executorType: "primitive_sequence",
    availability: "partial",
    note: "当前先只做潜行链路第一步：打开地图并前往 708,912。"
  },
  talk: {
    key: "talk",
    label: "搭话",
    executorType: "town_npc_social_loop",
    availability: "ready",
    note: "我能主动找路人搭话，把聊天页先顶出来。"
  },
  gift: {
    key: "gift",
    label: "送礼",
    executorType: "click_npc_interact",
    availability: "partial",
    note: "我能先顶到交互页，但整条送礼链还要继续补。"
  },
  inspect: {
    key: "inspect",
    label: "观察",
    executorType: "focus_window",
    availability: "ready",
    note: "我能先稳住窗口，把视角和注意力对准当前局面。"
  },
  trade: {
    key: "trade",
    label: "交易",
    executorType: "click_npc_interact",
    availability: "partial",
    note: "我能先摸到交易入口，完整交易路径还要继续打磨。"
  },
  threaten: {
    key: "threaten",
    label: "施压",
    executorType: "click_npc_interact",
    availability: "partial",
    note: "我现在只能借交互链试探推进，单独施压动作还没拆开。"
  },
  steal: {
    key: "steal",
    label: "偷窃",
    executorType: "click_npc_interact",
    availability: "partial",
    note: "我能先接近并打开交互，但偷窃专属路径还没补完。"
  },
  strike: {
    key: "strike",
    label: "动手",
    executorType: "click_npc_interact",
    availability: "partial",
    note: "我能先接触目标，真正的闷棍链路还在后面补。"
  },
  escape: {
    key: "escape",
    label: "抽身",
    executorType: "press_key",
    availability: "ready",
    note: "我能直接按退路，先把自己从当前局面里抽出来。"
  },
  wait: {
    key: "wait",
    label: "按住",
    executorType: "sleep",
    availability: "ready",
    note: "我能先停一下，给后续动作留观察窗口。"
  }
};

export const ALLOWED_ACTIONS = Object.keys(ACTION_REGISTRY);

export function getActionDefinition(actionKey) {
  return ACTION_REGISTRY[actionKey] || null;
}

export function getActionDefinitions(actionKeys = []) {
  return actionKeys
    .map((actionKey) => getActionDefinition(actionKey))
    .filter(Boolean);
}

export function buildActionCatalog() {
  return ALLOWED_ACTIONS.map((actionKey) => ACTION_REGISTRY[actionKey]);
}
