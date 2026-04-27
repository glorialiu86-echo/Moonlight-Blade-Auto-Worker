import base64
import ctypes
import io
import json
from pathlib import Path
import re
import sys
import time
from typing import Any

import cv2
import mss
import numpy as np
import pydirectinput
import pyperclip
import win32api
import win32con
import win32gui
from PIL import Image, ImageDraw
from rapidocr_onnxruntime import RapidOCR


pydirectinput.FAILSAFE = False
DEFAULT_POST_DELAY_MS = 350
DEFAULT_MOVE_PULSE_MS = 160
DEFAULT_INTERACT_TIMEOUT_MS = 4500
DEFAULT_SCAN_INTERVAL_MS = 180
DEFAULT_CAMERA_DRAG_MS = 220
DEFAULT_VERIFY_SETTLE_MS = 180
OCR_ENGINE = None
FIRST_STEALTH_BUFF_STATE = {
    "date": "",
    "used": False,
}
TMP_DIR = Path(__file__).resolve().parents[1] / "tmp"
CLICK_TRACE_DIR = TMP_DIR / "click-trace"
GAME_FIXED_CLIENT_WIDTH = 2560
GAME_FIXED_CLIENT_HEIGHT = 1440
JPEG_SAVE_QUALITY = 88
WORLD_HUD_KEYWORDS = ["感知", "潜行", "微风拂柳", "[Shift]", "[Space]", "叫卖"]
EXTERNAL_INPUT_MOUSE_DELTA_PX = 2
EXTERNAL_INPUT_CHECK_INTERVAL_MS = 40
EXTERNAL_INPUT_VKS = [
    win32con.VK_LBUTTON,
    win32con.VK_RBUTTON,
    win32con.VK_MBUTTON,
    win32con.VK_XBUTTON1,
    win32con.VK_XBUTTON2,
    win32con.VK_SHIFT,
    win32con.VK_CONTROL,
    win32con.VK_MENU,
    win32con.VK_SPACE,
    win32con.VK_TAB,
    win32con.VK_RETURN,
    win32con.VK_ESCAPE,
    win32con.VK_UP,
    win32con.VK_DOWN,
    win32con.VK_LEFT,
    win32con.VK_RIGHT,
    ord("W"),
    ord("A"),
    ord("S"),
    ord("D"),
    ord("Q"),
    ord("E"),
    ord("R"),
    ord("F"),
    ord("G"),
    ord("X"),
    ord("C"),
    ord("V"),
    ord("B"),
]


def get_cursor_position() -> tuple[int, int]:
    point = win32api.GetCursorPos()
    return int(point[0]), int(point[1])


def get_pressed_keys() -> set[int]:
    pressed: set[int] = set()
    for vk in EXTERNAL_INPUT_VKS:
        if win32api.GetAsyncKeyState(vk) & 0x8000:
            pressed.add(vk)
    return pressed


class ExternalInputGuard:
    def __init__(self) -> None:
        self.enabled = False
        self.cursor = (0, 0)
        self.pressed_keys: set[int] = set()

    def configure(self, enabled: bool) -> None:
        self.enabled = enabled
        self.refresh_baseline()

    def refresh_baseline(self) -> None:
        self.cursor = get_cursor_position()
        self.pressed_keys = get_pressed_keys()

    def check_or_raise(self, action_title: str = "") -> None:
        if not self.enabled:
            return

        cursor = get_cursor_position()
        pressed_keys = get_pressed_keys()
        moved = abs(cursor[0] - self.cursor[0]) >= EXTERNAL_INPUT_MOUSE_DELTA_PX or abs(cursor[1] - self.cursor[1]) >= EXTERNAL_INPUT_MOUSE_DELTA_PX
        new_keys = sorted(pressed_keys - self.pressed_keys)

        if moved or new_keys:
            raise ActionExecutionError(
                "Detected external mouse or keyboard input. AI execution was stopped.",
                error_code="EXTERNAL_INPUT_INTERRUPTED",
                failed_step={
                    "actionTitle": action_title,
                    "cursorBefore": {"x": self.cursor[0], "y": self.cursor[1]},
                    "cursorAfter": {"x": cursor[0], "y": cursor[1]},
                    "newKeys": new_keys,
                },
            )

        self.cursor = cursor
        self.pressed_keys = pressed_keys

    def guarded_sleep(self, duration_ms: int, action_title: str = "") -> None:
        if duration_ms <= 0:
            self.check_or_raise(action_title)
            return

        if not self.enabled:
            time.sleep(duration_ms / 1000)
            return

        deadline = time.time() + duration_ms / 1000
        while time.time() < deadline:
            self.check_or_raise(action_title)
            remaining_ms = max(0, int((deadline - time.time()) * 1000))
            time.sleep(min(EXTERNAL_INPUT_CHECK_INTERVAL_MS, remaining_ms) / 1000)


INPUT_GUARD = ExternalInputGuard()
# Reverted on April 20, 2026 after live regression:
# the stricter threshold caused visible magnifier targets to be misclassified
# as missing. Keep this looser so the previously stable "see magnifier -> use it"
# path remains the single owner again.
MIN_VIEW_BUTTON_SCORE = 55.0


def set_process_dpi_aware() -> None:
    windll = getattr(ctypes, "windll", None)
    if windll is None:
        return

    try:
        if windll.user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4)):
            return
    except Exception:
        pass

    try:
        windll.shcore.SetProcessDpiAwareness(2)
        return
    except Exception:
        pass

    try:
        windll.user32.SetProcessDPIAware()
    except Exception:
        pass


set_process_dpi_aware()


