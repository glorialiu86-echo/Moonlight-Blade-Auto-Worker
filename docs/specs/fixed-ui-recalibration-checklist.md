状态：执行完成

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
- 固定写死点击点已全部按 6 个视频重新过了一轮
- 本轮新增要求已执行：不再引用历史截图，只使用这 6 个视频和它们的邻近帧
- 对容易受 `2544x1388` 与 `2538x1384` 轻微差异影响的点位，已尽量回收到按钮或热区中心
- 当前文档状态可收口为“执行完成”，但“绿不绿”仍要靠真实跑链路验证

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
- `view`
- `confirm_small_talk`
- `trade`
- `target_close`
- `trade_left_up_shelf_button`
- `trade_sell_money_slot`
- `trade_sell_item_tab`
- `trade_sell_item_slot`
- `steal_button_1`
- `small_talk_confirm_dialog`
- `chat_input`
- `chat_exit`
- `drop_carried_target`
- `loot_submit`

本轮只复核、未硬改的点位：

- `close_panel`
- `steal_button_2`
- `steal_button_3`
- `steal_button_4`
- `loot_transfer_item`
- `loot_put_in`

本轮判断依据较强的链路：

- 货商买货
- 叫卖上货
- 交易主面板
- 交易数量弹窗
- 赠礼面板
- 右下角社交菜单
- 聊天面板
- 退出潜行
- 闷棍后放下目标
- 搜刮面板
- 妙取列表按钮

本轮判断依据较弱的链路：

- 个别关闭按钮
- 个别交易左侧分类与左侧首格
- `view` 与 `target_close` 这类和目标条、放大镜存在少量遮挡重叠的点位

本轮 double check 说明：

1. `选人-点查看放大镜-拉起右下角UI-交易买一次卖一次-赠礼-聊天.mp4`
2. `货商买货（墨和散酒）.mp4`
3. `叫卖.mp4`
4. `潜行-妙取.mp4`
5. `潜行-闷棍-扛起-放下-搜刮.mp4`
6. `退出潜行.mp4`

本轮复核方式：

- 对单帧证据不稳的点位，补抽邻近帧再叠图
- 优先把点击点压到按钮视觉中心，而不是按钮边缘
- 聊天、妙取、搜刮链路已改为只认六视频，不混入旧分辨率截图

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
