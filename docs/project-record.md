# 项目记录
状态：执行到一半

## 仓库位置

- GitHub 仓库：`https://github.com/glorialiu86-echo/Moonlight-Blade-Auto-Worker`
- 当前工作目录：`C:\Users\ZMT-User\Downloads\天刀控制系统`

## 当前机器结论

- 当前唯一开发与运行平台：Windows
- 后续不再切回 macOS
- 最终软件也只在这台 Windows 电脑上运行
- 游戏安装目录：`D:\天涯明月刀`
- 当前已确认游戏窗口标题：`天涯明月刀手游`

## 当前代码真实进度

已完成：

- 本地 `Node` 服务、`.env` 加载、千问文本链路
- 截图感知主链路已切到本地 `RapidOCR` OCR worker
- 文本规划链路已支持单独切到本地 `Ollama`，不再要求和视觉/OCR 共用同一 provider
- Windows 本地 Python 环境重建，`faster-whisper` CPU/GPU 双环境补齐
- 自动截图采集链路接入主服务
- 固定游戏窗口截图 `capture-game-window.ps1` 可直接运行
- 真实 Windows 输入执行器接入主链路
- `/api/chat` 已可触发 `规划 -> Windows 输入执行 -> 状态回写`
- 自动截图已可更新 `latestPerception` 与 `capture` 状态
- 自动截图调度已改为按目标频率补齐剩余时间，不再在每轮分析结束后额外空等一个完整间隔
- 路人 NPC 对话链路已明确切到点击 owner，`F` 只保留给功能型 NPC 作为候选交互键
- 本机已拉起 `qwen2.5:3b`，文本规划可走本地 `Ollama`
- 前端已拆成主播首页 `/` 和调试页 `/debug`
- 主播首页已加入明确的“开始执行任务 / 停止执行任务”主按钮

仍未完成：

- 动作语义仍是最小映射，当前主要落到 `inspect/focus`、`esc`、等待
- 还没有基于模板匹配或局部 OCR 的稳定点击坐标主链路
- 还没有点击后复检闭环
- 用户抢占、执行中断、恢复策略仍是骨架
- 自动运行策略还没有针对真控风险做完整产品级约束

## 本轮新增结论

- 主播首页不再暴露截图上传入口
- 调试信息、截图状态、实验记录都已移动到 `/debug`
- 后端 `/api/control` 的 `start/resume/stop` 已同步控制自动截图状态
- 新实例验证通过：
  - `GET /`
  - `GET /debug`
  - `GET /api/health`

## 当前主要风险

- 当前输入映射仍偏保守，尚不足以支撑复杂任务链
- 自动截图会把桌面调试窗口一起截进画面，后续需要更严格的窗口净化或裁剪策略
- 真实输入已经接入，后续所有自主动作都需要更明确的安全边界
