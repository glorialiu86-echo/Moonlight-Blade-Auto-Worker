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
    note: "当前先只做潜行链路第一步：打开地图并前往 711,950。"
  },
  talk: {
    key: "talk",
    label: "搭话",
    executorType: "npc_chat_entry_flow",
    availability: "ready",
    note: "我会拆成找目标、拉起查看、点交谈、点闲聊、确认入聊这几步推进。"
  },
  gift: {
    key: "gift",
    label: "送礼",
    executorType: "npc_gift_flow",
    availability: "partial",
    note: "我会拆成找目标、开赠礼页、选礼物、送礼、收面板；当前仍只走固定礼物槽。"
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
    executorType: "npc_trade_flow",
    availability: "partial",
    note: "我会拆成找目标、开交易页、逐步上架左货和右侧支付物，再提交交易。"
  },
  threaten: {
    key: "threaten",
    label: "施压",
    executorType: "npc_chat_entry_flow",
    availability: "partial",
    note: "我现在先只拆到接触目标并进交互链，单独施压动作还没补。"
  },
  steal: {
    key: "steal",
    label: "偷窃",
    executorType: "npc_chat_entry_flow",
    availability: "partial",
    note: "我现在先只拆到接触目标并进交互链，偷窃专属动作还没补完。"
  },
  strike: {
    key: "strike",
    label: "动手",
    executorType: "npc_chat_entry_flow",
    availability: "partial",
    note: "我现在先只拆到接触目标并进交互链，真正的动手链路还在后面补。"
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
