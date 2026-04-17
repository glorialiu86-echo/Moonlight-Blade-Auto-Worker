# 固定剧本自动化流程
状态：执行完成

## 目标

把自动化主流程收敛为固定剧本链，不再让 LLM 决定主动作顺序。

前端只展示像“正在思考并决定下一步”一样的消息流，但真实控制源在后端固定剧本。

## 唯一真源

- 用户必须通过前端说出触发词 `加油`
- 后端只回一条承接消息，不立即执行动作
- 后端等待固定延时后，按既定剧本依次推进
- 每一轮都先输出一段思考，再执行动作，再输出本轮结果
- 用户一旦发生人工输入，自动化立即暂停
- 固定剧本按 `stage key` 走专用执行器，不再统一复用手动回合的通用 plan 展开
- 若某一轮动作链卡住，前端不再插入失败台词；只让三角恢复按钮进入红色告警态，并执行按失败码构造的恢复动作队列

## 固定剧本

1. 正常思考，执行 `买货 -> 叫卖`，循环 `3` 轮
2. 正常思考，执行 `交易/买礼物 -> 赠礼 -> 交谈 -> 套话`，循环 `2` 轮
3. 黑化思考，执行 `交易/买礼物 -> 赠礼 -> 交谈 -> 套话`，循环 `2` 轮
4. 黑化思考，执行 `潜行 -> 闷棍 -> 扛走 -> 搜刮`，循环 `3` 次
5. 黑化思考，执行 `潜行 -> 妙取 -> 脱离 -> 退出潜行`，循环 `5` 次
6. 正常思考，执行 `随便找个路人 -> 交易 -> 连续上架 10 个道具 -> 提交交易 -> 回到街道`，循环 `1` 次

说明：

- 第三段与第二段的动作链保持一致，变化的是思考文案与聊天语气
- 第二段和第三段的社交链现在固定为同一目标 owner：首次拿人继续扫圈，聊天门槛暴露后才换人，`Tab` 只负责换到新的“可查看”目标
- 第四段不再依赖旧的 `stealth -> strike -> steal` 通用映射，而是固定执行 `travel_to_coordinate -> enter_stealth_with_retry -> stealth_front_arc_strike -> stealth_carry_target -> stealth_backstep_target -> stealth_drop_target -> stealth_open_loot -> loot_select_item_once/loot_put_in_once -> loot_submit_once`
- 第四段里的 `闷棍` 当前按“只要选中人就直接放倒”来设计，但它本身疑似存在按小时计的使用次数限制；准确预算还没锁定，需等技术确认后再把次数限制写死进链路
- 第五段是独立妙取链，固定执行 `travel_to_coordinate -> recover_front_target_visibility -> enter_stealth_with_retry -> acquire_npc_target(只要查看按钮) -> stealth_trigger_miaoqu(4) -> click_fixed_steal_button_and_escape -> exit_stealth`
- 第六段是收尾卖货链，固定执行 `acquire_npc_target -> open_npc_action_menu -> click_menu_trade -> trade_prepare_gift_bundle(10) -> trade_select_right_money_slot -> trade_scale_quantity -> trade_right_item_up_shelf -> trade_submit -> close_current_panel`
- 不允许前端展示“当前阶段 / 当前轮次 / 倒计时 / 固定剧本编号”
- 前端只允许看到人格化思考、执行结果、暂停和完成状态

## 当前实现边界

- 主流程 owner 已切到后端固定剧本 runner
- `api/chat` 只有在指令命中触发词 `加油` 时才会布置整套任务
- 旧 planner 仍保留给独立调试入口使用，不再负责自主自动化主链路
- 真正的游戏窗口截图与输入执行仍由 Windows 链路负责
- 地图寻路 owner 已收敛到 `travel_to_coordinate`，它负责开图、填坐标、前往、关图、小地图坐标校验和 reroute
- 社交恢复默认按失败码收敛：
  - `NPC_CHAT_THRESHOLD_REVEALED` 时换人后重跑 `赠礼 -> 聊天`
  - `NPC_VIEW_NOT_OPENED` 时根据失败位置决定重跑整段社交链或只跑恢复链
- 社交阶段进入聊天页后的后置自动回复，如在发送回复时失败，也会进入红三角恢复态；恢复时不重跑整段社交链，而是从当前聊天页继续续聊
- 潜行恢复默认按失败码收敛：
  - `STEALTH_ENTRY_BLOCKED` 会在 action 内原地重试 `5` 次后停下
  - `STEALTH_ALERTED` / `STEALTH_TARGET_RECOVERED` 会先 `hold S >= 3000ms`，再在固定剧本内有限次重开
- `妙取` 已从固定剧本第四段拆出，不再跟在闷棍后面硬接
- 独立妙取链不做 OCR 选 `1.0 秒`；拉起面板后直接盲点固定金色按钮，并在 `1.2s` 后执行一次短按 `S` 加一次长按 `S`
- 独立妙取链确认面板已拉起时，优先只看右侧固定区域里的金色 `妙取` 按钮栈；只有固定 UI 快检没命中时，才退回 `trade_panel` OCR 兜底
- 独立妙取链在进入潜行前新增遮挡恢复 owner：若普通场景下既没有 `查看` 也看不到前方名字，就先滚轮放大，再小幅左右转；仍未脱离遮挡时只进入失败恢复态，让三角按钮变红，不额外吐失败台词
- 全部主链结束后，固定剧本不再用通用“做完了”收尾，而是进入“任务完成、赚到钱、等籽岷回来验收”的完成文案