class ActionExecutionError(RuntimeError):
    def __init__(
        self,
        message: str,
        error_code: str = "INPUT_EXECUTION_FAILED",
        failed_step: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.failed_step = failed_step


FATAL_ACTION_ERROR_CODES = {
    "EXTERNAL_INPUT_INTERRUPTED",
}

FATAL_RUNTIME_ERROR_PREFIXES = (
    "shortcut name is required",
    "unknown shortcut:",
    "open_named_npc_trade action requires",
    "named_npc_trade_flow action requires",
    "open_named_vendor_purchase action requires",
    "Unsupported fixed vendor item:",
    "Unsupported steal button index:",
    "Current screen is not hawking screen",
    "click_named_point action requires",
    "type_text action requires",
    "send_chat_message action requires",
    "press_key action requires",
    "Unsupported input action:",
    "Unreachable miaoqu trigger state",
)


def is_fatal_action_error(exc: ActionExecutionError) -> bool:
    return str(exc.error_code or "").strip() in FATAL_ACTION_ERROR_CODES


def is_fatal_runtime_error(message: str) -> bool:
    normalized = str(message or "").strip()
    return any(normalized.startswith(prefix) for prefix in FATAL_RUNTIME_ERROR_PREFIXES)

NPC_STAGE_ROIS = {
    "look_button": (0.26, 0.48, 0.40, 0.62),
    "moving_view_search": (0.22, 0.12, 0.76, 0.76),
    "bottom_right_actions": (0.64, 0.70, 0.98, 0.98),
    "confirm_dialog": (0.16, 0.10, 0.84, 0.84),
    "chat_panel": (0.00, 0.00, 0.46, 0.98),
    "gift_panel": (0.64, 0.00, 1.00, 1.00),
    "trade_panel": (0.18, 0.00, 1.00, 1.00),
    "selected_target": (0.20, 0.18, 0.42, 0.36),
    "scene_npc_search": (0.18, 0.14, 0.98, 0.88),
}

STEALTH_ROIS = {
    "front_name_band": (0.28, 0.10, 0.72, 0.28),
    "exit_button": (0.86, 0.44, 0.99, 0.58),
    "result_banner": (0.26, 0.22, 0.74, 0.56),
    "steal_button_stack": (0.82, 0.28, 0.99, 0.94),
    "scene_color_probe": (0.04, 0.05, 0.94, 0.92),
    "knockout_action_cluster": (0.74, 0.56, 0.98, 0.96),
    "knockout_plus_upper": (0.84, 0.56, 0.95, 0.72),
    "knockout_plus_lower": (0.74, 0.79, 0.86, 0.96),
    "loot_submit_button": (0.47, 0.83, 0.66, 0.96),
    "loot_right_panel": (0.66, 0.02, 0.99, 0.98),
}

MAP_STAGE_ROIS = {
    "left_panel": (0.00, 0.05, 0.40, 0.90),
    "route_panel": (0.60, 0.76, 0.86, 0.96),
    "keypad_panel": (0.36, 0.50, 0.78, 0.94),
}

MINIMAP_COORDINATE_ROIS = {
    "primary": (0.82, 0.02, 0.95, 0.10),
    "secondary": (0.80, 0.00, 0.94, 0.12),
    "fallback": (0.78, 0.00, 0.92, 0.14),
}

NPC_CAPTURE_SCAN_POINTS = [
    (0.48, 0.40), (0.55, 0.40), (0.62, 0.40), (0.69, 0.40),
    (0.48, 0.48), (0.55, 0.48), (0.62, 0.48), (0.69, 0.48),
    (0.48, 0.56), (0.55, 0.56), (0.62, 0.56), (0.69, 0.56),
    (0.48, 0.64), (0.55, 0.64), (0.62, 0.64), (0.69, 0.64),
]

ACTION_POINTS = {
    "talk": (1830 / 2544, 1217 / 1388),
    # User-pinned fixed UI point: small-talk entry center was re-marked from
    # the provided red-circle screenshot on April 20, 2026. Do not adjust
    # casually unless re-validated against a fresh capture on this machine.
    "small_talk": (1697 / 2544, 1089 / 1388),
    "confirm_small_talk": (1090 / 1904, 781 / 1041),
    # Re-marked on April 27, 2026 from the live NPC action menu after the
    # ending-trade handoff. The old point sat between 详情 and 交易.
    "trade": (1602 / 1904, 840 / 1041),
    # Stable fixed UI point: this gift button center was re-marked on the
    # current 2538x1384 client capture and verified in the real
    # gift -> close -> retarget loop. Do not adjust casually unless it is
    # re-validated against fresh screenshots on this machine.
    "gift": (2328 / 2544, 1134 / 1388),
    "target_close": (958 / 2544, 203 / 1388),
    "close_panel": (2004 / 2048, 32 / 1152),
    "trade_left_item_tab": (49 / 2544, 530 / 1388),
    "trade_left_item_slot": (203 / 2544, 314 / 1388),
    # Left-side 上架 button on the current left-item trade panel.
    "trade_left_up_shelf_button": (704 / 1902, 842 / 1040),
    "trade_sell_money_slot": (2038 / 2544, 120 / 1388),
    "trade_gift_item_tab": (49 / 2544, 530 / 1388),
    "trade_gift_item_slot": (166 / 2544, 388 / 1388),
    "trade_sell_item_tab": (2440 / 2544, 318 / 1388),
    "trade_sell_item_slot": (2068 / 2544, 409 / 1388),
    "trade_right_money_slot": (218 / 1902, 304 / 1040),
    "trade_scale_button": (756 / 1902, 689 / 1040),
    "trade_sell_scale_button": (756 / 1902, 689 / 1040),
    "trade_right_up_shelf_button": (704 / 1902, 842 / 1040),
    "trade_final_submit_button": (1005 / 1902, 969 / 1040),
    "vendor_purchase_plus": (427 / 2544, 706 / 1388),
    # User re-marked on April 22, 2026 from the red-circled purchase panel:
    # keep these two points pinned to the visual centers of the max-quantity
    # arrow and the buy button. Do not adjust other vendor points here.
    "vendor_purchase_buy": (676 / 2538, 935 / 1384),
    "vendor_purchase_max_quantity": (870 / 2544, 724 / 1388),
    # Re-marked on April 27, 2026 from the live vendor purchase page:
    # click the visual center of the round top-right close button.
    "vendor_purchase_close": (1824 / 1904, 28 / 1041),
    "vendor_purchase_option": (2051 / 2544, 212 / 1388),
    "vendor_purchase_item_sanjiu": (2051 / 2544, 212 / 1388),
    "vendor_purchase_item_moding": (2051 / 2544, 485 / 1388),
    "hawking_inventory_first_slot": (2072 / 2544, 216 / 1388),
    "hawking_max_quantity": (1800 / 2544, 804 / 1388),
    # Re-marked on April 27, 2026 from the live hawking page after max quantity:
    # these are fixed UI buttons on this machine and should be owned by direct
    # clicks instead of keyboard shortcuts.
    "hawking_up_shelf_button": (1200 / 1904, 809 / 1041),
    "hawking_submit": (1778 / 1904, 923 / 1041),
    "steal_button_1": (2371 / 2544, 614 / 1388),
    "steal_button_2": (1916 / 2048, 704 / 1360),
    "steal_button_3": (1916 / 2048, 893 / 1360),
    "steal_button_4": (1916 / 2048, 1085 / 1360),
    "exit_stealth": (2275 / 2544, 493 / 1388),
    # User re-marked from the red-circle gift screenshot on April 20, 2026:
    # click the visual center of the first gift item, slightly lower than the
    # old point, so the detail pane can be opened/closed reliably before send.
    "gift_first_slot": (1719 / 2544, 632 / 1388),
    "gift_plus": (2027 / 2544, 1190 / 1388),
    "gift_submit": (2210 / 2544, 1172 / 1388),
    # Re-marked on April 27, 2026 from the live small-talk confirm dialog.
    "small_talk_confirm_dialog": (1090 / 1904, 781 / 1041),
    "small_talk_cancel_dialog": (815 / 1904, 781 / 1041),
    "chat_input": (278 / 2048, 1040 / 1152),
    # User re-marked on April 22, 2026 from the red-circled chat send button
    # and re-validated by drawing the expected mouse point back onto the latest
    # local chat-page reference capture. Keep this pinned unless re-marked.
    "chat_send": (975 / 2544, 1299 / 1388),
    "chat_exit": (1089 / 2544, 688 / 1388),
    # The user has pinned the in-game render resolution to 2560x1440, so the
    # coordinate route bar uses one fixed reference layout again.
    "map_coord_y_input": (1646 / GAME_FIXED_CLIENT_WIDTH, 1266 / GAME_FIXED_CLIENT_HEIGHT),
    "map_coord_x_input": (1869 / GAME_FIXED_CLIENT_WIDTH, 1266 / GAME_FIXED_CLIENT_HEIGHT),
    "map_go": (2062 / GAME_FIXED_CLIENT_WIDTH, 1258 / GAME_FIXED_CLIENT_HEIGHT),
    "teleport_confirm": (1440 / GAME_FIXED_CLIENT_WIDTH, 1036 / GAME_FIXED_CLIENT_HEIGHT),
    "drop_carried_target": (1728 / 2544, 779 / 1388),
    "loot_transfer_item": (1422 / 2048, 359 / 1152),
    "loot_put_in": (1134 / 2048, 858 / 1152),
    "loot_submit": (1517 / 2544, 1221 / 1388),
}

MAP_KEYPAD_POINTS = {
    "vertical": {
        "1": (995 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "2": (1155 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "3": (1317 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "4": (995 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "5": (1155 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "6": (1317 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "7": (995 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
        "8": (1155 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
        "9": (1317 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
        "0": (1478 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "delete": (1478 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "confirm": (1478 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
    },
    "horizontal": {
        "1": (1155 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "2": (1316 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "3": (1478 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "4": (1155 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "5": (1316 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "6": (1478 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "7": (1155 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
        "8": (1316 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
        "9": (1478 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
        "0": (1640 / GAME_FIXED_CLIENT_WIDTH, 944 / GAME_FIXED_CLIENT_HEIGHT),
        "delete": (1640 / GAME_FIXED_CLIENT_WIDTH, 784 / GAME_FIXED_CLIENT_HEIGHT),
        "confirm": (1640 / GAME_FIXED_CLIENT_WIDTH, 1105 / GAME_FIXED_CLIENT_HEIGHT),
    },
}

# Source of truth for the currently configured in-game shortcuts from the
# settings screen. Use these names instead of scattering raw key strings.
SHORTCUT_KEYS = {
    "menu": "esc",
    "caidan": "esc",
    "self_select": "f1",
    "select_self": "f1",
    "xuanziji": "f1",
    "teammate_1": "f2",
    "duiyou1": "f2",
    "teammate_2": "f3",
    "duiyou2": "f3",
    "teammate_3": "f4",
    "duiyou3": "f4",
    "teammate_4": "f5",
    "duiyou4": "f5",
    "switch_mode": "f8",
    "qiehuanmoshi": "f8",
    "season": "f10",
    "saiji": "f10",
    "shop": "f11",
    "shangcheng": "f11",
    "wardrobe": "f12",
    "yigui": "f12",
    "screenshot": "printscreen",
    "jietu": "printscreen",
    "martial_art": "`",
    "zhonghuaji": "`",
    "normal_attack": "1",
    "putonggongji": "1",
    "skill_1": "2",
    "jineng1": "2",
    "stealth": "2",
    "qianxing": "2",
    "skill_2": "3",
    "jineng2": "3",
    "sense": "3",
    "ganzhi": "3",
    "skill_3": "4",
    "jineng3": "4",
    "steal": "4",
    "miaoqu": "4",
    "miaoqv": "4",
    "hawking": "4",
    "jiaomai": "4",
    "skill_4": "5",
    "jineng4": "5",
    "skill_5": "6",
    "jineng5": "6",
    "martial_1": "7",
    "wuxue1": "7",
    "martial_2": "8",
    "wuxue2": "8",
    "martial_3": "9",
    "wuxue3": "9",
    "martial_4": "0",
    "wuxue4": "0",
    "camera": "-",
    "paizhao": "-",
    "voice": "=",
    "fayuyin": "=",
    "switch_target": "tab",
    "qiehuan": "tab",
    "qte1": "q",
    "forward": "w",
    "qianjin": "w",
    "qte2": "e",
    "block": "r",
    "gedang": "r",
    "breakaway": "t",
    "tuoliji": "t",
    "role": "y",
    "juese": "y",
    "friends": "u",
    "haoyou": "u",
    "achievement": "i",
    "chengjiu": "i",
    "guild": "o",
    "bangpai": "o",
    "martial_ui": "p",
    "wuxue_ui": "p",
    "arena": "[",
    "jingji": "[",
    "atlas": "]",
    "tujian": "]",
    "auto": "\\",
    "zidong": "\\",
    "run": "capslock",
    "kuaipao": "capslock",
    "move_left": "a",
    "zuoyi": "a",
    "move_back": "s",
    "houtui": "s",
    "move_right": "d",
    "youyi": "d",
    "interact": "f",
    "hudong": "f",
    "qte3": "g",
    "partner": "h",
    "huoban": "h",
    "gold_orchid": "j",
    "jinlan": "j",
    "identity": "k",
    "shenfen": "k",
    "team": "l",
    "duiwu": "l",
    "challenge": ";",
    "tiaozhan": ";",
    "script": "'",
    "huaben": "'",
    "roll": "shift",
    "shift": "shift",
    "sit": "x",
    "xiazuo": "x",
    "mount": "c",
    "zuoqi": "c",
    "qinggong": "v",
    "daqinggong": "v",
    "switch_camera": "b",
    "qiejingtou": "b",
    "bag": "n",
    "beibao": "n",
    "upgrade": "m",
    "qianghua": "m",
    "map": ",",
    "ditu": ",",
    "home": ".",
    "jiayuan": ".",
    "manual": "ctrl",
    "shoudong": "ctrl",
    "jump": "space",
    "space": "space",
    "chat": "enter",
    "liaotian": "enter",
    "scroll_top": "home",
    "daoding": "home",
    "page_up": "pageup",
    "shangfanye": "pageup",
    "scroll_bottom": "end",
    "daodi": "end",
    "page_down": "pagedown",
    "xiafanye": "pagedown",
    "look_up": "up",
    "shangkan": "up",
    "turn_left": "left",
    "zuozhuan": "left",
    "look_down": "down",
    "xiakan": "down",
    "turn_right": "right",
    "youzhuan": "right",
}

CHAT_KEYWORDS = ["点击输入聊天", "发送", "第一次见面", "好感度"]
GIFT_KEYWORDS = ["赠礼", "选择礼物", "赠送", "好感度"]
TRADE_KEYWORDS = ["交易结果预览", "交易倒计时", "上架", "我的", "总价"]
STEAL_KEYWORDS = ["妙取", "可妙取物品", "成功率", "用时"]
CONFIRM_KEYWORDS = ["确认", "闲聊", "取消"]
MAP_KEYWORDS = ["点击输入坐标寻路", "前往", "灵犀盏追踪目标", "通缉追踪目标"]
VENDOR_PURCHASE_KEYWORDS = ["进货", "购买", "购买数量", "每日进货体力消耗上限", "单价", "总价"]


HAWKING_SCREEN_KEYWORDS = ["上货", "货架", "库存", "出摊"]


KNOCKOUT_CONTEXT_KEYWORDS = ["扛走", "妙取", "搜刮"]


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def get_ocr_engine() -> RapidOCR:
    global OCR_ENGINE
    if OCR_ENGINE is None:
        OCR_ENGINE = RapidOCR()
    return OCR_ENGINE


DEFAULT_GAME_WINDOW_HINTS = ["天涯", "明月", "刀", "手游"]


DEFAULT_GAME_WINDOW_HINTS = [
    "\u5929\u6daf",
    "\u660e\u6708",
    "\u5200",
    "\u624b\u6e38",
]
GAME_PLAYER_NAME_ANCHORS = [
    "\u7c7d\u5cb7\u56e2\u961f",
    "\u56e2\u961f",
]

def normalize_window_text(text: str) -> str:
    return re.sub(r"\s+", "", str(text or "")).lower()


def build_window_search_terms(window_title_keyword: str) -> list[str]:
    raw = str(window_title_keyword or "").strip()
    if not raw:
        return list(DEFAULT_GAME_WINDOW_HINTS)

    parts = [part.strip() for part in re.split(r"[|,;/\s]+", raw) if part.strip()]
    if not parts:
        return list(DEFAULT_GAME_WINDOW_HINTS)

    search_terms: list[str] = []
    for part in parts:
        normalized = normalize_window_text(part)
        if normalized and normalized not in search_terms:
            search_terms.append(normalized)

    for hint in DEFAULT_GAME_WINDOW_HINTS:
        normalized_hint = normalize_window_text(hint)
        if normalized_hint and normalized_hint not in search_terms:
            search_terms.append(normalized_hint)

    return search_terms


def list_window_candidates(window_title_keyword: str) -> list[dict[str, Any]]:
    search_terms = build_window_search_terms(window_title_keyword)
    foreground_hwnd = win32gui.GetForegroundWindow()
    candidates: list[dict[str, Any]] = []

    def callback(hwnd: int, _lparam: int) -> bool:
        if not win32gui.IsWindowVisible(hwnd):
            return True

        title = win32gui.GetWindowText(hwnd).strip()
        if not title:
            return True

        try:
            class_name = win32gui.GetClassName(hwnd)
        except Exception:
            class_name = ""

        try:
            _client_left, _client_top = win32gui.ClientToScreen(hwnd, (0, 0))
            _client_x, _client_y, client_right, client_bottom = win32gui.GetClientRect(hwnd)
        except Exception:
            return True

        width = max(0, int(client_right))
        height = max(0, int(client_bottom))
        area = width * height
        if area <= 0:
            return True

        normalized_title = normalize_window_text(title)
        matched_terms = [term for term in search_terms if term and term in normalized_title]
        all_hints_matched = all(normalize_window_text(hint) in normalized_title for hint in DEFAULT_GAME_WINDOW_HINTS)

        score = 0
        if hwnd == foreground_hwnd:
            score += 300
        score += min(area // 5000, 200)
        score += len(matched_terms) * 120
        if all_hints_matched:
            score += 240

        normalized_class = normalize_window_text(class_name)
        if "chrome_widgetwin" in normalized_class:
            score -= 120
        if "visualstudiocode" in normalized_title or "code" == normalized_title:
            score -= 260

        candidates.append(
            {
                "hwnd": hwnd,
                "title": title,
                "className": class_name,
                "width": width,
                "height": height,
                "area": area,
                "isForeground": hwnd == foreground_hwnd,
                "matchedTerms": matched_terms,
                "score": score,
            }
        )
        return True

    win32gui.EnumWindows(callback, 0)
    candidates.sort(
        key=lambda item: (
            int(item["score"]),
            int(item["isForeground"]),
            int(item["area"]),
        ),
        reverse=True,
    )
    return candidates


def find_window(window_title_keyword: str) -> int | None:
    candidates = list_window_candidates(window_title_keyword)
    if not candidates:
        return None

    best = candidates[0]
    if best["score"] < 100:
        return None
    return int(best["hwnd"])


def activate_game_window_by_player_name() -> dict[str, Any] | None:
    image, monitor = capture_virtual_screen()
    items = ocr_items(image)
    items.extend(ocr_items_upscaled(image, 2.0))

    best_match = None
    best_score = None
    for item in items:
        normalized = re.sub(r"\s+", "", str(item["text"] or ""))
        if not normalized:
            continue
        if not any(anchor in normalized for anchor in GAME_PLAYER_NAME_ANCHORS):
            continue

        score = float(item["score"])
        if normalized == GAME_PLAYER_NAME_ANCHORS[0]:
            score += 1.0

        if best_score is None or score > best_score:
            best_score = score
            best_match = {
                "text": normalized,
                "score": round(float(item["score"]), 4),
                "screenX": round(monitor["left"] + item["centerX"]),
                "screenY": round(monitor["top"] + item["centerY"] + 18),
            }

    if best_match is None:
        return None

    pydirectinput.click(x=int(best_match["screenX"]), y=int(best_match["screenY"]), button="left")
    INPUT_GUARD.refresh_baseline()
    time.sleep(0.25)
    return best_match


def resolve_game_window(window_title_keyword: str) -> tuple[int | None, dict[str, Any] | None]:
    hwnd = find_window(window_title_keyword)
    if hwnd:
        return hwnd, None

    activation = activate_game_window_by_player_name()
    if not activation:
        return None, None

    hwnd = find_window(window_title_keyword)
    return hwnd, activation


def get_window_bounds(hwnd: int) -> dict[str, Any]:
    client_left, client_top = win32gui.ClientToScreen(hwnd, (0, 0))
    _client_x, _client_y, client_right, client_bottom = win32gui.GetClientRect(hwnd)
    return {
        "left": client_left,
        "top": client_top,
        "width": max(0, client_right),
        "height": max(0, client_bottom),
        "title": win32gui.GetWindowText(hwnd).strip(),
    }


def focus_window(hwnd: int) -> dict[str, Any]:
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.2)

    try:
        win32gui.SetForegroundWindow(hwnd)
        bounds = get_window_bounds(hwnd)
        bounds["focusMethod"] = "set_foreground"
        return bounds
    except Exception:
        bounds = get_window_bounds(hwnd)
        center_x = bounds["left"] + max(1, bounds["width"]) // 2
        center_y = bounds["top"] + max(1, bounds["height"]) // 2
        pydirectinput.click(x=center_x, y=center_y)
        time.sleep(0.2)
        bounds = get_window_bounds(hwnd)
        bounds["focusMethod"] = "click_activate"
        return bounds


def capture_window_region(hwnd: int, roi: tuple[float, float, float, float]) -> np.ndarray:
    bounds = get_window_bounds(hwnd)
    left = bounds["left"] + int(bounds["width"] * roi[0])
    top = bounds["top"] + int(bounds["height"] * roi[1])
    width = max(8, int(bounds["width"] * (roi[2] - roi[0])))
    height = max(8, int(bounds["height"] * (roi[3] - roi[1])))

    with mss.mss() as screen_capture:
        frame = np.array(
            screen_capture.grab(
                {
                    "left": left,
                    "top": top,
                    "width": width,
                    "height": height,
                }
            )
        )

    return frame[:, :, :3]


def capture_screen_rect(left: int, top: int, width: int, height: int) -> np.ndarray:
    with mss.mss() as screen_capture:
        frame = np.array(
            screen_capture.grab(
                {
                    "left": left,
                    "top": top,
                    "width": max(8, width),
                    "height": max(8, height),
                }
            )
        )

    return frame[:, :, :3]


def capture_virtual_screen() -> tuple[np.ndarray, dict[str, int]]:
    with mss.mss() as screen_capture:
        monitor = screen_capture.monitors[0]
        frame = np.array(screen_capture.grab(monitor))
    return frame[:, :, :3], {
        "left": int(monitor["left"]),
        "top": int(monitor["top"]),
        "width": int(monitor["width"]),
        "height": int(monitor["height"]),
    }


def save_debug_image(
    image: np.ndarray,
    name: str,
    click_point: tuple[int, int] | None = None,
) -> str:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    rgb = image[:, :, ::-1]
    debug_image = Image.fromarray(rgb.astype(np.uint8), mode="RGB")

    if click_point is not None:
        x, y = click_point
        draw = ImageDraw.Draw(debug_image)
        draw.ellipse((x - 7, y - 7, x + 7, y + 7), outline=(255, 80, 80), width=2)
        draw.line((x - 14, y, x + 14, y), fill=(255, 80, 80), width=2)
        draw.line((x, y - 14, x, y + 14), fill=(255, 80, 80), width=2)

    file_path = TMP_DIR / name
    if file_path.suffix.lower() != ".jpg":
        file_path = file_path.with_suffix(".jpg")
    debug_image.save(file_path, format="JPEG", quality=JPEG_SAVE_QUALITY, optimize=True)
    return str(file_path)


def slugify_debug_label(text: str) -> str:
    normalized = re.sub(r"\s+", "_", str(text or "").strip())
    normalized = re.sub(r"[^0-9A-Za-z_\-\u4e00-\u9fff]", "_", normalized)
    normalized = re.sub(r"_+", "_", normalized).strip("_")
    return normalized or "click"


def save_pre_click_trace(
    hwnd: int,
    screen_x: int,
    screen_y: int,
    label: str,
) -> dict[str, Any]:
    bounds = get_window_bounds(hwnd)
    image = capture_screen_rect(
        int(bounds["left"]),
        int(bounds["top"]),
        int(bounds["width"]),
        int(bounds["height"]),
    )
    relative_x = max(0, min(int(bounds["width"]) - 1, int(screen_x) - int(bounds["left"])))
    relative_y = max(0, min(int(bounds["height"]) - 1, int(screen_y) - int(bounds["top"])))
    CLICK_TRACE_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    trace_name = f"{timestamp}-{int(time.time() * 1000) % 1000:03d}-{slugify_debug_label(label)}.jpg"
    trace_path = save_debug_image(
        image,
        str(Path("click-trace") / trace_name),
        click_point=(relative_x, relative_y),
    )
    return {
        "path": trace_path,
        "windowBounds": bounds,
        "clientX": relative_x,
        "clientY": relative_y,
        "label": label,
    }


def ocr_text(image: np.ndarray) -> str:
    result = get_ocr_engine()(image)[0]

    if not result:
        return ""

    parts = []
    for item in result:
        if len(item) < 3:
            continue
        text = str(item[1] or "").strip().replace("\n", " ")
        if text:
            parts.append(text)

    return " ".join(parts)


def ocr_items(image: np.ndarray) -> list[dict[str, Any]]:
    result = get_ocr_engine()(image)[0]
    if not result:
        return []

    items: list[dict[str, Any]] = []
    for item in result:
        if len(item) < 3:
            continue

        box = item[0]
        text = str(item[1] or "").strip().replace("\n", " ")
        score = float(item[2] or 0)
        if not text or not box:
            continue

        points = [(float(point[0]), float(point[1])) for point in box]
        min_x = min(point[0] for point in points)
        max_x = max(point[0] for point in points)
        min_y = min(point[1] for point in points)
        max_y = max(point[1] for point in points)
        items.append(
            {
                "text": text,
                "score": round(score, 4),
                "minX": min_x,
                "maxX": max_x,
                "minY": min_y,
                "maxY": max_y,
                "centerX": (min_x + max_x) / 2,
                "centerY": (min_y + max_y) / 2,
            }
        )

    return items


def ocr_items_upscaled(image: np.ndarray, scale: float) -> list[dict[str, Any]]:
    if scale <= 1.0:
        return ocr_items(image)

    height, width = image.shape[:2]
    resized = cv2.resize(
        image,
        (max(1, int(round(width * scale))), max(1, int(round(height * scale)))),
        interpolation=cv2.INTER_CUBIC,
    )
    items = ocr_items(resized)
    if not items:
        return []

    normalized_items: list[dict[str, Any]] = []
    for item in items:
        normalized_items.append(
            {
                **item,
                "minX": item["minX"] / scale,
                "maxX": item["maxX"] / scale,
                "minY": item["minY"] / scale,
                "maxY": item["maxY"] / scale,
                "centerX": item["centerX"] / scale,
                "centerY": item["centerY"] / scale,
            }
        )
    return normalized_items


def capture_verify_frame(hwnd: int) -> np.ndarray:
    return capture_window_region(hwnd, (0.18, 0.16, 0.86, 0.86)).astype(np.int16)


def measure_frame_delta(before: np.ndarray, after: np.ndarray) -> dict[str, float]:
    min_height = min(before.shape[0], after.shape[0])
    min_width = min(before.shape[1], after.shape[1])
    before = before[:min_height, :min_width, :]
    after = after[:min_height, :min_width, :]
    diff = np.abs(after - before)
    mean_delta = float(np.mean(diff))
    gray_diff = np.mean(diff, axis=2)
    changed_ratio = float(np.mean(gray_diff > 12.0))
    return {
        "meanDelta": round(mean_delta, 3),
        "changedRatio": round(changed_ratio, 4),
    }


def capture_idle_baseline(
    hwnd: int,
    sample_gap_ms: int = 140,
    settle_before_ms: int = 220,
    sample_count: int = 4,
) -> dict[str, Any]:
    time.sleep(settle_before_ms / 1000)
    frames = [capture_verify_frame(hwnd)]

    for _ in range(max(1, sample_count) - 1):
        time.sleep(sample_gap_ms / 1000)
        frames.append(capture_verify_frame(hwnd))

    deltas = [
        measure_frame_delta(frames[index], frames[index + 1])
        for index in range(len(frames) - 1)
    ]
    baseline_delta = min(
        deltas,
        key=lambda item: (item["changedRatio"], item["meanDelta"]),
    )

    return {
        "firstFrame": frames[-2],
        "frame": frames[-1],
        "delta": baseline_delta,
        "sampleGapMs": sample_gap_ms,
        "settleBeforeMs": settle_before_ms,
        "sampleCount": sample_count,
    }


def encode_review_frames(baseline: dict[str, Any], after_frame: np.ndarray) -> str:
    buffer = io.BytesIO()
    np.savez_compressed(
        buffer,
        first_frame=baseline["firstFrame"][::4, ::4, :].astype(np.uint8),
        reference_frame=baseline["frame"][::4, ::4, :].astype(np.uint8),
        after_frame=after_frame[::4, ::4, :].astype(np.uint8),
    )
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def verify_dynamic_change(
    hwnd: int,
    baseline: dict[str, Any],
    settle_ms: int,
    mean_multiplier: float,
    ratio_multiplier: float,
    minimum_mean_floor: float,
    minimum_ratio_floor: float,
) -> dict[str, Any]:
    time.sleep(settle_ms / 1000)
    after_frame = capture_verify_frame(hwnd)
    delta = measure_frame_delta(baseline["frame"], after_frame)
    baseline_delta = baseline["delta"]
    required_mean = max(minimum_mean_floor, baseline_delta["meanDelta"] * mean_multiplier)
    required_ratio = max(minimum_ratio_floor, baseline_delta["changedRatio"] * ratio_multiplier)

    decision = "pass"
    if delta["meanDelta"] < required_mean * 0.7 and delta["changedRatio"] < required_ratio * 0.7:
        decision = "fail"
    elif delta["meanDelta"] < required_mean or delta["changedRatio"] < required_ratio:
        decision = "review"

    payload = {
        "baselineMeanDelta": baseline_delta["meanDelta"],
        "baselineChangedRatio": baseline_delta["changedRatio"],
        "meanDelta": delta["meanDelta"],
        "changedRatio": delta["changedRatio"],
        "requiredMeanDelta": round(required_mean, 3),
        "requiredChangedRatio": round(required_ratio, 4),
        "decision": decision,
        "sampleGapMs": baseline["sampleGapMs"],
        "settleBeforeMs": baseline.get("settleBeforeMs"),
        "sampleCount": baseline.get("sampleCount"),
        "settleMs": settle_ms,
    }

    if decision != "pass":
        payload["reviewArtifact"] = {
            "format": "npz_base64",
            "encoding": "base64",
            "downsampleStep": 4,
            "framesBase64": encode_review_frames(baseline, after_frame),
        }

    return payload


def contains_any_keyword(text: str, keywords: list[str]) -> bool:
    normalized = str(text or "").replace(" ", "")
    return any(keyword in normalized for keyword in keywords)


def count_keywords(text: str, keywords: list[str]) -> int:
    normalized = str(text or "").replace(" ", "")
    return sum(1 for keyword in keywords if keyword in normalized)


def looks_like_vendor_purchase_dialog(text: str, target_name: str = "", option_text: str = "") -> bool:
    normalized = str(text or "").replace(" ", "")
    if not normalized:
        return False
    strong_keywords = [
        "进货",
        "货物",
        "打零工",
        "低效",
        "告辞",
        "暂时不用",
        "进些货物",
        "我来进些货物",
    ]
    dynamic_keywords = [str(target_name or "").replace(" ", ""), str(option_text or "").replace(" ", "")]
    keywords = [keyword for keyword in [*strong_keywords, *dynamic_keywords] if keyword]
    return count_keywords(normalized, keywords) >= 2


def retry_probe_state(
    title: str,
    probe_fn,
    success_fn,
    attempts: int = 5,
    interval_ms: int = 500,
) -> tuple[Any, list[dict[str, Any]]]:
    history: list[dict[str, Any]] = []
    last_state = None
    max_attempts = max(1, int(attempts or 1))
    for attempt_index in range(max_attempts):
        last_state = probe_fn()
        success = bool(success_fn(last_state))
        history.append(
            {
                "attempt": attempt_index + 1,
                "success": success,
                "state": last_state,
            }
        )
        if success:
            break
        if attempt_index + 1 < max_attempts:
            INPUT_GUARD.guarded_sleep(max(0, int(interval_ms or 0)), title)
    return last_state, history


def probe_state_after_initial_wait(
    title: str,
    probe_fn,
    success_fn,
    initial_wait_ms: int = 1500,
    verify_window_ms: int = 4000,
    verify_interval_ms: int = 600,
) -> tuple[Any, list[dict[str, Any]]]:
    INPUT_GUARD.guarded_sleep(max(0, int(initial_wait_ms or 0)), title)
    history: list[dict[str, Any]] = []
    last_state = None
    deadline = time.time() + max(0, int(verify_window_ms or 0)) / 1000.0
    attempt_index = 0

    while True:
        attempt_index += 1
        last_state = probe_fn()
        success = bool(success_fn(last_state))
        history.append(
            {
                "attempt": attempt_index,
                "success": success,
                "state": last_state,
            }
        )
        if success or time.time() >= deadline:
            break
        INPUT_GUARD.guarded_sleep(max(0, int(verify_interval_ms or 0)), title)

    return last_state, history


def probe_until_timeout(
    title: str,
    probe_fn,
    success_fn,
    timeout_ms: int,
    interval_ms: int = 120,
    initial_wait_ms: int = 0,
) -> tuple[Any, list[dict[str, Any]]]:
    return probe_state_after_initial_wait(
        title,
        probe_fn,
        success_fn,
        initial_wait_ms=max(0, int(initial_wait_ms or 0)),
        verify_window_ms=max(0, int(timeout_ms or 0)),
        verify_interval_ms=max(0, int(interval_ms or 0)),
    )


def pulse_turn_key(hwnd: int, key: str, duration_ms: int, action_title: str) -> dict[str, Any]:
    bounds = focus_window(hwnd)
    pydirectinput.keyDown(key)
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(duration_ms, action_title)
    pydirectinput.keyUp(key)
    INPUT_GUARD.refresh_baseline()
    return {
        "key": key,
        "durationMs": duration_ms,
        "screenX": round(bounds["left"] + bounds["width"] * 0.5),
        "screenY": round(bounds["top"] + bounds["height"] * 0.5),
    }


def scroll_mouse_wheel(
    hwnd: int,
    notches: int,
    action_title: str,
    anchor_ratio: tuple[float, float] = (0.58, 0.42),
    settle_ms: int = 60,
) -> dict[str, Any]:
    bounds = focus_window(hwnd)
    anchor_x = round(bounds["left"] + bounds["width"] * anchor_ratio[0])
    anchor_y = round(bounds["top"] + bounds["height"] * anchor_ratio[1])
    win32api.SetCursorPos((anchor_x, anchor_y))
    INPUT_GUARD.refresh_baseline()

    direction = 1 if notches >= 0 else -1
    total_notches = max(0, abs(int(notches)))
    for _ in range(total_notches):
        win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL, 0, 0, win32con.WHEEL_DELTA * direction, 0)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(settle_ms, action_title)

    return {
        "anchorX": anchor_x,
        "anchorY": anchor_y,
        "notches": total_notches,
        "direction": "forward" if direction > 0 else "backward",
        "settleMs": settle_ms,
    }


def normalize_name_candidate(text: str) -> str:
    normalized = re.sub(r"\s+", "", str(text or ""))
    normalized = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9<>团队]", "", normalized)
    return normalized


STEALTH_EXCLUDED_NAME_KEYWORDS = [
    "籽岷团队",
]


def is_excluded_stealth_name(text: str) -> bool:
    normalized = normalize_name_candidate(text)
    if not normalized:
        return True
    if "团队" in normalized:
        return True
    return False


def looks_like_stealth_target_name(text: str) -> bool:
    normalized = normalize_name_candidate(text)
    if not normalized or is_excluded_stealth_name(normalized):
        return False
    for keyword in STEALTH_EXCLUDED_NAME_KEYWORDS:
        if keyword in normalized:
            return False
    return bool(re.fullmatch(r"[\u4e00-\u9fff]{2,6}", normalized))


def find_stealth_front_target(hwnd: int, roi: tuple[float, float, float, float]) -> dict[str, Any] | None:
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    items.extend(ocr_items_upscaled(image, 2.0))

    roi_center_x = image.shape[1] / 2.0
    roi_center_y = image.shape[0] / 2.0
    best_match = None
    best_score = None

    for item in items:
        normalized = normalize_name_candidate(item["text"])
        if not looks_like_stealth_target_name(normalized):
            continue

        dx = abs(float(item["centerX"]) - roi_center_x)
        dy = abs(float(item["centerY"]) - roi_center_y)
        distance_penalty = (dx * 1.0) + (dy * 0.6)
        score = float(item["score"]) * 100.0 - distance_penalty

        if best_score is None or score > best_score:
            best_score = score
            best_match = {
                "text": normalized,
                "score": round(float(item["score"]), 4),
                "screenX": round(bounds["left"] + bounds["width"] * roi[0] + item["centerX"]),
                "screenY": round(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
                "centerX": round(float(item["centerX"]), 1),
                "centerY": round(float(item["centerY"]), 1),
            }

    if best_match is None:
        return None

    return {
        **best_match,
        "roi": {
            "x1": roi[0],
            "y1": roi[1],
            "x2": roi[2],
            "y2": roi[3],
        },
    }


def list_front_visible_name_candidates(hwnd: int, roi: tuple[float, float, float, float]) -> list[dict[str, Any]]:
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    items.extend(ocr_items_upscaled(image, 2.0))

    candidates: list[dict[str, Any]] = []
    seen_names: set[str] = set()
    for item in items:
        normalized = normalize_name_candidate(item["text"])
        if not looks_like_stealth_target_name(normalized) or normalized in seen_names:
            continue
        seen_names.add(normalized)
        candidates.append(
            {
                "text": normalized,
                "score": round(float(item["score"]), 4),
                "screenX": round(bounds["left"] + bounds["width"] * roi[0] + item["centerX"]),
                "screenY": round(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
            }
        )
        if len(candidates) >= 6:
            break

    return candidates


def detect_map_screen(hwnd: int) -> dict[str, Any]:
    stage_texts = {
        name: ocr_text(capture_window_region(hwnd, roi))
        for name, roi in MAP_STAGE_ROIS.items()
    }
    combined = " ".join(stage_texts.values())
    return {
        "visible": contains_any_keyword(combined, MAP_KEYWORDS),
        "texts": stage_texts,
    }


def parse_coordinate_pair(text: str) -> dict[str, Any] | None:
    normalized = str(text or "")
    normalized = normalized.replace("O", "0").replace("o", "0").replace(" ", "")
    normalized = normalized.replace("（", "(").replace("）", ")").replace("，", ",")
    normalized = normalized.replace("\n", "")
    match = re.search(r"\(?(\d{2,4})[,.:;](\d{2,4})\)?", normalized)
    if not match:
        match = re.search(r"\((\d{2,4}),(\d{2,4})\)", normalized)
    if not match:
        return None
    return {
        "x": int(match.group(1)),
        "y": int(match.group(2)),
        "text": text,
    }


def detect_minimap_coordinate(hwnd: int) -> dict[str, Any]:
    for roi_name, roi in MINIMAP_COORDINATE_ROIS.items():
        text = ocr_text(capture_window_region(hwnd, roi))
        coordinate = parse_coordinate_pair(text)
        if coordinate is not None:
            return {
                "found": True,
                "text": text,
                "coordinate": {
                    "x": coordinate["x"],
                    "y": coordinate["y"],
                },
                "roiName": roi_name,
                "roi": {
                    "x1": roi[0],
                    "y1": roi[1],
                    "x2": roi[2],
                    "y2": roi[3],
                },
            }

    return {
        "found": False,
        "text": "",
        "coordinate": None,
        "roiName": "",
        "roi": None,
    }


def detect_vendor_purchase_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": contains_any_keyword(panel_text, VENDOR_PURCHASE_KEYWORDS),
        "text": panel_text,
    }


def detect_world_hud_state(hwnd: int) -> dict[str, Any]:
    action_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["bottom_right_actions"]))
    return {
        "visible": contains_any_keyword(action_text, WORLD_HUD_KEYWORDS),
        "text": action_text,
    }


def detect_vendor_interact_prompt(hwnd: int) -> dict[str, Any]:
    action_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["bottom_right_actions"]))
    normalized_text = normalize_npc_name(action_text)
    return {
        "visible": any(keyword in normalized_text for keyword in ["对话", "交谈"]),
        "text": action_text,
        "normalizedText": normalized_text,
    }


def detect_hawking_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": contains_any_keyword(panel_text, HAWKING_SCREEN_KEYWORDS),
        "text": panel_text,
    }


def detect_hawking_runtime_state(hwnd: int) -> dict[str, Any]:
    action_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["bottom_right_actions"]))
    normalized_text = normalize_npc_name(action_text)
    active_keywords = ["收摊", "改货", "议价"]
    ready_keywords = ["叫卖", "感知", "寻迹", "潜行", "微风拂柳"]
    return {
        "active": any(keyword in normalized_text for keyword in active_keywords),
        "ready": any(keyword in normalized_text for keyword in ready_keywords)
        and not any(keyword in normalized_text for keyword in active_keywords),
        "text": action_text,
        "normalizedText": normalized_text,
    }


def detect_steal_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": count_keywords(panel_text, STEAL_KEYWORDS) >= 2,
        "text": panel_text,
    }


def detect_steal_button_stack(hwnd: int) -> dict[str, Any]:
    image = capture_window_region(hwnd, STEALTH_ROIS["steal_button_stack"])
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gold_mask = cv2.inRange(
        hsv,
        np.array([10, 70, 135], dtype=np.uint8),
        np.array([40, 255, 255], dtype=np.uint8),
    )
    gold_mask = cv2.morphologyEx(gold_mask, cv2.MORPH_CLOSE, np.ones((5, 5), dtype=np.uint8))
    gold_mask = cv2.morphologyEx(gold_mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
    contours, _hierarchy = cv2.findContours(gold_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    height, width = image.shape[:2]
    min_width = max(42, int(width * 0.34))
    max_width = max(min_width, int(width * 0.98))
    min_height = max(18, int(height * 0.05))
    max_height = max(min_height, int(height * 0.22))
    candidates: list[dict[str, Any]] = []

    for contour in contours:
        x, y, box_width, box_height = cv2.boundingRect(contour)
        contour_area = float(cv2.contourArea(contour))
        fill_ratio = contour_area / float(max(1, box_width * box_height))
        aspect_ratio = box_width / float(max(1, box_height))

        if box_width < min_width or box_width > max_width:
            continue
        if box_height < min_height or box_height > max_height:
            continue
        if aspect_ratio < 2.1:
            continue
        if fill_ratio < 0.52:
            continue

        candidates.append(
            {
                "minX": int(x),
                "minY": int(y),
                "maxX": int(x + box_width),
                "maxY": int(y + box_height),
                "width": int(box_width),
                "height": int(box_height),
                "area": round(contour_area, 2),
                "fillRatio": round(fill_ratio, 4),
            }
        )

    candidates.sort(key=lambda item: (item["minY"], -item["area"]))
    gold_ratio = float(np.count_nonzero(gold_mask)) / float(max(1, gold_mask.size))
    return {
        "visible": len(candidates) >= 1,
        "buttonCount": len(candidates),
        "goldPixelRatio": round(gold_ratio, 5),
        "candidates": candidates[:4],
    }


def detect_steal_screen_ready(hwnd: int) -> dict[str, Any]:
    visual_state = detect_steal_button_stack(hwnd)
    if visual_state["visible"]:
        return {
            "visible": True,
            "text": "",
            "source": "fixed_gold_buttons",
            "visual": visual_state,
        }

    steal_state = detect_steal_screen(hwnd)
    return {
        "visible": steal_state["visible"],
        "text": steal_state["text"],
        "source": "ocr",
        "visual": visual_state,
    }


def summarize_color_suppression(image: np.ndarray) -> dict[str, float]:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    saturation = hsv[:, :, 1].astype(np.float32)
    value = hsv[:, :, 2].astype(np.float32)
    low_saturation_ratio = float(np.mean((saturation < 42.0) & (value > 24.0)))
    colorful_ratio = float(np.mean((saturation > 65.0) & (value > 60.0)))
    return {
        "meanSaturation": round(float(np.mean(saturation)), 3),
        "lowSaturationRatio": round(low_saturation_ratio, 4),
        "colorfulRatio": round(colorful_ratio, 4),
    }


def detect_stealth_scene_visual(hwnd: int) -> dict[str, Any]:
    metrics = summarize_color_suppression(capture_window_region(hwnd, STEALTH_ROIS["scene_color_probe"]))
    return {
        # The 2560x1440 Windows capture keeps more residual UI color than the
        # older baseline, so the stealth grayscale gate should stay strict on
        # average saturation/colorfulness but allow a lower grey-pixel ratio.
        "visible": metrics["lowSaturationRatio"] >= 0.35 and metrics["meanSaturation"] <= 48.0 and metrics["colorfulRatio"] <= 0.16,
        **metrics,
    }


def detect_exit_stealth_button_visual(hwnd: int) -> dict[str, Any]:
    image = capture_window_region(hwnd, STEALTH_ROIS["exit_button"])
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dark_ratio = float(np.mean(gray < 88.0))
    bright_ratio = float(np.mean(gray > 178.0))
    edge_ratio = float(np.mean(cv2.Canny(gray, 80, 160) > 0))
    return {
        "visible": dark_ratio >= 0.32 and bright_ratio >= 0.02 and edge_ratio >= 0.015,
        "darkRatio": round(dark_ratio, 4),
        "brightRatio": round(bright_ratio, 4),
        "edgeRatio": round(edge_ratio, 4),
    }


def detect_plus_marker_visual(image: np.ndarray) -> dict[str, Any]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright_mask = gray > 180
    height, width = bright_mask.shape
    center_row = bright_mask[max(0, height // 2 - 3): min(height, height // 2 + 4), :]
    center_col = bright_mask[:, max(0, width // 2 - 3): min(width, width // 2 + 4)]
    bright_ratio = float(np.mean(bright_mask))
    row_ratio = float(np.mean(center_row)) if center_row.size else 0.0
    col_ratio = float(np.mean(center_col)) if center_col.size else 0.0
    return {
        "visible": bright_ratio >= 0.035 and row_ratio >= 0.14 and col_ratio >= 0.14,
        "brightRatio": round(bright_ratio, 4),
        "rowRatio": round(row_ratio, 4),
        "colRatio": round(col_ratio, 4),
    }


def detect_knockout_action_wheel_visual(hwnd: int) -> dict[str, Any]:
    cluster_image = capture_window_region(hwnd, STEALTH_ROIS["knockout_action_cluster"])
    cluster_gray = cv2.cvtColor(cluster_image, cv2.COLOR_BGR2GRAY)
    cluster_bright_ratio = float(np.mean(cluster_gray > 150.0))
    cluster_edge_ratio = float(np.mean(cv2.Canny(cluster_gray, 70, 150) > 0))
    upper_plus = detect_plus_marker_visual(capture_window_region(hwnd, STEALTH_ROIS["knockout_plus_upper"]))
    lower_plus = detect_plus_marker_visual(capture_window_region(hwnd, STEALTH_ROIS["knockout_plus_lower"]))
    plus_count = int(upper_plus["visible"]) + int(lower_plus["visible"])
    return {
        "visible": plus_count == 0 and cluster_bright_ratio >= 0.045 and cluster_edge_ratio >= 0.06,
        "plusCount": plus_count,
        "clusterBrightRatio": round(cluster_bright_ratio, 4),
        "clusterEdgeRatio": round(cluster_edge_ratio, 4),
        "upperPlus": upper_plus,
        "lowerPlus": lower_plus,
    }


def detect_exit_stealth_button(hwnd: int) -> dict[str, Any]:
    scene_state = detect_stealth_scene_visual(hwnd)
    button_state = detect_exit_stealth_button_visual(hwnd)
    return {
        "visible": scene_state["visible"] and button_state["visible"],
        "text": "",
        "normalizedText": "",
        "source": "visual",
        "scene": scene_state,
        "button": button_state,
    }


def detect_knockout_context(hwnd: int) -> dict[str, Any]:
    scene_state = detect_stealth_scene_visual(hwnd)
    action_wheel = detect_knockout_action_wheel_visual(hwnd)
    return {
        "visible": scene_state["visible"] and action_wheel["visible"],
        "text": "",
        "source": "visual",
        "scene": scene_state,
        "actionWheel": action_wheel,
    }


def detect_loot_screen(hwnd: int) -> dict[str, Any]:
    submit_image = capture_window_region(hwnd, STEALTH_ROIS["loot_submit_button"])
    submit_hsv = cv2.cvtColor(submit_image, cv2.COLOR_BGR2HSV)
    submit_gold_mask = cv2.inRange(
        submit_hsv,
        np.array([10, 55, 110], dtype=np.uint8),
        np.array([40, 255, 255], dtype=np.uint8),
    )
    submit_gold_ratio = float(np.mean(submit_gold_mask > 0))

    right_panel = capture_window_region(hwnd, STEALTH_ROIS["loot_right_panel"])
    right_panel_gray = np.mean(right_panel, axis=2)
    right_panel_dark_ratio = float(np.mean(right_panel_gray < 82.0))

    right_panel_hsv = cv2.cvtColor(right_panel, cv2.COLOR_BGR2HSV)
    right_panel_color_mask = cv2.inRange(
        right_panel_hsv,
        np.array([0, 35, 55], dtype=np.uint8),
        np.array([179, 255, 255], dtype=np.uint8),
    )
    right_panel_color_ratio = float(np.mean(right_panel_color_mask > 0))

    return {
        "visible": submit_gold_ratio >= 0.08 and right_panel_dark_ratio >= 0.34 and right_panel_color_ratio >= 0.05,
        "submitGoldRatio": round(submit_gold_ratio, 4),
        "rightPanelDarkRatio": round(right_panel_dark_ratio, 4),
        "rightPanelColorRatio": round(right_panel_color_ratio, 4),
    }


def detect_miaoqu_success_banner(hwnd: int) -> dict[str, Any]:
    banner_text = ocr_text(capture_window_region(hwnd, STEALTH_ROIS["result_banner"]))
    normalized_text = normalize_npc_name(banner_text)
    return {
        "visible": "妙取成功" in normalized_text,
        "text": banner_text,
        "normalizedText": normalized_text,
    }


def ensure_map_screen_open(hwnd: int, title: str, toggle_key: str = "m", timeout_ms: int = 2500) -> dict[str, Any]:
    focus_window(hwnd)
    current_state = detect_map_screen(hwnd)
    if current_state["visible"]:
        return current_state

    pydirectinput.press(toggle_key)
    INPUT_GUARD.refresh_baseline()
    current_state, _ = probe_until_timeout(
        title,
        lambda: detect_map_screen(hwnd),
        lambda state: bool(state["visible"]),
        timeout_ms=timeout_ms,
        interval_ms=120,
        initial_wait_ms=180,
    )
    if current_state["visible"]:
        return current_state

    raise RuntimeError("Failed to open map screen before timeout")


def ensure_map_screen_closed(hwnd: int, title: str, toggle_key: str = "m", timeout_ms: int = 2000) -> dict[str, Any]:
    current_state = detect_map_screen(hwnd)
    if not current_state["visible"]:
        return current_state

    teleport_dialog = detect_teleport_confirm_dialog(hwnd)
    if teleport_dialog["visible"]:
        click_named_point(hwnd, "teleport_confirm")
        INPUT_GUARD.guarded_sleep(220, title)
    else:
        focus_window(hwnd)
        pydirectinput.press(toggle_key)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(220, title)

    current_state, _ = probe_until_timeout(
        title,
        lambda: detect_map_screen(hwnd),
        lambda state: not bool(state["visible"]),
        timeout_ms=timeout_ms,
        interval_ms=120,
        initial_wait_ms=180,
    )
    if not current_state["visible"]:
        return current_state

    raise RuntimeError("Failed to close map screen before timeout")


def find_map_keypad_digit_buttons(hwnd: int, sample_count: int = 4, sample_gap_ms: int = 120) -> dict[str, dict[str, Any]]:
    roi = MAP_STAGE_ROIS["keypad_panel"]
    digit_map: dict[str, dict[str, Any]] = {}
    for sample_index in range(max(1, sample_count)):
        bounds = get_window_bounds(hwnd)
        image = capture_window_region(hwnd, roi)
        items = ocr_items(image)

        for item in items:
            normalized = re.sub(r"\s+", "", str(item["text"] or ""))
            if not re.fullmatch(r"\d", normalized):
                continue

            current = digit_map.get(normalized)
            if current and current["score"] >= item["score"]:
                continue

            digit_map[normalized] = {
                "digit": normalized,
                "score": round(item["score"], 3),
                "screenX": round(bounds["left"] + bounds["width"] * roi[0] + item["centerX"]),
                "screenY": round(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
                "minX": item["minX"],
                "maxX": item["maxX"],
                "minY": item["minY"],
                "maxY": item["maxY"],
            }

        if sample_index < max(1, sample_count) - 1:
            INPUT_GUARD.guarded_sleep(sample_gap_ms, "find_map_keypad_digit_buttons")

    return digit_map


def find_map_route_controls(hwnd: int) -> dict[str, dict[str, Any]]:
    roi = MAP_STAGE_ROIS["route_panel"]
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    controls: dict[str, dict[str, Any]] = {}

    for item in items:
        normalized = re.sub(r"\s+", "", str(item["text"] or ""))
        if not normalized:
            continue

        if "前往" in normalized:
            controls["go"] = {
                "screenX": round(bounds["left"] + bounds["width"] * roi[0] + item["centerX"]),
                "screenY": round(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
            }
            continue

        if "纵" in normalized or "緃" in normalized:
            controls["vertical"] = {
                "screenX": round(bounds["left"] + bounds["width"] * roi[0] + min(item["centerX"] + 56, image.shape[1] - 12)),
                "screenY": round(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
            }
            continue

        if "横" in normalized:
            controls["horizontal"] = {
                "screenX": round(bounds["left"] + bounds["width"] * roi[0] + min(item["centerX"] + 56, image.shape[1] - 12)),
                "screenY": round(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
            }

    return controls


def click_map_route_control(hwnd: int, control_name: str, fallback_point_name: str) -> dict[str, Any]:
    click_state = click_named_point(hwnd, fallback_point_name)
    click_state["controlName"] = control_name
    click_state["locator"] = "fixed_ratio"
    return click_state


def derive_map_keypad_layout(digit_buttons: dict[str, dict[str, Any]]) -> dict[str, Any]:
    def mean_if_any(keys: list[str], axis: str) -> float | None:
        values = [digit_buttons[key][axis] for key in keys if key in digit_buttons]
        if not values:
            return None
        return float(np.mean(values))

    def resolve_triplet(first: float | None, second: float | None, third: float | None, label: str) -> tuple[float, float, float]:
        if first is None and second is not None and third is not None:
            first = second - (third - second)
        if second is None and first is not None and third is not None:
            second = (first + third) / 2.0
        if third is None and first is not None and second is not None:
            third = second + (second - first)
        if first is None or second is None or third is None:
            raise RuntimeError(f"Map keypad OCR could not locate {label}")
        return first, second, third

    col1, col2, col3 = resolve_triplet(
        mean_if_any(["1", "4", "7"], "screenX"),
        mean_if_any(["2", "5", "8"], "screenX"),
        mean_if_any(["3", "6", "9"], "screenX"),
        "keypad columns",
    )
    row1, row2, row3 = resolve_triplet(
        mean_if_any(["1", "2", "3"], "screenY"),
        mean_if_any(["4", "5", "6", "0"], "screenY"),
        mean_if_any(["7", "8", "9"], "screenY"),
        "keypad rows",
    )
    column_gap = np.mean([col2 - col1, col3 - col2])
    row_gap = np.mean([row2 - row1, row3 - row2])
    col4 = col3 + column_gap

    synthesized_positions = {
        "1": {"screenX": round(col1), "screenY": round(row1)},
        "2": {"screenX": round(col2), "screenY": round(row1)},
        "3": {"screenX": round(col3), "screenY": round(row1)},
        "4": {"screenX": round(col1), "screenY": round(row2)},
        "5": {"screenX": round(col2), "screenY": round(row2)},
        "6": {"screenX": round(col3), "screenY": round(row2)},
        "7": {"screenX": round(col1), "screenY": round(row3)},
        "8": {"screenX": round(col2), "screenY": round(row3)},
        "9": {"screenX": round(col3), "screenY": round(row3)},
        "0": {"screenX": round(col4), "screenY": round(row2)},
        "delete": {"screenX": round(col4), "screenY": round(row1)},
        "confirm": {"screenX": round(col4), "screenY": round(row3)},
    }

    button_map = {
        key: {
            **synthesized_positions[key],
            **({"digit": key, "score": round(digit_buttons[key]["score"], 3)} if key in digit_buttons else {}),
        }
        for key in synthesized_positions
    }

    return {
        "buttons": button_map,
        "columnGap": round(float(column_gap), 2),
        "rowGap": round(float(row_gap), 2),
    }


def input_map_coordinate_field(
    hwnd: int,
    point_name: str,
    control_name: str,
    coordinate_value: int,
    field_name: str,
    title: str,
) -> dict[str, Any]:
    click_state = click_map_route_control(hwnd, control_name, point_name)
    INPUT_GUARD.guarded_sleep(1000, title)
    layout = {
        "buttons": {
            key: {
                "screenX": round(get_window_bounds(hwnd)["left"] + get_window_bounds(hwnd)["width"] * value[0]),
                "screenY": round(get_window_bounds(hwnd)["top"] + get_window_bounds(hwnd)["height"] * value[1]),
            }
            for key, value in MAP_KEYPAD_POINTS[field_name].items()
        }
    }

    digits = list(str(int(coordinate_value)))

    typed_digits: list[dict[str, Any]] = []
    for digit in digits:
        button = layout["buttons"].get(digit)
        if not button:
            raise RuntimeError(f"Map keypad button for digit {digit} was not found")
        click_screen_point(hwnd, int(button["screenX"]), int(button["screenY"]), "left")
        INPUT_GUARD.guarded_sleep(1000, title)
        typed_digits.append({
            "digit": digit,
            "screenX": int(button["screenX"]),
            "screenY": int(button["screenY"]),
        })

    confirm_click = None
    if field_name in {"vertical", "horizontal"}:
        confirm_button = layout["buttons"].get("confirm")
        if not confirm_button:
            raise RuntimeError(f"Map keypad confirm button for {field_name} field was not found")
        click_screen_point(hwnd, int(confirm_button["screenX"]), int(confirm_button["screenY"]), "left")
        INPUT_GUARD.guarded_sleep(1000, title)
        confirm_click = {
            "screenX": int(confirm_button["screenX"]),
            "screenY": int(confirm_button["screenY"]),
        }

    return {
        "fieldName": field_name,
        "value": int(coordinate_value),
        "fieldClick": click_state,
        "activationAttempts": [click_state],
        "typedDigits": typed_digits,
        "confirmClick": confirm_click,
        "digitButtons": {
            key: {
                "screenX": int(value["screenX"]),
                "screenY": int(value["screenY"]),
            }
            for key, value in layout["buttons"].items()
            if key in {"0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "delete", "confirm"}
        },
    }


def start_map_route_to_coordinate(
    hwnd: int,
    title: str,
    x_coordinate: int,
    y_coordinate: int,
    toggle_key: str = "m",
    wait_after_go_ms: int = 0,
) -> dict[str, Any]:
    map_state = ensure_map_screen_open(hwnd, title, toggle_key=toggle_key)
    y_input = input_map_coordinate_field(hwnd, "map_coord_y_input", "vertical", y_coordinate, "vertical", title)
    x_input = input_map_coordinate_field(hwnd, "map_coord_x_input", "horizontal", x_coordinate, "horizontal", title)
    go_click = click_map_route_control(hwnd, "go", "map_go")
    INPUT_GUARD.guarded_sleep(max(180, wait_after_go_ms), title)
    teleport_confirm = maybe_confirm_teleport_dialog(
        hwnd,
        title,
        "teleport_confirm",
        initial_wait_ms=0,
        verify_window_ms=900,
        verify_interval_ms=180,
    )
    return {
        "toggleKey": toggle_key,
        "mapTexts": map_state["texts"],
        "xCoordinate": x_coordinate,
        "yCoordinate": y_coordinate,
        "verticalInput": y_input,
        "horizontalInput": x_input,
        "goClick": go_click,
        "teleportConfirm": teleport_confirm,
        "waitAfterGoMs": wait_after_go_ms,
    }


def run_map_route_to_coordinate(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "map_route_to_coordinate")
    x_coordinate = int(action.get("xCoordinate"))
    y_coordinate = int(action.get("yCoordinate"))
    wait_after_go_ms = int(action.get("waitAfterGoMs") or 0)
    toggle_key = str(action.get("toggleKey") or "m").strip().lower()

    route_start = start_map_route_to_coordinate(
        hwnd,
        title,
        x_coordinate,
        y_coordinate,
        toggle_key=toggle_key,
        wait_after_go_ms=wait_after_go_ms,
    )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Opened map and started routing to ({x_coordinate}, {y_coordinate})",
        "input": {
            "mode": "map_route_to_coordinate",
            **route_start,
        },
    }


def detect_dialog(hwnd: int) -> dict[str, Any]:
    title_text = ocr_text(capture_window_region(hwnd, (0.18, 0.08, 0.82, 0.36)))
    middle_text = ocr_text(capture_window_region(hwnd, (0.12, 0.18, 0.88, 0.62)))
    full_text = f"{title_text} {middle_text}".strip()
    keywords = ["对话", "交谈", "继续", "关闭", "任务", "接受", "提交", "剧情", "路人", "少侠"]
    return {
        "visible": any(keyword in full_text for keyword in keywords),
        "text": full_text,
    }


def detect_teleport_confirm_dialog(hwnd: int) -> dict[str, Any]:
    full_image = capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))
    title_patch = crop_client_roi(full_image, (0.00, 0.20, 0.18, 0.34))
    message_patch = crop_client_roi(full_image, (0.34, 0.42, 0.68, 0.58))
    confirm_patch = crop_client_roi(full_image, (0.49, 0.68, 0.66, 0.83))

    title_text = ocr_text(title_patch)
    message_text = ocr_text(message_patch)
    full_text = f"{title_text} {message_text}".strip()
    confirm_metrics = patch_brightness_metrics(confirm_patch)

    return {
        "visible": (
            contains_any_keyword(full_text, ["传送确认", "是否前往", "前往位于"])
            and confirm_metrics["brightRatio"] >= 0.22
        ),
        "text": full_text,
        "confirmBrightRatio": round(confirm_metrics["brightRatio"], 4),
    }


def maybe_confirm_teleport_dialog(
    hwnd: int,
    title: str,
    confirm_point_name: str,
    initial_wait_ms: int = 220,
    verify_window_ms: int = 900,
    verify_interval_ms: int = 180,
) -> dict[str, Any] | None:
    INPUT_GUARD.guarded_sleep(max(0, initial_wait_ms), title)
    deadline = time.time() + max(0, verify_window_ms) / 1000.0

    while True:
        dialog_state = detect_teleport_confirm_dialog(hwnd)
        if dialog_state["visible"]:
            confirm_click = click_named_point(hwnd, confirm_point_name)
            INPUT_GUARD.guarded_sleep(220, title)
            return {
                "dialog": dialog_state,
                "click": confirm_click,
                "initialWaitMs": initial_wait_ms,
                "verifyWindowMs": verify_window_ms,
                "verifyIntervalMs": verify_interval_ms,
            }

        if time.time() >= deadline:
            return None

        INPUT_GUARD.guarded_sleep(max(0, verify_interval_ms), title)


def crop_client_roi(image: np.ndarray, roi: tuple[float, float, float, float]) -> np.ndarray:
    height, width = image.shape[:2]
    left = max(0, min(width, int(width * roi[0])))
    top = max(0, min(height, int(height * roi[1])))
    right = max(left + 1, min(width, int(width * roi[2])))
    bottom = max(top + 1, min(height, int(height * roi[3])))
    return image[top:bottom, left:right].copy()


def patch_brightness_metrics(image: np.ndarray) -> dict[str, float]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    bright_ratio = float(np.count_nonzero(gray >= 170)) / float(max(gray.size, 1))
    dark_ratio = float(np.count_nonzero(gray <= 70)) / float(max(gray.size, 1))
    edge_ratio = float(np.count_nonzero(cv2.Canny(gray, 60, 140))) / float(max(gray.size, 1))
    return {
        "brightRatio": bright_ratio,
        "darkRatio": dark_ratio,
        "edgeRatio": edge_ratio,
    }


def patch_has_wide_button_shape(image: np.ndarray) -> bool:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), dtype=np.uint8))
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        _x, _y, width, height = cv2.boundingRect(contour)
        if width < 70 or height < 18:
            continue
        if width / max(height, 1) < 1.6:
            continue
        if cv2.contourArea(contour) < 1200:
            continue
        return True
    return False


def find_action_menu_button_centers(hwnd: int) -> dict[str, dict[str, int]]:
    roi = (0.66, 0.72, 0.995, 0.985)
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)
    binary = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), dtype=np.uint8))
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[dict[str, int]] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width < 70 or height < 20:
            continue
        if width / max(height, 1) < 1.5:
            continue
        if cv2.contourArea(contour) < 1200:
            continue
        candidates.append(
            {
                "centerX": int(x + width / 2),
                "centerY": int(y + height / 2),
                "width": int(width),
                "height": int(height),
            }
        )

    top_row = sorted(
        [item for item in candidates if item["centerY"] <= int(image.shape[0] * 0.58)],
        key=lambda item: item["centerX"],
    )
    button_map: dict[str, dict[str, int]] = {}
    if len(top_row) >= 3:
        names = ["view", "trade", "gift"]
        for name, item in zip(names, top_row[:3]):
            button_map[name] = {
                "screenX": int(bounds["left"] + bounds["width"] * roi[0] + item["centerX"]),
                "screenY": int(bounds["top"] + bounds["height"] * roi[1] + item["centerY"]),
                "width": item["width"],
                "height": item["height"],
            }
    return button_map


def detect_npc_action_menu_visual(hwnd: int) -> bool:
    image = capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))
    button_points = ["trade", "gift", "talk"]
    bright_buttons = 0
    for point_name in button_points:
        point = ACTION_POINTS[point_name]
        x_ratio = float(point[0])
        y_ratio = float(point[1])
        patch = crop_client_roi(
            image,
            (
                max(0.0, x_ratio - 0.035),
                max(0.0, y_ratio - 0.03),
                min(1.0, x_ratio + 0.035),
                min(1.0, y_ratio + 0.03),
            ),
        )
        metrics = patch_brightness_metrics(patch)
        if (
            metrics["brightRatio"] >= 0.15
            and metrics["edgeRatio"] >= 0.08
            and patch_has_wide_button_shape(patch)
        ):
            bright_buttons += 1

    exit_patch = crop_client_roi(image, (0.83, 0.88, 0.99, 0.98))
    exit_metrics = patch_brightness_metrics(exit_patch)
    return bright_buttons >= 2 and exit_metrics["brightRatio"] >= 0.40 and exit_metrics["edgeRatio"] >= 0.09


def detect_gift_screen_visual(hwnd: int) -> bool:
    image = capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))
    submit = ACTION_POINTS["gift_submit"]
    slot = ACTION_POINTS["gift_first_slot"]
    submit_patch = crop_client_roi(image, (submit[0] - 0.03, submit[1] - 0.025, submit[0] + 0.03, submit[1] + 0.025))
    slot_patch = crop_client_roi(image, (slot[0] - 0.03, slot[1] - 0.04, slot[0] + 0.03, slot[1] + 0.04))
    right_panel_patch = crop_client_roi(image, NPC_STAGE_ROIS["gift_panel"])
    submit_metrics = patch_brightness_metrics(submit_patch)
    slot_metrics = patch_brightness_metrics(slot_patch)
    right_panel_metrics = patch_brightness_metrics(right_panel_patch)
    return (
        submit_metrics["brightRatio"] >= 0.25
        and slot_metrics["brightRatio"] >= 0.45
        and right_panel_metrics["brightRatio"] >= 0.32
    )


def wait_for_npc_stage(
    hwnd: int,
    expected_stage: str,
    timeout_ms: int = 800,
    poll_interval_ms: int = 120,
) -> dict[str, Any]:
    deadline = time.time() + max(0, timeout_ms) / 1000.0
    last_stage_state = detect_npc_interaction_stage(hwnd)
    while True:
        if last_stage_state["stage"] == expected_stage:
            return last_stage_state
        if time.time() >= deadline:
            return last_stage_state
        INPUT_GUARD.guarded_sleep(max(0, poll_interval_ms), f"wait_for_{expected_stage}")
        last_stage_state = detect_npc_interaction_stage(hwnd)


def wait_for_any_npc_stage(
    hwnd: int,
    expected_stages: set[str] | list[str] | tuple[str, ...],
    timeout_ms: int = 800,
    poll_interval_ms: int = 120,
) -> dict[str, Any]:
    target_stages = {str(stage or "").strip() for stage in expected_stages if str(stage or "").strip()}
    deadline = time.time() + max(0, timeout_ms) / 1000.0
    last_stage_state = detect_npc_interaction_stage(hwnd)
    while True:
        if last_stage_state["stage"] in target_stages:
            return last_stage_state
        if time.time() >= deadline:
            return last_stage_state
        INPUT_GUARD.guarded_sleep(max(0, poll_interval_ms), "wait_for_any_npc_stage")
        last_stage_state = detect_npc_interaction_stage(hwnd)


def detect_chat_ready_visual(hwnd: int) -> bool:
    image = capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))
    input_patch = crop_client_roi(image, (0.03, 0.90, 0.42, 0.99))
    send_patch = crop_client_roi(image, (0.32, 0.89, 0.46, 0.99))
    input_metrics = patch_brightness_metrics(input_patch)
    send_metrics = patch_brightness_metrics(send_patch)
    return input_metrics["darkRatio"] >= 0.40 and send_metrics["brightRatio"] >= 0.20


def is_chat_reply_text(text: str) -> bool:
    normalized = str(text or "").strip()
    input_keywords = ["点击输入聊天", "点击输入", "输入聊天", "鐐瑰嚮杈撳叆鑱婂ぉ"]
    send_keywords = ["发送", "鍙戦€?"]
    return (
        contains_any_keyword(normalized, input_keywords)
        and contains_any_keyword(normalized, send_keywords)
    )


def read_stage_texts(hwnd: int) -> dict[str, str]:
    return {
        name: ocr_text(capture_window_region(hwnd, roi))
        for name, roi in NPC_STAGE_ROIS.items()
    }


def detect_npc_interaction_stage(hwnd: int) -> dict[str, Any]:
    if detect_npc_action_menu_visual(hwnd):
        return {
            "stage": "npc_action_menu",
            "texts": {},
        }
    if detect_gift_screen_visual(hwnd):
        return {
            "stage": "gift_screen",
            "texts": {},
        }
    if detect_chat_ready_visual(hwnd):
        return {
            "stage": "chat_ready",
            "texts": {},
        }

    stage_texts = read_stage_texts(hwnd)
    look_text = stage_texts["look_button"]
    bottom_right_text = stage_texts["bottom_right_actions"]
    confirm_text = stage_texts["confirm_dialog"]
    chat_panel_text = stage_texts["chat_panel"]
    gift_panel_text = stage_texts["gift_panel"]
    trade_panel_text = stage_texts["trade_panel"]
    world_hud_visible = contains_any_keyword(bottom_right_text, WORLD_HUD_KEYWORDS)

    npc_action_keyword_count = count_keywords(bottom_right_text, ["退出", "详情", "交易", "赠礼", "交谈", "战斗", "邀约", "邀请"])

    if npc_action_keyword_count >= 3 and not world_hud_visible:
        stage = "npc_action_menu"
    elif contains_any_keyword(bottom_right_text, ["闲聊"]) and not world_hud_visible:
        stage = "small_talk_menu"
    elif contains_any_keyword(bottom_right_text, ["交谈"]) and npc_action_keyword_count <= 2 and not world_hud_visible:
        stage = "small_talk_menu"
    elif is_gift_screen_text(gift_panel_text) and not world_hud_visible:
        stage = "gift_screen"
    elif count_keywords(trade_panel_text, STEAL_KEYWORDS) >= 2 and not world_hud_visible:
        stage = "steal_screen"
    elif count_keywords(trade_panel_text, TRADE_KEYWORDS) >= 2 and not world_hud_visible:
        stage = "trade_screen"
    elif contains_any_keyword(chat_panel_text, CHAT_KEYWORDS) and not world_hud_visible:
        stage = "chat_ready"
    elif contains_any_keyword(confirm_text, CONFIRM_KEYWORDS):
        stage = "small_talk_confirm"
    elif contains_any_keyword(look_text, ["查看"]):
        stage = "npc_selected"
    else:
        stage = "none"

    return {
        "stage": stage,
        "texts": stage_texts,
    }


def detect_npc_interaction_stage(hwnd: int) -> dict[str, Any]:
    # Stable UI owner for the NPC retarget chain:
    # action menu, gift screen, chat-ready, selected target, and world state
    # are resolved visually first so the worker does not stall on full-panel OCR.
    if detect_npc_action_menu_visual(hwnd):
        return {
            "stage": "npc_action_menu",
            "texts": {},
        }
    if detect_gift_screen_visual(hwnd):
        return {
            "stage": "gift_screen",
            "texts": {
                "gift_panel": ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["gift_panel"])),
            },
        }
    chat_panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["chat_panel"]))
    if is_chat_reply_text(chat_panel_text):
        return {
            "stage": "chat_ready",
            "texts": {
                "chat_panel": chat_panel_text,
            },
        }
    confirm_dialog_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["confirm_dialog"]))
    if contains_any_keyword(confirm_dialog_text, CONFIRM_KEYWORDS):
        return {
            "stage": "small_talk_confirm",
            "texts": {
                "confirm_dialog": confirm_dialog_text,
            },
        }
    if has_selected_target_visual(hwnd):
        return {
            "stage": "npc_selected",
            "texts": {},
        }
    return {
        "stage": "none",
        "texts": {},
    }


def detect_bottom_right_menu_stage(hwnd: int) -> dict[str, Any]:
    if detect_npc_action_menu_visual(hwnd):
        return {
            "stage": "npc_action_menu",
            "text": "",
        }

    bottom_right_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["bottom_right_actions"]))

    if contains_any_keyword(bottom_right_text, ["闲聊", "交谈"]):
        stage = "small_talk_menu"
    elif contains_any_keyword(bottom_right_text, ["交谈", "赠礼", "交易"]):
        stage = "npc_action_menu"
    else:
        stage = "none"

    return {
        "stage": stage,
        "text": bottom_right_text,
    }


