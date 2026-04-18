# NPC 原子 Action 规格
状态：执行完成

## 目的

把城镇路人 NPC 社交链从复合 action 拆成更细颗粒度的原子 action，作为当前仓库里 NPC 社交执行链的唯一真源。

当前状态说明：

- 代码已经按这份规格拆到新的 worker action
- 还没有在 Windows 真机上逐步验证稳定性
- 本文本轮补齐了固定剧本用到的社交承接、地图 travel owner 和潜行恢复 action

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

本轮新增的固定剧本关键 action：

- `retarget_social_target`
- `travel_to_coordinate`
- `enter_stealth_with_retry`
- `recover_front_target_visibility`

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

### `recover_front_target_visibility`

- 前置状态：普通场景、准备重新选人，当前既没有 `查看` 也没有稳定选中目标
- 行为：先检查前方名字带是否还能看到可用名字；若已经能看到，则不做额外动作；若完全被树木或建筑遮挡，则先滚轮放大，再按预算做小幅左右转
- 成功状态：
  - 已出现 `查看`
  - 或已经稳定选中目标
  - 或前方名字带重新出现可用名字
- 失败：多轮 `滚轮放大 + 小幅转向` 后仍然看不到前方名字，抛出 `NPC_TARGET_OCCLUDED`
- 关键输出：
  - `stage`
  - `targetText`
  - `frontNameCandidates`
  - `retryLimit`
  - `attempts`

### `open_npc_action_menu`

- 前置状态：`npc_selected` 或已经进入 NPC 交互上下文
- 行为：对已选中目标点击移动中的 `查看`，只围绕当前目标局部锚点重试，拉起右下角交互菜单
- 成功状态：
  - `npc_action_menu`
  - `small_talk_menu`
  - `chat_ready`
  - `gift_screen`
  - `trade_screen`
- 失败：3 次局部重试后仍无法从当前选中目标拉起交互上下文，抛出 `NPC_VIEW_NOT_OPENED`
- 关键输出：
  - `stage`
  - `targetText`
  - `viewAttempts`

### `retarget_social_target`

- 前置状态：社交链已经决定放弃当前目标
- 行为：`按一次 Tab，看一次`，最多 `5 + 扰动 + 5`
- 成功状态：
  - `npc_selected`
  - 或 `look_button` 出现 `查看`
  - 或已经回到 `npc_action_menu` / `small_talk_menu` / `chat_ready` / `gift_screen` / `trade_screen`
- 失败：预算耗尽仍未切到可查看目标，抛出 `NPC_TARGET_SWITCH_FAILED`
- 关键输出：
  - `attempts`
  - `retryCount`
  - `perturbation`

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
- 失败：
  - 若弹出好感门槛文案，抛出 `NPC_CHAT_THRESHOLD_REVEALED`
  - 其他异常仍视为普通失败
- 关键输出：
  - `stage`
  - `click`
  - `dialogText`
  - `requiredFavor`

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

### `trade_prepare_gift_bundle`

- 前置状态：`trade_screen`
- 行为：切到固定礼物页签，并连续执行多轮 `选中礼物 -> 上架`
- 成功状态：仍为 `trade_screen`
- 失败：任一轮离开交易页
- 关键输出：
  - `repeatCount`
  - `categoryClick`
  - `rounds`
  - `stageHistory`

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
- 失败：妙取面板消失或按钮点击后仍停留在 `steal_screen`，抛出 `STEALTH_TARGET_RECOVERED`
- 关键输出：
  - `stage`
  - `beforeText`
  - `pointName`
  - `buttonIndex`
  - `click`

说明：

- 这个动作当前仍保留给独立妙取链使用。
- 固定剧本第四段已经不再把它挂在闷棍后面。

### `click_fixed_steal_button_and_escape`

- 前置状态：`steal_screen`
- 行为：盲点固定一条金色 `妙取` 按钮，然后等待 `1.2s`
- 面板确认：优先用右侧固定金色按钮栈做快检；只有快检没命中时，才退回 `trade_panel` OCR
- 成功状态：在撤离节奏内抓到 `妙取成功` 文案，或读到妙取面板内容发生变化
- 失败：不在 `steal_screen` 时启动，或撤离结束前未确认 `妙取成功`，抛出 `STEALTH_TARGET_RECOVERED`
- 关键输出：
  - `stage`
  - `beforeText`
  - `afterText`
  - `successBannerText`
  - `buttonIndex`
  - `pointName`
  - `click`
  - `escapeDelayMs`
  - `shortBackstepMs`
  - `longBackstepMs`

### `travel_to_coordinate`

- 前置状态：城镇或可开图状态
- 行为：统一负责开图、输入坐标、前往、必要确认、关图和 travel watchdog
- 成功状态：小地图坐标与目标坐标横纵偏差都在 `±5`
- 失败：自动 reroute `2` 次后仍未到达，抛出 `ROUTE_STALLED`
- 关键输出：
  - `targetCoordinate`
  - `currentCoordinate`
  - `coordinateTolerance`
  - `attempts`

### `enter_stealth_with_retry`

- 前置状态：潜行 stage 已到位
- 行为：原地反复尝试拉起潜行，不额外后撤
- 成功状态：固定 `退出潜行` 按钮出现
- 失败：连续 `5` 次仍未进入潜行，抛出 `STEALTH_ENTRY_BLOCKED`
- 关键输出：
  - `retryCount`
  - `attempts`

### `stealth_front_arc_strike`

- 前置状态：已进入潜行
- 行为：不再搜索前方目标，也不先点人；在点位附近直接连续按 `3`，让游戏自动吃附近目标
- 成功状态：进入击倒上下文
- 失败：未进入击倒上下文即结束攻击窗口，抛出 `STEALTH_ALERTED`
- 关键输出：
  - `knockoutTimeoutMs`
  - `retryPressMs`
  - `strikeCount`
  - `knockoutText`

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
- 固定剧本第五段使用的是更强约束的独立妙取链，不直接复用这里的语义动作映射。

### `threaten / strike`

当前仍临时复用 `talk` 同一套“接触目标并推进交互链”的原子动作序列。

这只是保持当前系统可运行的过渡态，不代表最终语义正确。

### `align_named_vendor_interact_prompt`

- 前置状态：已跑到货商点位并下马
- 行为：通过小幅转镜头加轻按 `W` 贴近，直到右下角出现 `对话[F]`
- 成功状态：`对话[F]` 可见
- 失败：多轮调整后仍未出现 `对话[F]`
- 关键输出：
  - `dragHistory`
  - `forwardHistory`
  - `promptHistory`

### `open_named_vendor_purchase`

- 前置状态：右下角已经出现 `对话[F]`
- 行为：按 `F`，优先 OCR 命中 `我来进些货物`，命不中时再回退到固定点位，直到拉起 `进货` 页
- 成功状态：进入 `vendor_purchase_screen`
- 失败：`F` 与 `我来进些货物` 选择后仍未进入进货页

### `buy_current_vendor_item`

- 前置状态：已进入 `进货` 页
- 行为：优先按文字命中 `墨锭`，再点最大化、购买、关闭
- 成功状态：购买动作已提交且面板已关闭
- 失败：当前页不是 `进货` 页，或固定商品不受支持

## 当前没改的部分

- 地图 action
- 叫卖 action
- NPC 聊天页内的 `输入 / 发送 / 退出` 细拆

这些都不在本轮改动范围内。
