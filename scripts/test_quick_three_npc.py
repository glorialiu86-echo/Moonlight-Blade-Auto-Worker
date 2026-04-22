"""
快速三人NPC聊天测试 - 简化版
用于快速验证完整流程
"""
import json
import sys
import time
from pathlib import Path

# 添加scripts目录到路径
SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# 导入核心模块
import windows_input_worker as worker
import validate_input_state as vis

# ==================== 配置区 ====================
GAME_WINDOW_TITLE = "天涯明月刀手游"
TARGETS_TO_CHAT = 3
PREFERRED_NPCS = ["轩辕静安", "乔疯", "梅清流"]
CHAT_MESSAGES = [
    "我先拿点小生意当见面礼,别嫌我手黑。",
    "你这人看着稳,我想和你多来往几回。",
    "今儿先聊到这,改天我再带点好东西来。",
]
PROJECT_ROOT = SCRIPT_DIR.parent
OUTPUT_BASE_DIR = PROJECT_ROOT / "tmp" / f"quick_test_{int(time.time())}"
WAIT_CLICK = 0.22
WAIT_UI = 0.36
# ===============================================


def log(msg: str):
    """打印日志"""
    timestamp = time.strftime("%H:%M:%S")
    log_line = f"[{timestamp}] {msg}"
    print(log_line, flush=True)


def capture(hwnd: int, output_dir: Path, filename: str, click_point: dict = None) -> str:
    """截图保存"""
    output_dir.mkdir(parents=True, exist_ok=True)
    filepath = output_dir / filename
    
    try:
        from PIL import ImageGrab
        import win32gui
        
        # 获取窗口位置
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        
        # 截取整个屏幕
        screenshot = ImageGrab.grab()
        
        # 如果提供了点击点，绘制红点
        if click_point:
            from PIL import ImageDraw
            draw = ImageDraw.Draw(screenshot)
            x = click_point.get('screenX', 0)
            y = click_point.get('screenY', 0)
            radius = 10
            draw.ellipse([x-radius, y-radius, x+radius, y+radius], fill='red')
        
        # 保存截图
        screenshot.save(str(filepath), "JPEG", quality=95)
        log(f"✓ 截图已保存: {filename}")
        return str(filepath)
    except Exception as e:
        log(f"✗ 截图失败: {e}")
        return ""


def find_game_window():
    """查找游戏窗口"""
    log("正在查找游戏窗口...")
    hwnd = worker.find_window_by_title(GAME_WINDOW_TITLE)
    
    if hwnd:
        log(f"✓ 找到游戏窗口 (hwnd={hwnd})")
        return hwnd
    else:
        log(f"✗ 未找到标题包含 '{GAME_WINDOW_TITLE}' 的窗口")
        return None


def select_npc(hwnd: int, npc_name: str = None) -> dict:
    """选择NPC"""
    log(f"\n{'='*60}")
    log(f"步骤1: 选择NPC")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step1_select_npc"
    
    # 截图：初始状态
    capture(hwnd, output_dir, "before_select.jpg")
    
    # 使用worker选择NPC
    result = worker.acquire_npc_target(
        hwnd=hwnd,
        preferred_names=PREFERRED_NPCS if not npc_name else [npc_name],
        max_attempts=3
    )
    
    if result and result.get('ok'):
        npc_info = result.get('npc_info', {})
        log(f"✓ 成功选择NPC: {npc_info.get('name', 'Unknown')}")
        
        # 截图：选择后
        capture(hwnd, output_dir, "after_select.jpg")
        
        return result
    else:
        log(f"✗ 选择NPC失败: {result}")
        return None


def open_gift_panel(hwnd: int) -> bool:
    """打开赠礼面板"""
    log(f"\n{'='*60}")
    log(f"步骤2: 打开赠礼面板")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step2_open_gift"
    capture(hwnd, output_dir, "before_open_gift.jpg")
    
    result = worker.open_gift_panel(hwnd)
    
    if result and result.get('ok'):
        log("✓ 赠礼面板已打开")
        capture(hwnd, output_dir, "after_open_gift.jpg")
        return True
    else:
        log(f"✗ 打开赠礼面板失败: {result}")
        return False


def check_affinity(hwnd: int) -> dict:
    """检查好感度"""
    log(f"\n{'='*60}")
    log(f"步骤3: 检查好感度")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step3_check_affinity"
    capture(hwnd, output_dir, "affinity_check.jpg")
    
    result = worker.check_gift_chat_threshold(hwnd)
    
    if result:
        current = result.get('current', 0)
        threshold = result.get('threshold', 0)
        log(f"✓ 当前好感度: {current}, 阈值: {threshold}")
        return result
    else:
        log("✗ 检查好感度失败")
        return None


def send_gift_if_needed(hwnd: int, affinity_info: dict) -> bool:
    """根据好感度决定是否送礼"""
    log(f"\n{'='*60}")
    log(f"步骤4: 判断并执行送礼")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step4_send_gift"
    
    current = affinity_info.get('current', 0)
    threshold = affinity_info.get('threshold', 0)
    
    if current >= threshold:
        log(f"好感度已达上限 ({current}/{threshold}), 跳过送礼")
        capture(hwnd, output_dir, "skip_gift.jpg")
        return True
    else:
        log(f"好感度未达上限 ({current}/{threshold}), 执行送礼")
        result = worker.execute_gift_flow(hwnd, max_rounds=1)
        
        if result and result.get('ok'):
            log("✓ 送礼成功")
            capture(hwnd, output_dir, "gift_sent.jpg")
            return True
        else:
            log(f"✗ 送礼失败: {result}")
            return False


