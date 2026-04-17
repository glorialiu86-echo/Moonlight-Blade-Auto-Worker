# Windows 主机部署与运行方案
状态：执行到一半

## 目标

在当前这台 Windows 主机上，跑通天刀控制系统的本地部署、窗口截图、LLM 规划和真实键鼠输入执行。

## 已落地方案

### 运行形态

- 本地 `Node` 服务作为控制台与编排层
- 本地 Python 作为 ASR 与 Windows 输入执行层
- 浏览器访问本地页面
- 最终运行环境固定为当前 Windows 主机
- 前端分为两页：
  - `/`：主播首页，只保留聊天与系统启停
  - `/debug`：调试页，承载截图、环境摘要、实验记录和调试消息流

### 已完成能力

- Windows 本地开发环境已重建，不再依赖旧 macOS `.venv`
- 本地服务可启动
- 自动窗口截图已可直接抓取 `天涯明月刀手游`
- 截图分析结果已能写回 `latestPerception`
- 真实输入执行器已接入主链路
- `/api/chat` 已可驱动真实执行结果回写
- 自主自动化主流程已收敛为固定剧本 runner，前端只显示人格化思考与执行结果
- 固定剧本启动前固定进入 `2` 分钟黄色保护
- 固定剧本失败后不再弹文字报错，只让三角按钮变红并进入恢复动作队列
- 社交后置自动回复失败也会进入同一套红三角恢复态
- 执行态期间自动截图轮询会停掉，不再混入观看态自动接话
- 妙取链和闷棍搜刮链已拆成两条独立固定阶段

### 当前执行器策略

- 固定剧本不再依赖早期“语义动作统一映射最小按键”的策略作为主控制源
- 当前主链由专用 owner 负责：
  - 社交首次选人：`acquire_npc_target`
  - 社交换人：`retarget_social_target`
  - 放大镜承接：`open_npc_action_menu`
  - 地图寻路：`travel_to_coordinate`
  - 潜行入口：`enter_stealth_with_retry`
  - 遮挡恢复：`recover_front_target_visibility`
- `api/turn` 和独立调试入口仍可复用通用执行器，但固定剧本主链已经切到 stage 专用执行器

说明：

- 当前仓库里真正应以固定剧本和原子 action 规格为真源
- 这份文档只负责说明当前 Windows 主机运行形态，不再把旧的最小键位映射当作自动化主链路真源
- 主播首页不暴露手动截图入口，截图相关操作只留在调试页

## 未完成能力

- Windows 真机上的逐步稳定性验证
- 货商购买链路与叫卖链路的完整固定点位重标
- `闷棍` 使用次数预算确认并回填到真实策略文档
- 更系统的自动化测试和回归脚本
- 长时运行下的用户抢占、异常恢复和人工接管体验回归

## 本轮验证结果

已验证：

- `capture-game-window.ps1` 可直接输出窗口截图 JSON
- `src/capture/windows-game-window.js` 可成功抓取窗口图像
- `src/runtime/windows-executor.js` 可成功定位窗口并发送实际输入
- `GET /` 返回主播首页 HTML
- `GET /debug` 返回调试页 HTML
- `GET /api/health` 返回 `ok: true`
- `node --check src/server/index.js` 通过
- 固定剧本静态检查脚本可在本地直接跑，不依赖启动服务或真机输入

## 下一步建议

1. 在 Windows 真机上逐段验证 `sale / social / dark_close / dark_miaoqu / ending_trade` 五段真实成功率。
2. 完成货商购买链路与叫卖链路固定点位重标。
3. 在技术确认后，把 `闷棍` 次数预算写进真实规格，不再只停留在“待定”。
4. 继续补本地静态检查或 `node:test` 级别 smoke tests，减少后续文案池和 stage 配置回归。