def click_npc_candidate(
    hwnd: int,
    x_ratio: float,
    y_ratio: float,
    button: str = "left",
    trace_label: str = "",
) -> dict[str, Any]:
    bounds = focus_window(hwnd)
    click_x = round(bounds["left"] + bounds["width"] * x_ratio)
    click_y = round(bounds["top"] + bounds["height"] * y_ratio)
    trace = save_pre_click_trace(
        hwnd,
        click_x,
        click_y,
        trace_label or f"ratio_{x_ratio:.4f}_{y_ratio:.4f}",
    )
    pydirectinput.click(x=click_x, y=click_y, button=button)
    INPUT_GUARD.refresh_baseline()
    return {
        "button": button,
        "screenX": click_x,
        "screenY": click_y,
        "xRatio": x_ratio,
        "yRatio": y_ratio,
        "preClickTrace": trace,
    }


def click_named_point(hwnd: int, point_name: str) -> dict[str, Any]:
    x_ratio, y_ratio = ACTION_POINTS[point_name]
    return click_npc_candidate(hwnd, x_ratio, y_ratio, "left", trace_label=point_name)


def execute_fixed_trade_flow(hwnd: int, title: str) -> dict[str, Any]:
    # After the moving-target selection and the fixed trade entry button,
    # the rest of the trade UI is owned by one calibrated fixed-click chain.
    fixed_clicks = [
        ("trade_left_item_tab", 700),
        ("trade_left_item_slot", 900),
        ("trade_left_up_shelf_button", 1200),
        ("trade_right_money_slot", 1000),
        ("trade_scale_button", 1200),
        ("trade_right_up_shelf_button", 1200),
        ("trade_final_submit_button", 1600),
    ]
    click_results: list[dict[str, Any]] = []
    stage_history = ["trade_screen"]

    for point_name, delay_ms in fixed_clicks:
        click_results.append({
            "point": point_name,
            "click": click_named_point(hwnd, point_name),
        })
        INPUT_GUARD.guarded_sleep(delay_ms, title)
        stage_history.append("observed")

    return {
        "clicks": click_results,
        "stageHistory": stage_history,
    }


def execute_trade_gift_bundle_flow(hwnd: int, title: str, repeat_count: int = 10) -> dict[str, Any]:
    repeat_count = max(1, int(repeat_count))
    category_click = click_named_point(hwnd, "trade_sell_item_tab")
    INPUT_GUARD.guarded_sleep(700, title)

    stage_history = ["trade_screen"]
    rounds: list[dict[str, Any]] = []

    for round_index in range(repeat_count):
        item_click = click_named_point(hwnd, "trade_sell_item_slot")
        INPUT_GUARD.guarded_sleep(1000, title)
        shelf_click = click_named_point(hwnd, "trade_left_up_shelf_button")
        INPUT_GUARD.guarded_sleep(1200, title)
        stage_history.append("observed")
        rounds.append({
            "round": round_index + 1,
            "itemClick": item_click,
            "upShelfClick": shelf_click,
        })

    return {
        "categoryClick": category_click,
        "rounds": rounds,
        "stageHistory": stage_history,
    }


def click_screen_point(
    hwnd: int,
    screen_x: int,
    screen_y: int,
    button: str = "left",
    trace_label: str = "",
) -> dict[str, Any]:
    focus_window(hwnd)
    trace = save_pre_click_trace(
        hwnd,
        screen_x,
        screen_y,
        trace_label or f"screen_{screen_x}_{screen_y}",
    )
    pydirectinput.click(x=screen_x, y=screen_y, button=button)
    INPUT_GUARD.refresh_baseline()
    return {
        "button": button,
        "screenX": screen_x,
        "screenY": screen_y,
        "preClickTrace": trace,
    }


def resolve_shortcut_key(name: str) -> str:
    normalized = str(name or "").strip().lower()
    if not normalized:
        raise RuntimeError("shortcut name is required")
    key = SHORTCUT_KEYS.get(normalized)
    if not key:
        raise RuntimeError(f"unknown shortcut: {name}")
    return key


def send_chat_message(
    hwnd: int,
    text: str,
    close_after_send: bool,
    close_settle_ms: int,
) -> dict[str, Any]:
    focus_window(hwnd)
    click_named_point(hwnd, "chat_input")
    INPUT_GUARD.guarded_sleep(80, "send_chat_message")

    pyperclip.copy(text)
    pydirectinput.keyDown("ctrl")
    pydirectinput.press("v")
    pydirectinput.keyUp("ctrl")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(80, "send_chat_message")

    send_click = click_named_point(hwnd, "chat_send")
    INPUT_GUARD.guarded_sleep(180, "send_chat_message")

    if close_after_send:
        click_named_point(hwnd, "chat_exit")
        INPUT_GUARD.guarded_sleep(max(0, close_settle_ms), "send_chat_message")

    return {
        "textLength": len(text),
        "sendClick": send_click,
        "closeAfterSend": close_after_send,
        "closeSettleMs": close_settle_ms,
    }


def read_current_chat(hwnd: int) -> dict[str, Any]:
    stage_state, stage_checks = probe_until_timeout(
        "read_current_chat",
        lambda: detect_npc_interaction_stage(hwnd),
        lambda state: str(state.get("stage") or "") == "chat_ready",
        timeout_ms=1800,
        interval_ms=180,
        initial_wait_ms=220,
    )
    if stage_state["stage"] != "chat_ready":
        raise RuntimeError(
            "Current screen is not chat_ready. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    dialog_state, dialog_checks = probe_until_timeout(
        "read_current_chat",
        lambda: detect_dialog(hwnd),
        lambda state: bool(str(state.get("text") or "").strip()),
        timeout_ms=2200,
        interval_ms=220,
        initial_wait_ms=260,
    )
    dialog_text = str(dialog_state.get("text") or "").strip()
    if not dialog_text:
        raise RuntimeError("Current chat screen has no readable dialog text")

    return {
        "stage": "chat_ready",
        "dialogText": dialog_text,
        "stageTexts": stage_state["texts"],
        "stageChecks": stage_checks,
        "dialogChecks": dialog_checks,
    }


def find_moving_view_button(hwnd: int) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["moving_view_search"]
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)

    for item in items:
        normalized = item["text"].replace(" ", "")
        if "查看" not in normalized:
            continue

        # The actual hit target is the magnifier icon above the "查看" label.
        screen_x = round(bounds["left"] + bounds["width"] * roi[0] + item["centerX"])
        screen_y = round(bounds["top"] + bounds["height"] * roi[1] + max(18, item["minY"] - 42))
        return {
            "text": item["text"],
            "score": item["score"],
            "screenX": screen_x,
            "screenY": screen_y,
            "xRatio": round((screen_x - bounds["left"]) / max(1, bounds["width"]), 4),
            "yRatio": round((screen_y - bounds["top"]) / max(1, bounds["height"]), 4),
        }

    return None


def is_front_moving_view_candidate(moving_view: dict[str, Any] | None) -> bool:
    if not moving_view:
        return False
    x_ratio = float(moving_view.get("xRatio") or 0.0)
    y_ratio = float(moving_view.get("yRatio") or 0.0)
    return 0.30 <= x_ratio <= 0.78 and 0.18 <= y_ratio <= 0.72


def scan_nearby_npc_targets(hwnd: int, title: str) -> dict[str, Any]:
    scan_attempts: list[dict[str, Any]] = []

    for x_ratio, y_ratio in NPC_CAPTURE_SCAN_POINTS:
        click_state = click_npc_candidate(hwnd, x_ratio, y_ratio, "left")
        INPUT_GUARD.guarded_sleep(45, title)
        stage_state = detect_npc_interaction_stage(hwnd)
        target_info = detect_target_threshold(hwnd)
        moving_view = find_moving_view_button(hwnd)
        scan_attempt = {
            "xRatio": x_ratio,
            "yRatio": y_ratio,
            "click": click_state,
            "stage": stage_state["stage"],
            "targetText": target_info["text"],
            "hasSelectedTarget": has_selected_target(target_info),
            "hasReliableSelectedTarget": has_reliable_selected_target(hwnd, stage_state, target_info),
            "movingView": moving_view,
        }
        scan_attempts.append(scan_attempt)

        if stage_state["stage"] in ["npc_action_menu", "small_talk_menu", "chat_ready", "gift_screen", "trade_screen"]:
            return {
                "source": "nearby_scan",
                "matched": True,
                "attempts": scan_attempts,
                "stage": stage_state["stage"],
                "stageTexts": stage_state["texts"],
                "targetText": target_info["text"],
                "movingView": moving_view,
            }

        if has_clickable_selected_target(hwnd, stage_state, target_info, moving_view):
            return {
                "source": "nearby_scan",
                "matched": True,
                "attempts": scan_attempts,
                "stage": stage_state["stage"],
                "stageTexts": stage_state["texts"],
                "targetText": target_info["text"],
                "movingView": moving_view,
            }

    last_attempt = scan_attempts[-1] if scan_attempts else {
        "stage": "none",
        "targetText": "",
        "movingView": None,
    }
    return {
            "source": "nearby_scan",
            "matched": False,
            "attempts": scan_attempts,
            "stage": last_attempt["stage"],
            "stageTexts": {},
            "targetText": last_attempt["targetText"],
            "movingView": last_attempt["movingView"],
        }


def open_view_for_selected_npc(
    hwnd: int,
    title: str,
    target_text: str,
    last_npc_click: dict[str, Any] | None = None,
    max_attempts: int = 3,
) -> dict[str, Any]:
    view_attempts: list[dict[str, Any]] = []
    click_offsets = [(0, 0), (10, -8), (-10, 8)]
    candidate = None

    for attempt_index in range(max(1, max_attempts)):
        moving_view = find_moving_view_button(hwnd)
        if not moving_view and target_text:
            moving_view = find_view_button_near_target(hwnd, target_text)
        if (
            not moving_view
            and last_npc_click
            and last_npc_click.get("screenX") is not None
            and last_npc_click.get("screenY") is not None
        ):
            moving_view = find_view_button_near_click(
                hwnd,
                int(last_npc_click["screenX"]),
                int(last_npc_click["screenY"]),
            )

        if moving_view:
            candidate = moving_view

        if not candidate:
            break

        offset_x, offset_y = click_offsets[min(attempt_index, len(click_offsets) - 1)]
        click_screen_point(
            hwnd,
            int(candidate["screenX"]) + offset_x,
            int(candidate["screenY"]) + offset_y,
            "left",
        )
        view_attempts.append(
            {
                **candidate,
                "source": "selected_npc_view_button",
                "attemptIndex": attempt_index + 1,
                "offsetX": offset_x,
                "offsetY": offset_y,
                "targetText": target_text,
            }
        )
        INPUT_GUARD.guarded_sleep(120, title)

        stage_state = detect_npc_interaction_stage(hwnd)
        quick_menu_state = detect_bottom_right_menu_stage(hwnd)
        stage = quick_menu_state["stage"]
        stage_texts = {
            **stage_state["texts"],
            "bottom_right_actions": quick_menu_state["text"],
        }
        if stage not in ["npc_action_menu", "small_talk_menu"]:
            stage = stage_state["stage"]
            stage_texts = stage_state["texts"]

        if stage in ["npc_action_menu", "small_talk_menu", "chat_ready", "gift_screen", "trade_screen"]:
            return {
                "opened": True,
                "stage": stage,
                "stageTexts": stage_texts,
                "viewAttempts": view_attempts,
            }

    return {
        "opened": False,
        "stage": detect_npc_interaction_stage(hwnd)["stage"],
        "viewAttempts": view_attempts,
    }


def reset_transient_npc_selection(hwnd: int, title: str) -> dict[str, Any]:
    focus_window(hwnd)
    pydirectinput.press("esc")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(220, title)
    return {
        "triggered": True,
        "stageAfterReset": detect_npc_interaction_stage(hwnd)["stage"],
    }


