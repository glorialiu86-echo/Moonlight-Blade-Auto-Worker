# NPC 原子 Action 规格
状态：执行到一半

## 目的

把城镇路人 NPC 社交链从复合 action 拆成更细颗粒度的原子 action，作为当前仓库里 NPC 社交执行链的唯一真源。

当前状态说明：

- 代码已经按这份规格拆到新的 worker action
- 还没有在 Windows 真机上逐步验证稳定性
- 本文只覆盖本轮实际落地的 NPC 社交 action

## 分层

### 语义动作层

这一层仍保留给 planner 和固定剧本使用：

- `talk`
- `gift`
- `trade`
- `threaten`
- `steal`
- `strike`

这些语义动作不再直接对应单个输入，而是映射到一组原子 action。

### 原子动作层

这一层才是执行真源。每个 action 只负责一次输入和一次截图验状态。

## 当前状态枚举

- `npc_selected`
- `npc_action_menu`
- `small_talk_menu`
- `small_talk_confirm`
- `chat_ready`
- `gift_screen`
- `steal_screen`
- `trade_screen`
- `none`

## 原子 Action 规格

### `acquire_npc_target`

- 前置状态：`none`、未稳定选中 NPC
- 行为：在预设场景点击点位中逐个探测，验证是否命中 NPC，并在必要时做一次前进脉冲后继续探测
- 成功状态：
  - `npc_selected`
  - `npc_action_menu`
  - `small_talk_menu`
  - `chat_ready`
  - `gift_screen`
  - `trade_screen`
- 失败：超时仍未拿到稳定目标
- 关键输出：
  - `stage`
  - `targetText`
  - `stageHistory`
  - `clickAttempts`
  - `moveAttempts`
  - `clickPointAttempts`
  - `nearbyScanAttempts`
  - `selectionAttempts`
  - `lastClick`

### `open_npc_action_menu`

- 前置状态：`npc_selected` 或已经进入 NPC 交互上下文
- 行为：对已选中目标点击移动中的 `查看`，拉起右下角交互菜单
- 成功状态：
  - `npc_action_menu`
  - `small_talk_menu`
  - `chat_ready`
  - `gift_screen`
  - `trade_screen`
- 失败：无法从当前选中目标拉起交互上下文
- 关键输出：
  - `stage`
  - `targetText`
  - `viewAttempts`

### `click_menu_talk`

- 前置状态：`npc_action_menu`
- 行为：点击右下角 `交谈`
- 成功状态：
  - `small_talk_menu`
  - `chat_ready`
- 失败：点击后仍未进入 `small_talk_menu` 或 `chat_ready`
- 关键输出：
  - `stage`
  - `click`
  - `dialogText`

### `click_menu_small_talk`

- 前置状态：`small_talk_menu`
- 行为：点击 `闲聊`
- 成功状态：
  - `small_talk_confirm`
  - `chat_ready`
- 失败：点击后既没有确认弹窗，也没有进入聊天页
- 关键输出：
  - `stage`
  - `click`
  - `dialogText`

### `confirm_small_talk_entry`

- 前置状态：`small_talk_confirm`
- 行为：点击闲聊确认按钮
- 成功状态：`chat_ready`
- 失败：确认后仍未进入聊天页
- 关键输出：
  - `stage`
  - `click`
  - `dialogText`

### `click_menu_gift`

- 前置状态：`npc_action_menu`
- 行为：点击 `赠礼`
- 成功状态：`gift_screen`
- 失败：点击后未进入赠礼页
- 关键输出：
  - `stage`
  - `click`

### `select_gift_first_slot`

- 前置状态：`gift_screen`
- 行为：点击当前固定礼物槽位
- 成功状态：仍为 `gift_screen`
- 失败：点击后离开赠礼页
- 关键输出：
  - `stage`
  - `click`

### `submit_gift_once`

- 前置状态：`gift_screen`
- 行为：点击一次 `赠送`
- 成功状态：仍为 `gift_screen`
- 失败：点击后离开赠礼页
- 关键输出：
  - `stage`
  - `click`
  - `favorBefore`
  - `favorAfter`

### `click_menu_trade`

