# NPC 原子 Action 规格
状态：执行完成

## 目的

把当前固定剧本真正还在使用的 NPC 社交与潜行相关 action 收敛成一份唯一规格，避免文档继续保留已经撤下的旧 owner。

## 当前仍在使用的核心 action

- `acquire_npc_target`
- `open_npc_action_menu`
- `click_menu_gift`
- `inspect_gift_chat_threshold`
- `resolve_gift_chat_threshold`
- `click_menu_talk`
- `click_menu_small_talk`
- `confirm_small_talk_entry`
- `travel_to_coordinate`
- `enter_stealth_with_retry`

## 已移除的旧 owner

- `retarget_social_target`
- `recover_front_target_visibility`

这两个 action 已不再是固定剧本主链的一部分，也不再保留在当前实现里。

## 社交阶段原子链

1. `acquire_npc_target`
   - 选中当前可交互 NPC
2. `open_npc_action_menu`
   - 点击放大镜/查看，拉起右下角菜单
3. `click_menu_gift`
   - 打开赠礼页
4. `inspect_gift_chat_threshold`
   - 只判断当前好感度上限
5. `resolve_gift_chat_threshold`
   - 按当前门槛执行：
   - `99` 直接结束赠礼处理
   - 其余上限统一送 `10` 个礼物
6. `open_npc_action_menu`
   - 从当前 NPC 重新拉起菜单
7. `click_menu_talk`
8. `click_menu_small_talk`
9. `confirm_small_talk_entry`
   - 成功进入聊天页

## Stage 4 / Stage 5 特例

- Stage 4 `dark_close`
  - 社交类选人只在进入潜行前补一次
  - 成功进入潜行后补一次快捷键 `2`
- Stage 5 `dark_miaoqu`
  - 不走选人 action
  - 直接潜行后妙取

## 保持不变

- 原子 action 的目标仍然是“一次输入，对应一次明确状态推进”
- 固定 UI 点位一旦人工重标完成，继续按相对坐标点击，不再叠加额外控制源
