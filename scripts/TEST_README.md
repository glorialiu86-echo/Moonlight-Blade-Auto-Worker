# 三人NPC聊天测试脚本使用说明

## 脚本位置
`scripts/test_three_npc_chat.py`

## 功能说明
这是一个完整的NPC交互测试脚本，执行以下流程：
1. **点人** - 查找并点击选择NPC
2. **拉起赠礼** - 打开赠礼界面
3. **判断好感度上限** - 检测当前好感度和阈值
4. **送礼或不送** - 根据好感度决定是否送礼
5. **真实聊天** - 发送3条聊天消息
6. **聊完换人** - 关闭聊天，继续下一个NPC

成功聊完3个NPC后结束。

## 运行方式

### 方法1：直接运行
```bash
cd "c:\Users\ZMT-User\Downloads\天刀控制系统"
python scripts/test_three_npc_chat.py
```

### 方法2：在VSCode终端中运行
1. 打开VSCode终端
2. 导航到项目根目录
3. 运行上述命令

## 输出说明

### 日志输出
脚本会在控制台实时输出详细日志，包括：
- 每个步骤的执行状态
- NPC名称和选择结果
- 好感度数值
- 截图文件路径

### 截图输出
所有截图保存在：`tmp/three_npc_test_manual/`

目录结构：
```
tmp/three_npc_test_manual/
├── npc_01/              # 第1个NPC的所有截图
│   ├── 01-world-reset.jpg
│   ├── after-select-轩辕静安.jpg
│   ├── 02-npc-selected.jpg
│   ├── view-panel-opened.jpg
│   ├── gift-opened-for-check.jpg
│   ├── gift-screen-entered.jpg
│   ├── gift-slot-1.jpg
│   ├── gift-submit-1.jpg
│   ├── 04-gift-done.jpg
│   ├── talk-clicked.jpg
│   ├── small-talk-clicked.jpg
│   ├── confirm-talk-clicked.jpg
│   ├── chat-msg-1.jpg
│   ├── chat-msg-2.jpg
│   ├── chat-msg-3.jpg
│   └── 05-chat-done.jpg
├── npc_02/              # 第2个NPC的所有截图
└── npc_03/              # 第3个NPC的所有截图
```

### 关键截图说明

#### 选择NPC阶段
- `after-select-{NPC名}.jpg` - 点击NPC后的截图，红点标记点击位置
- `02-npc-selected.jpg` - 确认选中后的截图

#### 赠礼阶段
- `gift-opened-for-check.jpg` - 打开赠礼界面检查好感度
- `gift-screen-entered.jpg` - 正式开始赠礼
- `gift-slot-N.jpg` - 点击第N个礼物槽位
- `gift-submit-N.jpg` - 点击第N次赠送按钮
- `04-gift-done.jpg` - 赠礼完成后的状态

#### 聊天阶段
- `talk-clicked.jpg` - 点击交谈按钮
- `small-talk-clicked.jpg` - 点击闲聊按钮
- `confirm-talk-clicked.jpg` - 点击确认按钮
- `chat-msg-N.jpg` - 发送第N条消息后的截图
- `05-chat-done.jpg` - 聊天完成后的状态

## 验证方法

### 人工验证步骤
1. 运行脚本后，观察控制台输出
2. 每完成一个NPC，检查对应的截图文件夹
3. 重点检查：
   - NPC是否成功选中（看是否有选中框）
   - 赠礼界面是否正常打开
   - 好感度是否正确读取
   - 聊天界面是否正常显示
   - 消息是否成功发送

### 常见问题排查

#### 问题1：找不到游戏窗口
```
✗ 错误: 未找到游戏窗口
```
**解决**：确保游戏窗口标题包含"天涯明月刀手游"

#### 问题2：NPC选择失败
```
✗ 未找到NPC: XXX
```
**解决**：
- 检查NPC是否在视野范围内
- 尝试调整摄像机角度
- 检查预设NPC列表是否正确

#### 问题3：赠礼界面未打开
```
赠礼界面未打开: XXX
```
**解决**：
- 检查是否已成功选中NPC
- 检查详情面板是否正常打开
- 查看截图确认UI状态

#### 问题4：聊天界面异常
```
聊天界面未就绪: XXX
```
**解决**：
- 检查是否成功点击交谈按钮
- 查看截图确认UI流程
- 可能需要手动干预后重试

## 配置修改

### 修改目标NPC数量
编辑脚本中的 `TARGETS_TO_CHAT` 变量：
```python
TARGETS_TO_CHAT = 3  # 改为其他数字
```

### 修改优先选择的NPC列表
编辑 `PREFERRED_NPCS` 列表：
```python
PREFERRED_NPCS = ["轩辕静安", "乔疯", "梅清流", "净尘", "梅沧寒"]
```

### 修改聊天内容
编辑 `CHAT_MESSAGES` 列表：
```python
CHAT_MESSAGES = [
    "第一条消息",
    "第二条消息",
    "第三条消息",
]
```

### 修改等待时间
```python
WAIT_CLICK = 0.22  # 点击后等待时间（秒）
WAIT_UI = 0.36     # UI操作后等待时间（秒）
```

## 注意事项

1. **不要手动干预**：脚本运行时请勿移动鼠标或按键
2. **保持游戏窗口在前台**：确保游戏窗口可见且未被遮挡
3. **足够的NPC**：确保场景中有足够的可交互NPC
4. **网络稳定**：确保网络连接稳定，避免OCR识别失败
5. **截图验证**：每一步都有截图，方便人工验证和问题排查

## 成功标志

脚本成功完成的标志：
```
✓✓✓ 全部成功！✓✓✓
```

并且输出：
```
总目标数: 3
成功数量: 3
成功率: 100.0%
```

## 失败处理

如果某个NPC失败，脚本会：
1. 记录错误信息
2. 尝试重置到干净状态
3. 继续处理下一个NPC
4. 最终输出成功率统计

可以查看对应NPC文件夹中的截图来诊断问题所在。