def run_travel_to_coordinate(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "travel_to_coordinate")
    x_coordinate = int(action.get("xCoordinate"))
    y_coordinate = int(action.get("yCoordinate"))
    toggle_key = str(action.get("toggleKey") or "m").strip().lower()
    wait_after_go_ms = int(action.get("waitAfterGoMs") or 0)
    poll_ms = int(action.get("pollMs") or 1000)
    max_travel_ms = int(action.get("maxTravelMs") or 24000)
    stable_poll_limit = int(action.get("stablePollLimit") or 3)
    coordinate_tolerance = int(action.get("coordinateTolerance") or 5)
    reroute_limit = int(action.get("rerouteLimit") or 2)
    confirm_point_name = str(action.get("confirmPointName") or "").strip()
    # The game shows minimap coordinates as "vertical, horizontal":
    # left value is the vertical coordinate, right value is the horizontal one.
    # Route input already follows that UI order, so success checking must map
    # the OCR'd first value back to y_coordinate and the second value to x_coordinate.
    target_coordinate = {
        "x": y_coordinate,
        "y": x_coordinate,
    }
    attempts: list[dict[str, Any]] = []

    for route_attempt in range(reroute_limit + 1):
        route_start = start_map_route_to_coordinate(
            hwnd,
            title,
            x_coordinate,
            y_coordinate,
            toggle_key=toggle_key,
            wait_after_go_ms=wait_after_go_ms,
        )
        confirm_click = route_start.get("teleportConfirm")
        ensure_map_screen_closed(hwnd, title, toggle_key=toggle_key)

        started_at = time.time()
        stable_polls = 0
        last_coordinate = None
        coordinate_samples: list[dict[str, Any]] = []
        final_coordinate = None

        while (time.time() - started_at) * 1000 < max_travel_ms:
            INPUT_GUARD.guarded_sleep(max(120, poll_ms), title)
            minimap_state = detect_minimap_coordinate(hwnd)
            sample = {
                "timestampMs": round((time.time() - started_at) * 1000),
                "found": minimap_state["found"],
                "text": minimap_state["text"],
                "coordinate": minimap_state["coordinate"],
                "roiName": minimap_state["roiName"],
            }
            coordinate_samples.append(sample)

            if not minimap_state["found"] or minimap_state["coordinate"] is None:
                continue

            final_coordinate = minimap_state["coordinate"]
            if coordinates_within_tolerance(final_coordinate, target_coordinate, coordinate_tolerance):
                attempts.append(
                    {
                        "routeAttempt": route_attempt + 1,
                        "routeStart": route_start,
                        "confirmClick": confirm_click,
                        "coordinateSamples": coordinate_samples,
                        "currentCoordinate": final_coordinate,
                        "targetCoordinate": target_coordinate,
                    }
                )
                return {
                    "id": action_id,
                    "title": title,
                    "status": "performed",
                    "detail": f"Travel reached ({x_coordinate}, {y_coordinate}) within tolerance",
                    "input": {
                        "mode": "travel_to_coordinate",
                        "toggleKey": toggle_key,
                        "targetCoordinate": target_coordinate,
                        "currentCoordinate": final_coordinate,
                        "coordinateTolerance": coordinate_tolerance,
                        "rerouteLimit": reroute_limit,
                        "attempts": attempts,
                    },
                }

            if last_coordinate == final_coordinate:
                stable_polls += 1
            else:
                stable_polls = 0
            last_coordinate = final_coordinate

            if stable_polls >= stable_poll_limit:
                break

        attempts.append(
            {
                        "routeAttempt": route_attempt + 1,
                        "routeStart": route_start,
                        "confirmClick": confirm_click,
                        "coordinateSamples": coordinate_samples,
                        "currentCoordinate": final_coordinate,
                        "targetCoordinate": target_coordinate,
            }
        )

    current_coordinate = attempts[-1]["currentCoordinate"] if attempts else None
    failed_input = {
        "mode": "travel_to_coordinate",
        "targetCoordinate": target_coordinate,
        "currentCoordinate": current_coordinate,
        "coordinateTolerance": coordinate_tolerance,
        "retryCount": len(attempts),
        "rerouteLimit": reroute_limit,
        "attempts": attempts,
    }
    raise ActionExecutionError(
        f"Route stalled before reaching ({x_coordinate}, {y_coordinate})",
        error_code="ROUTE_STALLED",
        failed_step=build_failed_step_payload(
            action,
            "Travel watchdog exceeded reroute budget",
            failed_input,
        ),
    )


def find_view_button_near_target(hwnd: int, target_text: str) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["moving_view_search"]
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    keywords = [part for part in re.split(r"\s+", str(target_text or "").strip()) if len(part) >= 2]

    if not keywords:
        return None

    target_candidates = []
    view_candidates = []

    for item in items:
        normalized = item["text"].replace(" ", "")
        if "查看" in normalized:
            view_candidates.append(item)
            continue

        if any(keyword in normalized for keyword in keywords):
            target_candidates.append(item)

    if not target_candidates or not view_candidates:
        return None

    best_match = None
    best_distance = None

    for target_item in target_candidates:
        for view_item in view_candidates:
            dx = view_item["centerX"] - target_item["centerX"]
            dy = view_item["centerY"] - target_item["centerY"]
            distance = dx * dx + dy * dy
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_match = view_item

    if best_match is None:
        return None

    screen_x = round(bounds["left"] + bounds["width"] * roi[0] + best_match["centerX"])
    screen_y = round(bounds["top"] + bounds["height"] * roi[1] + max(18, best_match["minY"] - 42))
    return {
        "text": best_match["text"],
        "score": best_match["score"],
        "screenX": screen_x,
        "screenY": screen_y,
    }
def find_bright_icon_candidates(image: np.ndarray) -> list[dict[str, Any]]:
    rgb = image[:, :, ::-1].astype(np.int16)
    grayscale = np.mean(rgb, axis=2)
    channel_spread = np.max(rgb, axis=2) - np.min(rgb, axis=2)
    mask = (grayscale >= 218) & (channel_spread <= 42)

    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    candidates: list[dict[str, Any]] = []

    for y in range(height):
        for x in range(width):
            if not mask[y, x] or visited[y, x]:
                continue

            stack = [(x, y)]
            visited[y, x] = True
            pixels: list[tuple[int, int]] = []

            while stack:
                current_x, current_y = stack.pop()
                pixels.append((current_x, current_y))

                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if next_x < 0 or next_y < 0 or next_x >= width or next_y >= height:
                        continue
                    if visited[next_y, next_x] or not mask[next_y, next_x]:
                        continue
                    visited[next_y, next_x] = True
                    stack.append((next_x, next_y))

            area = len(pixels)
            if area < 140:
                continue

            xs = [point[0] for point in pixels]
            ys = [point[1] for point in pixels]
            min_x = min(xs)
            max_x = max(xs)
            min_y = min(ys)
            max_y = max(ys)
            box_width = max_x - min_x + 1
            box_height = max_y - min_y + 1
            fill_ratio = area / float(box_width * box_height)
            aspect_ratio = box_width / float(max(1, box_height))

            if box_width < 26 or box_height < 26 or box_width > 150 or box_height > 150:
                continue
            if not 0.65 <= aspect_ratio <= 1.35:
                continue
            if not 0.24 <= fill_ratio <= 0.88:
                continue

            candidates.append(
                {
                    "centerX": (min_x + max_x) / 2,
                    "centerY": (min_y + max_y) / 2,
                    "minX": min_x,
                    "minY": min_y,
                    "maxX": max_x,
                    "maxY": max_y,
                    "area": area,
                    "fillRatio": round(fill_ratio, 4),
                }
            )

    return candidates


def choose_local_view_candidate(
    image: np.ndarray,
    left: int,
    top: int,
    anchor_x: int,
    anchor_y: int,
) -> dict[str, Any] | None:
    text_candidates = []
    for item in ocr_items(image):
        normalized = item["text"].replace(" ", "")
        if "鏌ョ湅" in normalized:
            text_candidates.append(item)

    icon_candidates = find_bright_icon_candidates(image)
    best_match = None
    best_score = None

    for icon in icon_candidates:
        screen_x = round(left + icon["centerX"])
        screen_y = round(top + icon["centerY"])
        dx_anchor = screen_x - anchor_x
        dy_anchor = screen_y - anchor_y
        anchor_distance = float(dx_anchor * dx_anchor + dy_anchor * dy_anchor)
        score = anchor_distance / 12.0
        matched_text = None

        for text_item in text_candidates:
            dx_text = icon["centerX"] - text_item["centerX"]
            dy_text = icon["centerY"] - max(0.0, text_item["minY"] - 38.0)
            text_distance = float(dx_text * dx_text + dy_text * dy_text)
            if text_distance > 3600:
                continue
            if matched_text is None or text_distance < matched_text["distance"]:
                matched_text = {
                    "text": text_item["text"],
                    "score": text_item["score"],
                    "distance": text_distance,
                }

        if matched_text:
            score -= 220.0
            score -= matched_text["score"] * 120.0
            score += matched_text["distance"] / 18.0

        score -= min(icon["area"], 2600) / 20.0
        if anchor_distance > 220.0 * 220.0:
            score += ((anchor_distance ** 0.5) - 220.0) * 9.0

        candidate = {
            "text": matched_text["text"] if matched_text else "",
            "score": round(max(0.01, 1000.0 - score), 3),
            "screenX": screen_x,
            "screenY": screen_y,
            "source": "icon+text" if matched_text else "icon_only",
            "anchorDistance": round(anchor_distance ** 0.5, 2),
            "iconBox": {
                "minX": icon["minX"],
                "minY": icon["minY"],
                "maxX": icon["maxX"],
                "maxY": icon["maxY"],
            },
        }

        if best_score is None or score < best_score:
            best_score = score
            best_match = candidate

    if best_match and float(best_match.get("anchorDistance") or 0.0) <= 220.0:
        return best_match

    if text_candidates:
        best_text = max(text_candidates, key=lambda item: item["score"])
        fallback_y = top + max(18, best_text["minY"] - 42)
        return {
            "text": best_text["text"],
            "score": round(best_text["score"], 3),
            "screenX": round(left + best_text["centerX"]),
            "screenY": round(fallback_y),
            "source": "text_only",
            "anchorDistance": round(
                ((left + best_text["centerX"] - anchor_x) ** 2 + (fallback_y - anchor_y) ** 2) ** 0.5,
                2,
            ),
        }

    return None


def find_view_button_near_click(
    hwnd: int,
    anchor_x: int,
    anchor_y: int,
    search_width: int = 420,
    search_height: int = 360,
) -> dict[str, Any] | None:
    bounds = get_window_bounds(hwnd)
    left = max(bounds["left"], anchor_x - search_width // 2)
    top = max(bounds["top"], anchor_y - search_height // 2)
    right = min(bounds["left"] + bounds["width"], left + search_width)
    bottom = min(bounds["top"] + bounds["height"], top + search_height)
    image = capture_screen_rect(left, top, right - left, bottom - top)

    best_match = None

    for item in items:
        normalized = item["text"].replace(" ", "")
        if "查看" not in normalized:
            continue

        screen_x = round(left + item["centerX"])
        screen_y = round(top + max(18, item["minY"] - 42))
        candidate = {
            "text": item["text"],
            "score": item["score"],
            "screenX": screen_x,
            "screenY": screen_y,
        }

        if best_match is None or candidate["score"] > best_match["score"]:
            best_match = candidate

    return best_match


def find_bright_icon_candidates(image: np.ndarray) -> list[dict[str, Any]]:
    rgb = image[:, :, ::-1].astype(np.int16)
    grayscale = np.mean(rgb, axis=2)
    channel_spread = np.max(rgb, axis=2) - np.min(rgb, axis=2)
    mask = (grayscale >= 218) & (channel_spread <= 42)

    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    candidates: list[dict[str, Any]] = []

    for y in range(height):
        for x in range(width):
            if not mask[y, x] or visited[y, x]:
                continue

            stack = [(x, y)]
            visited[y, x] = True
            pixels: list[tuple[int, int]] = []

            while stack:
                current_x, current_y = stack.pop()
                pixels.append((current_x, current_y))

                for next_x, next_y in (
                    (current_x - 1, current_y),
                    (current_x + 1, current_y),
                    (current_x, current_y - 1),
                    (current_x, current_y + 1),
                ):
                    if next_x < 0 or next_y < 0 or next_x >= width or next_y >= height:
                        continue
                    if visited[next_y, next_x] or not mask[next_y, next_x]:
                        continue
                    visited[next_y, next_x] = True
                    stack.append((next_x, next_y))

            area = len(pixels)
            if area < 140:
                continue

            xs = [point[0] for point in pixels]
            ys = [point[1] for point in pixels]
            min_x = min(xs)
            max_x = max(xs)
            min_y = min(ys)
            max_y = max(ys)
            box_width = max_x - min_x + 1
            box_height = max_y - min_y + 1
            fill_ratio = area / float(box_width * box_height)
            aspect_ratio = box_width / float(max(1, box_height))

            if box_width < 26 or box_height < 26 or box_width > 150 or box_height > 150:
                continue
            if not 0.65 <= aspect_ratio <= 1.35:
                continue
            if not 0.24 <= fill_ratio <= 0.88:
                continue

            candidates.append(
                {
                    "centerX": (min_x + max_x) / 2,
                    "centerY": (min_y + max_y) / 2,
                    "minX": min_x,
                    "minY": min_y,
                    "maxX": max_x,
                    "maxY": max_y,
                    "area": area,
                    "fillRatio": round(fill_ratio, 4),
                }
            )

    return candidates


def choose_local_view_candidate(
    image: np.ndarray,
    left: int,
    top: int,
    anchor_x: int,
    anchor_y: int,
) -> dict[str, Any] | None:
    text_candidates = []
    for item in ocr_items(image):
        normalized = item["text"].replace(" ", "")
        if "鏌ョ湅" in normalized:
            text_candidates.append(item)

    icon_candidates = find_bright_icon_candidates(image)
    best_match = None
    best_score = None

    for icon in icon_candidates:
        screen_x = round(left + icon["centerX"])
        screen_y = round(top + icon["centerY"])
        dx_anchor = screen_x - anchor_x
        dy_anchor = screen_y - anchor_y
        anchor_distance = float(dx_anchor * dx_anchor + dy_anchor * dy_anchor)
        score = anchor_distance / 12.0
        matched_text = None

        for text_item in text_candidates:
            dx_text = icon["centerX"] - text_item["centerX"]
            dy_text = icon["centerY"] - max(0.0, text_item["minY"] - 38.0)
            text_distance = float(dx_text * dx_text + dy_text * dy_text)
            if text_distance > 3600:
                continue
            if matched_text is None or text_distance < matched_text["distance"]:
                matched_text = {
                    "text": text_item["text"],
                    "score": text_item["score"],
                    "distance": text_distance,
                }

        if matched_text:
            score -= 220.0
            score -= matched_text["score"] * 120.0
            score += matched_text["distance"] / 18.0

        score -= min(icon["area"], 2600) / 20.0

        candidate = {
            "text": matched_text["text"] if matched_text else "",
            "score": round(max(0.01, 1000.0 - score), 3),
            "screenX": screen_x,
            "screenY": screen_y,
            "source": "icon+text" if matched_text else "icon_only",
            "anchorDistance": round(anchor_distance ** 0.5, 2),
            "iconBox": {
                "minX": icon["minX"],
                "minY": icon["minY"],
                "maxX": icon["maxX"],
                "maxY": icon["maxY"],
            },
        }

        if best_score is None or score < best_score:
            best_score = score
            best_match = candidate

    if best_match:
        return best_match

    if text_candidates:
        best_text = max(text_candidates, key=lambda item: item["score"])
        fallback_y = top + max(18, best_text["minY"] - 42)
        return {
            "text": best_text["text"],
            "score": round(best_text["score"], 3),
            "screenX": round(left + best_text["centerX"]),
            "screenY": round(fallback_y),
            "source": "text_only",
            "anchorDistance": round(
                ((left + best_text["centerX"] - anchor_x) ** 2 + (fallback_y - anchor_y) ** 2) ** 0.5,
                2,
            ),
        }

    return None


def find_view_button_near_click(
    hwnd: int,
    anchor_x: int,
    anchor_y: int,
    search_width: int = 420,
    search_height: int = 360,
) -> dict[str, Any] | None:
    bounds = get_window_bounds(hwnd)
    left = max(bounds["left"], anchor_x - search_width // 2)
    top = max(bounds["top"], anchor_y - search_height // 2)
    right = min(bounds["left"] + bounds["width"], left + search_width)
    bottom = min(bounds["top"] + bounds["height"], top + search_height)
    image = capture_screen_rect(left, top, right - left, bottom - top)
    best_match = choose_local_view_candidate(image, left, top, anchor_x, anchor_y)
    if best_match and float(best_match.get("score") or 0.0) < MIN_VIEW_BUTTON_SCORE:
        best_match = None
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    click_point = None
    if best_match:
        click_point = (best_match["screenX"] - left, best_match["screenY"] - top)
    debug_path = save_debug_image(image, f"view-search-{timestamp}-{anchor_x}-{anchor_y}.jpg", click_point)
    if best_match:
        best_match["debugImage"] = debug_path
        best_match["searchRect"] = {
            "left": left,
            "top": top,
            "width": right - left,
            "height": bottom - top,
        }
    return best_match


def choose_local_view_candidate(
    image: np.ndarray,
    left: int,
    top: int,
    anchor_x: int,
    anchor_y: int,
) -> dict[str, Any] | None:
    icon_candidates = find_bright_icon_candidates(image)
    best_match = None
    best_score = None

    for icon in icon_candidates:
        screen_x = round(left + icon["centerX"])
        screen_y = round(top + icon["centerY"])
        dx_anchor = screen_x - anchor_x
        dy_anchor = screen_y - anchor_y
        anchor_distance = float(dx_anchor * dx_anchor + dy_anchor * dy_anchor)
        score = anchor_distance / 12.0
        score -= min(icon["area"], 2600) / 20.0

        candidate = {
            "text": "",
            "score": round(max(0.01, 1000.0 - score), 3),
            "screenX": screen_x,
            "screenY": screen_y,
            "source": "icon_only",
            "anchorDistance": round(anchor_distance ** 0.5, 2),
            "iconBox": {
                "minX": icon["minX"],
                "minY": icon["minY"],
                "maxX": icon["maxX"],
                "maxY": icon["maxY"],
            },
        }

        if best_score is None or score < best_score:
            best_score = score
            best_match = candidate

    return best_match


def find_view_button_near_target(hwnd: int, target_text: str) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["moving_view_search"]
    bounds = get_window_bounds(hwnd)
    left = int(bounds["left"] + bounds["width"] * roi[0])
    top = int(bounds["top"] + bounds["height"] * roi[1])
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    keywords = [part for part in re.split(r"\s+", normalize_npc_name(target_text)) if len(part) >= 2]
    if not keywords:
        return None

    target_candidates = []
    for item in items:
        normalized = normalize_npc_name(item["text"])
        if not normalized:
            continue
        if any(keyword in normalized or normalized in keyword for keyword in keywords):
            target_candidates.append(item)

    if not target_candidates:
        return None

    best_target = max(target_candidates, key=lambda item: float(item["score"]))
    anchor_x = round(left + best_target["centerX"])
    anchor_y = round(top + best_target["maxY"] + max(36, (best_target["maxY"] - best_target["minY"]) * 2.6))
    candidate = choose_local_view_candidate(image, left, top, anchor_x, anchor_y)
    if not candidate:
        return None
    if float(candidate.get("score") or 0.0) < MIN_VIEW_BUTTON_SCORE:
        return None
    candidate["xRatio"] = round((int(candidate["screenX"]) - bounds["left"]) / max(1, bounds["width"]), 4)
    candidate["yRatio"] = round((int(candidate["screenY"]) - bounds["top"]) / max(1, bounds["height"]), 4)
    candidate["targetAnchor"] = {
        "screenX": anchor_x,
        "screenY": anchor_y,
        "text": best_target["text"],
        "score": round(float(best_target["score"]), 3),
    }
    return candidate


def find_moving_view_button(hwnd: int) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["moving_view_search"]
    bounds = get_window_bounds(hwnd)
    left = int(bounds["left"] + bounds["width"] * roi[0])
    top = int(bounds["top"] + bounds["height"] * roi[1])
    image = capture_window_region(hwnd, roi)
    anchor_x = round(left + image.shape[1] * 0.56)
    anchor_y = round(top + image.shape[0] * 0.60)
    candidate = choose_local_view_candidate(image, left, top, anchor_x, anchor_y)
    if not candidate:
        return None
    if float(candidate.get("score") or 0.0) < MIN_VIEW_BUTTON_SCORE:
        return None
    candidate["xRatio"] = round((int(candidate["screenX"]) - bounds["left"]) / max(1, bounds["width"]), 4)
    candidate["yRatio"] = round((int(candidate["screenY"]) - bounds["top"]) / max(1, bounds["height"]), 4)
    candidate["searchRect"] = {
        "left": left,
        "top": top,
        "width": image.shape[1],
        "height": image.shape[0],
    }
    return candidate


def pulse_forward(hwnd: int, move_pulse_ms: int) -> dict[str, Any]:
    bounds = focus_window(hwnd)
    pydirectinput.keyDown("w")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(move_pulse_ms, "move_forward_pulse")
    pydirectinput.keyUp("w")
    INPUT_GUARD.refresh_baseline()
    return {
        "screenX": round(bounds["left"] + bounds["width"] * 0.5),
        "screenY": round(bounds["top"] + bounds["height"] * 0.5),
        "movePulseMs": move_pulse_ms,
    }


def run_move_forward_pulse(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "move_forward_pulse")
    raw_move_pulse_ms = action.get("movePulseMs")
    move_pulse_ms = DEFAULT_MOVE_PULSE_MS if raw_move_pulse_ms is None else int(raw_move_pulse_ms)
    baseline = capture_idle_baseline(hwnd)
    state = pulse_forward(hwnd, move_pulse_ms)
    verification = verify_dynamic_change(
        hwnd,
        baseline,
        int(action.get("verifySettleMs") or DEFAULT_VERIFY_SETTLE_MS),
        float(action.get("meanMultiplier") or 2.2),
        float(action.get("ratioMultiplier") or 2.2),
        float(action.get("minimumMeanFloor") or 1.1),
        float(action.get("minimumRatioFloor") or 0.012),
    )
    time.sleep((int(action.get("postDelayMs") or DEFAULT_POST_DELAY_MS)) / 1000)
    step_payload = {
        "id": action_id,
        "title": title,
        "sourceType": action.get("sourceType"),
        "status": "performed" if verification["decision"] == "pass" else "review_required",
        "detail": f"Moved forward for {move_pulse_ms}ms",
        "input": {
            **state,
            "actionType": "move_forward_pulse",
            "verification": verification,
        },
    }
    if verification["decision"] == "fail":
        step_payload["status"] = "failed"
        raise ActionExecutionError(
            "move_forward_pulse verification failed: "
            f"meanDelta={verification['meanDelta']}, changedRatio={verification['changedRatio']}",
            error_code="MOTION_VERIFICATION_FAILED",
            failed_step=step_payload,
        )
    return step_payload


def drag_camera(hwnd: int, start_ratio: tuple[float, float], end_ratio: tuple[float, float], duration_ms: int) -> dict[str, Any]:
    bounds = focus_window(hwnd)
    start_x = round(bounds["left"] + bounds["width"] * start_ratio[0])
    start_y = round(bounds["top"] + bounds["height"] * start_ratio[1])
    end_x = round(bounds["left"] + bounds["width"] * end_ratio[0])
    end_y = round(bounds["top"] + bounds["height"] * end_ratio[1])

    pydirectinput.moveTo(start_x, start_y)
    pydirectinput.mouseDown(button="right")
    pydirectinput.moveTo(end_x, end_y, duration=duration_ms / 1000)
    pydirectinput.mouseUp(button="right")
    INPUT_GUARD.refresh_baseline()

    return {
        "startX": start_x,
        "startY": start_y,
        "endX": end_x,
        "endY": end_y,
        "durationMs": duration_ms,
    }


def run_drag_camera(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "drag_camera")
    start_ratio = action.get("startRatio") or [0.52, 0.48]
    end_ratio = action.get("endRatio") or [0.66, 0.48]
    duration_ms = int(action.get("durationMs") or DEFAULT_CAMERA_DRAG_MS)
    baseline = capture_idle_baseline(hwnd)
    state = drag_camera(
        hwnd,
        (float(start_ratio[0]), float(start_ratio[1])),
        (float(end_ratio[0]), float(end_ratio[1])),
        duration_ms,
    )
    verification = verify_dynamic_change(
        hwnd,
        baseline,
        int(action.get("verifySettleMs") or DEFAULT_VERIFY_SETTLE_MS),
        float(action.get("meanMultiplier") or 2.8),
        float(action.get("ratioMultiplier") or 2.8),
        float(action.get("minimumMeanFloor") or 1.8),
        float(action.get("minimumRatioFloor") or 0.02),
    )
    time.sleep((int(action.get("postDelayMs") or DEFAULT_POST_DELAY_MS)) / 1000)
    step_payload = {
        "id": action_id,
        "title": title,
        "sourceType": action.get("sourceType"),
        "status": "performed" if verification["decision"] == "pass" else "review_required",
        "detail": f"Dragged camera for {duration_ms}ms",
        "input": {
            "actionType": "drag_camera",
            "startRatio": start_ratio,
            "endRatio": end_ratio,
            **state,
            "verification": verification,
        },
    }
    if verification["decision"] == "fail":
        step_payload["status"] = "failed"
        raise ActionExecutionError(
            "drag_camera verification failed: "
            f"meanDelta={verification['meanDelta']}, changedRatio={verification['changedRatio']}",
            error_code="MOTION_VERIFICATION_FAILED",
            failed_step=step_payload,
        )
    return step_payload


def parse_favor_value(text: str) -> int | None:
    match = re.search(r"好感度[:：]\s*(\d+)\s*/\s*\d+", str(text or ""))
    if not match:
        return None
    return int(match.group(1))


def parse_favor_limit(text: str) -> int | None:
    normalized = re.sub(r"\s+", "", str(text or ""))
    match = re.search(r"好感度[:：]?(\d+)/(\d+)", normalized)
    if not match:
        return None
    return int(match.group(2))


def extract_favor_pair(text: str) -> tuple[int, int] | None:
    normalized = re.sub(r"\s+", "", str(text or ""))
    matches = re.findall(r"(\d+)\s*/\s*(\d+)", normalized)
    if not matches:
        return None

    for left, right in matches:
        left_value = int(left)
        right_value = int(right)
        if right_value in {99, 199, 299, 599} and left_value <= right_value:
            return left_value, right_value

    left, right = matches[0]
    left_value = int(left)
    right_value = int(right)
    if left_value <= right_value:
        return left_value, right_value
    return None


def parse_favor_value(text: str) -> int | None:
    favor_pair = extract_favor_pair(text)
    if not favor_pair:
        return None
    return int(favor_pair[0])


def parse_favor_limit(text: str) -> int | None:
    # Only the value after "/" is the cap used for routing:
    # 12/99 -> 99, 23/299 -> 299.
    favor_pair = extract_favor_pair(text)
    if not favor_pair:
        return None
    return int(favor_pair[1])


def inspect_gift_chat_threshold(stage_state: dict[str, Any]) -> dict[str, Any]:
    gift_panel_text = str(stage_state["texts"].get("gift_panel") or "")
    favor_before = parse_favor_value(gift_panel_text)
    favor_limit = parse_favor_limit(gift_panel_text)
    if favor_limit == 99:
        gift_policy = "chat_direct"
        gift_count = 0
    elif favor_limit == 199:
        gift_policy = "gift_fixed"
        gift_count = 2
    elif favor_limit == 299:
        gift_policy = "gift_fixed"
        gift_count = 4
    else:
        gift_policy = "gift_fixed"
        gift_count = 4
    return {
        "favorBefore": favor_before,
        "favorLimit": favor_limit,
        "favorLimitDetected": favor_limit is not None,
        "giftPolicy": gift_policy,
        "giftCount": gift_count,
        "giftPanelText": gift_panel_text,
    }


def is_gift_screen_text(text: str) -> bool:
    normalized = re.sub(r"\s+", "", str(text or ""))
    if not normalized:
        return False
    if any(keyword in normalized for keyword in ["选择礼物", "赠送"]):
        return True
    if "好感度" in normalized and parse_favor_limit(normalized) is not None:
        return True
    return False


def detect_target_threshold(hwnd: int) -> dict[str, Any]:
    text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["selected_target"]))
    is_special = "<" in text and ">" in text
    return {
        "isSpecialNpc": is_special,
        "threshold": 50 if is_special else 10,
        "text": text,
    }


def has_selected_target(target_info: dict[str, Any]) -> bool:
    raw_text = str(target_info.get("text") or "").strip()
    normalized = normalize_npc_name(raw_text)
    if not normalized:
        return False
    if bool(target_info.get("isSpecialNpc")):
        return "<" in raw_text and ">" in raw_text and len(normalized) >= 3
    return re.fullmatch(r"[\u4e00-\u9fff]{2,6}", normalized) is not None


def has_selected_target_visual(hwnd: int) -> bool:
    image = capture_window_region(hwnd, NPC_STAGE_ROIS["selected_target"])
    height, width = image.shape[:2]
    if width <= 0 or height <= 0:
        return False

    avatar = image[0:max(8, int(height * 0.86)), 0:max(8, int(width * 0.30))]
    avatar_gray = cv2.cvtColor(avatar, cv2.COLOR_BGR2GRAY)
    avatar_edge_ratio = float(np.count_nonzero(cv2.Canny(avatar_gray, 60, 140))) / float(max(avatar_gray.size, 1))

    hp_left = max(0, int(width * 0.26))
    hp_top = max(0, int(height * 0.18))
    hp_right = max(hp_left + 1, min(width, int(width * 0.84)))
    hp_bottom = max(hp_top + 1, min(height, int(height * 0.36)))
    hp_image = image[hp_top:hp_bottom, hp_left:hp_right]
    hp_gray = cv2.cvtColor(hp_image, cv2.COLOR_BGR2GRAY)
    _, hp_mask = cv2.threshold(hp_gray, 168, 255, cv2.THRESH_BINARY)
    hp_mask = cv2.morphologyEx(hp_mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
    contours, _ = cv2.findContours(hp_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    has_hp_bar = False
    for contour in contours:
        _x, _y, bar_width, bar_height = cv2.boundingRect(contour)
        if bar_width >= 36 and 3 <= bar_height <= 16 and (bar_width / max(bar_height, 1)) >= 4.0:
            has_hp_bar = True
            break

    cross_left = max(0, int(width * 0.74))
    cross_top = max(0, int(height * 0.04))
    cross_right = max(cross_left + 1, min(width, int(width * 0.92)))
    cross_bottom = max(cross_top + 1, min(height, int(height * 0.22)))
    cross_image = image[cross_top:cross_bottom, cross_left:cross_right]
    cross_gray = cv2.cvtColor(cross_image, cv2.COLOR_BGR2GRAY)
    _, cross_mask = cv2.threshold(cross_gray, 160, 255, cv2.THRESH_BINARY)
    cross_lines = cv2.HoughLinesP(cross_mask, 1, np.pi / 180, threshold=10, minLineLength=8, maxLineGap=4)
    has_cross = False
    if cross_lines is not None:
        positive = 0
        negative = 0
        for line in cross_lines[:, 0]:
            x1, y1, x2, y2 = [int(value) for value in line]
            dx = x2 - x1
            dy = y2 - y1
            if abs(dx) < 4 or abs(dy) < 4:
                continue
            slope = dy / dx
            if 0.5 <= slope <= 1.8:
                positive += 1
            elif -1.8 <= slope <= -0.5:
                negative += 1
        has_cross = positive >= 1 and negative >= 1

    return avatar_edge_ratio >= 0.02 and (has_hp_bar or has_cross)


def has_reliable_selected_target(hwnd: int, stage_state: dict[str, Any], target_info: dict[str, Any]) -> bool:
    stage = str(stage_state.get("stage") or "none")
    if stage in NPC_READY_STAGES:
        return True
    look_text = str(stage_state.get("texts", {}).get("look_button") or "")
    if contains_any_keyword(look_text, ["查看"]):
        return True
    if stage != "npc_selected":
        return False
    return has_selected_target(target_info) and has_selected_target_visual(hwnd)


def has_reliable_selected_target(hwnd: int, stage_state: dict[str, Any], target_info: dict[str, Any]) -> bool:
    stage = str(stage_state.get("stage") or "none")
    if stage in NPC_READY_STAGES:
        return True
    if has_selected_target_visual(hwnd):
        return True
    look_text = str(stage_state.get("texts", {}).get("look_button") or "")
    if contains_any_keyword(look_text, ["鏌ョ湅"]):
        return True
    return stage == "npc_selected"


def has_clickable_selected_target(
    hwnd: int,
    stage_state: dict[str, Any],
    target_info: dict[str, Any],
    moving_view: dict[str, Any] | None,
) -> bool:
    stage = str(stage_state.get("stage") or "none")
    if stage in NPC_READY_STAGES:
        return True
    if not moving_view:
        return False
    # Stabilized social-chain rule:
    # after closing gift/chat panels the world state may briefly lose the
    # left-top selected-name readback, but if the magnifier is still inside
    # the verified front interaction area, it is already safe to continue.
    if is_front_moving_view_candidate(moving_view):
        return True
    if has_reliable_selected_target(hwnd, stage_state, target_info):
        return True
    return has_selected_target(target_info)


def has_strict_clickable_selected_target(
    stage_state: dict[str, Any],
    moving_view: dict[str, Any] | None,
) -> bool:
    stage = str(stage_state.get("stage") or "none")
    if stage in NPC_READY_STAGES:
        return True
    if not moving_view:
        return False
    return is_front_moving_view_candidate(moving_view)


def normalize_npc_name(text: str) -> str:
    normalized = re.sub(r"\s+", "", str(text or ""))
    normalized = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9<>]", "", normalized)
    return normalized


def names_match(expected_name: str, actual_name: str) -> bool:
    expected = normalize_npc_name(expected_name)
    actual = normalize_npc_name(actual_name)
    if not expected or not actual:
        return False
    return expected == actual or expected in actual or actual in expected


def count_name_overlap(expected_name: str, actual_name: str) -> int:
    expected = normalize_npc_name(expected_name)
    actual = normalize_npc_name(actual_name)
    if not expected or not actual:
        return 0

    overlap = 0
    remaining = list(actual)
    for char in expected:
        if char in remaining:
            overlap += 1
            remaining.remove(char)
    return overlap


def find_click_target_name(
    hwnd: int,
    screen_x: int,
    screen_y: int,
    search_width: int = 240,
    search_height: int = 220,
) -> dict[str, Any] | None:
    bounds = get_window_bounds(hwnd)
    left = max(bounds["left"], screen_x - search_width // 2)
    top = max(bounds["top"], screen_y - search_height // 2)
    right = min(bounds["left"] + bounds["width"], left + search_width)
    bottom = min(bounds["top"] + bounds["height"], top + search_height)
    image = capture_screen_rect(left, top, right - left, bottom - top)
    items = ocr_items(image)

    best_match = None
    best_distance = None
    for item in items:
        normalized = normalize_npc_name(item["text"])
        if not re.fullmatch(r"[\u4e00-\u9fff]{2,4}", normalized):
            continue
        item_screen_x = left + item["centerX"]
        item_screen_y = top + item["centerY"]
        dx = item_screen_x - screen_x
        dy = item_screen_y - screen_y
        distance = dx * dx + dy * dy
        if best_distance is None or distance < best_distance:
            best_distance = distance
            best_match = {
                "text": normalized,
                "score": round(item["score"], 3),
                "screenX": round(item_screen_x),
                "screenY": round(item_screen_y),
            }

    return best_match


def verify_npc_selection(
    hwnd: int,
    click_state: dict[str, Any],
    expected_name: str,
    verify_within_ms: int = 200,
) -> dict[str, Any]:
    deadline = time.time() + verify_within_ms / 1000.0
    attempts: list[dict[str, Any]] = []

    while time.time() <= deadline:
        INPUT_GUARD.check_or_raise("verify_npc_selection")
        target_info = detect_target_threshold(hwnd)
        actual_name = normalize_npc_name(target_info["text"])
        matched = names_match(expected_name, actual_name)
        attempt = {
            "expectedName": normalize_npc_name(expected_name),
            "actualName": actual_name,
            "matched": matched,
        }
        attempts.append(attempt)
        if matched:
            return {
                "selected": True,
                "expectedName": attempt["expectedName"],
                "actualName": actual_name,
                "attempts": attempts,
                "click": click_state,
            }
        INPUT_GUARD.guarded_sleep(40, "verify_npc_selection")

    last_actual = attempts[-1]["actualName"] if attempts else ""
    return {
        "selected": False,
        "expectedName": normalize_npc_name(expected_name),
        "actualName": last_actual,
        "attempts": attempts,
        "click": click_state,
    }


def find_selected_target_anchor(hwnd: int, target_text: str) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["selected_target"]
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    keywords = [part for part in re.split(r"\s+", str(target_text or "").strip()) if len(part) >= 1]

    if not keywords:
        return None

    best_match = None
    best_score = None
    for item in items:
        normalized = item["text"].replace(" ", "")
        if not any(keyword in normalized or normalized in keyword for keyword in keywords):
            continue

        score = item["score"]
        if best_score is None or score > best_score:
            best_score = score
            best_match = item

    if best_match is None:
        return None

    screen_x = round(bounds["left"] + bounds["width"] * roi[0] + best_match["centerX"])
    screen_y = round(bounds["top"] + bounds["height"] * roi[1] + min(best_match["centerY"] + 86, image.shape[0] - 12))
    return {
        "screenX": screen_x,
        "screenY": screen_y,
        "text": best_match["text"],
        "score": round(best_match["score"], 3),
        "source": "selected_target_roi",
    }


def find_named_npc_in_scene(hwnd: int, target_text: str) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["scene_npc_search"]
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    items.extend(ocr_items_upscaled(image, 2.0))
    items.extend(ocr_items_upscaled(image, 3.0))
    expected_name = normalize_npc_name(target_text)
    keywords = [part for part in re.split(r"\s+", expected_name) if part]

    if not keywords:
        return None

    best_match = None
    best_score = None
    for item in items:
        normalized = normalize_npc_name(item["text"])
        if not normalized:
            continue
        overlap = count_name_overlap(expected_name, normalized)
        if not any(keyword in normalized or normalized in keyword for keyword in keywords) and overlap < 2:
            continue

        score = float(item["score"]) + overlap * 20.0
        if best_score is None or score > best_score:
            best_score = score
            best_match = item

    if best_match is None:
        return None

    screen_x = round(bounds["left"] + bounds["width"] * roi[0] + best_match["centerX"])
    screen_y = round(bounds["top"] + bounds["height"] * roi[1] + min(best_match["centerY"] + 86, image.shape[0] - 10))
    return {
        "text": best_match["text"],
        "score": round(best_match["score"], 3),
        "screenX": screen_x,
        "screenY": screen_y,
        "source": "scene_npc_search",
    }


def find_text_button_in_roi(hwnd: int, roi: tuple[float, float, float, float], target_text: str) -> dict[str, Any] | None:
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    keywords = [part for part in re.split(r"\s+", normalize_npc_name(target_text)) if part]

    if not keywords:
        return None

    best_match = None
    best_score = None
    for item in items:
        normalized = normalize_npc_name(item["text"])
        if not normalized:
            continue
        if not any(keyword in normalized or normalized in keyword for keyword in keywords):
            continue
        score = float(item["score"])
        if best_score is None or score > best_score:
            best_score = score
            best_match = item

    if best_match is None:
        return None

    return {
        "text": best_match["text"],
        "score": round(best_match["score"], 3),
        "screenX": round(bounds["left"] + bounds["width"] * roi[0] + best_match["centerX"]),
        "screenY": round(bounds["top"] + bounds["height"] * roi[1] + best_match["centerY"]),
        "source": "roi_text_match",
    }


def run_open_named_npc_trade(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "open_named_npc_trade")
    target_name = str(action.get("targetName") or "").strip()
    timeout_ms = int(action.get("timeoutMs") or 5000)

    if not target_name:
        raise RuntimeError("open_named_npc_trade action requires targetName")

    focus_window(hwnd)
    npc_anchor = find_named_npc_in_scene(hwnd, target_name)
    if not npc_anchor:
        raise RuntimeError(f"Failed to locate named NPC in scene: {target_name}")

    click_state = click_screen_point(hwnd, int(npc_anchor["screenX"]), int(npc_anchor["screenY"]), "left")
    INPUT_GUARD.guarded_sleep(220, title)

    stage_state = detect_npc_interaction_stage(hwnd)
    stage_history = [stage_state["stage"]]
    view_attempt = None

    if stage_state["stage"] not in ["npc_action_menu", "small_talk_menu", "trade_screen"]:
        view_attempt = find_view_button_near_target(hwnd, target_name)
        if view_attempt:
            click_screen_point(hwnd, int(view_attempt["screenX"]), int(view_attempt["screenY"]), "left")
            INPUT_GUARD.guarded_sleep(160, title)
            quick_menu_state = detect_bottom_right_menu_stage(hwnd)
            stage_history.append(quick_menu_state["stage"])
            if quick_menu_state["stage"] in ["npc_action_menu", "small_talk_menu"]:
                stage_state = {
                    "stage": quick_menu_state["stage"],
                    "texts": {
                        "bottom_right_actions": quick_menu_state["text"],
                    },
                }

    if stage_state["stage"] not in ["npc_action_menu", "small_talk_menu", "trade_screen"]:
        menu_state = ensure_npc_action_menu(hwnd, timeout_ms, DEFAULT_MOVE_PULSE_MS, DEFAULT_SCAN_INTERVAL_MS)
        stage_history.extend(menu_state["stageHistory"])
        stage_state = {
            "stage": menu_state["stage"],
            "texts": menu_state.get("stageTexts", {}),
        }

    if stage_state["stage"] == "trade_screen":
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Reached trade screen for {target_name}",
            "input": {
                "mode": "open_named_npc_trade",
                "targetName": target_name,
                "stage": "trade_screen",
                "npcAnchor": npc_anchor,
                "click": click_state,
                "viewAttempt": view_attempt,
                "stageHistory": stage_history,
            },
        }

    click_named_point(hwnd, "trade")
    INPUT_GUARD.guarded_sleep(350, title)
    trade_state = detect_npc_interaction_stage(hwnd)
    stage_history.append(trade_state["stage"])

    if trade_state["stage"] != "trade_screen":
        raise RuntimeError(
            f"Failed to open trade screen for {target_name}. Last stage: {trade_state['stage'] or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Reached trade screen for {target_name}",
        "input": {
            "mode": "open_named_npc_trade",
            "targetName": target_name,
            "stage": "trade_screen",
            "npcAnchor": npc_anchor,
            "click": click_state,
            "viewAttempt": view_attempt,
            "stageHistory": stage_history,
        },
    }


def run_named_npc_trade_flow(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "named_npc_trade_flow")
    target_name = str(action.get("targetName") or "").strip()
    timeout_ms = int(action.get("timeoutMs") or 5000)

    if not target_name:
        raise RuntimeError("named_npc_trade_flow action requires targetName")

    open_result = run_open_named_npc_trade(
        hwnd,
        {
            "id": action_id,
            "title": title,
            "targetName": target_name,
            "timeoutMs": timeout_ms,
        },
    )
    trade_result = execute_fixed_trade_flow(hwnd, title)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Completed fixed trade flow for {target_name}",
        "input": {
            "mode": "named_npc_trade_flow",
            "targetName": target_name,
            "openTrade": open_result["input"],
            "tradeFlow": trade_result,
        },
    }


def run_open_named_vendor_purchase(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "open_named_vendor_purchase")
    target_name = str(action.get("targetName") or "").strip()
    option_text = str(action.get("optionText") or "进些货物").strip()
    interact_attempts = max(1, int(action.get("interactAttempts") or 3))
    post_interact_initial_wait_ms = int(action.get("postInteractInitialWaitMs") or 1500)
    post_option_initial_wait_ms = int(action.get("postOptionInitialWaitMs") or 1500)
    verify_window_ms = int(action.get("verifyWindowMs") or 4000)
    verify_interval_ms = int(action.get("verifyIntervalMs") or 600)

    if not target_name:
        raise RuntimeError("open_named_vendor_purchase action requires targetName")

    focus_window(hwnd)
    interact_attempt_log: list[dict[str, Any]] = []
    option_click = None
    option_match = None
    purchase_state = detect_vendor_purchase_screen(hwnd)

    for interact_index in range(interact_attempts):
        if purchase_state["visible"]:
            break

        focus_window(hwnd)
        prompt_state = detect_vendor_interact_prompt(hwnd)
        pydirectinput.press("f")
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(post_interact_initial_wait_ms, title)

        dialog_state = detect_dialog(hwnd)
        quick_menu_state = detect_bottom_right_menu_stage(hwnd)
        confirm_dialog_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["confirm_dialog"]))
        purchase_state = detect_vendor_purchase_screen(hwnd)
        option_click = None
        option_match = None
        purchase_checks: list[dict[str, Any]] = []
        combined_dialog_text = "\n".join(
            part
            for part in [
                str(dialog_state.get("text") or ""),
                str(quick_menu_state.get("text") or ""),
                str(confirm_dialog_text or ""),
            ]
            if str(part or "").strip()
        )
        fixed_option_ready = looks_like_vendor_purchase_dialog(
            combined_dialog_text,
            target_name=target_name,
            option_text=option_text,
        )
        if not purchase_state["visible"]:
            option_match = find_text_button_in_roi(hwnd, NPC_STAGE_ROIS["confirm_dialog"], option_text)
            if option_match is not None:
                option_click = click_screen_point(
                    hwnd,
                    int(option_match["screenX"]),
                    int(option_match["screenY"]),
                    "left",
                )
                purchase_state, purchase_checks = probe_state_after_initial_wait(
                    title,
                    lambda: detect_vendor_purchase_screen(hwnd),
                    lambda state: bool(state["visible"]),
                    initial_wait_ms=post_option_initial_wait_ms,
                    verify_window_ms=verify_window_ms,
                    verify_interval_ms=verify_interval_ms,
                )
            elif fixed_option_ready or dialog_state["visible"] or quick_menu_state["stage"] in {"npc_action_menu", "small_talk_menu"}:
                option_click = click_named_point(hwnd, "vendor_purchase_option")
                purchase_state, purchase_checks = probe_state_after_initial_wait(
                    title,
                    lambda: detect_vendor_purchase_screen(hwnd),
                    lambda state: bool(state["visible"]),
                    initial_wait_ms=post_option_initial_wait_ms,
                    verify_window_ms=verify_window_ms,
                    verify_interval_ms=verify_interval_ms,
                )

        interact_attempt_log.append(
            {
                "interactAttempt": interact_index + 1,
                "promptVisible": bool(prompt_state["visible"]),
                "promptText": prompt_state["text"],
                "dialogVisible": bool(dialog_state["visible"]),
                "dialogText": dialog_state["text"],
                "confirmDialogText": confirm_dialog_text,
                "menuStage": quick_menu_state["stage"],
                "menuText": quick_menu_state["text"],
                "fixedOptionReady": fixed_option_ready,
                "optionMatch": option_match,
                "optionClick": option_click,
                "purchaseVisible": bool(purchase_state["visible"]),
                "purchaseText": purchase_state["text"],
                "purchaseChecks": purchase_checks,
            }
        )

    if not purchase_state["visible"]:
        raise RuntimeError("Vendor purchase option did not open purchase screen.")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Reached vendor purchase screen for {target_name}",
        "input": {
            "mode": "open_named_vendor_purchase",
            "targetName": target_name,
            "optionText": option_text,
            "postInteractInitialWaitMs": post_interact_initial_wait_ms,
            "postOptionInitialWaitMs": post_option_initial_wait_ms,
            "verifyWindowMs": verify_window_ms,
            "verifyIntervalMs": verify_interval_ms,
            "interactAttempts": interact_attempt_log,
            "optionMatch": option_match,
            "optionClick": option_click,
            "stage": "vendor_purchase_screen",
            "purchaseText": purchase_state["text"],
        },
    }


