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

- 本地 `Node` 服务、单页控制台、`.env` 加载、千问文本/视觉/OCR 调用链路
- Windows 本地 Python 环境重建，`faster-whisper` CPU/GPU 双环境补齐
- 自动截图采集链路接入主服务
- 固定游戏窗口截图 `capture-game-window.ps1` 可直接运行
- 真实 Windows 输入执行器接入主链路
- `/api/chat` 已可触发 `规划 -> Windows 输入执行 -> 状态回写`
- 自动截图已可更新 `latestPerception` 与 `capture` 状态

仍未完成：

- 动作语义仍是最小映射，当前主要落到 `inspect/focus`、`esc`、等待
- 还没有基于模板匹配或局部 OCR 的稳定点击坐标主链路
- 还没有点击后复检闭环
- 用户抢占、执行中断、恢复策略仍是骨架
- 自动运行策略还没有针对真控风险做完整产品级约束

## 本轮新增结论

- `MockExecutor` 已不再是主执行源，服务端已切到真实 `WindowsInputExecutor`
- 后台服务直接 `SetForegroundWindow` 不稳定，因此执行器已降级支持“窗口内点击激活”
- 自主回合不再在服务启动后自动乱跑，只有系统进入 `running` 后才会执行
- 新实例验证通过：
  - `GET /api/state`
  - `POST /api/chat`
  - 自动窗口截图成功
  - 游戏窗口输入成功

## 当前主要风险

- 当前输入映射仍偏保守，尚不足以支撑复杂任务链
- 自动截图会把桌面调试窗口一起截进画面，后续需要更严格的窗口净化或裁剪策略
- 真实输入已经接入，后续所有自主动作都需要更明确的安全边界