- 前置状态：`npc_action_menu`
- 行为：点击 `交易`
- 成功状态：`trade_screen`
- 失败：点击后未进入交易页
- 关键输出：
  - `stage`
  - `click`

### `trade_select_left_item_tab`

- 前置状态：`trade_screen`
- 行为：点击左侧货栏页签
- 成功状态：仍为 `trade_screen`
- 失败：点击后离开交易页
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `trade_select_left_item`

- 前置状态：`trade_screen`
- 行为：点击左侧待交易物品
- 成功状态：仍为 `trade_screen`
- 失败：点击后离开交易页
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `trade_left_item_up_shelf`

- 前置状态：`trade_screen`
- 行为：点击左侧 `上架`
- 成功状态：仍为 `trade_screen`
- 失败：点击后离开交易页
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `trade_select_right_money_slot`

- 前置状态：`trade_screen`
- 行为：点击右侧支付物槽位
- 成功状态：仍为 `trade_screen`
- 失败：点击后离开交易页
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `trade_scale_quantity`

- 前置状态：`trade_screen`
- 行为：点击数量调整控件
- 成功状态：仍为 `trade_screen`
- 失败：点击后离开交易页
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `trade_right_item_up_shelf`

- 前置状态：`trade_screen`
- 行为：点击右侧 `上架`
- 成功状态：仍为 `trade_screen`
- 失败：点击后离开交易页
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `trade_submit`

- 前置状态：`trade_screen`
- 行为：点击底部 `交易`
- 成功状态：允许仍在 `trade_screen`，也允许进入交易后的其他稳定状态
- 失败：输入后发生异常中断
- 关键输出：
  - `stage`
  - `pointName`
  - `click`

### `click_steal_button`

- 前置状态：`steal_screen`
- 行为：点击右侧列表中的固定金色 `妙取` 按钮
- 成功状态：离开 `steal_screen`
- 失败：点击后仍停留在 `steal_screen`
- 关键输出：
  - `stage`
  - `beforeText`
  - `pointName`
  - `buttonIndex`
  - `click`

### `close_current_panel`

- 前置状态：
  - `chat_ready`
  - `gift_screen`
  - `trade_screen`
  - `npc_action_menu`
  - `small_talk_menu`
  - `small_talk_confirm`
- 行为：点击右上角关闭按钮，等待界面收起
- 成功状态：离开原先面板态
- 失败：关闭后仍停留在原面板态
- 关键输出：
  - `beforeStage`
  - `stage`
  - `closeTriggered`

## 语义动作到原子动作的映射

### `talk`

按顺序映射为：

1. `acquire_npc_target`
2. `open_npc_action_menu`
3. `click_menu_talk`
4. `click_menu_small_talk`
5. `confirm_small_talk_entry`

### `gift`

按顺序映射为：

1. `acquire_npc_target`
2. `open_npc_action_menu`
3. `click_menu_gift`
4. `select_gift_first_slot`
5. `submit_gift_once`
6. `select_gift_first_slot`
7. `submit_gift_once`
8. `close_current_panel`

### `trade`

按顺序映射为：

1. `acquire_npc_target`
2. `open_npc_action_menu`
3. `click_menu_trade`
4. `trade_select_left_item_tab`
5. `trade_select_left_item`
6. `trade_left_item_up_shelf`
7. `trade_select_right_money_slot`
8. `trade_scale_quantity`
9. `trade_right_item_up_shelf`
10. `trade_submit`
11. `close_current_panel`

### `steal`

按顺序映射为：

1. `press_shortcut(steal -> 4)`
2. `click_steal_button`

说明：

- 这一层只覆盖 `4 -> 金色妙取按钮`。
- `潜行(2)`、靠近目标、再次按 `4` 开下一轮，都不归 `steal` 这个语义动作接管。

### `threaten / strike`

当前仍临时复用 `talk` 同一套“接触目标并推进交互链”的原子动作序列。

这只是保持当前系统可运行的过渡态，不代表最终语义正确。

## 当前没改的部分

- 地图 action
- 货商购买 action
- 叫卖 action
- 潜行 action
- NPC 聊天页内的 `输入 / 发送 / 退出` 细拆

这些都不在本轮改动范围内。