def run_align_named_vendor_interact_prompt(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "align_named_vendor_interact_prompt")
    target_name = str(action.get("targetName") or "").strip()
    retry_limit = max(1, min(6, int(action.get("retryLimit") or 5)))
    forward_pulse_ms = max(80, int(action.get("forwardPulseMs") or 180))
    drag_duration_ms = max(80, int(action.get("dragDurationMs") or 220))
    settle_ms = max(80, int(action.get("settleMs") or 280))
    drag_pattern = [
        ((0.58, 0.54), (0.46, 0.54)),
        ((0.44, 0.54), (0.58, 0.54)),
        ((0.55, 0.54), (0.49, 0.54)),
    ]

    focus_window(hwnd)
    prompt_history: list[dict[str, Any]] = []
    drag_history: list[dict[str, Any]] = []
    forward_history: list[dict[str, Any]] = []
    prompt_state = detect_vendor_interact_prompt(hwnd)

    for attempt_index in range(retry_limit):
        prompt_history.append(
            {
                "attempt": attempt_index + 1,
                "phase": "before_drag",
                "visible": bool(prompt_state["visible"]),
                "text": prompt_state["text"],
            }
        )
        if prompt_state["visible"]:
            break

        start_ratio, end_ratio = drag_pattern[attempt_index % len(drag_pattern)]
        drag_state = drag_camera(hwnd, start_ratio, end_ratio, drag_duration_ms)
        drag_history.append({"attempt": attempt_index + 1, **drag_state})
        INPUT_GUARD.guarded_sleep(settle_ms, title)
        prompt_state = detect_vendor_interact_prompt(hwnd)
        prompt_history.append(
            {
                "attempt": attempt_index + 1,
                "phase": "after_drag",
                "visible": bool(prompt_state["visible"]),
                "text": prompt_state["text"],
            }
        )
        if prompt_state["visible"]:
            break

        forward_state = pulse_forward(hwnd, forward_pulse_ms)
        forward_history.append({"attempt": attempt_index + 1, **forward_state})
        INPUT_GUARD.guarded_sleep(settle_ms, title)
        prompt_state = detect_vendor_interact_prompt(hwnd)
        prompt_history.append(
            {
                "attempt": attempt_index + 1,
                "phase": "after_forward",
                "visible": bool(prompt_state["visible"]),
                "text": prompt_state["text"],
            }
        )
        if prompt_state["visible"]:
            break

    if not prompt_state["visible"]:
        raise ActionExecutionError(
            "Vendor interaction prompt did not appear after camera and movement adjustments",
            failed_step=build_failed_step_payload(
                action,
                "Failed to align the vendor view to a visible 对话[F] prompt",
                {
                    "mode": "align_named_vendor_interact_prompt",
                    "targetName": target_name,
                    "retryLimit": retry_limit,
                    "forwardPulseMs": forward_pulse_ms,
                    "dragDurationMs": drag_duration_ms,
                    "settleMs": settle_ms,
                    "promptHistory": prompt_history,
                },
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Aligned the view for {target_name} until 对话[F] appeared",
        "input": {
            "mode": "align_named_vendor_interact_prompt",
            "targetName": target_name,
            "retryLimit": retry_limit,
            "forwardPulseMs": forward_pulse_ms,
            "dragDurationMs": drag_duration_ms,
            "settleMs": settle_ms,
            "dragHistory": drag_history,
            "forwardHistory": forward_history,
            "promptHistory": prompt_history,
            "promptText": prompt_state["text"],
        },
    }


def run_buy_current_vendor_item(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "buy_current_vendor_item")
    quantity = max(1, int(action.get("quantity") or 1))
    post_buy_settle_ms = int(action.get("postBuySettleMs") or 1000)
    post_close_initial_wait_ms = int(action.get("postCloseInitialWaitMs") or 1500)
    verify_window_ms = int(action.get("verifyWindowMs") or 4000)
    verify_interval_ms = int(action.get("verifyIntervalMs") or 600)
    post_esc_initial_wait_ms = int(action.get("postEscInitialWaitMs") or 1500)
    item_name = str(action.get("itemName") or "墨锭").strip()

    purchase_state = detect_vendor_purchase_screen(hwnd)

    item_key = normalize_npc_name(item_name)
    if item_key == normalize_npc_name("墨锭"):
        item_button = {"pointName": "vendor_purchase_item_moding"}
    elif item_key == normalize_npc_name("散酒"):
        item_button = {"pointName": "vendor_purchase_item_sanjiu"}
    else:
        raise RuntimeError(f"Unsupported fixed vendor item: {item_name}")

    def probe_close_state() -> dict[str, Any]:
        current_purchase_state = detect_vendor_purchase_screen(hwnd)
        current_world_hud_state = detect_world_hud_state(hwnd)
        return {
            "purchaseVisible": bool(current_purchase_state["visible"]),
            "purchaseText": current_purchase_state["text"],
            "worldHudVisible": bool(current_world_hud_state["visible"]),
            "worldHudText": current_world_hud_state["text"],
        }

    def close_success(state: dict[str, Any]) -> bool:
        return (not bool(state["purchaseVisible"])) and bool(state["worldHudVisible"])

    item_click = click_named_point(hwnd, str(item_button["pointName"]))
    INPUT_GUARD.guarded_sleep(1000, title)

    # max_quantity_click = click_named_point(hwnd, "vendor_purchase_max_quantity")
    # INPUT_GUARD.guarded_sleep(1000, title)
    buy_click = click_named_point(hwnd, "vendor_purchase_buy")
    INPUT_GUARD.guarded_sleep(post_buy_settle_ms, title)
    close_click = click_named_point(hwnd, "vendor_purchase_close")
    close_state, close_checks = probe_state_after_initial_wait(
        title,
        probe_close_state,
        close_success,
        initial_wait_ms=post_close_initial_wait_ms,
        verify_window_ms=verify_window_ms,
        verify_interval_ms=verify_interval_ms,
    )
    esc_fallback = None
    esc_checks: list[dict[str, Any]] = []
    if not close_success(close_state):
        if bool(close_state["purchaseVisible"]):
            focus_window(hwnd)
            pydirectinput.press("esc")
            INPUT_GUARD.refresh_baseline()
            esc_fallback = {"key": "esc"}
            close_state, esc_checks = probe_state_after_initial_wait(
                title,
                probe_close_state,
                close_success,
                initial_wait_ms=post_esc_initial_wait_ms,
                verify_window_ms=verify_window_ms,
                verify_interval_ms=verify_interval_ms,
            )
        else:
            ambiguous_state, ambiguous_checks = probe_state_after_initial_wait(
                title,
                probe_close_state,
                close_success,
                initial_wait_ms=max(300, int(action.get("ambiguousInitialWaitMs") or 700)),
                verify_window_ms=max(1000, int(action.get("ambiguousVerifyWindowMs") or 2200)),
                verify_interval_ms=max(120, int(action.get("ambiguousVerifyIntervalMs") or 260)),
            )
            close_checks.extend(ambiguous_checks)
            close_state = ambiguous_state
            if not close_success(close_state) and bool(close_state["purchaseVisible"]):
                focus_window(hwnd)
                pydirectinput.press("esc")
                INPUT_GUARD.refresh_baseline()
                esc_fallback = {"key": "esc"}
                close_state, esc_checks = probe_state_after_initial_wait(
                    title,
                    probe_close_state,
                    close_success,
                    initial_wait_ms=post_esc_initial_wait_ms,
                    verify_window_ms=verify_window_ms,
                    verify_interval_ms=verify_interval_ms,
                )

    if not close_success(close_state):
        raise RuntimeError(
            "Vendor purchase did not return to the normal world HUD after close and one guarded Esc fallback"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked item, bought it, closed the purchase panel, and verified the normal world HUD returned",
        "input": {
            "mode": "buy_current_vendor_item",
            "itemName": item_name,
            "quantity": quantity,
            "itemButton": item_button,
            "itemClick": item_click,
            "buyClick": buy_click,
            "closeClick": close_click,
            "escFallback": esc_fallback,
            "beforeText": purchase_state["text"],
            "closeChecks": close_checks,
            "escChecks": esc_checks,
            "finalPurchaseText": close_state["purchaseText"],
            "finalWorldHudText": close_state["worldHudText"],
            "postBuySettleMs": post_buy_settle_ms,
            "postCloseInitialWaitMs": post_close_initial_wait_ms,
            "verifyWindowMs": verify_window_ms,
            "verifyIntervalMs": verify_interval_ms,
            "postEscInitialWaitMs": post_esc_initial_wait_ms,
        },
    }


def run_close_vendor_panel(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "close_vendor_panel")
    click_state = click_named_point(hwnd, "close_panel")
    post_delay_ms = int(action.get("postDelayMs") or 1000)
    after_state, close_checks = probe_until_timeout(
        title,
        lambda: detect_npc_interaction_stage(hwnd),
        lambda state: str(state.get("stage") or "none") in {"none", "chat_ready", "npc_action_menu", "small_talk_menu"},
        timeout_ms=max(1200, int(action.get("verifyWindowMs") or 2200)),
        interval_ms=max(120, int(action.get("verifyIntervalMs") or 220)),
        initial_wait_ms=post_delay_ms,
    )
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Closed current vendor panel",
        "input": {
            "mode": "close_vendor_panel",
            "click": click_state,
            "afterStage": after_state["stage"],
            "closeChecks": close_checks,
        },
    }


def run_stock_first_hawking_item(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stock_first_hawking_item")
    hawking_state = detect_hawking_screen(hwnd)
    post_stock_initial_wait_ms = int(action.get("postStockInitialWaitMs") or 1500)
    verify_window_ms = int(action.get("verifyWindowMs") or 4000)
    verify_interval_ms = int(action.get("verifyIntervalMs") or 600)

    inventory_click = click_named_point(hwnd, "hawking_inventory_first_slot")
    INPUT_GUARD.guarded_sleep(1000, title)
    max_quantity_click = click_named_point(hwnd, "hawking_max_quantity")
    INPUT_GUARD.guarded_sleep(1000, title)
    up_shelf_click = click_named_point(hwnd, "hawking_up_shelf_button")
    after_state, after_checks = probe_state_after_initial_wait(
        title,
        lambda: detect_hawking_screen(hwnd),
        lambda state: bool(state["visible"]),
        initial_wait_ms=post_stock_initial_wait_ms,
        verify_window_ms=verify_window_ms,
        verify_interval_ms=verify_interval_ms,
    )
    after_text = str(after_state["text"] or "")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Selected the first hawking item, maximized quantity, and clicked the hawking up-shelf button",
        "input": {
            "mode": "stock_first_hawking_item",
            "beforeText": hawking_state["text"],
            "inventoryClick": inventory_click,
            "maxQuantityClick": max_quantity_click,
            "upShelfClick": up_shelf_click,
            "afterText": after_text,
            "afterChecks": after_checks,
            "postStockInitialWaitMs": post_stock_initial_wait_ms,
            "verifyWindowMs": verify_window_ms,
            "verifyIntervalMs": verify_interval_ms,
        },
    }


