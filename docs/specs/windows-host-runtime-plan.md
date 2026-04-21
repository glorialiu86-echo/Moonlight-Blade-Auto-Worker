# Windows 主机部署与运行方案
状态：执行完成

## 目标

说明当前 Windows 主机上，固定剧本、窗口截图、LLM 生成和真实键鼠执行的唯一运行形态。

## 当前运行形态

- 本地 `Node` 服务负责固定剧本编排与前端接口
- 本地 Python worker 负责截图、OCR、视觉判定与真实输入
- 浏览器前端分为两页：
  - `/`：主播主页面
  - `/debug`：调试页

## 当前唯一 owner

- 地图寻路：`travel_to_coordinate`
- 选人：`acquire_npc_target`
- 拉起放大镜与右下角交互菜单：`open_npc_action_menu`
- 赠礼门槛判断与送礼执行：`inspect_gift_chat_threshold` / `resolve_gift_chat_threshold`
- 进入潜行：`enter_stealth_with_retry`
- 固定剧本恢复入口：`resumeFailedAutomationStep -> inspectCurrentNpcInteractionStage`

## 已移除的旧 owner

- 已不再使用 `retarget_social_target`
- 已不再使用 `recover_front_target_visibility`
- 已不再保留“聊天前先交易买礼物”的社交前置链
- `/debug` 页已不再单独展示 recoveryLine 块

## 当前恢复逻辑

- 任意失败都会进入可见失败态，并生成 LLM 风格的“救救我”文案
- 红色三角按钮会先看当前界面，再决定从当前页面继续，而不是机械重跑旧链路
- 如果主播中途手动推进了页面，恢复逻辑会直接承接当前状态

## 保持不变

- 固定剧本仍然只在这台 Windows 机器上运行
- 真实截图、真实输入、真实聊天仍然都在本机完成
