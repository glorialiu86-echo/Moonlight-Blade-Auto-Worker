# 项目记录
状态：执行完成

## 仓库位置

- GitHub 仓库：`https://github.com/glorialiu86-echo/Moonlight-Blade-Auto-Worker`
- 当前工作目录：`C:\Users\ZMT-User\Downloads\天刀控制系统`

## 当前固定剧本真实进度

已完成：

- 固定剧本主链已经收敛到单一 stage runner
- 聊天前买礼物步骤已从社交主链删除
- `social_warm` 改为第一个地点只聊一个 NPC，第一句固定吹嘘籽岷
- `social_dark` 改为第二个地点只聊一个 NPC，前五轮正常搞钱、后五轮黑化搞钱
- 赠礼策略已收敛为：
  - `99` 直接聊
  - 其余上限统一送 `10` 个礼物
- `dark_close` 已改成“不再吃蛊；不再先点人、不再扛走放下，直接闷棍后直连搜刮”
- `dark_miaoqu` 已改成“不跑地图、不下马、不额外按 v，直接从当前位置潜行后妙取；失败清理后直接进下一轮”
- 所有失败统一走 LLM 求救文案，不再静默失败
- 三角恢复按钮已改成“先看当前界面，再从当前界面接着跑”
- `/debug` 页面已去掉单独的 recoveryLine 展示块
- 固定剧本思考链已改成按动作 checkpoint 分段输出，不再起手一口气堆多条
- 固定剧本评论与动作之间现在默认保留约 `1200ms` 间隔，表现更像“先想一下再动手”
- 除 `dark_close` / `dark_miaoqu` 外，其余写死顺序点击里原先短于 `500ms` 的固定间隔已统一拉开

本轮额外整理：

- 删除了未被主链使用的旧社交交易入口 `createFixedSocialTradeActions`
- 删除了 worker 里未被主链使用的旧 owner：
  - `retarget_social_target`
  - `recover_front_target_visibility`
- 同步更新了固定剧本、按键说明、主机运行方案与 NPC 原子动作文档

## 中文文本核查结论

- 已按 UTF-8 实际读取方式检查仓库内本轮相关代码与文档
- 当前没有发现需要落盘修复的真实文件级中文乱码
- 之前终端里看到的部分乱码，属于 PowerShell 输出显示问题，不是仓库文件本体损坏

## 保持不变

- 4 个未跟踪测试脚本残留仍未纳入提交：
  - `scripts/TEST_README.md`
  - `scripts/test_quick_three_npc.py`
  - `scripts/test_simple.py`
  - `scripts/test_three_npc_chat.py`
