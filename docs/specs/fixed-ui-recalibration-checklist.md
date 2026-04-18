状态：执行到一半

# 固定 UI 待重标清单

这份清单只整理当前代码里“固定写死坐标”的点位，方便后续逐项重标。

## 本轮视频复标结果

本轮依据桌面 6 个视频做了人工复核与二次叠图检查。

double check 方法：

- 先把桌面视频复制成 ASCII 临时文件名
- 抽关键帧
- 把当前固定点位叠到关键帧上
- 对明显偏移的点位直接回写
- 回写后再次叠图复核
- 对货商买货、叫卖、交易、赠礼、社交菜单、退出潜行做了至少一轮二次叠图检查

当前结论：

- 地图链路：已排除，不在本轮重标范围
- 已根据视频回写一批固定点
- 仍有少量点位证据不足，只做了复核，没有硬改
- 当前整体状态：不能直接判定为“绿”
- 原因：潜行搜刮链路、部分交易左侧点位、部分关闭类点位还缺可反复验证的证据

本轮已回写的点位：

- `talk`
- `small_talk`
- `gift`
- `trade_left_item_tab`
- `trade_left_item_slot`
- `trade_gift_item_tab`
- `trade_gift_item_slot`
- `trade_right_money_slot`
- `trade_scale_button`
- `trade_sell_scale_button`
- `trade_right_up_shelf_button`
- `trade_final_submit_button`
- `vendor_purchase_plus`
- `vendor_purchase_buy`
- `vendor_purchase_max_quantity`
- `vendor_purchase_close`
- `vendor_purchase_option`
- `vendor_purchase_item_sanjiu`
- `vendor_purchase_item_moding`
- `hawking_inventory_first_slot`
- `hawking_max_quantity`
- `hawking_stock_button`
- `hawking_submit`
- `exit_stealth`
- `gift_first_slot`
- `gift_plus`
- `gift_submit`

本轮只复核、未硬改的点位：

- `view`
- `confirm_small_talk`
- `target_close`
- `close_panel`
- `trade_sell_money_slot`
- `steal_button_1`
- `steal_button_2`
- `steal_button_3`
- `steal_button_4`
- `drop_carried_target`
- `loot_transfer_item`
- `loot_put_in`
- `loot_submit`
- `chat_input`
- `chat_exit`
- `small_talk_confirm_dialog`

本轮判断依据较强的链路：

- 货商买货
- 叫卖上货
- 交易主面板
- 交易数量弹窗
- 赠礼面板
- 右下角社交菜单
- 退出潜行

本轮判断依据较弱的链路：

- 闷棍后扛起、放下、搜刮
- 妙取列表按钮
- 个别关闭按钮
- 个别交易左侧分类与左侧首格

如果后续继续清这份清单，优先顺序应该是：

1. `loot_transfer_item`
2. `loot_put_in`
3. `loot_submit`
4. `drop_carried_target`
5. `steal_button_1`
6. `steal_button_2`
7. `steal_button_3`
8. `steal_button_4`
9. `target_close`
10. `close_panel`

已确认不用重复标定：

- 地图链路
- 地图纵坐标输入框
- 地图横坐标输入框
- 地图前往按钮
- 地图传送确认
- 地图纵坐标键盘
- 地图横坐标键盘

## 一、NPC 交互与通用面板

文件：`scripts/windows_input_worker.py`

- `view`
- `talk`
- `small_talk`
- `confirm_small_talk`
- `trade`
- `gift`
- `target_close`
- `close_panel`
- `chat_input`
- `chat_exit`
- `small_talk_confirm_dialog`

## 二、交易面板固定点

文件：`scripts/windows_input_worker.py`

- `trade_left_item_tab`
- `trade_left_item_slot`
- `trade_left_up_shelf_button`
- `trade_sell_money_slot`
- `trade_gift_item_tab`
- `trade_gift_item_slot`
- `trade_sell_item_tab`
- `trade_sell_item_slot`
- `trade_right_money_slot`
- `trade_scale_button`
- `trade_sell_scale_button`
- `trade_right_up_shelf_button`
- `trade_final_submit_button`

## 三、货商购买固定点

文件：`scripts/windows_input_worker.py`

- `vendor_purchase_plus`
- `vendor_purchase_buy`
- `vendor_purchase_max_quantity`
- `vendor_purchase_close`
- `vendor_purchase_option`
- `vendor_purchase_item_sanjiu`
- `vendor_purchase_item_moding`

## 四、叫卖面板固定点

文件：`scripts/windows_input_worker.py`

- `hawking_inventory_first_slot`
- `hawking_max_quantity`
- `hawking_stock_button`
- `hawking_submit`

## 五、送礼链路固定点

文件：`scripts/windows_input_worker.py`

- `gift_first_slot`
- `gift_plus`
- `gift_submit`

## 六、潜行、妙取、搜刮固定点

文件：`scripts/windows_input_worker.py`

- `steal_button_1`
- `steal_button_2`
- `steal_button_3`
- `steal_button_4`
- `exit_stealth`
- `drop_carried_target`
- `loot_transfer_item`
- `loot_put_in`
- `loot_submit`

## 七、固定地图目标坐标

这些不是按钮，但同样是固定写死的坐标目标；如果分辨率调整后路径表现异常，也要一起复查。

文件：`src/runtime/windows-executor.js`

- 货商坐标：`y=555, x=666`
- 大街叫卖坐标：`y=538, x=670`
- 第一卦摊坐标：`y=630, x=548`
- 第二卦摊坐标：`y=753, x=698`
- 潜行点坐标：`y=812, x=405`

## 八、当前不在这份重标清单里的内容

这些链路不是固定写死点击，暂时不归入本清单：

- OCR 文本识别
- 小地图坐标识别
- NPC 目标搜索
- NPC 菜单拉起后的动态识别
- 其他依赖截图、模板或状态判定的动态逻辑