def run_submit_hawking(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "submit_hawking")
    hawking_state = detect_hawking_screen(hwnd)

    submit_ready_delay_ms = max(400, int(action.get("submitReadyDelayMs") or 1000))

    submit_click = click_named_point(hwnd, "hawking_submit")
    INPUT_GUARD.guarded_sleep(submit_ready_delay_ms, title)

    runtime_state = detect_hawking_runtime_state(hwnd)

    while time.time() <= active_deadline:
        active_history.append(
            {
                "phase": "wait_active",
                "active": bool(runtime_state["active"]),
                "ready": bool(runtime_state["ready"]),
                "text": runtime_state["text"],
            }
        )
        if runtime_state["active"]:
            break
        INPUT_GUARD.guarded_sleep(600, title)
        runtime_state = detect_hawking_runtime_state(hwnd)

    if not runtime_state["active"]:
        raise ActionExecutionError(
            "Hawking state did not switch into 改货/收摊 after submit",
            failed_step=build_failed_step_payload(
                action,
                "Clicked 出摊 but the bottom-right actions did not switch into the hawking runtime state",
                {
                    "mode": "submit_hawking",
                    "beforeText": hawking_state["text"],
                    "submitClick": submit_click,
                    "submitReadyDelayMs": submit_ready_delay_ms,
                    "activeTimeoutMs": active_timeout_ms,
                    "finishTimeoutMs": finish_timeout_ms,
                    "activeHistory": active_history,
                },
            ),
        )

    finish_history: list[dict[str, Any]] = []
    finish_deadline = time.time() + finish_timeout_ms / 1000.0

    while time.time() <= finish_deadline:
        finish_history.append(
            {
                "phase": "wait_finish",
                "active": bool(runtime_state["active"]),
                "ready": bool(runtime_state["ready"]),
                "text": runtime_state["text"],
            }
        )
        if runtime_state["ready"]:
            break
        INPUT_GUARD.guarded_sleep(1000, title)
        runtime_state = detect_hawking_runtime_state(hwnd)

    if not runtime_state["ready"]:
        raise ActionExecutionError(
            "Hawking state did not return to the normal world HUD before timeout",
            failed_step=build_failed_step_payload(
                action,
                "Entered the hawking runtime state but did not return to the normal 12345 HUD in time",
                {
                    "mode": "submit_hawking",
                    "beforeText": hawking_state["text"],
                    "submitClick": submit_click,
                    "submitReadyDelayMs": submit_ready_delay_ms,
                    "activeTimeoutMs": active_timeout_ms,
                    "finishTimeoutMs": finish_timeout_ms,
                    "activeHistory": active_history,
                    "finishHistory": finish_history,
                },
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Submitted hawking, observed 改货/收摊, and waited until the normal world HUD returned",
        "input": {
            "mode": "submit_hawking",
            "beforeText": hawking_state["text"],
            "submitClick": submit_click,
            "submitReadyDelayMs": submit_ready_delay_ms,
            "activeTimeoutMs": active_timeout_ms,
            "finishTimeoutMs": finish_timeout_ms,
            "activeHistory": active_history,
            "finishHistory": finish_history,
            "afterText": runtime_state["text"],
        },
    }


def exit_panel(hwnd: int) -> None:
    click_named_point(hwnd, "close_panel")
    # Closing the chat page is not instantaneous. Wait for the UI transition to
    # settle before assuming the clean town page is ready for the next action.
    INPUT_GUARD.guarded_sleep(250, "exit_panel")


NPC_READY_STAGES = {"npc_action_menu", "small_talk_menu", "chat_ready", "gift_screen", "trade_screen"}


def collect_npc_stage_input(
    hwnd: int,
    stage_state: dict[str, Any],
    target_text: str = "",
) -> dict[str, Any]:
    payload = {
        "stage": stage_state["stage"],
        "stageTexts": stage_state["texts"],
        "targetText": target_text,
    }
    if stage_state["stage"] == "chat_ready":
        payload["dialogText"] = str(detect_dialog(hwnd).get("text") or "").strip()
    return payload


def build_failed_step_payload(
    action: dict[str, Any],
    detail: str,
    input_payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "id": str(action.get("id") or ""),
        "title": str(action.get("title") or action.get("type") or ""),
        "sourceType": action.get("sourceType"),
        "status": "failed",
        "detail": detail,
        "input": input_payload or {},
    }


def build_nonfatal_failed_step(
    action: dict[str, Any],
    message: str,
    error_code: str = "INPUT_EXECUTION_FAILED",
    failed_step: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload = dict(failed_step or build_failed_step_payload(action, message, {}))
    payload["id"] = str(payload.get("id") or action.get("id") or "")
    payload["title"] = str(payload.get("title") or action.get("title") or action.get("type") or "")
    payload["sourceType"] = payload.get("sourceType") or action.get("sourceType")
    payload["status"] = "failed"
    payload["detail"] = str(payload.get("detail") or message or "Action validation failed")
    input_payload = dict(payload.get("input") or {})
    input_payload["errorCode"] = str(input_payload.get("errorCode") or error_code or "INPUT_EXECUTION_FAILED")
    input_payload["nonFatal"] = True
    payload["input"] = input_payload
    return payload


def npc_stage_has_selectable_target(hwnd: int, stage_state: dict[str, Any], target_info: dict[str, Any]) -> bool:
    stage = str(stage_state.get("stage") or "none")
    if stage in NPC_READY_STAGES or stage == "npc_selected":
        return True
    return contains_any_keyword(stage_state["texts"].get("look_button", ""), ["查看"]) or has_selected_target(target_info)


def npc_stage_has_selectable_target_legacy(stage_state: dict[str, Any], target_info: dict[str, Any]) -> bool:
    return stage_state is not None and target_info is not None


def npc_stage_has_selectable_target(hwnd: int, stage_state: dict[str, Any], target_info: dict[str, Any]) -> bool:
    return has_reliable_selected_target(hwnd, stage_state, target_info)


def extract_chat_threshold_gate(stage_state: dict[str, Any]) -> dict[str, Any] | None:
    combined_text = " ".join(
        [
            str(stage_state["texts"].get("confirm_dialog") or ""),
            str(stage_state["texts"].get("chat_panel") or ""),
            str(stage_state["texts"].get("bottom_right_actions") or ""),
        ]
    ).strip()
    normalized = re.sub(r"\s+", "", combined_text)
    if "好感" not in normalized:
        return None
    if not any(keyword in normalized for keyword in ["达到", "不足", "需要", "解锁", "开启", "可闲聊", "可交谈"]):
        return None
    threshold_match = re.search(r"(10|50)", normalized)
    return {
        "requiredFavor": int(threshold_match.group(1)) if threshold_match else None,
        "text": combined_text,
    }


def coordinates_within_tolerance(current_coordinate: dict[str, Any] | None, target_coordinate: dict[str, int], tolerance: int) -> bool:
    if not current_coordinate:
        return False
    return (
        abs(int(current_coordinate["x"]) - int(target_coordinate["x"])) <= tolerance
        and abs(int(current_coordinate["y"]) - int(target_coordinate["y"])) <= tolerance
    )


def run_acquire_npc_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "acquire_npc_target")
    timeout_ms = int(action.get("timeoutMs") or DEFAULT_INTERACT_TIMEOUT_MS)
    raw_move_pulse_ms = action.get("movePulseMs")
    move_pulse_ms = DEFAULT_MOVE_PULSE_MS if raw_move_pulse_ms is None else int(raw_move_pulse_ms)
    scan_interval_ms = int(action.get("scanIntervalMs") or DEFAULT_SCAN_INTERVAL_MS)
    custom_click_points = action.get("clickPoints")
    click_points = [
        (0.48, 0.40), (0.55, 0.40), (0.62, 0.40), (0.69, 0.40),
        (0.48, 0.48), (0.55, 0.48), (0.62, 0.48), (0.69, 0.48),
        (0.48, 0.56), (0.55, 0.56), (0.62, 0.56), (0.69, 0.56),
        (0.48, 0.64), (0.55, 0.64), (0.62, 0.64), (0.69, 0.64),
    ]
    if isinstance(custom_click_points, list):
        normalized_click_points: list[tuple[float, float]] = []
        for point in custom_click_points:
            if isinstance(point, (list, tuple)) and len(point) == 2:
                normalized_click_points.append((float(point[0]), float(point[1])))
        if normalized_click_points:
            click_points = normalized_click_points
    click_attempts = 0
    move_attempts = 0
    click_point_attempts: list[dict[str, float]] = []
    nearby_scan_attempts: list[dict[str, Any]] = []
    selection_attempts: list[dict[str, Any]] = []
    stage_history: list[str] = []
    start_time = time.time()
    last_stage = "none"
    last_npc_click: dict[str, Any] | None = None

    focus_window(hwnd)

    current_stage_state = detect_npc_interaction_stage(hwnd)
    current_target_info = detect_target_threshold(hwnd)
    current_moving_view = find_moving_view_button(hwnd)
    current_stage = current_stage_state["stage"]
    if has_strict_clickable_selected_target(current_stage_state, current_moving_view):
        resolved_stage = current_stage if current_stage != "none" else "npc_selected"
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"NPC target already available at stage {resolved_stage}",
            "input": {
                "mode": "acquire_npc_target",
                **collect_npc_stage_input(hwnd, {**current_stage_state, "stage": resolved_stage}, current_target_info["text"]),
                "stageHistory": [resolved_stage],
                "clickAttempts": click_attempts,
                "moveAttempts": move_attempts,
                "clickPointAttempts": click_point_attempts,
                "nearbyScanAttempts": nearby_scan_attempts,
                "selectionAttempts": selection_attempts,
                "lastClick": last_npc_click,
            },
        }

    nearby_scan = scan_nearby_npc_targets(hwnd, title)
    nearby_scan_attempts = nearby_scan["attempts"]
    if nearby_scan["matched"]:
        stage_history.extend([attempt["stage"] for attempt in nearby_scan_attempts])
        resolved_stage = nearby_scan["stage"]
        nearby_stage_state = {
            "stage": resolved_stage,
            "texts": nearby_scan.get("stageTexts") or {},
        }
        nearby_target_info = {
            "text": nearby_scan.get("targetText") or "",
            "isSpecialNpc": "<" in str(nearby_scan.get("targetText") or "") and ">" in str(nearby_scan.get("targetText") or ""),
        }
        if resolved_stage == "none" and has_strict_clickable_selected_target(
            nearby_stage_state,
            nearby_scan.get("movingView"),
        ):
            resolved_stage = "npc_selected"
        if resolved_stage in NPC_READY_STAGES or resolved_stage == "npc_selected":
            last_npc_click = nearby_scan_attempts[-1]["click"] if nearby_scan_attempts else None
            return {
                "id": action_id,
                "title": title,
                "status": "performed",
                "detail": f"Acquired NPC target at stage {resolved_stage}",
                "input": {
                    "mode": "acquire_npc_target",
                    "stage": resolved_stage,
                    "stageTexts": nearby_scan["stageTexts"],
                    "targetText": nearby_scan["targetText"],
                    **({"dialogText": str(detect_dialog(hwnd).get("text") or "").strip()} if resolved_stage == "chat_ready" else {}),
                    "stageHistory": stage_history,
                    "clickAttempts": len(nearby_scan_attempts),
                    "moveAttempts": move_attempts,
                    "clickPointAttempts": click_point_attempts,
                    "nearbyScanAttempts": nearby_scan_attempts,
                    "selectionAttempts": selection_attempts,
                    "lastClick": last_npc_click,
                },
            }

    while (time.time() - start_time) * 1000 < timeout_ms:
        INPUT_GUARD.check_or_raise(title)
        stage_state = detect_npc_interaction_stage(hwnd)
        target_info = detect_target_threshold(hwnd)
        moving_view = find_moving_view_button(hwnd)
        last_stage = stage_state["stage"]
        resolved_stage = last_stage if last_stage != "none" else (
            "npc_selected" if has_strict_clickable_selected_target(stage_state, moving_view) else "none"
        )
        stage_history.append(resolved_stage)

        if resolved_stage in NPC_READY_STAGES or (
            resolved_stage == "npc_selected" and has_strict_clickable_selected_target(stage_state, moving_view)
        ):
            return {
                "id": action_id,
                "title": title,
                "status": "performed",
                "detail": f"Acquired NPC target at stage {resolved_stage}",
                "input": {
                    "mode": "acquire_npc_target",
                    **collect_npc_stage_input(hwnd, {**stage_state, "stage": resolved_stage}, target_info["text"]),
                    "stageHistory": stage_history,
                    "clickAttempts": click_attempts,
                    "moveAttempts": move_attempts,
                    "clickPointAttempts": click_point_attempts,
                    "nearbyScanAttempts": nearby_scan_attempts,
                    "selectionAttempts": selection_attempts,
                    "lastClick": last_npc_click,
                },
            }

        x_ratio, y_ratio = click_points[click_attempts % len(click_points)]
        last_npc_click = click_npc_candidate(hwnd, x_ratio, y_ratio, "left")
        click_point_attempts.append({"xRatio": x_ratio, "yRatio": y_ratio})
        click_target = find_click_target_name(hwnd, int(last_npc_click["screenX"]), int(last_npc_click["screenY"]))
        if click_target:
            selection_result = verify_npc_selection(hwnd, last_npc_click, click_target["text"])
            selection_result["targetProbe"] = click_target
            selection_attempts.append(selection_result)
            if selection_result["selected"]:
                last_npc_click = {
                    **last_npc_click,
                    "targetName": selection_result["actualName"],
                }
            else:
                last_npc_click = None
        else:
            selection_attempts.append(
                {
                    "selected": False,
                    "expectedName": "",
                    "actualName": "",
                    "click": last_npc_click,
                    "targetProbe": None,
                }
            )
            last_npc_click = None

        click_attempts += 1
        INPUT_GUARD.guarded_sleep(100, title)

        if move_pulse_ms > 0 and click_attempts % len(click_points) == 0:
            move_attempts += 1
            pulse_forward(hwnd, move_pulse_ms)
            INPUT_GUARD.guarded_sleep(80, title)

        INPUT_GUARD.guarded_sleep(min(scan_interval_ms, 90), title)

    raise RuntimeError(
        "Failed to acquire a stable NPC target before timeout. "
        f"Last stage: {last_stage or 'none'}"
    )


def run_open_npc_action_menu(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "open_npc_action_menu")
    stage_state = detect_npc_interaction_stage(hwnd)
    target_info = detect_target_threshold(hwnd)
    moving_view = find_moving_view_button(hwnd)
    current_stage = stage_state["stage"]
    reset_attempts: list[dict[str, Any]] = []

    if current_stage in NPC_READY_STAGES:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"NPC menu context already available at stage {current_stage}",
            "input": {
                "mode": "open_npc_action_menu",
                **collect_npc_stage_input(hwnd, stage_state, target_info["text"]),
                "viewAttempts": [],
            },
        }

    if not has_clickable_selected_target(hwnd, stage_state, target_info, moving_view):
        if bool(action.get("disableReacquire")) or has_selected_target_visual(hwnd):
            INPUT_GUARD.guarded_sleep(400, title)
            stage_state = detect_npc_interaction_stage(hwnd)
            target_info = detect_target_threshold(hwnd)
            moving_view = find_moving_view_button(hwnd)
            current_stage = stage_state["stage"]
            if current_stage in NPC_READY_STAGES:
                return {
                    "id": action_id,
                    "title": title,
                    "status": "performed",
                    "detail": f"NPC menu context became available after a short settle at stage {current_stage}",
                    "input": {
                        "mode": "open_npc_action_menu",
                        **collect_npc_stage_input(hwnd, stage_state, target_info["text"]),
                        "viewAttempts": [],
                        "resetAttempts": reset_attempts,
                    },
                }
            if not has_clickable_selected_target(hwnd, stage_state, target_info, moving_view):
                failed_input = {
                    "mode": "open_npc_action_menu",
                    **collect_npc_stage_input(hwnd, stage_state, target_info["text"]),
                    "viewAttempts": [],
                    "resetAttempts": reset_attempts,
                }
                return build_nonfatal_failed_step(
                    action,
                    "Selected NPC exists but magnifier is not inside the clickable red-box area",
                    "NPC_VIEW_NOT_VISIBLE",
                    build_failed_step_payload(
                        action,
                        "Fixed social chain keeps the stable view path and will not fall back to scan clicks here",
                        failed_input,
                    ),
                )

    if not has_clickable_selected_target(hwnd, stage_state, target_info, moving_view):
        reacquire_result = run_acquire_npc_target(
            hwnd,
            {
                "id": f"{action_id}-reacquire" if action_id else "open_npc_action_menu-reacquire",
                "title": f"{title}_reacquire",
                "timeoutMs": int(action.get("reacquireTimeoutMs") or 2500),
                "movePulseMs": DEFAULT_MOVE_PULSE_MS if action.get("reacquireMovePulseMs") is None else int(action.get("reacquireMovePulseMs")),
                "scanIntervalMs": int(action.get("reacquireScanIntervalMs") or DEFAULT_SCAN_INTERVAL_MS),
            },
        )
        stage_state = {
            "stage": str(reacquire_result.get("input", {}).get("stage") or "none"),
            "texts": dict(reacquire_result.get("input", {}).get("stageTexts") or {}),
        }
        target_info = {
            "text": str(reacquire_result.get("input", {}).get("targetText") or ""),
            "isSpecialNpc": "<" in str(reacquire_result.get("input", {}).get("targetText") or "")
            and ">" in str(reacquire_result.get("input", {}).get("targetText") or ""),
        }
        moving_view = find_moving_view_button(hwnd)
        current_stage = stage_state["stage"]
        reset_attempts.append(
            {
                "triggered": True,
                "reason": "reacquire_before_open",
                "stageAfterReset": current_stage,
                "targetText": target_info["text"],
            }
        )

        if current_stage in NPC_READY_STAGES:
            return {
                "id": action_id,
                "title": title,
                "status": "performed",
                "detail": f"NPC menu context became available during reacquire at stage {current_stage}",
                "input": {
                    "mode": "open_npc_action_menu",
                    **collect_npc_stage_input(hwnd, stage_state, target_info["text"]),
                    "viewAttempts": [],
                    "resetAttempts": reset_attempts,
                },
            }

    if has_reliable_selected_target(hwnd, stage_state, target_info) and not moving_view:
        failed_input = {
            "mode": "open_npc_action_menu",
            **collect_npc_stage_input(hwnd, stage_state, target_info["text"]),
            "viewAttempts": [],
            "resetAttempts": reset_attempts,
        }
        return build_nonfatal_failed_step(
            action,
            "Selected NPC exists but magnifier is not inside the clickable red-box area",
            "NPC_VIEW_NOT_VISIBLE",
            build_failed_step_payload(
                action,
                "Selected NPC has no clickable magnifier in the expected interaction area",
                failed_input,
            ),
        )

    if not has_clickable_selected_target(hwnd, stage_state, target_info, moving_view):
        failed_input = {
            "mode": "open_npc_action_menu",
            **collect_npc_stage_input(hwnd, stage_state, target_info["text"]),
            "viewAttempts": [],
            "resetAttempts": reset_attempts,
        }
        return build_nonfatal_failed_step(
            action,
            "open_npc_action_menu requires an already selected NPC target",
            "NPC_VIEW_NOT_OPENED",
            build_failed_step_payload(
                action,
                f"Cannot open menu from stage {current_stage or 'none'}",
                failed_input,
            ),
        )

    open_view_result = open_view_for_selected_npc(hwnd, title, target_info["text"], max_attempts=int(action.get("viewAttemptLimit") or 3))
    next_stage = open_view_result["stage"]
    if not open_view_result["opened"] or next_stage not in NPC_READY_STAGES:
        failed_input = {
            "mode": "open_npc_action_menu",
            "stage": next_stage,
            "stageTexts": open_view_result.get("stageTexts") or stage_state["texts"],
            "targetText": target_info["text"],
            "viewAttempts": open_view_result["viewAttempts"],
            "retryCount": len(open_view_result["viewAttempts"]),
            "resetAttempts": reset_attempts,
        }
        return build_nonfatal_failed_step(
            action,
            "Failed to open NPC action menu from the selected target",
            "NPC_VIEW_NOT_OPENED",
            build_failed_step_payload(
                action,
                f"Magnifier click did not open menu. Last stage: {next_stage or 'none'}",
                failed_input,
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Opened NPC interaction context at stage {next_stage}",
        "input": {
            "mode": "open_npc_action_menu",
            "stage": next_stage,
            "stageTexts": open_view_result.get("stageTexts") or {},
            "targetText": target_info["text"],
            **({"dialogText": str(detect_dialog(hwnd).get("text") or "").strip()} if next_stage == "chat_ready" else {}),
            "viewAttempts": open_view_result["viewAttempts"],
            "resetAttempts": reset_attempts,
        },
    }


def run_click_menu_talk(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_talk")
    talk_click = click_named_point(hwnd, "talk")
    INPUT_GUARD.guarded_sleep(220, title)
    next_stage_state = wait_for_any_npc_stage(
        hwnd,
        {"small_talk_menu", "small_talk_confirm", "chat_ready", "npc_action_menu"},
        timeout_ms=max(400, int(action.get("settleTimeoutMs") or 900)),
        poll_interval_ms=max(80, int(action.get("pollIntervalMs") or 120)),
    )
    next_stage = next_stage_state["stage"]

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Clicked talk entry and observed {next_stage or 'none'}",
        "input": {
            "mode": "click_menu_talk",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": talk_click,
        },
    }


def run_click_menu_small_talk(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_small_talk")
    small_talk_click = click_named_point(hwnd, "small_talk")
    INPUT_GUARD.guarded_sleep(max(1000, int(action.get("preConfirmWaitMs") or 1000)), title)
    next_stage_state = wait_for_any_npc_stage(
        hwnd,
        {"small_talk_confirm", "chat_ready", "small_talk_menu", "npc_action_menu"},
        timeout_ms=max(2000, int(action.get("settleTimeoutMs") or 3200)),
        poll_interval_ms=max(120, int(action.get("pollIntervalMs") or 180)),
    )
    next_stage = next_stage_state["stage"]
    if next_stage != "small_talk_confirm":
        return build_nonfatal_failed_step(
            action,
            "Small-talk entry did not reach the confirm dialog before confirm click",
            "NPC_SMALL_TALK_CONFIRM_NOT_REACHED",
            build_failed_step_payload(
                action,
                "After clicking small talk and waiting 1 second, the flow must first reach the confirm dialog",
                {
                    "mode": "click_menu_small_talk",
                    **collect_npc_stage_input(hwnd, next_stage_state),
                    "click": small_talk_click,
                },
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Clicked small talk and observed {next_stage or 'none'}",
        "input": {
            "mode": "click_menu_small_talk",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": small_talk_click,
        },
    }


def run_confirm_small_talk_entry(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "confirm_small_talk_entry")
    stage_before = detect_npc_interaction_stage(hwnd)
    confirm_dialog_click = click_named_point(hwnd, "small_talk_confirm_dialog")
    INPUT_GUARD.guarded_sleep(max(200, int(action.get("postConfirmInitialWaitMs") or 300)), title)

    after_confirm_state = wait_for_any_npc_stage(
        hwnd,
        {"chat_ready", "small_talk_confirm", "small_talk_menu", "npc_action_menu"},
        timeout_ms=max(3000, int(action.get("postConfirmTimeoutMs") or 5000)),
        poll_interval_ms=max(160, int(action.get("postConfirmPollIntervalMs") or 320)),
    )

    confirm_dialog_text_after = str(after_confirm_state["texts"].get("confirm_dialog") or "")
    if after_confirm_state["stage"] != "chat_ready" or contains_any_keyword(confirm_dialog_text_after, CONFIRM_KEYWORDS):
        return build_nonfatal_failed_step(
            action,
            "Small-talk confirm did not advance into the real chat page before input click",
            "NPC_CHAT_CONFIRM_NOT_REACHED",
            build_failed_step_payload(
                action,
                "Chat entry is not complete until the confirm dialog disappears and chat_ready is visible",
                {
                    "mode": "confirm_small_talk_entry",
                    "stageBefore": stage_before["stage"],
                    "stageAfterConfirm": after_confirm_state["stage"],
                    **collect_npc_stage_input(hwnd, after_confirm_state),
                    **({"confirmDialogClick": confirm_dialog_click} if confirm_dialog_click else {}),
                },
            ),
        )

    next_stage_state = wait_for_any_npc_stage(
        hwnd,
        {"chat_ready", "small_talk_confirm", "small_talk_menu", "npc_action_menu"},
        timeout_ms=max(1200, int(action.get("settleTimeoutMs") or 1800)),
        poll_interval_ms=max(120, int(action.get("pollIntervalMs") or 180)),
    )
    next_stage = next_stage_state["stage"]
    chat_input_click = None
    if next_stage == "chat_ready":
        chat_input_click = click_named_point(hwnd, "chat_input")
        INPUT_GUARD.guarded_sleep(80, title)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": (
            f"Confirmed small talk from {stage_before['stage'] or 'none'} "
            f"and observed {next_stage or 'none'}"
        ),
        "input": {
            "mode": "confirm_small_talk_entry",
            "stageBefore": stage_before["stage"],
            "stageAfterConfirm": after_confirm_state["stage"],
            **collect_npc_stage_input(hwnd, next_stage_state),
            **({"confirmDialogClick": confirm_dialog_click} if confirm_dialog_click else {}),
            **({"chatInputClick": chat_input_click} if chat_input_click else {}),
        },
    }


def run_click_menu_gift(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_gift")
    action_menu_buttons = find_action_menu_button_centers(hwnd)

    if "gift" in action_menu_buttons:
        gift_button = action_menu_buttons["gift"]
        gift_click = click_screen_point(
            hwnd,
            int(gift_button["screenX"]),
            int(gift_button["screenY"]),
            "left",
            trace_label="gift_dynamic",
        )
        gift_click["locator"] = "action_menu_contour"
        gift_click["buttonBox"] = gift_button
    else:
        gift_click = click_named_point(hwnd, "gift")
        gift_click["locator"] = "fixed_ratio"
    INPUT_GUARD.guarded_sleep(300, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Clicked gift entry and observed {next_stage_state['stage'] or 'none'}",
        "input": {
            "mode": "click_menu_gift",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": gift_click,
        },
    }


def run_inspect_gift_chat_threshold(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "inspect_gift_chat_threshold")
    stage_state = wait_for_npc_stage(
        hwnd,
        "gift_screen",
        timeout_ms=max(300, int(action.get("settleTimeoutMs") or 900)),
        poll_interval_ms=max(80, int(action.get("pollIntervalMs") or 120)),
    )
    if stage_state["stage"] != "gift_screen":
        raise RuntimeError(
            "inspect_gift_chat_threshold requires gift_screen. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    threshold_info = inspect_gift_chat_threshold(stage_state)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Gift threshold resolved to {threshold_info['giftPolicy']}",
        "input": {
            "mode": "inspect_gift_chat_threshold",
            **collect_npc_stage_input(hwnd, stage_state),
            **threshold_info,
        },
    }


def run_select_gift_first_slot(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "select_gift_first_slot")
    gift_click = click_named_point(hwnd, "gift_first_slot")
    INPUT_GUARD.guarded_sleep(150, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Clicked the first gift slot and observed {next_stage_state['stage'] or 'none'}",
        "input": {
            "mode": "select_gift_first_slot",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": gift_click,
        },
    }


def run_submit_gift_once(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "submit_gift_once")
    stage_state = detect_npc_interaction_stage(hwnd)
    favor_before = parse_favor_value(str(stage_state.get("texts", {}).get("gift_panel") or ""))
    submit_click = click_named_point(hwnd, "gift_submit")
    INPUT_GUARD.guarded_sleep(450, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Clicked gift submit and observed {next_stage_state['stage'] or 'none'}",
        "input": {
            "mode": "submit_gift_once",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": submit_click,
            "favorBefore": favor_before,
            "favorAfter": parse_favor_value(next_stage_state["texts"]["gift_panel"]),
        },
    }


def run_inspect_npc_interaction_stage(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "inspect_npc_interaction_stage")
    stage_state = detect_npc_interaction_stage(hwnd)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Detected current NPC interaction stage: {stage_state['stage'] or 'none'}",
        "input": {
            "mode": "inspect_npc_interaction_stage",
            **collect_npc_stage_input(hwnd, stage_state),
        },
    }


def run_inspect_recovery_anchor_state(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "inspect_recovery_anchor_state")
    npc_stage_state = detect_npc_interaction_stage(hwnd)
    vendor_purchase_state = detect_vendor_purchase_screen(hwnd)
    hawking_screen_state = detect_hawking_screen(hwnd)
    hawking_runtime_state = detect_hawking_runtime_state(hwnd)
    world_hud_state = detect_world_hud_state(hwnd)
    stealth_state = detect_exit_stealth_button(hwnd)
    knockout_state = detect_knockout_context(hwnd)
    loot_state = detect_loot_screen(hwnd)
    steal_state = detect_steal_screen_ready(hwnd)
    map_state = detect_map_screen(hwnd)

    anchor_id = "unknown"
    confidence = "unknown"

    npc_stage = str(npc_stage_state.get("stage") or "")
    if npc_stage in {"chat_ready", "gift_screen", "trade_screen", "npc_action_menu", "small_talk_menu", "small_talk_confirm"}:
        anchor_id = npc_stage
        confidence = "confirmed"
    elif vendor_purchase_state["visible"]:
        anchor_id = "vendor_purchase_screen"
        confidence = "confirmed"
    elif hawking_screen_state["visible"]:
        anchor_id = "hawking_screen"
        confidence = "confirmed"
    elif hawking_runtime_state["active"]:
        anchor_id = "hawking_runtime_active"
        confidence = "confirmed"
    elif hawking_runtime_state["ready"]:
        anchor_id = "hawking_runtime_ready"
        confidence = "probable"
    elif loot_state["visible"]:
        anchor_id = "loot_screen"
        confidence = "confirmed"
    elif steal_state["visible"]:
        anchor_id = "steal_screen"
        confidence = "confirmed"
    elif knockout_state["visible"]:
        anchor_id = "knockout_context"
        confidence = "confirmed"
    elif stealth_state["visible"]:
        anchor_id = "stealth_ready"
        confidence = "confirmed"
    elif map_state["visible"]:
        anchor_id = "map_screen"
        confidence = "confirmed"
    elif world_hud_state["visible"]:
        anchor_id = "world_hud"
        confidence = "probable"

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Detected current recovery anchor: {anchor_id}",
        "input": {
            "mode": "inspect_recovery_anchor_state",
            "anchorId": anchor_id,
            "confidence": confidence,
            "npcStage": npc_stage,
            "vendorPurchase": vendor_purchase_state,
            "hawkingScreen": hawking_screen_state,
            "hawkingRuntime": hawking_runtime_state,
            "worldHud": world_hud_state,
            "stealth": stealth_state,
            "knockout": knockout_state,
            "loot": loot_state,
            "steal": steal_state,
            "map": map_state,
            "npcStageState": collect_npc_stage_input(hwnd, npc_stage_state),
        },
    }


def run_resolve_gift_chat_threshold(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "resolve_gift_chat_threshold")
    stage_state = detect_npc_interaction_stage(hwnd)
    threshold_info = inspect_gift_chat_threshold(stage_state)
    expected_policy = str(action.get("giftPolicy") or "").strip()
    gift_policy = expected_policy or str(threshold_info["giftPolicy"])
    post_delay_ms = max(200, int(action.get("postDelayMs") or 5000))
    repeat_submit_cd_ms = max(0, int(action.get("repeatSubmitCdMs") or 2000))
    select_detail_delay_ms = max(200, int(action.get("selectDetailDelayMs") or 2000))
    first_submit_delay_ms = max(200, int(action.get("firstSubmitDelayMs") or 5000))
    second_submit_delay_ms = max(200, int(action.get("secondSubmitDelayMs") or 5000))

    if gift_policy == "chat_direct":
        close_click = click_named_point(hwnd, "close_panel")
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        next_stage_state = detect_npc_interaction_stage(hwnd)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Favor cap is low enough to skip gifting and go directly to chat",
            "input": {
                "mode": "resolve_gift_chat_threshold",
                **collect_npc_stage_input(hwnd, next_stage_state),
                **threshold_info,
                "giftPolicy": gift_policy,
                "closeClick": close_click,
                "giftRounds": [],
            },
        }

    if gift_policy == "gift_fixed":
        gift_rounds: list[dict[str, Any]] = []
        current_stage_state = stage_state
        initial_select_click = click_named_point(hwnd, "gift_first_slot")
        INPUT_GUARD.guarded_sleep(select_detail_delay_ms, title)
        current_stage_state = detect_npc_interaction_stage(hwnd)
        gift_count = max(0, int(threshold_info.get("giftCount") or 0))
        for round_index in range(gift_count):
            before_panel_text = str(current_stage_state["texts"].get("gift_panel") or "")
            favor_before = parse_favor_value(before_panel_text)
            dismiss_detail_click = None
            if round_index == 0:
                dismiss_detail_click = click_named_point(hwnd, "gift_submit")
                INPUT_GUARD.guarded_sleep(first_submit_delay_ms, title)
                current_stage_state = detect_npc_interaction_stage(hwnd)
            submit_click = click_named_point(hwnd, "gift_submit")
            INPUT_GUARD.guarded_sleep(second_submit_delay_ms, title)
            current_stage_state = detect_npc_interaction_stage(hwnd)
            gift_rounds.append(
                {
                    "roundIndex": round_index + 1,
                    "selectClick": initial_select_click if round_index == 0 else None,
                    "dismissDetailClick": dismiss_detail_click,
                    "submitClick": submit_click,
                    "favorBefore": favor_before,
                    "favorAfter": parse_favor_value(current_stage_state["texts"].get("gift_panel") or ""),
                    "postSubmitDelayMs": second_submit_delay_ms,
                }
            )
            if round_index + 1 < gift_count and repeat_submit_cd_ms > 0:
                INPUT_GUARD.guarded_sleep(repeat_submit_cd_ms, title)

        close_click = click_named_point(hwnd, "close_panel")
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        next_stage_state = detect_npc_interaction_stage(hwnd)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Selected the first gift once, used the first submit to dismiss the detail popup, then submitted {gift_count} gifts and closed the gift screen",
            "input": {
                "mode": "resolve_gift_chat_threshold",
                **collect_npc_stage_input(hwnd, next_stage_state),
                **threshold_info,
                "giftPolicy": gift_policy,
                "closeClick": close_click,
                "repeatSubmitCdMs": repeat_submit_cd_ms,
                "selectDetailDelayMs": select_detail_delay_ms,
                "firstSubmitDelayMs": first_submit_delay_ms,
                "secondSubmitDelayMs": second_submit_delay_ms,
                "giftRounds": gift_rounds,
            },
        }

    close_click = click_named_point(hwnd, "close_panel")
    INPUT_GUARD.guarded_sleep(post_delay_ms, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    failed_input = {
        "mode": "resolve_gift_chat_threshold",
        **collect_npc_stage_input(hwnd, next_stage_state),
        **threshold_info,
        "giftPolicy": gift_policy,
        "closeClick": close_click,
        "giftRounds": [],
    }
    raise ActionExecutionError(
        "Gift screen revealed a favor cap that should be skipped instead of gifting",
        error_code="NPC_CHAT_THRESHOLD_REVEALED",
        failed_step=build_failed_step_payload(
            action,
            "Gift threshold could not be resolved into the fixed gift route",
            failed_input,
        ),
    )


def run_click_menu_trade(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_trade")
    post_trade_initial_wait_ms = int(action.get("postTradeInitialWaitMs") or 2600)
    trade_click = click_named_point(hwnd, "trade")
    INPUT_GUARD.guarded_sleep(post_trade_initial_wait_ms, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Clicked trade entry and waited {post_trade_initial_wait_ms}ms before continuing",
        "input": {
            "mode": "click_menu_trade",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": trade_click,
            "postTradeInitialWaitMs": post_trade_initial_wait_ms,
        },
    }


def run_trade_click_step(
    hwnd: int,
    action: dict[str, Any],
    point_name: str,
    detail: str,
    delay_ms: int,
    allow_non_trade_after: bool = False,
) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or action.get("type") or point_name)
    step_click = click_named_point(hwnd, point_name)
    INPUT_GUARD.guarded_sleep(delay_ms, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": detail,
        "input": {
            "mode": str(action.get("type") or point_name),
            **collect_npc_stage_input(hwnd, next_stage_state),
            "pointName": point_name,
            "click": step_click,
        },
    }


def run_trade_prepare_gift_bundle(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "trade_prepare_gift_bundle")
    repeat_count = int(action.get("repeatCount") or 10)
    bundle_flow = execute_trade_gift_bundle_flow(hwnd, title, repeat_count)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Prepared fixed gift bundle with {len(bundle_flow['rounds'])} up-shelf rounds",
        "input": {
            "mode": "trade_prepare_gift_bundle",
            "repeatCount": repeat_count,
            "categoryClick": bundle_flow["categoryClick"],
            "rounds": bundle_flow["rounds"],
            "stageHistory": bundle_flow["stageHistory"],
        },
    }


