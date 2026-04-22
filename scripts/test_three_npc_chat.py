"""
三人NPC聊天完整流程测试脚本 (重构版)
功能：点人 -> 拉起赠礼 -> 判断好感度上限 -> 送礼或不送 -> 真实聊天 -> 聊完换人
成功聊完三个人就结束，每一步自动截图供人工验证
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
TARGETS_TO_CHAT = 3  # 要聊天的NPC数量
PREFERRED_NPCS = ["轩辕静安", "乔疯", "梅清流", "净尘", "梅沧寒"]  # 优先选择的NPC列表
CHAT_MESSAGES = [
    "我先拿点小生意当见面礼,别嫌我手黑。",
    "你这人看着稳,我想和你多来往几回。",
    "今儿先聊到这,改天我再带点好东西来。",
]
PROJECT_ROOT = SCRIPT_DIR.parent
OUTPUT_BASE_DIR = PROJECT_ROOT / "tmp" / "three_npc_test_refactored"
WAIT_CLICK = 0.22  # 点击后等待时间（秒）
WAIT_UI = 0.36     # UI操作后等待时间（秒）
# ===============================================


def log(msg: str):
    """打印日志到stdout和文件"""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {msg}"
    print(log_line, flush=True)
    
    # 同时写入日志文件
    OUTPUT_BASE_DIR.mkdir(parents=True, exist_ok=True)
    log_file = OUTPUT_BASE_DIR / "test_log.txt"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(log_line + "\n")


def capture(hwnd: int, output_dir: Path, filename: str, click_point: dict = None) -> str:
    """截图保存"""
    output_dir.mkdir(parents=True, exist_ok=True)
    image = vis.capture_full_client(hwnd)
    
    client_x = click_point.get("clientX") if click_point else None
    client_y = click_point.get("clientY") if click_point else None
    
    filepath = vis.save_debug_image(image, filename, client_x, client_y, output_dir)
    return filepath


def get_stage(hwnd: int) -> dict:
    """获取当前交互阶段及文本信息"""
    return worker.detect_npc_interaction_stage(hwnd)


def click_named_point(hwnd: int, point_name: str, wait: float = WAIT_UI) -> dict:
    """点击命名好的UI点"""
    x_ratio, y_ratio = worker.ACTION_POINTS[point_name]
    point = vis.build_screen_point_from_ratio(hwnd, x_ratio, y_ratio)
    vis.click_screen_point(hwnd, point["screenX"], point["screenY"])
    time.sleep(wait)
    return point


def reset_to_clean_state(hwnd: int):
    """重置到干净的世界状态"""
    log("  → 重置到世界状态")
    vis.reset_to_world(hwnd)
    time.sleep(0.5)


def select_npc(hwnd: int, npc_name: str, attempt_dir: Path) -> dict:
    """选择指定名称的NPC"""
    log(f"  → 查找NPC: {npc_name}")
    
    bounds = vis.get_window_bounds(hwnd)
    named_anchor = worker.find_named_npc_in_scene(hwnd, npc_name)
    
    if not named_anchor:
        log(f"  ✗ 未找到NPC: {npc_name}")
        return None
    
    # 构建点击点
    click_point = {
        "screenX": int(named_anchor["screenX"]),
        "screenY": int(named_anchor["screenY"]),
        "clientX": int(named_anchor["screenX"] - bounds["left"]),
        "clientY": int(named_anchor["screenY"] - bounds["top"]),
        "name": npc_name,
    }
    
    # 点击NPC
    log(f"  → 点击NPC位置: ({click_point['screenX']}, {click_point['screenY']})")
    vis.click_screen_point(hwnd, click_point["screenX"], click_point["screenY"])
    time.sleep(WAIT_CLICK)
    
    # 截图验证选择状态
    capture(hwnd, attempt_dir, f"after-select-{npc_name}.jpg", click_point)
    
    # 验证是否选中
    image = vis.capture_full_client(hwnd)
    selected_state = vis.detect_selection_state(image, click_point)
    
    if selected_state["selected"]:
        log(f"  ✓ 成功选中: {npc_name}")
        return click_point
    else:
        log(f"  ✗ 选择失败: {npc_name}")
        return None


def open_view_panel(hwnd: int, target_click: dict, attempt_dir: Path) -> dict:
    """打开详情面板"""
    log("  → 打开详情面板")
    
    view_click = worker.find_view_button_near_click(
        hwnd, 
        target_click["screenX"], 
        target_click["screenY"]
    )
    
    if not view_click:
        raise RuntimeError("未找到查看按钮")
    
    bounds = vis.get_window_bounds(hwnd)
    view_click["clientX"] = int(view_click["screenX"] - bounds["left"])
    view_click["clientY"] = int(view_click["screenY"] - bounds["top"])
    
    vis.click_screen_point(hwnd, view_click["screenX"], view_click["screenY"])
    time.sleep(WAIT_UI)
    
    capture(hwnd, attempt_dir, "view-panel-opened.jpg", view_click)
    
    stage_info = get_stage(hwnd)
    log(f"  → 当前阶段: {stage_info['stage']}")
    
    return view_click


def check_favor_threshold(hwnd: int, attempt_dir: Path) -> dict:
    """检测好感度阈值"""
    log("  → 检测好感度阈值")
    
    # 打开赠礼界面
    gift_point = click_named_point(hwnd, "gift", WAIT_UI)
    capture(hwnd, attempt_dir, "gift-opened-for-check.jpg", gift_point)
    
    stage_info = get_stage(hwnd)
    stage = stage_info["stage"]
    log(f"  → 赠礼界面阶段: {stage}")
    
    if stage != "gift_screen":
        raise RuntimeError(f"赠礼界面未打开: {stage}")
    
    # 获取阈值信息
    threshold_info = worker.detect_target_threshold(hwnd)
    texts = stage_info.get("texts", {})
    favor_text = texts.get("gift_panel", "")
    current_favor = worker.parse_favor_value(favor_text)
    
    need_gift = current_favor is not None and current_favor < threshold_info["threshold"]
    
    log(f"  → 当前好感度: {current_favor}")
    log(f"  → 好感度阈值: {threshold_info['threshold']}")
    log(f"  → 需要送礼: {need_gift}")
    
    # 关闭赠礼界面
    worker.exit_panel(hwnd)
    time.sleep(0.35)
    capture(hwnd, attempt_dir, "gift-closed-after-check.jpg")
    
    return {
        "threshold": threshold_info["threshold"],
        "currentFavor": current_favor,
        "needGift": need_gift,
    }


def execute_gift_flow(hwnd: int, threshold_info: dict, attempt_dir: Path):
    """执行赠礼流程"""
    if not threshold_info["needGift"]:
        log("  → 好感度已满，跳过赠礼")
        return
    
    log(f"  → 开始赠礼流程 (当前:{threshold_info['currentFavor']}, 目标:{threshold_info['threshold']})")
    
    # 打开赠礼界面
    gift_point = click_named_point(hwnd, "gift", WAIT_UI)
    capture(hwnd, attempt_dir, "gift-screen-entered.jpg", gift_point)
    
    stage_info = get_stage(hwnd)
    if stage_info["stage"] != "gift_screen":
        raise RuntimeError(f"赠礼界面打开失败: {stage_info['stage']}")
    
    max_rounds = 6
    for round_num in range(1, max_rounds + 1):
        log(f"    第{round_num}轮赠礼...")
        
        # 点击第一个礼物槽位
        slot_point = click_named_point(hwnd, "gift_first_slot", 0.18)
        capture(hwnd, attempt_dir, f"gift-slot-{round_num}.jpg", slot_point)
        
        # 点击赠送按钮
        submit_point = click_named_point(hwnd, "gift_submit", 0.46)
        capture(hwnd, attempt_dir, f"gift-submit-{round_num}.jpg", submit_point)
        
        # 检查是否还在赠礼界面
        stage_info = get_stage(hwnd)
        if stage_info["stage"] != "gift_screen":
            log(f"    ⚠ 赠礼界面提前退出: {stage_info['stage']}")
            break
        
        # 读取更新后的好感度
        texts = stage_info.get("texts", {})
        favor_text = texts.get("gift_panel", "")
        current_favor = worker.parse_favor_value(favor_text)
        
        log(f"    → 当前好感度: {current_favor}")
        
        if current_favor is not None and current_favor >= threshold_info["threshold"]:
            log(f"    ✓ 已达到阈值 {threshold_info['threshold']}")
            break
    
    # 关闭赠礼界面
    worker.exit_panel(hwnd)
    time.sleep(0.35)
    capture(hwnd, attempt_dir, "gift-flow-completed.jpg")
    log("  → 赠礼流程完成")


def execute_chat_flow(hwnd: int, npc_name: str, attempt_dir: Path):
    """执行聊天流程"""
    log(f"  → 开始与 {npc_name} 聊天")
    
    # 点击交谈
    talk_point = click_named_point(hwnd, "talk", WAIT_UI)
    capture(hwnd, attempt_dir, "talk-clicked.jpg", talk_point)
    
    # 点击闲聊
    small_talk_point = click_named_point(hwnd, "small_talk", WAIT_UI)
    capture(hwnd, attempt_dir, "small-talk-clicked.jpg", small_talk_point)
    
    # 点击确认
    confirm_point = click_named_point(hwnd, "small_talk_confirm_dialog", WAIT_UI)
    capture(hwnd, attempt_dir, "confirm-talk-clicked.jpg", confirm_point)
    
    # 检查聊天界面
    stage_info = get_stage(hwnd)
    stage = stage_info["stage"]
    log(f"  → 聊天界面阶段: {stage}")
    
    if stage != "chat_ready":
        raise RuntimeError(f"聊天界面未就绪: {stage}")
    
    log("  ✓ 聊天界面已就绪")
    
    # 发送消息
    for idx, message in enumerate(CHAT_MESSAGES, 1):
        log(f"    发送消息 {idx}/{len(CHAT_MESSAGES)}: {message}")
        
        worker.send_chat_message(hwnd, message, False, 0)
        time.sleep(0.24)
        
        capture(hwnd, attempt_dir, f"chat-msg-{idx}.jpg")
        
        # 验证聊天界面状态
        stage_info = get_stage(hwnd)
        if stage_info["stage"] != "chat_ready":
            raise RuntimeError(f"发送消息后聊天界面异常: {stage_info['stage']}")
    
    log(f"  ✓ 成功发送 {len(CHAT_MESSAGES)} 条消息")
    
    # 关闭聊天界面
    chat_exit_point = click_named_point(hwnd, "chat_exit", 0.28)
    capture(hwnd, attempt_dir, "chat-closed.jpg", chat_exit_point)
    
    log("  → 聊天流程完成")


def process_one_npc(hwnd: int, npc_index: int, used_names: set) -> bool:
    """处理单个NPC的完整流程"""
    log(f"\n{'='*70}")
    log(f"处理第 {npc_index} 个NPC")
    log(f"{'='*70}")
    
    attempt_dir = OUTPUT_BASE_DIR / f"npc_{npc_index:02d}"
    attempt_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # 1. 重置状态
        reset_to_clean_state(hwnd)
        capture(hwnd, attempt_dir, "01-world-reset.jpg")
        
        # 2. 选择NPC
        target_click = None
        selected_name = None
        
        # 尝试预设名称
        for npc_name in PREFERRED_NPCS:
            if npc_name in used_names:
                continue
            
            target_click = select_npc(hwnd, npc_name, attempt_dir)
            if target_click:
                selected_name = npc_name
                used_names.add(npc_name)
                break
        
        # 如果预设都用完了，尝试随机NPC
        if not target_click:
            log("  → 预设NPC已用完，尝试随机NPC")
            for attempt in range(1, 6):
                random_target = vis.find_random_npc_target(hwnd, npc_index * 10 + attempt)
                if not random_target:
                    continue
                
                bounds = vis.get_window_bounds(hwnd)
                target_click = vis.build_target_click_from_bbox(hwnd, random_target)
                
                vis.click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
                time.sleep(WAIT_CLICK)
                
                image = vis.capture_full_client(hwnd)
                selected_state = vis.detect_selection_state(image, target_click)
                
                if selected_state["selected"]:
                    selected_name = random_target.get("name", f"Random_{attempt}")
                    used_names.add(selected_name)
                    capture(hwnd, attempt_dir, f"after-select-random-{selected_name}.jpg", target_click)
                    log(f"  ✓ 选中随机NPC: {selected_name}")
                    break
                
                target_click = None
        
        if not target_click:
            log("  ✗ 无法找到可用的NPC")
            return False
        
        capture(hwnd, attempt_dir, "02-npc-selected.jpg", target_click)
        
        # 3. 打开详情面板
        view_click = open_view_panel(hwnd, target_click, attempt_dir)
        capture(hwnd, attempt_dir, "03-view-opened.jpg", view_click)
        
        # 4. 检测好感度
        threshold_info = check_favor_threshold(hwnd, attempt_dir)
        
        # 5. 执行赠礼（如果需要）
        execute_gift_flow(hwnd, threshold_info, attempt_dir)
        capture(hwnd, attempt_dir, "04-gift-done.jpg")
        
        # 6. 执行聊天
        execute_chat_flow(hwnd, selected_name, attempt_dir)
        capture(hwnd, attempt_dir, "05-chat-done.jpg")
        
        log(f"\n✓✓✓ 第{npc_index}个NPC ({selected_name}) 完成！\n")
        return True
        
    except Exception as e:
        log(f"\n✗✗✗ 第{npc_index}个NPC失败: {e}\n")
        import traceback
        log(traceback.format_exc())
        
        # 尝试恢复
        try:
            reset_to_clean_state(hwnd)
        except:
            pass
        
        return False


def main():
    """主函数"""
    log("="*70)
    log("三人NPC聊天测试 - 开始 (重构版)")
    log(f"目标: 成功聊天 {TARGETS_TO_CHAT} 个NPC")
    log(f"输出目录: {OUTPUT_BASE_DIR}")
    log("="*70)
    
    # 查找游戏窗口
    hwnd, activation = worker.resolve_game_window(GAME_WINDOW_TITLE)
    if not hwnd:
        log("✗ 错误: 未找到游戏窗口")
        return 1
    
    log(f"✓ 找到游戏窗口 (HWND={hwnd})")
    if activation:
        log(f"  激活方式: {activation}")
    
    # 创建输出目录
    OUTPUT_BASE_DIR.mkdir(parents=True, exist_ok=True)
    
    # 禁用输入保护
    worker.INPUT_GUARD.configure(False)
    
    # 执行测试
    used_names = set()
    success_count = 0
    
    for i in range(1, TARGETS_TO_CHAT + 1):
        success = process_one_npc(hwnd, i, used_names)
        
        if success:
            success_count += 1
            log(f"进度: {success_count}/{TARGETS_TO_CHAT} 完成")
        else:
            log(f"进度: {success_count}/{TARGETS_TO_CHAT} 完成 (第{i}个失败)")
        
        # NPC之间间隔
        if i < TARGETS_TO_CHAT:
            log("\n等待2秒后继续下一个NPC...\n")
            time.sleep(2.0)
    
    # 总结
    log("\n" + "="*70)
    log("测试完成总结")
    log("="*70)
    log(f"总目标数: {TARGETS_TO_CHAT}")
    log(f"成功数量: {success_count}")
    log(f"成功率: {success_count/TARGETS_TO_CHAT*100:.1f}%")
    log(f"输出目录: {OUTPUT_BASE_DIR}")
    
    if success_count == TARGETS_TO_CHAT:
        log("\n✓✓✓ 全部成功！✓✓✓")
        return 0
    else:
        log(f"\n✗✗✗ 部分失败 ({success_count}/{TARGETS_TO_CHAT}) ✗✗✗")
        return 1


if __name__ == "__main__":
    try:
        exit_code = main()
        sys.exit(exit_code)
    except KeyboardInterrupt:
        log("\n\n用户中断")
        sys.exit(1)
    except Exception as e:
        log(f"\n\n异常退出: {e}")
        import traceback
        log(traceback.format_exc())
        sys.exit(1)
import json
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import validate_input_state as vis
import windows_input_worker as input_worker


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = PROJECT_ROOT / "tmp" / "three_npc_chat_test"
GAME_WINDOW_TITLE = "天涯明月刀手游"
TARGETS_TO_CHAT = 3
PREFERRED_TARGET_NAMES = ["轩辕静安", "乔疯", "梅清流", "净尘", "梅沧寒"]
WAIT_AFTER_TARGET_CLICK_MS = 220
WAIT_AFTER_UI_CLICK_MS = 360
CHAT_LINES = [
    "我先拿点小生意当见面礼,别嫌我手黑。",
    "你这人看着稳,我想和你多来往几回。",
    "今儿先聊到这,改天我再带点好东西来。",
]


def log(message: str) -> None:
    """打印日志到stdout和文件"""
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_line = f"[{timestamp}] {message}"
    print(log_line, flush=True)
    
    # 同时写入日志文件
    log_file = TMP_DIR / "test_log.txt"
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(log_line + "\n")


def build_named_point(hwnd: int, point_name: str) -> dict:
    x_ratio, y_ratio = input_worker.ACTION_POINTS[point_name]
    return vis.build_screen_point_from_ratio(hwnd, x_ratio, y_ratio)


def capture_step(hwnd: int, output_dir: Path, name: str, click_point: dict | None = None) -> str:
    image = vis.capture_full_client(hwnd)
    client_x = None if click_point is None else click_point.get("clientX")
    client_y = None if click_point is None else click_point.get("clientY")
    return vis.save_debug_image(image, name, client_x, client_y, output_dir)


def stage_snapshot(hwnd: int) -> dict:
    state = input_worker.detect_npc_interaction_stage(hwnd)
    return {
        "stage": state["stage"],
        "texts": state.get("texts", {}),
    }


def detect_gift_threshold(hwnd: int, output_dir: Path) -> dict:
    """检测好感度阈值 - 截图验证用"""
    log(">>> 步骤: 检测好感度阈值")
    
    gift_click = build_named_point(hwnd, "gift")
    log(f"点击赠礼按钮: {gift_click}")
    vis.click_screen_point(hwnd, gift_click["screenX"], gift_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    
    # 截图:打开赠礼界面后
    capture_step(hwnd, output_dir, "gift-opened-for-threshold-check.jpg", gift_click)
    
    threshold_info = input_worker.detect_target_threshold(hwnd)
    current_stage = stage_snapshot(hwnd)
    favor_value = input_worker.parse_favor_value(current_stage["texts"].get("gift_panel", ""))
    
    log(f"当前阶段: {current_stage['stage']}")
    log(f"好感度阈值信息: {threshold_info}")
    log(f"当前好感度: {favor_value}")
    
    need_gift = favor_value is not None and favor_value < threshold_info["threshold"]
    log(f"是否需要送礼: {need_gift}")
    
    # 关闭赠礼界面
    input_worker.exit_panel(hwnd)
    time.sleep(0.35)
    
    capture_step(hwnd, output_dir, "gift-closed-after-threshold-check.jpg")
    
    return {
        "threshold": threshold_info["threshold"],
        "currentFavor": favor_value,
        "needGift": need_gift,
    }


def execute_gift_flow(hwnd: int, output_dir: Path, threshold_info: dict) -> dict:
    """执行赠礼流程 - 截图验证用"""
    log(">>> 步骤: 执行赠礼流程")
    
    result = {
        "thresholdInfo": threshold_info,
        "steps": [],
        "giftRounds": 0,
    }
    
    if not threshold_info["needGift"]:
        log("好感度已满,跳过赠礼")
        result["skipped"] = True
        result["reason"] = "favor_already_maxed"
        return result
    
    gift_click = build_named_point(hwnd, "gift")
    log(f"打开赠礼界面")
    vis.click_screen_point(hwnd, gift_click["screenX"], gift_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    
    capture_step(hwnd, output_dir, "gift-screen-opened.jpg", gift_click)
    
    gift_state = stage_snapshot(hwnd)
    if gift_state["stage"] != "gift_screen":
        raise RuntimeError(f"GIFT_SCREEN_NOT_OPENED: {gift_state['stage']}")
    
    favor_before = input_worker.parse_favor_value(gift_state["texts"].get("gift_panel", ""))
    log(f"赠礼前好感度: {favor_before}")
    
    max_gift_rounds = 6
    for gift_round in range(1, max_gift_rounds + 1):
        log(f"--- 赠礼轮次 {gift_round}/{max_gift_rounds} ---")
        
        # 点击第一个礼物槽位
        slot_point = build_named_point(hwnd, "gift_first_slot")
        log(f"点击礼物槽位")
        vis.click_screen_point(hwnd, slot_point["screenX"], slot_point["screenY"])
        time.sleep(0.18)
        
        capture_step(hwnd, output_dir, f"gift-slot-{gift_round:02d}-clicked.jpg", slot_point)
        
        # 点击赠送按钮
        submit_point = build_named_point(hwnd, "gift_submit")
        log(f"点击赠送按钮")
        vis.click_screen_point(hwnd, submit_point["screenX"], submit_point["screenY"])
        time.sleep(0.46)
        
        capture_step(hwnd, output_dir, f"gift-submit-{gift_round:02d}-clicked.jpg", submit_point)
        
        # 检查是否还在赠礼界面
        updated_state = stage_snapshot(hwnd)
        if updated_state["stage"] != "gift_screen":
            log(f"警告: 赠礼界面提前关闭 - {updated_state['stage']}")
            break
        
        favor_after = input_worker.parse_favor_value(updated_state["texts"].get("gift_panel", ""))
        log(f"赠礼后好感度: {favor_after}")
        
        result["giftRounds"] = gift_round
        
        if favor_after is not None and favor_after >= threshold_info["threshold"]:
            log(f"✓ 已达到好感度阈值 {threshold_info['threshold']}")
            break
    
    log(f"赠礼完成,共 {result['giftRounds']} 轮")
    
    # 关闭赠礼界面
    input_worker.exit_panel(hwnd)
    time.sleep(0.35)
    capture_step(hwnd, output_dir, "gift-panel-exited.jpg")
    
    return result


def execute_chat_flow(hwnd: int, output_dir: Path, target_name: str) -> dict:
    """执行聊天流程 - 截图验证用"""
    log(f">>> 步骤: 执行聊天流程 (目标: {target_name})")
    
    result = {
        "targetName": target_name,
        "messagesSent": 0,
    }
    
    # 点击交谈按钮
    talk_click = build_named_point(hwnd, "talk")
    log(f"点击交谈按钮")
    vis.click_screen_point(hwnd, talk_click["screenX"], talk_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    capture_step(hwnd, output_dir, "talk-button-clicked.jpg", talk_click)
    
    # 点击闲聊按钮
    small_talk_click = build_named_point(hwnd, "small_talk")
    log(f"点击闲聊按钮")
    vis.click_screen_point(hwnd, small_talk_click["screenX"], small_talk_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    capture_step(hwnd, output_dir, "small-talk-button-clicked.jpg", small_talk_click)
    
    # 点击确认按钮
    confirm_click = build_named_point(hwnd, "small_talk_confirm_dialog")
    log(f"点击确认按钮")
    vis.click_screen_point(hwnd, confirm_click["screenX"], confirm_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    capture_step(hwnd, output_dir, "confirm-small-talk-clicked.jpg", confirm_click)
    
    chat_ready_state = stage_snapshot(hwnd)
    log(f"聊天界面状态: {chat_ready_state['stage']}")
    
    if chat_ready_state["stage"] != "chat_ready":
        raise RuntimeError(f"CHAT_NOT_READY: {chat_ready_state['stage']}")
    
    log("✓ 聊天界面已就绪")
    
    # 发送聊天消息
    for index, line in enumerate(CHAT_LINES, start=1):
        log(f"--- 发送消息 {index}/{len(CHAT_LINES)}: {line} ---")
        
        send_state = input_worker.send_chat_message(hwnd, line, False, 0)
        time.sleep(0.24)
        
        capture_step(hwnd, output_dir, f"chat-message-{index:02d}-sent.jpg")
        
        after_send_state = stage_snapshot(hwnd)
        log(f"发送后状态: {after_send_state['stage']}")
        
        if after_send_state["stage"] != "chat_ready":
            raise RuntimeError(f"CHAT_LEFT_READY_AFTER_SEND: {after_send_state['stage']}")
        
        result["messagesSent"] = index
    
    log(f"✓ 成功发送 {result['messagesSent']} 条消息")
    
    # 关闭聊天界面
    chat_exit_click = build_named_point(hwnd, "chat_exit")
    log(f"关闭聊天界面")
    vis.click_screen_point(hwnd, chat_exit_click["screenX"], chat_exit_click["screenY"])
    time.sleep(0.28)
    capture_step(hwnd, output_dir, "chat-closed.jpg", chat_exit_click)
    
    return result


def find_and_select_target(hwnd: int, attempt_index: int, used_targets: set) -> tuple[dict, dict] | None:
    """查找并选择目标NPC"""
    log(f">>> 步骤: 查找并选择目标NPC (尝试 #{attempt_index})")
    
    bounds = vis.get_window_bounds(hwnd)
    
    # 优先使用预设名称
    for preferred_name in PREFERRED_TARGET_NAMES:
        if preferred_name in used_targets:
            log(f"跳过已使用的目标: {preferred_name}")
            continue
        
        log(f"尝试查找预设NPC: {preferred_name}")
        named_anchor = input_worker.find_named_npc_in_scene(hwnd, preferred_name)
        
        if not named_anchor:
            log(f"未找到NPC: {preferred_name}")
            continue
        
        target_click = {
            "screenX": int(named_anchor["screenX"]),
            "screenY": int(named_anchor["screenY"]),
            "clientX": int(named_anchor["screenX"] - bounds["left"]),
            "clientY": int(named_anchor["screenY"] - bounds["top"]),
            "name": preferred_name,
            "source": "preferred_named_anchor",
        }
        
        log(f"找到NPC {preferred_name}, 点击位置: ({target_click['screenX']}, {target_click['screenY']})")
        
        # 点击选择
        vis.click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
        time.sleep(WAIT_AFTER_TARGET_CLICK_MS / 1000.0)
        
        # 验证选择状态
        selected_image = vis.capture_full_client(hwnd)
        selected_state = vis.detect_selection_state(selected_image, target_click)
        
        capture_step(hwnd, TMP_DIR / f"npc_{len(used_targets)+1:02d}", 
                    f"select-{preferred_name}.jpg", target_click)
        
        if selected_state["selected"]:
            log(f"✓ 成功选择NPC: {preferred_name}")
            used_targets.add(preferred_name)
            return {"name": preferred_name}, target_click
        else:
            log(f"✗ 选择失败: {preferred_name}")
    
    # 如果预设名称都用完了,尝试随机目标
    log("预设NPC已全部使用,尝试随机目标...")
    for candidate_index in range(1, 6):
        log(f"尝试随机目标 #{candidate_index}")
        random_target = vis.find_random_npc_target(hwnd, attempt_index + candidate_index)
        
        if random_target is None:
            continue
        
        target_click = vis.build_target_click_from_bbox(hwnd, random_target)
        
        vis.click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
        time.sleep(WAIT_AFTER_TARGET_CLICK_MS / 1000.0)
        
        selected_image = vis.capture_full_client(hwnd)
        selected_state = vis.detect_selection_state(selected_image, target_click)
        
        if selected_state["selected"]:
            target_name = random_target["name"]
            log(f"✓ 成功选择随机NPC: {target_name}")
            used_targets.add(target_name)
            return random_target, target_click
    
    log("✗ 未找到可用的NPC目标")
    return None


def open_view_panel(hwnd: int, output_dir: Path, target_click: dict) -> dict:
    """打开详情面板"""
    log(">>> 步骤: 打开详情面板")
    
    view_click = input_worker.find_view_button_near_click(hwnd, target_click["screenX"], target_click["screenY"])
    if view_click is None:
        raise RuntimeError("VIEW_BUTTON_NOT_FOUND")
    
    bounds = vis.get_window_bounds(hwnd)
    view_click["clientX"] = int(view_click["screenX"] - bounds["left"])
    view_click["clientY"] = int(view_click["screenY"] - bounds["top"])
    
    log(f"点击查看按钮: ({view_click['screenX']}, {view_click['screenY']})")
    vis.click_screen_point(hwnd, view_click["screenX"], view_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    
    capture_step(hwnd, output_dir, "view-panel-opened.jpg", view_click)
    
    detail_state = stage_snapshot(hwnd)
    log(f"详情面板状态: {detail_state['stage']}")
    
    return view_click


def process_single_npc(hwnd: int, npc_index: int, used_targets: set) -> bool:
    """处理单个NPC的完整流程"""
    log(f"\n{'='*60}")
    log(f"开始处理 NPC #{npc_index}")
    log(f"{'='*60}\n")
    
    output_dir = TMP_DIR / f"npc_{npc_index:02d}"
    output_dir.mkdir(parents=True, exist_ok=True)
    
    try:
        # 重置到世界状态
        log("--- 重置到世界状态 ---")
        vis.reset_to_world(hwnd)
        time.sleep(0.5)
        capture_step(hwnd, output_dir, "world-reset.jpg")
        
        # 查找并选择目标
        target_info = find_and_select_target(hwnd, npc_index, used_targets)
        if target_info is None:
            log("✗ 未能找到可用的NPC目标")
            return False
        
        target, target_click = target_info
        target_name = target["name"]
        log(f"✓ 已选择目标: {target_name}")
        
        # 打开详情面板
        view_click = open_view_panel(hwnd, output_dir, target_click)
        
        # 检测好感度阈值
        threshold_info = detect_gift_threshold(hwnd, output_dir)
        
        # 执行赠礼流程(如果需要)
        if threshold_info["needGift"]:
            log("\n>>> 开始赠礼流程")
            gift_result = execute_gift_flow(hwnd, output_dir, threshold_info)
            log(f"赠礼结果: {gift_result['giftRounds']} 轮")
        else:
            log("\n>>> 跳过赠礼流程(好感度已满)")
        
        # 执行聊天流程
        log("\n>>> 开始聊天流程")
        chat_result = execute_chat_flow(hwnd, output_dir, target_name)
        log(f"聊天结果: 发送 {chat_result['messagesSent']} 条消息")
        
        log(f"\n✓✓✓ NPC #{npc_index} ({target_name}) 处理成功! ✓✓✓\n")
        return True
        
    except Exception as exc:
        log(f"\n✗✗✗ NPC #{npc_index} 处理失败: {exc} ✗✗✗\n")
        import traceback
        log(traceback.format_exc())
        
        # 失败后重置
        try:
            log("尝试重置到世界状态...")
            vis.reset_to_world(hwnd)
        except Exception:
            pass
        
        return False


def main() -> int:
    log("=" * 80)
    log("三人NPC聊天测试开始")
    log(f"目标数量: {TARGETS_TO_CHAT}")
    log(f"输出目录: {TMP_DIR}")
    log("=" * 80)
    
    hwnd, activation = input_worker.resolve_game_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        log("✗ 错误: 未找到游戏窗口")
        return 1
    
    log(f"✓ 找到游戏窗口, HWND: {hwnd}")
    if activation:
        log(f"窗口激活方式: {activation}")
    
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    input_worker.INPUT_GUARD.configure(False)
    
    used_targets = set()
    completed_count = 0
    
    for npc_index in range(1, TARGETS_TO_CHAT + 1):
        success = process_single_npc(hwnd, npc_index, used_targets)
        
        if success:
            completed_count += 1
            log(f"\n进度: {completed_count}/{TARGETS_TO_CHAT} 完成\n")
        else:
            log(f"\n进度: {completed_count}/{TARGETS_TO_CHAT} 完成 (NPC #{npc_index} 失败)\n")
        
        # NPC之间等待时间
        if npc_index < TARGETS_TO_CHAT:
            log(f"等待 2 秒后继续下一个NPC...")
            time.sleep(2.0)
    
    # 最终总结
    log("\n" + "=" * 80)
    log("测试完成总结")
    log("=" * 80)
    log(f"总目标数: {TARGETS_TO_CHAT}")
    log(f"成功完成: {completed_count}")
    log(f"成功率: {completed_count/TARGETS_TO_CHAT*100:.1f}%")
    
    if completed_count == TARGETS_TO_CHAT:
        log("\n✓✓✓ 所有NPC聊天测试成功! ✓✓✓")
        return 0
    else:
        log(f"\n✗✗✗ 测试部分失败,仅完成 {completed_count}/{TARGETS_TO_CHAT} ✗✗✗")
        return 1


if __name__ == "__main__":
    try:
        exit_code = main()
        raise SystemExit(exit_code)
    except KeyboardInterrupt:
        log("\n\n用户中断测试")
        raise SystemExit(1)
    except Exception as e:
        log(f"\n\n测试异常退出: {e}")
        import traceback
        log(traceback.format_exc())
        raise SystemExit(1)
