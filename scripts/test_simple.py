"""
简化版三人NPC聊天测试 - 用于快速验证
"""
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import windows_input_worker as worker
import validate_input_state as vis

GAME_WINDOW_TITLE = "天涯明月刀手游"
OUTPUT_DIR = SCRIPT_DIR.parent / "tmp" / "simple_test"

print("=== 简化测试开始 ===", flush=True)
print(f"输出目录: {OUTPUT_DIR}", flush=True)

# 查找窗口
print("\n1. 查找游戏窗口...", flush=True)
hwnd, activation = worker.resolve_game_window(GAME_WINDOW_TITLE)

if not hwnd:
    print("✗ 未找到游戏窗口！", flush=True)
    sys.exit(1)

print(f"✓ 找到窗口 HWND={hwnd}", flush=True)

# 创建输出目录
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
print(f"✓ 创建输出目录: {OUTPUT_DIR}", flush=True)

# 禁用输入保护
worker.INPUT_GUARD.configure(False)
print("✓ 输入保护已禁用", flush=True)

# 截图测试
print("\n2. 截图测试...", flush=True)
try:
    image = vis.capture_full_client(hwnd)
    print(f"✓ 截图成功，尺寸: {image.shape}", flush=True)
    
    filepath = vis.save_debug_image(image, "test-screenshot.jpg", output_dir=OUTPUT_DIR)
    print(f"✓ 截图保存: {filepath}", flush=True)
except Exception as e:
    print(f"✗ 截图失败: {e}", flush=True)
    import traceback
    traceback.print_exc()

# 检测当前阶段
print("\n3. 检测当前阶段...", flush=True)
try:
    stage = worker.detect_npc_interaction_stage(hwnd)
    print(f"✓ 当前阶段: {stage.get('stage', 'unknown')}", flush=True)
except Exception as e:
    print(f"✗ 阶段检测失败: {e}", flush=True)

print("\n=== 基础测试完成 ===", flush=True)
print(f"\n请检查目录查看截图: {OUTPUT_DIR}", flush=True)