def run_click_steal_button(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_steal_button")
    button_index = int(action.get("buttonIndex") or 1)
    point_name = f"steal_button_{button_index}"
    settle_ms = int(action.get("settleMs") or action.get("postDelayMs") or 450)

    if point_name not in ACTION_POINTS:
        raise RuntimeError(f"Unsupported steal button index: {button_index}")

    stage_state = detect_npc_interaction_stage(hwnd)
    if stage_state["stage"] != "steal_screen":
        failed_input = {
            "mode": "click_steal_button",
            **collect_npc_stage_input(hwnd, stage_state),
            "buttonIndex": button_index,
            "pointName": point_name,
        }
        raise ActionExecutionError(
            "click_steal_button requires steal_screen",
            error_code="STEALTH_TARGET_RECOVERED",
            failed_step=build_failed_step_payload(
                action,
                f"Steal panel was no longer available at stage {stage_state['stage'] or 'none'}",
                failed_input,
            ),
        )

    steal_state = detect_steal_screen(hwnd)
    step_click = click_named_point(hwnd, point_name)
    INPUT_GUARD.guarded_sleep(settle_ms, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if next_stage_state["stage"] == "steal_screen":
        failed_input = {
            "mode": "click_steal_button",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "beforeText": steal_state["text"],
            "pointName": point_name,
            "buttonIndex": button_index,
            "click": step_click,
        }
        raise ActionExecutionError(
            f"Steal button {point_name} did not complete before the panel closed",
            error_code="STEALTH_TARGET_RECOVERED",
            failed_step=build_failed_step_payload(
                action,
                "Steal panel remained open after the fixed miaoqu click",
                failed_input,
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked the gold steal button and left the steal panel",
        "input": {
            "mode": "click_steal_button",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "beforeText": steal_state["text"],
            "pointName": point_name,
            "buttonIndex": button_index,
            "click": step_click,
        },
    }


def run_exit_stealth(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "exit_stealth")
    settle_ms = int(action.get("settleMs") or action.get("postDelayMs") or 450)

    exit_state = detect_exit_stealth_button(hwnd)
    if not exit_state["visible"]:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Stealth mode was already inactive",
            "input": {
                "mode": "exit_stealth",
                "beforeVisual": exit_state,
                "afterVisual": exit_state,
                "pointName": "exit_stealth",
                "click": None,
                "exitTriggered": False,
            },
        }

    step_click = click_named_point(hwnd, "exit_stealth")
    INPUT_GUARD.guarded_sleep(settle_ms, title)
    next_exit_state = detect_exit_stealth_button(hwnd)

    if next_exit_state["visible"]:
        raise RuntimeError("Exit stealth button is still visible after click.")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked the fixed exit stealth button and left stealth mode",
        "input": {
            "mode": "exit_stealth",
            "beforeVisual": exit_state,
            "afterVisual": next_exit_state,
            "pointName": "exit_stealth",
            "click": step_click,
            "exitTriggered": True,
        },
    }


def run_click_fixed_steal_button_and_escape(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_fixed_steal_button_and_escape")
    button_index = int(action.get("buttonIndex") or 1)
    escape_delay_ms = int(action.get("escapeDelayMs") or 1500)
    spam_backstep_ms = int(action.get("spamBackstepMs") or action.get("longBackstepMs") or 3000)
    spam_interval_ms = int(action.get("spamIntervalMs") or action.get("successCheckIntervalMs") or 80)
    move_settle_ms = int(action.get("moveSettleMs") or 80)
    point_name = f"steal_button_{button_index}"

    if point_name not in ACTION_POINTS:
        raise RuntimeError(f"Unsupported steal button index: {button_index}")

    ready_state = detect_steal_screen_ready(hwnd)
    if not ready_state["visible"]:
        stage_state = detect_npc_interaction_stage(hwnd)
        failed_input = {
            "mode": "click_fixed_steal_button_and_escape",
            **collect_npc_stage_input(hwnd, stage_state),
            "buttonIndex": button_index,
            "pointName": point_name,
            "panelReadySource": ready_state["source"],
            "panelReadyText": ready_state["text"],
            "panelReadyVisual": ready_state["visual"],
        }
        raise ActionExecutionError(
            "Fixed miaoqu escape requires steal_screen",
            error_code="STEALTH_TARGET_RECOVERED",
            failed_step=build_failed_step_payload(
                action,
                f"Fixed miaoqu chain started from {stage_state['stage'] or 'none'} instead of steal_screen",
                failed_input,
            ),
        )

    steal_state = detect_steal_screen(hwnd)
    step_click = click_named_point(hwnd, point_name)
    INPUT_GUARD.guarded_sleep(max(0, escape_delay_ms), title)

    success_banner = detect_miaoqu_success_banner(hwnd)
    after_steal_state = detect_steal_screen(hwnd)
    steal_success = success_banner["visible"] or (
        after_steal_state["visible"] and after_steal_state["text"] != steal_state["text"]
    )
    retreat_deadline = time.time() + max(80, spam_backstep_ms) / 1000.0
    spam_press_count = 0
    while time.time() <= retreat_deadline:
        pydirectinput.press("s")
        INPUT_GUARD.refresh_baseline()
        spam_press_count += 1
        if not steal_success:
            success_banner = detect_miaoqu_success_banner(hwnd)
            after_steal_state = detect_steal_screen(hwnd)
            steal_success = success_banner["visible"] or (
                after_steal_state["visible"] and after_steal_state["text"] != steal_state["text"]
            )
        remaining_ms = max(0, int((retreat_deadline - time.time()) * 1000))
        if remaining_ms <= 0:
            break
        INPUT_GUARD.guarded_sleep(min(max(20, spam_interval_ms), remaining_ms), title)
    INPUT_GUARD.guarded_sleep(max(0, move_settle_ms), title)

    next_stage_state = detect_npc_interaction_stage(hwnd)
    success_banner = detect_miaoqu_success_banner(hwnd)
    after_steal_state = detect_steal_screen(hwnd)
    steal_success = steal_success or success_banner["visible"] or (
        after_steal_state["visible"] and after_steal_state["text"] != steal_state["text"]
    )
    if not steal_success:
        failed_input = {
            "mode": "click_fixed_steal_button_and_escape",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "beforeText": steal_state["text"],
            "afterText": after_steal_state["text"],
            "successBannerText": success_banner["text"],
            "buttonIndex": button_index,
            "pointName": point_name,
            "click": step_click,
            "escapeDelayMs": escape_delay_ms,
            "spamBackstepMs": spam_backstep_ms,
            "spamIntervalMs": spam_interval_ms,
            "spamPressCount": spam_press_count,
            "panelReadySource": ready_state["source"],
            "panelReadyVisual": ready_state["visual"],
        }
        raise ActionExecutionError(
            "Fixed miaoqu click did not produce a confirmed steal success before retreat finished",
            error_code="STEALTH_TARGET_RECOVERED",
            failed_step=build_failed_step_payload(
                action,
                "Blind miaoqu click finished the escape rhythm but did not confirm 妙取成功",
                failed_input,
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked the fixed gold miaoqu button, waited 1.2s, then escaped with two S backsteps",
        "input": {
            "mode": "click_fixed_steal_button_and_escape",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "beforeText": steal_state["text"],
            "afterText": after_steal_state["text"],
            "successBannerText": success_banner["text"],
            "buttonIndex": button_index,
            "pointName": point_name,
            "click": step_click,
            "escapeDelayMs": escape_delay_ms,
            "spamBackstepMs": spam_backstep_ms,
            "spamIntervalMs": spam_interval_ms,
            "spamPressCount": spam_press_count,
            "panelReadySource": ready_state["source"],
            "panelReadyVisual": ready_state["visual"],
        },
    }


def run_submit_hawking(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "submit_hawking")
    hawking_state = detect_hawking_screen(hwnd)
    if not hawking_state["visible"]:
        raise RuntimeError("Current screen is not hawking screen")

    submit_ready_delay_ms = max(400, int(action.get("submitReadyDelayMs") or 1000))
    active_timeout_ms = max(1000, int(action.get("activeTimeoutMs") or 8000))
    finish_timeout_ms = max(1000, int(action.get("finishTimeoutMs") or 120000))
    submit_click = click_named_point(hwnd, "hawking_submit")
    INPUT_GUARD.guarded_sleep(submit_ready_delay_ms, title)
    runtime_state, active_history = probe_until_timeout(
        title,
        lambda: detect_hawking_runtime_state(hwnd),
        lambda state: bool(state["active"]),
        timeout_ms=active_timeout_ms,
        interval_ms=max(220, int(action.get("activeVerifyIntervalMs") or 600)),
        initial_wait_ms=max(240, int(action.get("activeInitialWaitMs") or 500)),
    )

    if not runtime_state["active"]:
        raise ActionExecutionError(
            "Hawking state did not switch into 改货/收摊 after submit",
            failed_step=build_failed_step_payload(
                action,
                "Clicked 出摊 but the bottom-right actions did not switch into the hawking runtime state",
                {
                    "mode": "submit_hawking",
                    "beforeText": hawking_state["text"],
                    "submitClick": submit_click,
                    "submitReadyDelayMs": submit_ready_delay_ms,
                    "activeTimeoutMs": active_timeout_ms,
                    "finishTimeoutMs": finish_timeout_ms,
                    "activeHistory": active_history,
                },
            ),
        )

    runtime_state, finish_history = probe_until_timeout(
        title,
        lambda: detect_hawking_runtime_state(hwnd),
        lambda state: bool(state["ready"]),
        timeout_ms=finish_timeout_ms,
        interval_ms=max(400, int(action.get("finishVerifyIntervalMs") or 1000)),
        initial_wait_ms=max(600, int(action.get("finishInitialWaitMs") or 1000)),
    )

    if not runtime_state["ready"]:
        raise ActionExecutionError(
            "Hawking state did not return to the normal world HUD before timeout",
            failed_step=build_failed_step_payload(
                action,
                "Entered the hawking runtime state but did not return to the normal world HUD in time",
                {
                    "mode": "submit_hawking",
                    "beforeText": hawking_state["text"],
                    "submitClick": submit_click,
                    "submitReadyDelayMs": submit_ready_delay_ms,
                    "activeTimeoutMs": active_timeout_ms,
                    "finishTimeoutMs": finish_timeout_ms,
                    "activeHistory": active_history,
                    "finishHistory": finish_history,
                },
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked hawking submit, observed 改货/收摊, and waited until the normal world HUD returned",
        "input": {
            "mode": "submit_hawking",
            "beforeText": hawking_state["text"],
            "submitClick": submit_click,
            "submitReadyDelayMs": submit_ready_delay_ms,
            "activeTimeoutMs": active_timeout_ms,
            "finishTimeoutMs": finish_timeout_ms,
            "activeHistory": active_history,
            "finishHistory": finish_history,
            "afterText": runtime_state["text"],
        },
    }


def run_wait_hawking_runtime_finish(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "wait_hawking_runtime_finish")
    finish_timeout_ms = max(1000, int(action.get("finishTimeoutMs") or 120000))
    runtime_state = detect_hawking_runtime_state(hwnd)
    if not runtime_state["active"] and runtime_state["ready"]:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Hawking runtime had already finished and returned to the normal world HUD",
            "input": {
                "mode": "wait_hawking_runtime_finish",
                "afterText": runtime_state["text"],
                "history": [],
            },
        }

    runtime_state, active_probe_history = probe_until_timeout(
        title,
        lambda: detect_hawking_runtime_state(hwnd),
        lambda state: bool(state["active"] or state["ready"]),
        timeout_ms=max(1600, int(action.get("activeProbeWindowMs") or 2600)),
        interval_ms=max(220, int(action.get("activeProbeIntervalMs") or 500)),
        initial_wait_ms=max(220, int(action.get("activeProbeInitialWaitMs") or 400)),
    )

    if not runtime_state["active"] and not runtime_state["ready"]:
        raise ActionExecutionError(
            "Hawking runtime wait requires the active 改货/收摊 state or an already-restored world HUD",
            failed_step=build_failed_step_payload(
                action,
                "Expected an active hawking runtime state before waiting for it to finish",
                {
                    "mode": "wait_hawking_runtime_finish",
                    "beforeText": runtime_state["text"],
                    "activeProbeHistory": active_probe_history,
                },
            ),
        )

    runtime_state, finish_history = probe_until_timeout(
        title,
        lambda: detect_hawking_runtime_state(hwnd),
        lambda state: bool(state["ready"]),
        timeout_ms=finish_timeout_ms,
        interval_ms=max(400, int(action.get("finishVerifyIntervalMs") or 1000)),
        initial_wait_ms=max(600, int(action.get("finishInitialWaitMs") or 1000)),
    )

    if not runtime_state["ready"]:
        raise ActionExecutionError(
            "Hawking runtime did not return to the normal world HUD before timeout",
            failed_step=build_failed_step_payload(
                action,
                "Entered hawking runtime wait but did not return to the normal world HUD in time",
                {
                    "mode": "wait_hawking_runtime_finish",
                    "finishTimeoutMs": finish_timeout_ms,
                    "finishHistory": finish_history,
                },
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Observed the active hawking runtime state and waited until the normal world HUD returned",
        "input": {
            "mode": "wait_hawking_runtime_finish",
            "finishTimeoutMs": finish_timeout_ms,
            "finishHistory": finish_history,
            "afterText": runtime_state["text"],
        },
    }


def run_close_current_panel(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "close_current_panel")
    before_stage_state = detect_npc_interaction_stage(hwnd)
    before_stage = before_stage_state["stage"]
    closable_stages = {"chat_ready", "gift_screen", "trade_screen", "npc_action_menu", "small_talk_menu", "small_talk_confirm"}

    if before_stage not in closable_stages:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"No closable panel at stage {before_stage or 'none'}",
            "input": {
                "mode": "close_current_panel",
                **collect_npc_stage_input(hwnd, before_stage_state),
                "beforeStage": before_stage,
                "closeTriggered": False,
            },
        }

    if before_stage == "small_talk_confirm":
        close_click = click_named_point(hwnd, "small_talk_cancel_dialog")
        post_close_wait_ms = 300
    elif before_stage == "chat_ready":
        close_click = click_named_point(hwnd, "chat_exit")
        post_close_wait_ms = 300
    else:
        close_click = exit_panel(hwnd)
        post_close_wait_ms = int(action.get("postDelayMs") or 300)
    after_stage_state, close_checks = probe_until_timeout(
        title,
        lambda: detect_npc_interaction_stage(hwnd),
        lambda state: str(state.get("stage") or "none") != before_stage or str(state.get("stage") or "none") not in closable_stages,
        timeout_ms=max(1200, int(action.get("verifyWindowMs") or 2200)),
        interval_ms=max(120, int(action.get("verifyIntervalMs") or 220)),
        initial_wait_ms=post_close_wait_ms,
    )
    after_stage = after_stage_state["stage"]
    if after_stage == before_stage and after_stage in closable_stages:
        raise RuntimeError(
            "close_current_panel did not leave the current panel. "
            f"Stage remained: {after_stage or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Closed panel from {before_stage} to {after_stage or 'none'}",
        "input": {
            "mode": "close_current_panel",
            **collect_npc_stage_input(hwnd, after_stage_state),
            "beforeStage": before_stage,
            "closeTriggered": True,
            "click": close_click,
            "closeChecks": close_checks,
        },
    }


def ensure_npc_action_menu(hwnd: int, timeout_ms: int, move_pulse_ms: int, scan_interval_ms: int) -> dict[str, Any]:
    acquire_result = run_acquire_npc_target(
        hwnd,
        {
            "id": "ensure-npc-action-menu-acquire",
            "title": "ensure_npc_action_menu_acquire",
            "timeoutMs": timeout_ms,
            "movePulseMs": move_pulse_ms,
            "scanIntervalMs": scan_interval_ms,
        },
    )
    menu_result = run_open_npc_action_menu(
        hwnd,
        {
            "id": "ensure-npc-action-menu-open",
            "title": "ensure_npc_action_menu_open",
        },
    )
    acquire_input = acquire_result["input"]
    menu_input = menu_result["input"]
    stage_history = list(acquire_input.get("stageHistory") or [])
    if menu_input.get("stage"):
        stage_history.append(menu_input["stage"])

    return {
        "stage": menu_input["stage"],
        "stageTexts": menu_input.get("stageTexts") or {},
        "stageHistory": stage_history,
        "clickAttempts": int(acquire_input.get("clickAttempts") or 0),
        "moveAttempts": int(acquire_input.get("moveAttempts") or 0),
        "cameraDrags": 0,
        "clickPointAttempts": acquire_input.get("clickPointAttempts") or [],
        "nearbyScanAttempts": acquire_input.get("nearbyScanAttempts") or [],
        "selectionAttempts": acquire_input.get("selectionAttempts") or [],
        "viewAttempts": menu_input.get("viewAttempts") or [],
        "targetText": menu_input.get("targetText") or acquire_input.get("targetText") or "",
    }


def run_enter_stealth_with_retry(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "enter_stealth_with_retry")
    retry_limit = int(action.get("retryLimit") or 5)
    settle_ms = int(action.get("settleMs") or 260)
    post_stealth_cooldown_ms = int(action.get("postStealthCooldownMs") or 5000)
    retry_backstep_ms = int(action.get("retryBackstepMs") or action.get("waitBetweenMs") or 180)
    retry_move_settle_ms = int(action.get("retryMoveSettleMs") or 140)
    consume_buff_once = bool(action.get("consumeBuffOnFirstSuccessOnly", False))
    buff_settle_ms = int(action.get("buffSettleMs") or 300)
    shortcut_key = SHORTCUT_KEYS.get("stealth", "2")
    attempts: list[dict[str, Any]] = []

    focus_window(hwnd)
    exit_state = detect_exit_stealth_button(hwnd)
    if exit_state["visible"]:
        INPUT_GUARD.guarded_sleep(max(0, post_stealth_cooldown_ms), title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Stealth mode was already active",
            "input": {
                "mode": "enter_stealth_with_retry",
                "retryCount": 0,
                "attempts": attempts,
                "stealthVisual": exit_state,
                "postStealthCooldownMs": post_stealth_cooldown_ms,
            },
        }

    for attempt_index in range(max(1, retry_limit)):
        INPUT_GUARD.check_or_raise(title)
        pydirectinput.press(shortcut_key)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(settle_ms, title)
        exit_state = detect_exit_stealth_button(hwnd)
        attempt_payload = {
            "attemptIndex": attempt_index + 1,
            "exitStealthVisible": exit_state["visible"],
            "stealthVisual": exit_state,
        }
        attempts.append(attempt_payload)
        if exit_state["visible"]:
            buff_triggered = False
            if consume_buff_once:
                today_key = time.strftime("%Y-%m-%d")
                if FIRST_STEALTH_BUFF_STATE["date"] != today_key:
                    FIRST_STEALTH_BUFF_STATE["date"] = today_key
                    FIRST_STEALTH_BUFF_STATE["used"] = False
                if not FIRST_STEALTH_BUFF_STATE["used"]:
                    pydirectinput.press(shortcut_key)
                    INPUT_GUARD.refresh_baseline()
                    INPUT_GUARD.guarded_sleep(max(0, buff_settle_ms), title)
                    FIRST_STEALTH_BUFF_STATE["used"] = True
                    buff_triggered = True
            INPUT_GUARD.guarded_sleep(max(0, post_stealth_cooldown_ms), title)
            return {
                "id": action_id,
                "title": title,
                "status": "performed",
                "detail": f"Entered stealth on attempt {attempt_index + 1}",
                "input": {
                    "mode": "enter_stealth_with_retry",
                    "retryCount": attempt_index + 1,
                    "attempts": attempts,
                    "stealthVisual": exit_state,
                    "postStealthCooldownMs": post_stealth_cooldown_ms,
                    "buffTriggered": buff_triggered,
                    "consumeBuffOnFirstSuccessOnly": consume_buff_once,
                },
            }
        if attempt_index < retry_limit - 1:
            pydirectinput.keyDown("s")
            INPUT_GUARD.refresh_baseline()
            INPUT_GUARD.guarded_sleep(max(40, retry_backstep_ms), title)
            pydirectinput.keyUp("s")
            INPUT_GUARD.refresh_baseline()
            INPUT_GUARD.guarded_sleep(max(0, retry_move_settle_ms), title)
            attempt_payload["retryBackstepMs"] = retry_backstep_ms
            attempt_payload["retryMoveSettleMs"] = retry_move_settle_ms

    failed_input = {
        "mode": "enter_stealth_with_retry",
        "retryCount": len(attempts),
        "attempts": attempts,
        "stealthVisual": exit_state,
        "retryBackstepMs": retry_backstep_ms,
        "retryMoveSettleMs": retry_move_settle_ms,
    }
    return build_nonfatal_failed_step(
        action,
        "Failed to enter stealth after backstep retry within the configured retry budget",
        "STEALTH_ENTRY_BLOCKED",
        build_failed_step_payload(
            action,
            "Stealth entry stayed blocked without entering grey stealth state after backstep retries",
            failed_input,
        ),
    )


def run_stealth_front_arc_strike(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_front_arc_strike")
    knockout_timeout_ms = int(action.get("knockoutTimeoutMs") or 2600)
    retry_press_ms = int(action.get("retryPressMs") or 180)

    focus_window(hwnd)
    strike_count = 0
    started_at = time.time()
    knockout_state = detect_knockout_context(hwnd)

    while (time.time() - started_at) * 1000 < knockout_timeout_ms:
        INPUT_GUARD.check_or_raise(title)
        pydirectinput.press("3")
        INPUT_GUARD.refresh_baseline()
        strike_count += 1
        INPUT_GUARD.guarded_sleep(max(60, retry_press_ms), title)
        knockout_state = detect_knockout_context(hwnd)
        if knockout_state["visible"]:
            break

    if not knockout_state["visible"]:
        failed_input = {
            "mode": "stealth_front_arc_strike",
            "knockoutTimeoutMs": knockout_timeout_ms,
            "retryPressMs": retry_press_ms,
            "strikeCount": strike_count,
        }
        return build_nonfatal_failed_step(
            action,
            "Stealth strike did not reach the knockout context after directly striking nearby targets",
            "STEALTH_ALERTED",
            build_failed_step_payload(
                action,
                "Direct stealth strike failed to auto-lock a nearby target into knockout",
                failed_input,
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Entered knockout context by directly striking a nearby target",
        "input": {
            "mode": "stealth_front_arc_strike",
            "knockoutVisual": knockout_state,
            "knockoutTimeoutMs": knockout_timeout_ms,
            "retryPressMs": retry_press_ms,
            "strikeCount": strike_count,
        },
    }


def run_stealth_knock_loot_flow(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_knock_loot_flow")
    search_timeout_ms = int(action.get("searchTimeoutMs") or 7000)
    knockout_timeout_ms = int(action.get("knockoutTimeoutMs") or 5000)
    turn_pulse_ms = int(action.get("turnPulseMs") or 180)
    strike_interval_ms = int(action.get("strikeIntervalMs") or 120)
    move_settle_ms = int(action.get("moveSettleMs") or 80)
    carry_settle_ms = int(action.get("carrySettleMs") or 220)
    backstep_ms = int(action.get("backstepMs") or 3000)
    drop_settle_ms = int(action.get("dropSettleMs") or 220)
    loot_open_timeout_ms = int(action.get("lootOpenTimeoutMs") or 1600)
    loot_settle_ms = int(action.get("lootSettleMs") or 160)
    front_roi = action.get("frontRoi") or STEALTH_ROIS["front_name_band"]
    roi = (
        float(front_roi[0]),
        float(front_roi[1]),
        float(front_roi[2]),
        float(front_roi[3]),
    )

    focus_window(hwnd)
    deadline = time.time() + search_timeout_ms / 1000.0
    search_pattern = ["left", "left", "right", "right"]
    search_attempts: list[dict[str, Any]] = []
    turn_attempts: list[dict[str, Any]] = []
    target = find_stealth_front_target(hwnd, roi)

    while time.time() <= deadline and target is None:
        for key in search_pattern:
            if time.time() > deadline:
                break
            INPUT_GUARD.check_or_raise(title)
            turn_attempts.append(pulse_turn_key(hwnd, key, turn_pulse_ms, title))
            INPUT_GUARD.guarded_sleep(move_settle_ms, title)
            target = find_stealth_front_target(hwnd, roi)
            search_attempts.append({"key": key, "target": target})
            if target is not None:
                break

    if target is None:
        raise RuntimeError("Stealth knock-loot flow timed out before finding a front target")

    target_click = click_screen_point(hwnd, int(target["screenX"]), int(target["screenY"]), "left")
    INPUT_GUARD.guarded_sleep(90, title)

    knockout_state = detect_knockout_context(hwnd)
    strike_count = 0
    knockout_started_at = time.time()
    pydirectinput.keyDown("w")
    INPUT_GUARD.refresh_baseline()

    try:
        while (time.time() - knockout_started_at) * 1000 < knockout_timeout_ms:
            INPUT_GUARD.check_or_raise(title)
            pydirectinput.press("3")
            INPUT_GUARD.refresh_baseline()
            strike_count += 1
            INPUT_GUARD.guarded_sleep(strike_interval_ms, title)
            knockout_state = detect_knockout_context(hwnd)
            if knockout_state["visible"]:
                break
    finally:
        pydirectinput.keyUp("w")
        INPUT_GUARD.refresh_baseline()

    if not knockout_state["visible"]:
        raise RuntimeError("Did not reach knockout context before timeout")

    pydirectinput.press("2")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(carry_settle_ms, title)

    pydirectinput.keyDown("s")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(backstep_ms, title)
    pydirectinput.keyUp("s")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(move_settle_ms, title)

    drop_click = click_named_point(hwnd, "drop_carried_target")
    INPUT_GUARD.guarded_sleep(drop_settle_ms, title)

    pydirectinput.press("4")
    INPUT_GUARD.refresh_baseline()

    loot_state = detect_loot_screen(hwnd)
    loot_deadline = time.time() + loot_open_timeout_ms / 1000.0
    while time.time() <= loot_deadline and not loot_state["visible"]:
        INPUT_GUARD.guarded_sleep(80, title)
        loot_state = detect_loot_screen(hwnd)

    if not loot_state["visible"]:
        raise RuntimeError("Loot panel did not appear after pressing 4")

    loot_clicks: list[dict[str, Any]] = []
    for click_index in range(6):
        item_click = click_named_point(hwnd, "loot_transfer_item")
        INPUT_GUARD.guarded_sleep(max(400, loot_settle_ms), title)
        put_in_click = click_named_point(hwnd, "loot_put_in")
        loot_clicks.append({
            "clickIndex": click_index + 1,
            "itemClick": item_click,
            "putInClick": put_in_click,
        })
        INPUT_GUARD.guarded_sleep(max(200, loot_settle_ms), title)

    final_loot_click = click_named_point(hwnd, "loot_submit")
    INPUT_GUARD.guarded_sleep(max(220, loot_settle_ms), title)
    pydirectinput.keyDown("w")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(5000, title)
    pydirectinput.keyUp("w")
    INPUT_GUARD.refresh_baseline()

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Knocked down {target['text']}, carried back, dropped, and fast-transferred fixed loot items",
        "input": {
            "mode": "stealth_knock_loot_flow",
            "target": target,
            "targetClick": target_click,
            "searchTimeoutMs": search_timeout_ms,
            "knockoutTimeoutMs": knockout_timeout_ms,
            "turnPulseMs": turn_pulse_ms,
            "strikeIntervalMs": strike_interval_ms,
            "strikeCount": strike_count,
            "backstepMs": backstep_ms,
            "frontRoi": {
                "x1": roi[0],
                "y1": roi[1],
                "x2": roi[2],
                "y2": roi[3],
            },
            "knockoutVisual": knockout_state,
            **loot_state,
            "dropClick": drop_click,
            "lootClicks": loot_clicks,
            "finalLootClick": final_loot_click,
            "searchAttempts": search_attempts,
            "turnAttempts": turn_attempts,
        },
    }


def run_stealth_search_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_search_target")
    search_timeout_ms = int(action.get("searchTimeoutMs") or 7000)
    turn_pulse_ms = int(action.get("turnPulseMs") or 180)
    move_settle_ms = int(action.get("moveSettleMs") or 80)
    front_roi = action.get("frontRoi") or STEALTH_ROIS["front_name_band"]
    roi = (
        float(front_roi[0]),
        float(front_roi[1]),
        float(front_roi[2]),
        float(front_roi[3]),
    )

    focus_window(hwnd)
    deadline = time.time() + search_timeout_ms / 1000.0
    search_pattern = ["left", "left", "right", "right"]
    search_attempts: list[dict[str, Any]] = []
    turn_attempts: list[dict[str, Any]] = []
    target = find_stealth_front_target(hwnd, roi)

    while time.time() <= deadline and target is None:
        for key in search_pattern:
            if time.time() > deadline:
                break
            INPUT_GUARD.check_or_raise(title)
            turn_attempts.append(pulse_turn_key(hwnd, key, turn_pulse_ms, title))
            INPUT_GUARD.guarded_sleep(move_settle_ms, title)
            target = find_stealth_front_target(hwnd, roi)
            search_attempts.append({"key": key, "target": target})
            if target is not None:
                break

    if target is None:
        raise RuntimeError("Stealth target search timed out before finding a front NPC name")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Aligned to front target {target['text']}",
        "input": {
            "mode": "stealth_search_target",
            "target": target,
            "searchTimeoutMs": search_timeout_ms,
            "turnPulseMs": turn_pulse_ms,
            "searchAttempts": search_attempts,
            "turnAttempts": turn_attempts,
        },
    }


def run_stealth_select_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_select_target")
    selection_timeout_ms = int(action.get("selectionTimeoutMs") or 2200)
    selection_settle_ms = int(action.get("selectionSettleMs") or 120)
    front_roi = action.get("frontRoi") or STEALTH_ROIS["front_name_band"]
    roi = (
        float(front_roi[0]),
        float(front_roi[1]),
        float(front_roi[2]),
        float(front_roi[3]),
    )

    target = find_stealth_front_target(hwnd, roi)
    if target is None:
        raise RuntimeError("No front target was available to select")

    started_at = time.time()
    click_attempts: list[dict[str, Any]] = []
    stage_state = detect_npc_interaction_stage(hwnd)
    while (time.time() - started_at) * 1000 < selection_timeout_ms:
        click = click_screen_point(hwnd, int(target["screenX"]), int(target["screenY"]), "left")
        click_attempts.append(click)
        INPUT_GUARD.guarded_sleep(selection_settle_ms, title)
        stage_state = detect_npc_interaction_stage(hwnd)
        if stage_state["stage"] == "npc_selected" or contains_any_keyword(stage_state["texts"].get("look_button", ""), ["查看"]):
            break

    if stage_state["stage"] != "npc_selected" and not contains_any_keyword(stage_state["texts"].get("look_button", ""), ["查看"]):
        raise RuntimeError("Failed to reach selected NPC state with 查看/放大镜 visible")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Selected front target {target['text']}",
        "input": {
            "mode": "stealth_select_target",
            "target": target,
            "click": click_attempts[-1] if click_attempts else None,
            "clickAttempts": click_attempts,
            "stage": stage_state["stage"],
            "stageTexts": stage_state["texts"],
        },
    }


def run_stealth_rush_knockout(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_rush_knockout")
    knockout_timeout_ms = int(action.get("knockoutTimeoutMs") or 5000)
    strike_interval_ms = int(action.get("strikeIntervalMs") or 0)
    move_settle_ms = int(action.get("moveSettleMs") or 50)

    knockout_state = detect_knockout_context(hwnd)
    strike_count = 0
    started_at = time.time()
    INPUT_GUARD.check_or_raise(title)
    pydirectinput.press("3")
    INPUT_GUARD.refresh_baseline()
    strike_count = 1

    while (time.time() - started_at) * 1000 < knockout_timeout_ms:
        INPUT_GUARD.guarded_sleep(max(40, strike_interval_ms), title)
        knockout_state = detect_knockout_context(hwnd)
        if knockout_state["visible"]:
            break

    if not knockout_state["visible"]:
        raise RuntimeError("Did not reach knockout context before timeout")

    INPUT_GUARD.guarded_sleep(move_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Reached knockout context",
        "input": {
            "mode": "stealth_rush_knockout",
            "knockoutVisual": knockout_state,
            "strikeCount": strike_count,
            "knockoutTimeoutMs": knockout_timeout_ms,
            "strikeIntervalMs": strike_interval_ms,
        },
    }


def run_stealth_carry_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_carry_target")
    carry_settle_ms = int(action.get("carrySettleMs") or 120)
    knockout_state = detect_knockout_context(hwnd)
    if not knockout_state["visible"]:
        raise RuntimeError("Cannot carry target because knockout context is not visible")
    pydirectinput.press("2")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(carry_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Pressed 2 to carry target",
        "input": {"mode": "stealth_carry_target", "knockoutVisual": knockout_state},
    }


def run_stealth_backstep_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_backstep_target")
    backstep_ms = int(action.get("backstepMs") or 3000)
    move_settle_ms = int(action.get("moveSettleMs") or 40)
    pydirectinput.keyDown("s")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(backstep_ms, title)
    pydirectinput.keyUp("s")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(move_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Backstepped with target for {backstep_ms}ms",
        "input": {"mode": "stealth_backstep_target", "backstepMs": backstep_ms},
    }


def run_stealth_drop_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_drop_target")
    drop_settle_ms = int(action.get("dropSettleMs") or 80)
    click = click_named_point(hwnd, "drop_carried_target")
    INPUT_GUARD.guarded_sleep(drop_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Dropped the carried target",
        "input": {"mode": "stealth_drop_target", "click": click},
    }


def run_stealth_open_loot(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_open_loot")
    loot_open_timeout_ms = int(action.get("lootOpenTimeoutMs") or 1200)
    loot_settle_ms = int(action.get("lootSettleMs") or 40)
    before_frame = capture_verify_frame(hwnd)
    pydirectinput.press("4")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(loot_settle_ms, title)

    loot_state = detect_loot_screen(hwnd)
    deadline = time.time() + loot_open_timeout_ms / 1000.0
    while time.time() <= deadline and not loot_state["visible"]:
        INPUT_GUARD.guarded_sleep(40, title)
        loot_state = detect_loot_screen(hwnd)

    if not loot_state["visible"]:
        return build_nonfatal_failed_step(
            action,
            "Loot panel did not appear after pressing 4",
            "STEALTH_TARGET_RECOVERED",
            build_failed_step_payload(
                action,
                "Loot panel failed to open before the target recovered",
                {
                    "mode": "stealth_open_loot",
                    "lootOpenTimeoutMs": loot_open_timeout_ms,
                    **loot_state,
                },
            ),
        )

    frame_delta = measure_frame_delta(before_frame, capture_verify_frame(hwnd))
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Opened loot panel",
        "input": {"mode": "stealth_open_loot", **loot_state, "frameDelta": frame_delta},
    }


def run_stealth_quick_open_loot_after_knockout(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_quick_open_loot_after_knockout")
    left_step_ms = int(action.get("leftStepMs") or 110)
    left_settle_ms = int(action.get("leftSettleMs") or 30)
    click_settle_ms = int(action.get("clickSettleMs") or 35)
    loot_trigger_settle_ms = int(action.get("lootTriggerSettleMs") or 50)
    loot_open_timeout_ms = int(action.get("lootOpenTimeoutMs") or 900)
    loot_observe_window_ms = int(action.get("lootObserveWindowMs") or 220)
    loot_observe_interval_ms = int(action.get("lootObserveIntervalMs") or 40)
    raw_click_points = action.get("targetClickPoints") or []
    click_points: list[tuple[float, float]] = []
    for point in raw_click_points:
        if isinstance(point, (list, tuple)) and len(point) == 2:
            click_points.append((float(point[0]), float(point[1])))
    if not click_points:
        click_points = [
            (0.57, 0.56),
            (0.60, 0.56),
            (0.58, 0.59),
            (0.62, 0.58),
            (0.55, 0.58),
            (0.64, 0.56),
        ]

    focus_window(hwnd)
    pydirectinput.keyDown("a")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(left_step_ms, title)
    pydirectinput.keyUp("a")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(left_settle_ms, title)

    click_attempts: list[dict[str, Any]] = []
    loot_state = detect_loot_screen(hwnd)
    deadline = time.time() + loot_open_timeout_ms / 1000.0
    point_index = 0
    while time.time() <= deadline and not loot_state["visible"]:
        INPUT_GUARD.check_or_raise(title)
        x_ratio, y_ratio = click_points[point_index % len(click_points)]
        target_click = click_npc_candidate(hwnd, x_ratio, y_ratio, "left")
        click_attempts.append({
            "xRatio": x_ratio,
            "yRatio": y_ratio,
            "targetClick": target_click,
        })
        INPUT_GUARD.guarded_sleep(click_settle_ms, title)
        pydirectinput.press("3")
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(loot_trigger_settle_ms, title)
        observe_deadline = time.time() + max(0, loot_observe_window_ms) / 1000.0
        loot_state = detect_loot_screen(hwnd)
        while time.time() <= observe_deadline and not loot_state["visible"]:
            INPUT_GUARD.guarded_sleep(max(0, loot_observe_interval_ms), title)
            loot_state = detect_loot_screen(hwnd)
        click_attempts[-1]["lootVisible"] = loot_state["visible"]
        point_index += 1

    if not loot_state["visible"]:
        return build_nonfatal_failed_step(
            action,
            "Loot panel did not appear after the quick knockout loot handoff",
            "STEALTH_TARGET_RECOVERED",
            build_failed_step_payload(
                action,
                "Knocked target recovered before the quick left-step and right-side loot handoff opened the loot panel",
                {
                    "mode": "stealth_quick_open_loot_after_knockout",
                    "leftStepMs": left_step_ms,
                    "targetClickPoints": click_points,
                    "clickAttempts": click_attempts,
                    **loot_state,
                },
            ),
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Quick-opened the loot panel after knockout without using carry/drop",
        "input": {
            "mode": "stealth_quick_open_loot_after_knockout",
            "leftStepMs": left_step_ms,
            "clickAttempts": click_attempts,
            **loot_state,
        },
    }


def ensure_loot_panel_visible(hwnd: int, title: str) -> dict[str, Any]:
    loot_state = detect_loot_screen(hwnd)
    if not loot_state["visible"]:
        raise ActionExecutionError(
            f"{title} requires the loot panel to stay visible",
            error_code="STEALTH_TARGET_RECOVERED",
            failed_step={
                "id": "",
                "title": title,
                "status": "failed",
                "detail": "Loot panel disappeared during the steal flow",
                "input": {
                    "mode": "loot_panel_visibility_check",
                    **loot_state,
                },
            },
        )
    return loot_state


def run_loot_collect_fixed_items(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "loot_collect_fixed_items")
    click_count = max(1, int(action.get("clickCount") or 6))
    item_settle_ms = int(action.get("itemSettleMs") or 400)
    put_in_settle_ms = int(action.get("putInSettleMs") or 200)
    clicks: list[dict[str, Any]] = []

    for click_index in range(click_count):
        item_click = click_named_point(hwnd, "loot_transfer_item")
        INPUT_GUARD.guarded_sleep(item_settle_ms, title)
        put_in_click = click_named_point(hwnd, "loot_put_in")
        clicks.append({
            "clickIndex": click_index + 1,
            "itemClick": item_click,
            "putInClick": put_in_click,
        })
        INPUT_GUARD.guarded_sleep(put_in_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Transferred {click_count} fixed loot items through the fixed put-in button",
        "input": {
            "mode": "loot_collect_fixed_items",
            "clickCount": click_count,
            "itemSettleMs": item_settle_ms,
            "putInSettleMs": put_in_settle_ms,
            "clicks": clicks,
        },
    }


def run_loot_submit_once(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "loot_submit_once")
    loot_settle_ms = int(action.get("lootSettleMs") or 40)
    click = click_named_point(hwnd, "loot_submit")
    INPUT_GUARD.guarded_sleep(loot_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Submitted loot",
        "input": {"mode": "loot_submit_once", "click": click},
    }


def run_loot_escape_forward(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "loot_escape_forward")
    escape_forward_ms = int(action.get("escapeForwardMs") or 5000)
    pydirectinput.keyDown("w")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(escape_forward_ms, title)
    pydirectinput.keyUp("w")
    INPUT_GUARD.refresh_baseline()
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Escaped forward for {escape_forward_ms}ms",
        "input": {"mode": "loot_escape_forward", "escapeForwardMs": escape_forward_ms},
    }


def run_stealth_trigger_miaoqu(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_trigger_miaoqu")
    retry_limit = max(1, int(action.get("retryLimit") or 3))
    trigger_timeout_ms = int(action.get("triggerTimeoutMs") or 5000)
    trigger_settle_ms = int(action.get("triggerSettleMs") or 40)
    retry_forward_ms = int(action.get("retryForwardMs") or 140)
    retry_move_settle_ms = int(action.get("retryMoveSettleMs") or 80)
    ocr_fallback_interval_ms = int(action.get("ocrFallbackIntervalMs") or 280)
    trigger_key = str(action.get("triggerKey") or "3").strip().lower()
    attempts: list[dict[str, Any]] = []
    steal_state = {
        "visible": False,
        "text": "",
        "source": "fixed_gold_buttons",
        "visual": {"visible": False},
    }

    for attempt_index in range(retry_limit):
        INPUT_GUARD.check_or_raise(title)
        pydirectinput.press(trigger_key)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(trigger_settle_ms, title)

        initial_visual_state = detect_steal_button_stack(hwnd)
        steal_state = {
            "visible": initial_visual_state["visible"],
            "text": "",
            "source": "fixed_gold_buttons",
            "visual": initial_visual_state,
        }
        attempt_payload = {
            "attemptIndex": attempt_index + 1,
            "triggerKey": trigger_key,
            "panelReady": steal_state["visible"],
            "panelReadySource": steal_state["source"],
            "panelReadyVisual": steal_state["visual"],
        }

        deadline = time.time() + trigger_timeout_ms / 1000.0
        last_ocr_probe_at = time.time()
        while time.time() <= deadline and not steal_state["visible"]:
            INPUT_GUARD.guarded_sleep(40, title)
            visual_state = detect_steal_button_stack(hwnd)
            if visual_state["visible"]:
                steal_state = {
                    "visible": True,
                    "text": "",
                    "source": "fixed_gold_buttons",
                    "visual": visual_state,
                }
                break
            if (time.time() - last_ocr_probe_at) * 1000 >= max(120, ocr_fallback_interval_ms):
                steal_state = detect_steal_screen_ready(hwnd)
                last_ocr_probe_at = time.time()
            else:
                steal_state = {
                    "visible": False,
                    "text": "",
                    "source": "fixed_gold_buttons",
                    "visual": visual_state,
                }

        attempt_payload["panelReady"] = steal_state["visible"]
        attempt_payload["panelReadySource"] = steal_state["source"]
        attempt_payload["panelReadyText"] = steal_state["text"]
        attempt_payload["panelReadyVisual"] = steal_state["visual"]
        attempts.append(attempt_payload)

        if steal_state["visible"]:
            return {
                "id": action_id,
                "title": title,
                "status": "performed",
                "detail": f"Opened miaoqu panel on attempt {attempt_index + 1}",
                "input": {
                    "mode": "stealth_trigger_miaoqu",
                    "triggerKey": trigger_key,
                    "retryLimit": retry_limit,
                    "retryCount": attempt_index + 1,
                    "triggerTimeoutMs": trigger_timeout_ms,
                    "triggerSettleMs": trigger_settle_ms,
                    "retryForwardMs": retry_forward_ms,
                    "retryMoveSettleMs": retry_move_settle_ms,
                    "attempts": attempts,
                    "text": steal_state["text"],
                    "panelReadySource": steal_state["source"],
                    "panelReadyVisual": steal_state["visual"],
                },
            }

        if attempt_index < retry_limit - 1:
            pydirectinput.keyDown("w")
            INPUT_GUARD.refresh_baseline()
            INPUT_GUARD.guarded_sleep(max(40, retry_forward_ms), title)
            pydirectinput.keyUp("w")
            INPUT_GUARD.refresh_baseline()
            INPUT_GUARD.guarded_sleep(max(0, retry_move_settle_ms), title)
            attempt_payload["retryForwardMs"] = retry_forward_ms
            attempt_payload["retryMoveSettleMs"] = retry_move_settle_ms

    if not steal_state["visible"]:
        raise ActionExecutionError(
            "Steal panel did not appear after miaoqu trigger retries",
            error_code="STEALTH_TARGET_RECOVERED",
            failed_step=build_failed_step_payload(
                action,
                "Miaoqu panel stayed closed after retrying with short forward steps",
                {
                    "mode": "stealth_trigger_miaoqu",
                    "triggerKey": trigger_key,
                    "retryLimit": retry_limit,
                    "retryCount": len(attempts),
                    "triggerTimeoutMs": trigger_timeout_ms,
                    "triggerSettleMs": trigger_settle_ms,
                    "retryForwardMs": retry_forward_ms,
                    "retryMoveSettleMs": retry_move_settle_ms,
                    "attempts": attempts,
                    "text": steal_state["text"],
                    "panelReadySource": steal_state["source"],
                    "panelReadyVisual": steal_state["visual"],
                },
            ),
        )

    raise RuntimeError("Unreachable miaoqu trigger state")


def run_stealth_escape_backward(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_escape_backward")
    backstep_ms = int(action.get("backstepMs") or 3000)
    move_settle_ms = int(action.get("moveSettleMs") or 40)
    pydirectinput.keyDown("s")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(backstep_ms, title)
    pydirectinput.keyUp("s")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(move_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Escaped backward for {backstep_ms}ms",
        "input": {
            "mode": "stealth_escape_backward",
            "backstepMs": backstep_ms,
        },
    }


def run_stealth_spam_escape_backward(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_spam_escape_backward")
    backstep_ms = int(action.get("backstepMs") or 3000)
    spam_interval_ms = int(action.get("spamIntervalMs") or 80)
    move_settle_ms = int(action.get("moveSettleMs") or 40)
    presses = 0
    deadline = time.time() + max(80, backstep_ms) / 1000.0
    while time.time() <= deadline:
        INPUT_GUARD.check_or_raise(title)
        pydirectinput.press("s")
        INPUT_GUARD.refresh_baseline()
        presses += 1
        remaining_ms = max(0, int((deadline - time.time()) * 1000))
        if remaining_ms <= 0:
            break
        INPUT_GUARD.guarded_sleep(min(max(20, spam_interval_ms), remaining_ms), title)
    INPUT_GUARD.guarded_sleep(move_settle_ms, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Spam-pressed S backward for {backstep_ms}ms",
        "input": {
            "mode": "stealth_spam_escape_backward",
            "backstepMs": backstep_ms,
            "spamIntervalMs": spam_interval_ms,
            "pressCount": presses,
        },
    }




def run_action(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    action_type = str(action.get("type") or "inspect")
    title = str(action.get("title") or action_type)
    post_delay_ms = int(action.get("postDelayMs") or DEFAULT_POST_DELAY_MS)
    INPUT_GUARD.check_or_raise(title)

    if action_type == "focus_window":
        bounds = focus_window(hwnd)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Focused window {bounds['title']}",
            "bounds": bounds,
        }

    if action_type == "acquire_npc_target":
        return run_acquire_npc_target(hwnd, action)

    if action_type == "open_npc_action_menu":
        return run_open_npc_action_menu(hwnd, action)

    if action_type == "click_menu_talk":
        return run_click_menu_talk(hwnd, action)

    if action_type == "click_menu_small_talk":
        return run_click_menu_small_talk(hwnd, action)

    if action_type == "confirm_small_talk_entry":
        return run_confirm_small_talk_entry(hwnd, action)

    if action_type == "click_menu_gift":
        return run_click_menu_gift(hwnd, action)

    if action_type == "inspect_gift_chat_threshold":
        return run_inspect_gift_chat_threshold(hwnd, action)

    if action_type == "inspect_npc_interaction_stage":
        return run_inspect_npc_interaction_stage(hwnd, action)

    if action_type == "inspect_recovery_anchor_state":
        return run_inspect_recovery_anchor_state(hwnd, action)

    if action_type == "select_gift_first_slot":
        return run_select_gift_first_slot(hwnd, action)

    if action_type == "submit_gift_once":
        return run_submit_gift_once(hwnd, action)

    if action_type == "resolve_gift_chat_threshold":
        return run_resolve_gift_chat_threshold(hwnd, action)

    if action_type == "click_menu_trade":
        return run_click_menu_trade(hwnd, action)

    if action_type == "stealth_front_arc_strike":
        return run_stealth_front_arc_strike(hwnd, action)

    if action_type == "enter_stealth_with_retry":
        return run_enter_stealth_with_retry(hwnd, action)

    if action_type == "stealth_search_target":
        return run_stealth_search_target(hwnd, action)

    if action_type == "stealth_select_target":
        return run_stealth_select_target(hwnd, action)

    if action_type == "stealth_rush_knockout":
        return run_stealth_rush_knockout(hwnd, action)

    if action_type == "stealth_carry_target":
        return run_stealth_carry_target(hwnd, action)

    if action_type == "stealth_backstep_target":
        return run_stealth_backstep_target(hwnd, action)

    if action_type == "stealth_drop_target":
        return run_stealth_drop_target(hwnd, action)

    if action_type == "stealth_open_loot":
        return run_stealth_open_loot(hwnd, action)

    if action_type == "stealth_quick_open_loot_after_knockout":
        return run_stealth_quick_open_loot_after_knockout(hwnd, action)

    if action_type == "loot_collect_fixed_items":
        return run_loot_collect_fixed_items(hwnd, action)

    if action_type == "loot_submit_once":
        return run_loot_submit_once(hwnd, action)

    if action_type == "loot_escape_forward":
        return run_loot_escape_forward(hwnd, action)

    if action_type == "stealth_knock_loot_flow":
        return run_stealth_knock_loot_flow(hwnd, action)

    if action_type == "stealth_escape_backward":
        return run_stealth_escape_backward(hwnd, action)

    if action_type == "stealth_spam_escape_backward":
        return run_stealth_spam_escape_backward(hwnd, action)

    if action_type == "click_fixed_steal_button_and_escape":
        return run_click_fixed_steal_button_and_escape(hwnd, action)

    if action_type == "click_named_point":
        point_name = str(action.get("pointName") or "").strip()
        if not point_name:
            raise RuntimeError("click_named_point action requires pointName")
        click_state = click_named_point(hwnd, point_name)
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Clicked fixed point {point_name}",
            "input": {
                "pointName": point_name,
                **click_state,
            },
        }

    if action_type == "map_route_to_coordinate":
        return run_map_route_to_coordinate(hwnd, action)

    if action_type == "travel_to_coordinate":
        return run_travel_to_coordinate(hwnd, action)

    if action_type == "open_named_npc_trade":
        return run_open_named_npc_trade(hwnd, action)

    if action_type == "named_npc_trade_flow":
        return run_named_npc_trade_flow(hwnd, action)

    if action_type == "align_named_vendor_interact_prompt":
        return run_align_named_vendor_interact_prompt(hwnd, action)

    if action_type == "open_named_vendor_purchase":
        return run_open_named_vendor_purchase(hwnd, action)

    if action_type == "buy_current_vendor_item":
        return run_buy_current_vendor_item(hwnd, action)

    if action_type == "close_vendor_panel":
        return run_close_vendor_panel(hwnd, action)

    if action_type == "stock_first_hawking_item":
        return run_stock_first_hawking_item(hwnd, action)

    if action_type == "submit_hawking":
        return run_submit_hawking(hwnd, action)

    if action_type == "wait_hawking_runtime_finish":
        return run_wait_hawking_runtime_finish(hwnd, action)

    if action_type == "trade_select_left_item_tab":
        return run_trade_click_step(hwnd, action, "trade_left_item_tab", "Selected the left trade tab", 700)

    if action_type == "trade_select_left_item":
        return run_trade_click_step(hwnd, action, "trade_left_item_slot", "Selected the left trade item", 1000)

    if action_type == "trade_left_item_up_shelf":
        return run_trade_click_step(hwnd, action, "trade_left_up_shelf_button", "Placed the left trade item on shelf", 1200)

    if action_type == "trade_prepare_gift_bundle":
        return run_trade_prepare_gift_bundle(hwnd, action)

    if action_type == "trade_select_right_money_slot":
        return run_trade_click_step(hwnd, action, "trade_right_money_slot", "Selected the left-side payment coin", 1000)

    if action_type == "trade_scale_quantity":
        return run_trade_click_step(hwnd, action, "trade_scale_button", "Adjusted the trade quantity", 1200)

    if action_type == "trade_right_item_up_shelf":
        return run_trade_click_step(hwnd, action, "trade_right_up_shelf_button", "Placed the right-side payment item on shelf", 1200)

    if action_type == "trade_submit":
        return run_trade_click_step(hwnd, action, "trade_final_submit_button", "Submitted the current trade", 1600, True)

    if action_type == "click_steal_button":
        return run_click_steal_button(hwnd, action)

    if action_type == "exit_stealth":
        return run_exit_stealth(hwnd, action)

    if action_type == "close_current_panel":
        return run_close_current_panel(hwnd, action)

    if action_type == "move_forward_pulse":
        return run_move_forward_pulse(hwnd, action)

    if action_type == "drag_camera":
        return run_drag_camera(hwnd, action)

    if action_type == "type_text":
        text = str(action.get("text") or "").strip()
        if not text:
            raise RuntimeError("type_text action requires text")
        focus_window(hwnd)

        click_ratio = action.get("clickRatio")
        if isinstance(click_ratio, list) and len(click_ratio) == 2:
            click_npc_candidate(hwnd, float(click_ratio[0]), float(click_ratio[1]), "left")
            INPUT_GUARD.guarded_sleep(80, title)

        pyperclip.copy(text)
        pydirectinput.keyDown("ctrl")
        pydirectinput.press("v")
        pydirectinput.keyUp("ctrl")
        INPUT_GUARD.refresh_baseline()

        if bool(action.get("pressEnter", False)):
            INPUT_GUARD.guarded_sleep(80, title)
            pydirectinput.press("enter")
            INPUT_GUARD.refresh_baseline()

        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Typed text with length {len(text)}",
            "input": {
                "text": text,
                "pressEnter": bool(action.get("pressEnter", False)),
                "clickRatio": click_ratio,
            },
        }

    if action_type == "send_chat_message":
        text = str(action.get("text") or "").strip()
        if not text:
            raise RuntimeError("send_chat_message action requires text")
        close_after_send = bool(action.get("closeAfterSend", True))
        close_settle_ms = int(action.get("closeSettleMs") or 600)
        input_state = send_chat_message(hwnd, text, close_after_send, close_settle_ms)
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Sent chat message with length {len(text)}",
            "input": {
                "text": text,
                **input_state,
            },
        }

    if action_type == "read_current_chat":
        input_state = read_current_chat(hwnd)
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Read current chat dialog with length {len(input_state['dialogText'])}",
            "input": input_state,
        }

    if action_type == "press_key":
        key = str(action.get("key") or "").strip().lower()
        if not key:
            raise RuntimeError("press_key action requires key")
        focus_window(hwnd)
        duration_ms = int(action.get("durationMs") or 0)
        if duration_ms > 0:
            pydirectinput.keyDown(key)
            INPUT_GUARD.refresh_baseline()
            INPUT_GUARD.guarded_sleep(duration_ms, title)
            pydirectinput.keyUp(key)
        else:
            pydirectinput.press(key)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Held key {key} for {duration_ms}ms" if duration_ms > 0 else f"Sent key {key}",
            "input": {
                "key": key,
                **({"durationMs": duration_ms} if duration_ms > 0 else {}),
            },
        }

    if action_type == "press_shortcut":
        shortcut = str(action.get("shortcut") or action.get("name") or "").strip()
        key = resolve_shortcut_key(shortcut)
        focus_window(hwnd)
        pydirectinput.press(key)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Sent shortcut {shortcut} -> {key}",
            "input": {
                "shortcut": shortcut,
                "key": key,
            },
        }

    if action_type == "click_relative":
        x_ratio = float(action.get("xRatio"))
        y_ratio = float(action.get("yRatio"))
        button = str(action.get("button") or "left").strip().lower()
        bounds = focus_window(hwnd)
        click_x = round(bounds["left"] + bounds["width"] * x_ratio)
        click_y = round(bounds["top"] + bounds["height"] * y_ratio)
        pydirectinput.click(x=click_x, y=click_y, button=button)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Clicked relative point ({x_ratio:.3f}, {y_ratio:.3f})",
            "input": {
                "button": button,
                "screenX": click_x,
                "screenY": click_y,
                "xRatio": x_ratio,
                "yRatio": y_ratio,
            },
        }

    if action_type == "sleep":
        duration_ms = int(action.get("durationMs") or 1000)
        INPUT_GUARD.guarded_sleep(duration_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Slept for {duration_ms}ms",
            "input": {"durationMs": duration_ms},
        }

    raise RuntimeError(f"Unsupported input action: {action_type}")


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8")
    if not raw.strip():
        emit({"ok": False, "message": "Missing execution payload"})
        return

    payload = json.loads(raw)
    window_title_keyword = str(payload.get("windowTitleKeyword") or "天涯明月刀手游").strip()
    interrupt_on_external_input = bool(payload.get("interruptOnExternalInput", False))
    actions = payload.get("actions") or []

    if not actions:
        emit({"ok": False, "message": "No actions provided"})
        return

    hwnd = find_window(window_title_keyword)
    if not hwnd:
        emit(
            {
                "ok": False,
                "message": f"Window containing '{window_title_keyword}' was not found",
                "errorCode": "WINDOW_NOT_FOUND",
            }
        )
        return

    INPUT_GUARD.configure(interrupt_on_external_input)

    results: list[dict[str, Any]] = []

    try:
        for action in actions:
            try:
                results.append(run_action(hwnd, action))
            except ActionExecutionError as exc:
                if is_fatal_action_error(exc):
                    emit(
                        {
                            "ok": False,
                            "message": str(exc),
                            "errorCode": exc.error_code,
                            "steps": results,
                            "failedStep": exc.failed_step,
                        }
                    )
                    return
                results.append(
                    build_nonfatal_failed_step(
                        action,
                        str(exc),
                        exc.error_code,
                        exc.failed_step,
                    )
                )
            except RuntimeError as exc:
                if is_fatal_runtime_error(str(exc)):
                    emit(
                        {
                            "ok": False,
                            "message": str(exc),
                            "errorCode": "INPUT_EXECUTION_FAILED",
                            "steps": results,
                        }
                    )
                    return
                results.append(
                    build_nonfatal_failed_step(
                        action,
                        str(exc),
                        "INPUT_EXECUTION_FAILED",
                    )
                )
    except Exception as exc:
        emit(
            {
                "ok": False,
                "message": str(exc),
                "errorCode": "INPUT_EXECUTION_FAILED",
                "steps": results,
            }
        )
        return

    emit(
        {
            "ok": True,
            "executor": "WindowsInputExecutor",
            "windowTitleKeyword": window_title_keyword,
            "steps": results,
            "nonFatalFailureCount": sum(1 for step in results if step.get("status") == "failed"),
        }
    )