def start_chat(hwnd: int) -> bool:
    """开始聊天"""
    log(f"\n{'='*60}")
    log(f"步骤5: 开始聊天")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step5_start_chat"
    capture(hwnd, output_dir, "before_chat.jpg")
    
    result = worker.start_small_talk(hwnd)
    
    if result and result.get('ok'):
        log("✓ 聊天界面已打开")
        capture(hwnd, output_dir, "chat_started.jpg")
        return True
    else:
        log(f"✗ 打开聊天界面失败: {result}")
        return False


def send_chat_messages(hwnd: int, messages: list) -> bool:
    """发送聊天消息"""
    log(f"\n{'='*60}")
    log(f"步骤6: 发送聊天消息")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step6_chat_messages"
    
    for i, msg in enumerate(messages, 1):
        log(f"发送消息 {i}/{len(messages)}: {msg[:30]}...")
        
        result = worker.send_chat_message(hwnd, msg)
        
        if result and result.get('ok'):
            log(f"✓ 消息 {i} 发送成功")
            capture(hwnd, output_dir, f"msg_{i}.jpg")
        else:
            log(f"✗ 消息 {i} 发送失败: {result}")
            return False
        
        time.sleep(WAIT_UI)
    
    return True


def close_chat_and_reset(hwnd: int) -> bool:
    """关闭聊天并重置状态"""
    log(f"\n{'='*60}")
    log(f"步骤7: 关闭聊天并重置")
    log(f"{'='*60}")
    
    output_dir = OUTPUT_BASE_DIR / "step7_reset"
    capture(hwnd, output_dir, "before_reset.jpg")
    
    result = worker.close_chat_and_reset(hwnd)
    
    if result and result.get('ok'):
        log("✓ 已重置到干净状态")
        capture(hwnd, output_dir, "after_reset.jpg")
        return True
    else:
        log(f"✗ 重置失败: {result}")
        return False


def main():
    """主函数"""
    log("\n" + "="*80)
    log("三人NPC聊天完整流程测试 - 简化版")
    log("="*80)
    log(f"输出目录: {OUTPUT_BASE_DIR}")
    log(f"目标NPC数量: {TARGETS_TO_CHAT}")
    log(f"优先NPC列表: {', '.join(PREFERRED_NPCS)}")
    log("="*80 + "\n")
    
    # 创建输出目录
    OUTPUT_BASE_DIR.mkdir(parents=True, exist_ok=True)
    
    # 查找游戏窗口
    hwnd = find_game_window()
    if not hwnd:
        log("\n✗✗✗ 测试中止：未找到游戏窗口 ✗✗✗")
        return
    
    success_count = 0
    
    # 循环处理每个NPC
    for npc_idx in range(TARGETS_TO_CHAT):
        log(f"\n\n{'#'*80}")
        log(f"# NPC #{npc_idx + 1}/{TARGETS_TO_CHAT}")
        log(f"{'#'*80}\n")
        
        npc_dir = OUTPUT_BASE_DIR / f"npc_{npc_idx + 1:02d}"
        
        try:
            # 步骤1: 选择NPC
            npc_result = select_npc(hwnd)
            if not npc_result:
                log(f"✗ NPC #{npc_idx + 1} 选择失败，跳过")
                continue
            
            # 步骤2: 打开赠礼面板
            if not open_gift_panel(hwnd):
                log(f"✗ NPC #{npc_idx + 1} 打开赠礼失败，跳过")
                continue
            
            # 步骤3: 检查好感度
            affinity = check_affinity(hwnd)
            if not affinity:
                log(f"✗ NPC #{npc_idx + 1} 检查好感度失败，跳过")
                continue
            
            # 步骤4: 送礼（如果需要）
            if not send_gift_if_needed(hwnd, affinity):
                log(f"⚠ NPC #{npc_idx + 1} 送礼环节有问题，继续聊天")
            
            # 步骤5: 开始聊天
            if not start_chat(hwnd):
                log(f"✗ NPC #{npc_idx + 1} 开始聊天失败，跳过")
                continue
            
            # 步骤6: 发送聊天消息
            if not send_chat_messages(hwnd, CHAT_MESSAGES):
                log(f"✗ NPC #{npc_idx + 1} 发送消息失败")
                continue
            
            # 步骤7: 关闭聊天并重置
            if not close_chat_and_reset(hwnd):
                log(f"⚠ NPC #{npc_idx + 1} 重置失败，可能影响下一个NPC")
            
            success_count += 1
            log(f"\n✓✓✓ NPC #{npc_idx + 1} 完成！✓✓✓\n")
            
        except Exception as e:
            log(f"\n✗✗✗ NPC #{npc_idx + 1} 发生异常: {e} ✗✗✗\n")
            import traceback
            traceback.print_exc()
            continue
    
    # 总结
    log(f"\n\n{'='*80}")
    log(f"测试完成！")
    log(f"{'='*80}")
    log(f"总目标数: {TARGETS_TO_CHAT}")
    log(f"成功数量: {success_count}")
    log(f"成功率: {success_count/TARGETS_TO_CHAT*100:.1f}%")
    log(f"输出目录: {OUTPUT_BASE_DIR}")
    log(f"{'='*80}")
    
    if success_count == TARGETS_TO_CHAT:
        log("\n✓✓✓ 全部成功！✓✓✓\n")
    else:
        log(f"\n⚠ 有 {TARGETS_TO_CHAT - success_count} 个NPC未完成\n")


if __name__ == "__main__":
    main()