def main_v2() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8")
    if not raw.strip():
        emit({"ok": False, "message": "Missing execution payload"})
        return

    payload = json.loads(raw)
    window_title_keyword = str(
        payload.get("windowTitleKeyword")
        or "\u5929\u6daf\u660e\u6708\u5200\u624b\u6e38"
    ).strip()
    interrupt_on_external_input = bool(payload.get("interruptOnExternalInput", False))
    actions = payload.get("actions") or []

    if not actions:
        emit({"ok": False, "message": "No actions provided"})
        return

    hwnd, activation = resolve_game_window(window_title_keyword)
    if not hwnd:
        emit(
            {
                "ok": False,
                "message": f"Window containing '{window_title_keyword}' was not found",
                "errorCode": "WINDOW_NOT_FOUND",
                "windowCandidates": list_window_candidates(window_title_keyword)[:5],
            }
        )
        return

    INPUT_GUARD.configure(interrupt_on_external_input)
    results: list[dict[str, Any]] = []

    try:
        for action in actions:
            try:
                results.append(run_action(hwnd, action))
            except ActionExecutionError as exc:
                if is_fatal_action_error(exc):
                    emit(
                        {
                            "ok": False,
                            "message": str(exc),
                            "errorCode": exc.error_code,
                            "steps": results,
                            "failedStep": exc.failed_step,
                            "activationFallback": activation,
                        }
                    )
                    return
                results.append(
                    build_nonfatal_failed_step(
                        action,
                        str(exc),
                        exc.error_code,
                        exc.failed_step,
                    )
                )
            except RuntimeError as exc:
                if is_fatal_runtime_error(str(exc)):
                    emit(
                        {
                            "ok": False,
                            "message": str(exc),
                            "errorCode": "INPUT_EXECUTION_FAILED",
                            "steps": results,
                            "activationFallback": activation,
                        }
                    )
                    return
                results.append(
                    build_nonfatal_failed_step(
                        action,
                        str(exc),
                        "INPUT_EXECUTION_FAILED",
                    )
                )
    except Exception as exc:
        emit(
            {
                "ok": False,
                "message": str(exc),
                "errorCode": "INPUT_EXECUTION_FAILED",
                "steps": results,
                "activationFallback": activation,
            }
        )
        return

    emit(
        {
            "ok": True,
            "executor": "WindowsInputExecutor",
            "windowTitleKeyword": window_title_keyword,
            "activationFallback": activation,
            "steps": results,
            "nonFatalFailureCount": sum(1 for step in results if step.get("status") == "failed"),
        }
    )


if __name__ == "__main__":
    main_v2()

