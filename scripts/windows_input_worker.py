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
TMP_DIR = Path(__file__).resolve().parents[1] / "tmp"
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

NPC_STAGE_ROIS = {
    "look_button": (0.26, 0.48, 0.40, 0.62),
    "moving_view_search": (0.68, 0.24, 0.92, 0.60),
    "bottom_right_actions": (0.64, 0.70, 0.98, 0.98),
    "confirm_dialog": (0.16, 0.10, 0.84, 0.84),
    "chat_panel": (0.00, 0.00, 0.46, 0.98),
    "gift_panel": (0.64, 0.00, 1.00, 1.00),
    "trade_panel": (0.18, 0.00, 1.00, 1.00),
    "selected_target": (0.20, 0.18, 0.42, 0.36),
    "scene_npc_search": (0.18, 0.14, 0.98, 0.88),
}

STEALTH_ROIS = {
    "front_name_band": (0.36, 0.18, 0.64, 0.42),
    "exit_button": (0.86, 0.44, 0.99, 0.58),
}

MAP_STAGE_ROIS = {
    "left_panel": (0.00, 0.05, 0.40, 0.90),
    "route_panel": (0.60, 0.76, 0.86, 0.96),
    "keypad_panel": (0.36, 0.50, 0.78, 0.94),
}

NPC_CAPTURE_SCAN_POINTS = [
    (0.515, 0.500), (0.557, 0.507), (0.592, 0.526), (0.618, 0.556), (0.634, 0.594),
    (0.639, 0.636), (0.634, 0.678), (0.618, 0.716), (0.592, 0.746), (0.557, 0.765),
    (0.515, 0.772), (0.473, 0.765), (0.438, 0.746), (0.412, 0.716), (0.396, 0.678),
    (0.391, 0.636), (0.396, 0.594), (0.412, 0.556), (0.438, 0.526), (0.473, 0.507),
    (0.515, 0.530), (0.548, 0.536), (0.576, 0.551), (0.597, 0.575), (0.610, 0.606),
    (0.614, 0.640), (0.610, 0.674), (0.597, 0.705), (0.576, 0.729), (0.548, 0.744),
    (0.515, 0.750), (0.482, 0.744), (0.454, 0.729), (0.433, 0.705), (0.420, 0.674),
    (0.416, 0.640), (0.420, 0.606), (0.433, 0.575), (0.454, 0.551), (0.482, 0.536),
    (0.555, 0.566), (0.579, 0.586), (0.593, 0.614), (0.596, 0.646), (0.588, 0.677),
    (0.570, 0.703), (0.544, 0.720), (0.486, 0.720), (0.460, 0.703), (0.442, 0.677),
]

ACTION_POINTS = {
    "view": (0.32, 0.57),
    "talk": (1870 / 2537, 1252 / 1384),
    "small_talk": (1677 / 2537, 1081 / 1384),
    "confirm_small_talk": (1481 / 2537, 1018 / 1384),
    "trade": (2139 / 2537, 1139 / 1384),
    "gift": (2404 / 2537, 1141 / 1384),
    "target_close": (1115 / 2537, 691 / 1384),
    "close_panel": (2494 / 2537, 48 / 1384),
    "trade_left_item_tab": (0.037, 0.394),
    "trade_left_item_slot": (0.115, 0.409),
    "trade_left_up_shelf_button": (0.362, 0.764),
    "trade_right_money_slot": (0.843, 0.159),
    "trade_scale_button": (0.744, 0.542),
    "trade_right_up_shelf_button": (0.639, 0.703),
    "trade_final_submit_button": (0.510, 0.905),
    "vendor_purchase_plus": (625 / 1848, 550 / 1020),
    "vendor_purchase_buy": (634 / 1848, 716 / 1020),
    "vendor_purchase_max_quantity": (740 / 2048, 597 / 1151),
    "vendor_purchase_close": (1995 / 2048, 79 / 1151),
    "vendor_purchase_option": (2160 / 2643, 221 / 1398),
    "vendor_purchase_item_moding": (1680 / 2048, 500 / 1151),
    "hawking_inventory_first_slot": (1691 / 2048, 257 / 1151),
    "hawking_max_quantity": (1464 / 2048, 661 / 1151),
    "hawking_stock_button": (1298 / 2048, 843 / 1151),
    "hawking_submit": (2459 / 2644, 1227 / 1399),
    "steal_button_1": (1916 / 2048, 512 / 1360),
    "steal_button_2": (1916 / 2048, 704 / 1360),
    "steal_button_3": (1916 / 2048, 893 / 1360),
    "steal_button_4": (1916 / 2048, 1085 / 1360),
    "exit_stealth": (407 / 2048, 810 / 1152),
    "gift_first_slot": (1721 / 2537, 580 / 1384),
    "gift_plus": (0.82, 0.92),
    "gift_submit": (2289 / 2537, 1216 / 1384),
    "small_talk_confirm_dialog": (0.581, 0.746),
    "chat_input": (652 / 2537, 1294 / 1384),
    # Send is fixed UI, but it only becomes actionable after valid text input.
    # Keep the point calibrated now; do not assume the button is clickable
    # until the text-entry chain is wired in.
    "chat_send": (938 / 2537, 1289 / 1384),
    "chat_exit": (0.425, 0.508),
    "map_coord_y_input": (1300 / 1870, 843 / 976),
    "map_coord_x_input": (1971 / 2643, 1213 / 1398),
    "map_go": (0.808551, 0.864807),
    "teleport_confirm": (0.569, 0.742),
    "drop_carried_target": (0.706, 0.553),
    "loot_item_1": (0.717, 0.356),
    "loot_item_2": (0.788, 0.356),
    "loot_item_3": (0.860, 0.356),
    "loot_put_in": (0.543, 0.634),
    "loot_submit": (0.862, 0.885),
}

MAP_KEYPAD_POINTS = {
    "vertical": {
        "1": (778 / 1870, 552 / 976),
        "2": (894 / 1870, 552 / 976),
        "3": (1011 / 1870, 552 / 976),
        "4": (778 / 1870, 665 / 976),
        "5": (894 / 1870, 665 / 976),
        "6": (1011 / 1870, 665 / 976),
        "7": (778 / 1870, 777 / 976),
        "8": (894 / 1870, 777 / 976),
        "9": (1011 / 1870, 777 / 976),
        "0": (1127 / 1870, 665 / 976),
        "delete": (1127 / 1870, 552 / 976),
        "confirm": (1127 / 1870, 777 / 976),
    },
    "horizontal": {
        "1": (1267 / 2643, 791 / 1398),
        "2": (1431 / 2643, 791 / 1398),
        "3": (1595 / 2643, 791 / 1398),
        "4": (1267 / 2643, 952 / 1398),
        "5": (1431 / 2643, 952 / 1398),
        "6": (1595 / 2643, 952 / 1398),
        "7": (1267 / 2643, 1113 / 1398),
        "8": (1431 / 2643, 1113 / 1398),
        "9": (1595 / 2643, 1113 / 1398),
        "0": (1758 / 2643, 952 / 1398),
        "delete": (1758 / 2643, 791 / 1398),
        "confirm": (1758 / 2643, 1113 / 1398),
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
LOOT_SCREEN_KEYWORDS = ["搜刮", "放入", "今日搜刮次数"]


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
    debug_image.save(file_path)
    return str(file_path)


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


def normalize_name_candidate(text: str) -> str:
    normalized = re.sub(r"\s+", "", str(text or ""))
    normalized = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9<>团队]", "", normalized)
    return normalized


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


def detect_vendor_purchase_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": contains_any_keyword(panel_text, VENDOR_PURCHASE_KEYWORDS),
        "text": panel_text,
    }


def detect_hawking_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": contains_any_keyword(panel_text, HAWKING_SCREEN_KEYWORDS),
        "text": panel_text,
    }


def detect_steal_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": count_keywords(panel_text, STEAL_KEYWORDS) >= 2,
        "text": panel_text,
    }


def detect_exit_stealth_button(hwnd: int) -> dict[str, Any]:
    button_text = ocr_text(capture_window_region(hwnd, STEALTH_ROIS["exit_button"]))
    normalized_text = normalize_npc_name(button_text)
    return {
        "visible": "退出潜行" in normalized_text,
        "text": button_text,
        "normalizedText": normalized_text,
    }


def detect_knockout_context(hwnd: int) -> dict[str, Any]:
    action_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["bottom_right_actions"]))
    return {
        "visible": count_keywords(action_text, KNOCKOUT_CONTEXT_KEYWORDS) >= 2,
        "text": action_text,
    }


def detect_loot_screen(hwnd: int) -> dict[str, Any]:
    panel_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))
    return {
        "visible": count_keywords(panel_text, LOOT_SCREEN_KEYWORDS) >= 2,
        "text": panel_text,
    }


def ensure_map_screen_open(hwnd: int, title: str, toggle_key: str = "m", timeout_ms: int = 2500) -> dict[str, Any]:
    focus_window(hwnd)
    current_state = detect_map_screen(hwnd)
    if current_state["visible"]:
        return current_state

    pydirectinput.press(toggle_key)
    INPUT_GUARD.refresh_baseline()
    deadline = time.time() + timeout_ms / 1000.0

    while time.time() <= deadline:
        INPUT_GUARD.guarded_sleep(120, title)
        current_state = detect_map_screen(hwnd)
        if current_state["visible"]:
            return current_state

    raise RuntimeError("Failed to open map screen before timeout")


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


def run_map_route_to_coordinate(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "map_route_to_coordinate")
    x_coordinate = int(action.get("xCoordinate"))
    y_coordinate = int(action.get("yCoordinate"))
    wait_after_go_ms = int(action.get("waitAfterGoMs") or 0)
    toggle_key = str(action.get("toggleKey") or "m").strip().lower()

    map_state = ensure_map_screen_open(hwnd, title, toggle_key=toggle_key)
    y_input = input_map_coordinate_field(hwnd, "map_coord_y_input", "vertical", y_coordinate, "vertical", title)
    x_input = input_map_coordinate_field(hwnd, "map_coord_x_input", "horizontal", x_coordinate, "horizontal", title)
    go_click = click_map_route_control(hwnd, "go", "map_go")
    INPUT_GUARD.guarded_sleep(max(1000, wait_after_go_ms), title)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Opened map and started routing to ({x_coordinate}, {y_coordinate})",
        "input": {
            "mode": "map_route_to_coordinate",
            "toggleKey": toggle_key,
            "mapTexts": map_state["texts"],
            "xCoordinate": x_coordinate,
            "yCoordinate": y_coordinate,
            "verticalInput": y_input,
            "horizontalInput": x_input,
            "goClick": go_click,
            "waitAfterGoMs": wait_after_go_ms,
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


def read_stage_texts(hwnd: int) -> dict[str, str]:
    return {
        name: ocr_text(capture_window_region(hwnd, roi))
        for name, roi in NPC_STAGE_ROIS.items()
    }


def detect_npc_interaction_stage(hwnd: int) -> dict[str, Any]:
    stage_texts = read_stage_texts(hwnd)
    look_text = stage_texts["look_button"]
    bottom_right_text = stage_texts["bottom_right_actions"]
    confirm_text = stage_texts["confirm_dialog"]
    chat_panel_text = stage_texts["chat_panel"]
    gift_panel_text = stage_texts["gift_panel"]
    trade_panel_text = stage_texts["trade_panel"]
    world_hud_visible = contains_any_keyword(bottom_right_text, WORLD_HUD_KEYWORDS)

    if contains_any_keyword(gift_panel_text, GIFT_KEYWORDS) and not world_hud_visible:
        stage = "gift_screen"
    elif count_keywords(trade_panel_text, STEAL_KEYWORDS) >= 2 and not world_hud_visible:
        stage = "steal_screen"
    elif count_keywords(trade_panel_text, TRADE_KEYWORDS) >= 2 and not world_hud_visible:
        stage = "trade_screen"
    elif contains_any_keyword(chat_panel_text, CHAT_KEYWORDS) and not world_hud_visible:
        stage = "chat_ready"
    elif contains_any_keyword(confirm_text, CONFIRM_KEYWORDS):
        stage = "small_talk_confirm"
    elif contains_any_keyword(bottom_right_text, ["闲聊", "交谈"]):
        stage = "small_talk_menu"
    elif contains_any_keyword(bottom_right_text, ["交谈", "赠礼", "邀请", "战斗", "交易"]):
        stage = "npc_action_menu"
    elif contains_any_keyword(look_text, ["查看"]):
        stage = "npc_selected"
    else:
        stage = "none"

    return {
        "stage": stage,
        "texts": stage_texts,
    }


def detect_bottom_right_menu_stage(hwnd: int) -> dict[str, Any]:
    bottom_right_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["bottom_right_actions"]))

    if contains_any_keyword(bottom_right_text, ["闂茶亰", "浜よ皥"]):
        stage = "small_talk_menu"
    elif contains_any_keyword(bottom_right_text, ["浜よ皥", "璧犵ぜ", "浜ゆ槗"]):
        stage = "npc_action_menu"
    else:
        stage = "none"

    return {
        "stage": stage,
        "text": bottom_right_text,
    }


def click_npc_candidate(hwnd: int, x_ratio: float, y_ratio: float, button: str = "left") -> dict[str, Any]:
    bounds = focus_window(hwnd)
    click_x = round(bounds["left"] + bounds["width"] * x_ratio)
    click_y = round(bounds["top"] + bounds["height"] * y_ratio)
    pydirectinput.click(x=click_x, y=click_y, button=button)
    INPUT_GUARD.refresh_baseline()
    return {
        "button": button,
        "screenX": click_x,
        "screenY": click_y,
        "xRatio": x_ratio,
        "yRatio": y_ratio,
    }


def click_named_point(hwnd: int, point_name: str) -> dict[str, Any]:
    x_ratio, y_ratio = ACTION_POINTS[point_name]
    return click_npc_candidate(hwnd, x_ratio, y_ratio, "left")


def execute_fixed_trade_flow(hwnd: int, title: str) -> dict[str, Any]:
    # After the moving-target selection and the fixed trade entry button,
    # the rest of the trade UI is owned by one calibrated fixed-click chain.
    fixed_clicks = [
        ("trade_left_item_tab", 180),
        ("trade_left_item_slot", 260),
        ("trade_left_up_shelf_button", 320),
        ("trade_right_money_slot", 220),
        ("trade_scale_button", 220),
        ("trade_right_up_shelf_button", 320),
        ("trade_final_submit_button", 380),
    ]
    click_results: list[dict[str, Any]] = []
    stage_history = ["trade_screen"]

    for point_name, delay_ms in fixed_clicks:
        click_results.append({
            "point": point_name,
            "click": click_named_point(hwnd, point_name),
        })
        INPUT_GUARD.guarded_sleep(delay_ms, title)
        stage_state = detect_npc_interaction_stage(hwnd)
        stage_history.append(stage_state["stage"])
        if point_name != "trade_final_submit_button" and stage_state["stage"] != "trade_screen":
            raise RuntimeError(
                f"Trade flow left trade screen after {point_name}. Last stage: {stage_state['stage'] or 'none'}"
            )

    return {
        "clicks": click_results,
        "stageHistory": stage_history,
    }


def click_screen_point(hwnd: int, screen_x: int, screen_y: int, button: str = "left") -> dict[str, Any]:
    focus_window(hwnd)
    pydirectinput.click(x=screen_x, y=screen_y, button=button)
    INPUT_GUARD.refresh_baseline()
    return {
        "button": button,
        "screenX": screen_x,
        "screenY": screen_y,
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

    click_named_point(hwnd, "chat_send")
    INPUT_GUARD.guarded_sleep(180, "send_chat_message")

    if close_after_send:
        exit_panel(hwnd)
        INPUT_GUARD.guarded_sleep(max(0, close_settle_ms), "send_chat_message")

    return {
        "textLength": len(text),
        "closeAfterSend": close_after_send,
        "closeSettleMs": close_settle_ms,
    }


def read_current_chat(hwnd: int) -> dict[str, Any]:
    stage_state = detect_npc_interaction_stage(hwnd)
    if stage_state["stage"] != "chat_ready":
        raise RuntimeError(
            "Current screen is not chat_ready. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    dialog_state = detect_dialog(hwnd)
    dialog_text = str(dialog_state.get("text") or "").strip()
    if not dialog_text:
        raise RuntimeError("Current chat screen has no readable dialog text")

    return {
        "stage": "chat_ready",
        "dialogText": dialog_text,
        "stageTexts": stage_state["texts"],
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
        }

    return None


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

        if moving_view or has_selected_target(target_info):
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
) -> dict[str, Any]:
    view_attempts: list[dict[str, Any]] = []

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

    if not moving_view:
        return {
            "opened": False,
            "stage": detect_npc_interaction_stage(hwnd)["stage"],
            "viewAttempts": view_attempts,
        }

    click_screen_point(hwnd, moving_view["screenX"], moving_view["screenY"], "left")
    view_attempts.append({
        **moving_view,
        "source": "selected_npc_view_button",
    })
    INPUT_GUARD.guarded_sleep(100, title)

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

    return {
        "opened": stage in ["npc_action_menu", "small_talk_menu", "chat_ready", "gift_screen", "trade_screen"],
        "stage": stage,
        "stageTexts": stage_texts,
        "viewAttempts": view_attempts,
    }


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
    search_width: int = 260,
    search_height: int = 280,
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
    search_width: int = 260,
    search_height: int = 280,
) -> dict[str, Any] | None:
    bounds = get_window_bounds(hwnd)
    left = max(bounds["left"], anchor_x - search_width // 2)
    top = max(bounds["top"], anchor_y - search_height // 2)
    right = min(bounds["left"] + bounds["width"], left + search_width)
    bottom = min(bounds["top"] + bounds["height"], top + search_height)
    image = capture_screen_rect(left, top, right - left, bottom - top)
    best_match = choose_local_view_candidate(image, left, top, anchor_x, anchor_y)
    timestamp = time.strftime("%Y%m%d-%H%M%S")
    click_point = None
    if best_match:
        click_point = (best_match["screenX"] - left, best_match["screenY"] - top)
    debug_path = save_debug_image(image, f"view-search-{timestamp}-{anchor_x}-{anchor_y}.png", click_point)
    if best_match:
        best_match["debugImage"] = debug_path
        best_match["searchRect"] = {
            "left": left,
            "top": top,
            "width": right - left,
            "height": bottom - top,
        }
    return best_match


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
    move_pulse_ms = int(action.get("movePulseMs") or DEFAULT_MOVE_PULSE_MS)
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


def detect_target_threshold(hwnd: int) -> dict[str, Any]:
    text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["selected_target"]))
    is_special = "<" in text and ">" in text
    return {
        "isSpecialNpc": is_special,
        "threshold": 50 if is_special else 10,
        "text": text,
    }


def has_selected_target(target_info: dict[str, Any]) -> bool:
    text = str(target_info.get("text") or "").strip()
    return len(text) >= 2 and text != "1"


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


def find_vendor_item_button(hwnd: int, item_name: str) -> dict[str, Any] | None:
    roi = NPC_STAGE_ROIS["trade_panel"]
    bounds = get_window_bounds(hwnd)
    image = capture_window_region(hwnd, roi)
    items = ocr_items(image)
    keywords = [part for part in re.split(r"\s+", normalize_npc_name(item_name)) if part]

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
        "screenY": round(bounds["top"] + bounds["height"] * roi[1] + max(best_match["centerY"] - 70, 16)),
        "source": "vendor_item_text",
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
    approach_steps = max(1, min(3, int(action.get("approachSteps") or 2)))
    approach_move_pulse_ms = max(60, int(action.get("approachMovePulseMs") or 180))
    interact_attempts = max(1, int(action.get("interactAttempts") or 3))

    if not target_name:
        raise RuntimeError("open_named_vendor_purchase action requires targetName")

    focus_window(hwnd)
    approach_moves: list[dict[str, Any]] = []
    interact_attempt_log: list[dict[str, Any]] = []
    option_click = None
    purchase_state = detect_vendor_purchase_screen(hwnd)

    for step_index in range(approach_steps):
        forward_state = pulse_forward(hwnd, approach_move_pulse_ms)
        approach_moves.append(forward_state)
        INPUT_GUARD.guarded_sleep(1000, title)

        for interact_index in range(interact_attempts):
            focus_window(hwnd)
            pydirectinput.press("f")
            INPUT_GUARD.refresh_baseline()
            INPUT_GUARD.guarded_sleep(1000, title)

            quick_menu_state = detect_bottom_right_menu_stage(hwnd)
            purchase_state = detect_vendor_purchase_screen(hwnd)
            option_click = None
            if not purchase_state["visible"] and quick_menu_state["stage"] in {"npc_action_menu", "small_talk_menu"}:
                option_click = click_named_point(hwnd, "vendor_purchase_option")
                INPUT_GUARD.guarded_sleep(1000, title)
                purchase_state = detect_vendor_purchase_screen(hwnd)
            interact_attempt_log.append(
                {
                    "approachStep": step_index + 1,
                    "interactAttempt": interact_index + 1,
                    "menuStage": quick_menu_state["stage"],
                    "menuText": quick_menu_state["text"],
                    "optionClick": option_click,
                    "purchaseVisible": bool(purchase_state["visible"]),
                    "purchaseText": purchase_state["text"],
                }
            )
            if purchase_state["visible"]:
                break

        if purchase_state["visible"]:
            break

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
            "approachSteps": approach_steps,
            "approachMovePulseMs": approach_move_pulse_ms,
            "approachMoves": approach_moves,
            "interactAttempts": interact_attempt_log,
            "optionClick": option_click,
            "stage": "vendor_purchase_screen",
            "purchaseText": purchase_state["text"],
        },
    }


def run_buy_current_vendor_item(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "buy_current_vendor_item")
    quantity = max(1, int(action.get("quantity") or 1))
    item_name = str(action.get("itemName") or "墨锭").strip()

    purchase_state = detect_vendor_purchase_screen(hwnd)
    if not purchase_state["visible"]:
        raise RuntimeError("Current screen is not vendor purchase screen")

    item_key = normalize_npc_name(item_name)
    if item_key == normalize_npc_name("墨锭"):
        item_button = {"pointName": "vendor_purchase_item_moding"}
    else:
        raise RuntimeError(f"Unsupported fixed vendor item: {item_name}")

    item_click = click_named_point(hwnd, item_button["pointName"])
    INPUT_GUARD.guarded_sleep(1000, title)

    max_quantity_click = click_named_point(hwnd, "vendor_purchase_max_quantity")
    INPUT_GUARD.guarded_sleep(1000, title)
    buy_click = click_named_point(hwnd, "vendor_purchase_buy")
    INPUT_GUARD.guarded_sleep(1000, title)
    close_click = click_named_point(hwnd, "vendor_purchase_close")
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 1000), title)
    after_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked item, maximized quantity, bought it, and closed the purchase panel",
        "input": {
            "mode": "buy_current_vendor_item",
            "itemName": item_name,
            "quantity": quantity,
            "itemButton": item_button,
            "itemClick": item_click,
            "maxQuantityClick": max_quantity_click,
            "buyClick": buy_click,
            "closeClick": close_click,
            "beforeText": purchase_state["text"],
            "afterText": after_text,
        },
    }


def run_close_vendor_panel(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "close_vendor_panel")
    click_state = click_named_point(hwnd, "close_panel")
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 1000), title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Closed current vendor panel",
        "input": {
            "mode": "close_vendor_panel",
            "click": click_state,
        },
    }


def run_stock_first_hawking_item(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stock_first_hawking_item")
    hawking_state = detect_hawking_screen(hwnd)
    if not hawking_state["visible"]:
        raise RuntimeError("Current screen is not hawking screen")

    inventory_click = click_named_point(hwnd, "hawking_inventory_first_slot")
    INPUT_GUARD.guarded_sleep(1000, title)
    max_quantity_click = click_named_point(hwnd, "hawking_max_quantity")
    INPUT_GUARD.guarded_sleep(1000, title)
    stock_click = click_named_point(hwnd, "hawking_stock_button")
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 1000), title)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Selected the first hawking item, maximized quantity, and clicked the stock button",
        "input": {
            "mode": "stock_first_hawking_item",
            "beforeText": hawking_state["text"],
            "inventoryClick": inventory_click,
            "maxQuantityClick": max_quantity_click,
            "stockClick": stock_click,
        },
    }


def run_submit_hawking(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "submit_hawking")
    hawking_state = detect_hawking_screen(hwnd)
    if not hawking_state["visible"]:
        raise RuntimeError("Current screen is not hawking screen")

    submit_click = click_named_point(hwnd, "hawking_submit")
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 1000), title)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Submitted current hawking shelf setup",
        "input": {
            "mode": "submit_hawking",
            "beforeText": hawking_state["text"],
            "submitClick": submit_click,
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


def run_acquire_npc_target(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "acquire_npc_target")
    timeout_ms = int(action.get("timeoutMs") or DEFAULT_INTERACT_TIMEOUT_MS)
    move_pulse_ms = int(action.get("movePulseMs") or DEFAULT_MOVE_PULSE_MS)
    scan_interval_ms = int(action.get("scanIntervalMs") or DEFAULT_SCAN_INTERVAL_MS)
    click_points = [
        (0.80, 0.44),
        (0.84, 0.45),
        (0.88, 0.46),
        (0.78, 0.50),
        (0.82, 0.51),
        (0.86, 0.52),
        (0.80, 0.56),
        (0.84, 0.56),
    ]
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
    current_stage = current_stage_state["stage"]
    if current_stage in NPC_READY_STAGES or current_stage == "npc_selected" or has_selected_target(current_target_info):
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
        if resolved_stage == "none" and has_selected_target({"text": nearby_scan["targetText"]}):
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
        last_stage = stage_state["stage"]
        resolved_stage = last_stage if last_stage != "none" else ("npc_selected" if has_selected_target(target_info) else "none")
        stage_history.append(resolved_stage)

        if resolved_stage in NPC_READY_STAGES or resolved_stage == "npc_selected":
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

        if click_attempts % len(click_points) == 0:
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
    current_stage = stage_state["stage"]

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

    if current_stage != "npc_selected" and not has_selected_target(target_info):
        raise RuntimeError(
            "open_npc_action_menu requires an already selected NPC target. "
            f"Detected stage: {current_stage or 'none'}"
        )

    open_view_result = open_view_for_selected_npc(hwnd, title, target_info["text"])
    next_stage = open_view_result["stage"]
    if not open_view_result["opened"] or next_stage not in NPC_READY_STAGES:
        raise RuntimeError(
            "Failed to open NPC action menu from the selected target. "
            f"Last stage: {next_stage or 'none'}"
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
        },
    }


def run_click_menu_talk(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_talk")
    stage_state = detect_npc_interaction_stage(hwnd)
    current_stage = stage_state["stage"]

    if current_stage in {"small_talk_menu", "chat_ready"}:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Talk entry already advanced to {current_stage}",
            "input": {
                "mode": "click_menu_talk",
                **collect_npc_stage_input(hwnd, stage_state),
                "click": None,
            },
        }

    if current_stage != "npc_action_menu":
        raise RuntimeError(
            "click_menu_talk requires npc_action_menu. "
            f"Detected stage: {current_stage or 'none'}"
        )

    talk_click = click_named_point(hwnd, "talk")
    INPUT_GUARD.guarded_sleep(180, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    next_stage = next_stage_state["stage"]
    if next_stage not in {"small_talk_menu", "chat_ready"}:
        raise RuntimeError(
            "Talk entry did not advance to small talk or chat. "
            f"Last stage: {next_stage or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Talk entry advanced to {next_stage}",
        "input": {
            "mode": "click_menu_talk",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": talk_click,
        },
    }


def run_click_menu_small_talk(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_small_talk")
    stage_state = detect_npc_interaction_stage(hwnd)
    current_stage = stage_state["stage"]

    if current_stage == "chat_ready":
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Chat screen is already open",
            "input": {
                "mode": "click_menu_small_talk",
                **collect_npc_stage_input(hwnd, stage_state),
                "click": None,
            },
        }

    if current_stage != "small_talk_menu":
        raise RuntimeError(
            "click_menu_small_talk requires small_talk_menu. "
            f"Detected stage: {current_stage or 'none'}"
        )

    small_talk_click = click_named_point(hwnd, "small_talk")
    INPUT_GUARD.guarded_sleep(180, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    next_stage = next_stage_state["stage"]
    if next_stage not in {"small_talk_confirm", "chat_ready"}:
        raise RuntimeError(
            "Small talk did not advance to confirmation or chat. "
            f"Last stage: {next_stage or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Small talk entry advanced to {next_stage}",
        "input": {
            "mode": "click_menu_small_talk",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": small_talk_click,
        },
    }


def run_confirm_small_talk_entry(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "confirm_small_talk_entry")
    stage_state = detect_npc_interaction_stage(hwnd)
    current_stage = stage_state["stage"]

    if current_stage == "chat_ready":
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Chat screen is already ready",
            "input": {
                "mode": "confirm_small_talk_entry",
                **collect_npc_stage_input(hwnd, stage_state),
                "click": None,
            },
        }

    if current_stage != "small_talk_confirm":
        raise RuntimeError(
            "confirm_small_talk_entry requires small_talk_confirm. "
            f"Detected stage: {current_stage or 'none'}"
        )

    confirm_click = click_named_point(hwnd, "small_talk_confirm_dialog")
    INPUT_GUARD.guarded_sleep(350, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    next_stage = next_stage_state["stage"]
    if next_stage != "chat_ready":
        raise RuntimeError(
            "Small talk confirmation did not reach chat_ready. "
            f"Last stage: {next_stage or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Confirmed small talk and reached chat screen",
        "input": {
            "mode": "confirm_small_talk_entry",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": confirm_click,
        },
    }


def run_click_menu_gift(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_gift")
    stage_state = detect_npc_interaction_stage(hwnd)
    current_stage = stage_state["stage"]

    if current_stage == "gift_screen":
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Gift screen is already open",
            "input": {
                "mode": "click_menu_gift",
                **collect_npc_stage_input(hwnd, stage_state),
                "click": None,
            },
        }

    if current_stage != "npc_action_menu":
        raise RuntimeError(
            "click_menu_gift requires npc_action_menu. "
            f"Detected stage: {current_stage or 'none'}"
        )

    gift_click = click_named_point(hwnd, "gift")
    INPUT_GUARD.guarded_sleep(300, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if next_stage_state["stage"] != "gift_screen":
        raise RuntimeError(
            "Gift entry did not reach gift_screen. "
            f"Last stage: {next_stage_state['stage'] or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Opened gift screen",
        "input": {
            "mode": "click_menu_gift",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": gift_click,
        },
    }


def run_select_gift_first_slot(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "select_gift_first_slot")
    stage_state = detect_npc_interaction_stage(hwnd)
    if stage_state["stage"] != "gift_screen":
        raise RuntimeError(
            "select_gift_first_slot requires gift_screen. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    gift_click = click_named_point(hwnd, "gift_first_slot")
    INPUT_GUARD.guarded_sleep(150, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if next_stage_state["stage"] != "gift_screen":
        raise RuntimeError(
            "Gift slot selection left gift_screen unexpectedly. "
            f"Last stage: {next_stage_state['stage'] or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Selected the first gift slot",
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
    if stage_state["stage"] != "gift_screen":
        raise RuntimeError(
            "submit_gift_once requires gift_screen. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    favor_before = parse_favor_value(stage_state["texts"]["gift_panel"])
    submit_click = click_named_point(hwnd, "gift_submit")
    INPUT_GUARD.guarded_sleep(450, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if next_stage_state["stage"] != "gift_screen":
        raise RuntimeError(
            "Gift submit left gift_screen unexpectedly. "
            f"Last stage: {next_stage_state['stage'] or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Submitted one gift round",
        "input": {
            "mode": "submit_gift_once",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": submit_click,
            "favorBefore": favor_before,
            "favorAfter": parse_favor_value(next_stage_state["texts"]["gift_panel"]),
        },
    }


def run_click_menu_trade(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_menu_trade")
    stage_state = detect_npc_interaction_stage(hwnd)
    current_stage = stage_state["stage"]

    if current_stage == "trade_screen":
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Trade screen is already open",
            "input": {
                "mode": "click_menu_trade",
                **collect_npc_stage_input(hwnd, stage_state),
                "click": None,
            },
        }

    if current_stage != "npc_action_menu":
        raise RuntimeError(
            "click_menu_trade requires npc_action_menu. "
            f"Detected stage: {current_stage or 'none'}"
        )

    trade_click = click_named_point(hwnd, "trade")
    INPUT_GUARD.guarded_sleep(350, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if next_stage_state["stage"] != "trade_screen":
        raise RuntimeError(
            "Trade entry did not reach trade_screen. "
            f"Last stage: {next_stage_state['stage'] or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Opened trade screen",
        "input": {
            "mode": "click_menu_trade",
            **collect_npc_stage_input(hwnd, next_stage_state),
            "click": trade_click,
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
    stage_state = detect_npc_interaction_stage(hwnd)
    if stage_state["stage"] != "trade_screen":
        raise RuntimeError(
            f"{action.get('type') or point_name} requires trade_screen. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    step_click = click_named_point(hwnd, point_name)
    INPUT_GUARD.guarded_sleep(delay_ms, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if not allow_non_trade_after and next_stage_state["stage"] != "trade_screen":
        raise RuntimeError(
            f"Trade step {point_name} left trade_screen unexpectedly. "
            f"Last stage: {next_stage_state['stage'] or 'none'}"
        )

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
        raise RuntimeError(
            f"click_steal_button requires steal_screen. "
            f"Detected stage: {stage_state['stage'] or 'none'}"
        )

    steal_state = detect_steal_screen(hwnd)
    step_click = click_named_point(hwnd, point_name)
    INPUT_GUARD.guarded_sleep(settle_ms, title)
    next_stage_state = detect_npc_interaction_stage(hwnd)
    if next_stage_state["stage"] == "steal_screen":
        raise RuntimeError(
            f"Steal button {point_name} did not close the steal panel. "
            f"Last stage: {next_stage_state['stage'] or 'none'}"
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
        raise RuntimeError(
            "exit_stealth requires visible 退出潜行 button. "
            f"Detected text: {exit_state['text'] or 'none'}"
        )

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
            "beforeText": exit_state["text"],
            "afterText": next_exit_state["text"],
            "pointName": "exit_stealth",
            "click": step_click,
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

    exit_panel(hwnd)
    after_stage_state = detect_npc_interaction_stage(hwnd)
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


def run_stealth_front_arc_strike(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "stealth_front_arc_strike")
    search_timeout_ms = int(action.get("searchTimeoutMs") or 7000)
    turn_pulse_ms = int(action.get("turnPulseMs") or 180)
    hold_forward_ms = int(action.get("holdForwardMs") or 2200)
    strike_interval_ms = int(action.get("strikeIntervalMs") or 180)
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
            INPUT_GUARD.guarded_sleep(80, title)
            target = find_stealth_front_target(hwnd, roi)
            search_attempts.append(
                {
                    "key": key,
                    "target": target,
                }
            )
            if target is not None:
                break

    if target is None:
        raise RuntimeError("Stealth front-arc search timed out before finding a non-team target name")

    pydirectinput.keyDown("w")
    INPUT_GUARD.refresh_baseline()
    strike_count = 0
    started_at = time.time()

    try:
        while (time.time() - started_at) * 1000 < hold_forward_ms:
            INPUT_GUARD.check_or_raise(title)
            pydirectinput.press("3")
            INPUT_GUARD.refresh_baseline()
            strike_count += 1
            INPUT_GUARD.guarded_sleep(strike_interval_ms, title)
    finally:
        pydirectinput.keyUp("w")
        INPUT_GUARD.refresh_baseline()

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Found {target['text']} in the front arc and advanced while striking",
        "input": {
            "mode": "stealth_front_arc_strike",
            "target": target,
            "searchTimeoutMs": search_timeout_ms,
            "turnPulseMs": turn_pulse_ms,
            "holdForwardMs": hold_forward_ms,
            "strikeIntervalMs": strike_interval_ms,
            "strikeCount": strike_count,
            "frontRoi": {
                "x1": roi[0],
                "y1": roi[1],
                "x2": roi[2],
                "y2": roi[3],
            },
            "searchAttempts": search_attempts,
            "turnAttempts": turn_attempts,
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
    for _ in range(8):
        loot_clicks.append({
            "point": "loot_item_1",
            "click": click_named_point(hwnd, "loot_item_1"),
        })
        INPUT_GUARD.guarded_sleep(loot_settle_ms, title)
        loot_clicks.append({
            "point": "loot_put_in",
            "click": click_named_point(hwnd, "loot_put_in"),
        })
        INPUT_GUARD.guarded_sleep(loot_settle_ms, title)

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
        "detail": f"Knocked down {target['text']}, carried back, dropped, and looted three items fast",
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
            "knockoutText": knockout_state["text"],
            "lootText": loot_state["text"],
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
            "knockoutText": knockout_state["text"],
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
        "input": {"mode": "stealth_carry_target", "knockoutText": knockout_state["text"]},
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
    pydirectinput.press("4")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(loot_settle_ms, title)

    loot_state = detect_loot_screen(hwnd)
    deadline = time.time() + loot_open_timeout_ms / 1000.0
    while time.time() <= deadline and not loot_state["visible"]:
        INPUT_GUARD.guarded_sleep(40, title)
        loot_state = detect_loot_screen(hwnd)

    if not loot_state["visible"]:
        raise RuntimeError("Loot panel did not appear after pressing 4")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Opened loot panel",
        "input": {"mode": "stealth_open_loot", "lootText": loot_state["text"]},
    }


def ensure_loot_panel_visible(hwnd: int, title: str) -> dict[str, Any]:
    loot_state = detect_loot_screen(hwnd)
    if not loot_state["visible"]:
        raise RuntimeError(f"{title} requires the loot panel to stay visible")
    return loot_state


def run_loot_select_item_once(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "loot_select_item_once")
    loot_settle_ms = int(action.get("lootSettleMs") or 20)
    ensure_loot_panel_visible(hwnd, title)
    click = click_named_point(hwnd, "loot_item_1")
    INPUT_GUARD.guarded_sleep(loot_settle_ms, title)
    ensure_loot_panel_visible(hwnd, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Selected the fixed loot item slot",
        "input": {"mode": "loot_select_item_once", "click": click},
    }


def run_loot_put_in_once(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "loot_put_in_once")
    loot_settle_ms = int(action.get("lootSettleMs") or 20)
    ensure_loot_panel_visible(hwnd, title)
    click = click_named_point(hwnd, "loot_put_in")
    INPUT_GUARD.guarded_sleep(loot_settle_ms, title)
    ensure_loot_panel_visible(hwnd, title)
    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Clicked put-in on loot panel",
        "input": {"mode": "loot_put_in_once", "click": click},
    }


def run_loot_submit_once(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "loot_submit_once")
    loot_settle_ms = int(action.get("lootSettleMs") or 40)
    ensure_loot_panel_visible(hwnd, title)
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
    trigger_timeout_ms = int(action.get("triggerTimeoutMs") or 5000)
    trigger_settle_ms = int(action.get("triggerSettleMs") or 40)
    pydirectinput.press("3")
    INPUT_GUARD.refresh_baseline()
    INPUT_GUARD.guarded_sleep(trigger_settle_ms, title)

    steal_state = detect_steal_screen(hwnd)
    deadline = time.time() + trigger_timeout_ms / 1000.0
    while time.time() <= deadline and not steal_state["visible"]:
        INPUT_GUARD.guarded_sleep(40, title)
        steal_state = detect_steal_screen(hwnd)

    if not steal_state["visible"]:
        raise RuntimeError("Steal panel did not appear after pressing 3")

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Opened miaoqu panel after pressing 3 once",
        "input": {
            "mode": "stealth_trigger_miaoqu",
            "text": steal_state["text"],
            "triggerTimeoutMs": trigger_timeout_ms,
        },
    }


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

    if action_type == "select_gift_first_slot":
        return run_select_gift_first_slot(hwnd, action)

    if action_type == "submit_gift_once":
        return run_submit_gift_once(hwnd, action)

    if action_type == "click_menu_trade":
        return run_click_menu_trade(hwnd, action)

    if action_type == "stealth_front_arc_strike":
        return run_stealth_front_arc_strike(hwnd, action)

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

    if action_type == "loot_select_item_once":
        return run_loot_select_item_once(hwnd, action)

    if action_type == "loot_put_in_once":
        return run_loot_put_in_once(hwnd, action)

    if action_type == "loot_submit_once":
        return run_loot_submit_once(hwnd, action)

    if action_type == "loot_escape_forward":
        return run_loot_escape_forward(hwnd, action)

    if action_type == "stealth_knock_loot_flow":
        return run_stealth_knock_loot_flow(hwnd, action)

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

    if action_type == "open_named_npc_trade":
        return run_open_named_npc_trade(hwnd, action)

    if action_type == "named_npc_trade_flow":
        return run_named_npc_trade_flow(hwnd, action)

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

    if action_type == "trade_select_left_item_tab":
        return run_trade_click_step(hwnd, action, "trade_left_item_tab", "Selected the left trade tab", 180)

    if action_type == "trade_select_left_item":
        return run_trade_click_step(hwnd, action, "trade_left_item_slot", "Selected the left trade item", 260)

    if action_type == "trade_left_item_up_shelf":
        return run_trade_click_step(hwnd, action, "trade_left_up_shelf_button", "Placed the left trade item on shelf", 320)

    if action_type == "trade_select_right_money_slot":
        return run_trade_click_step(hwnd, action, "trade_right_money_slot", "Selected the right-side payment item", 220)

    if action_type == "trade_scale_quantity":
        return run_trade_click_step(hwnd, action, "trade_scale_button", "Adjusted the trade quantity", 220)

    if action_type == "trade_right_item_up_shelf":
        return run_trade_click_step(hwnd, action, "trade_right_up_shelf_button", "Placed the right-side payment item on shelf", 320)

    if action_type == "trade_submit":
        return run_trade_click_step(hwnd, action, "trade_final_submit_button", "Submitted the current trade", 380, True)

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
        pydirectinput.press(key)
        INPUT_GUARD.refresh_baseline()
        INPUT_GUARD.guarded_sleep(post_delay_ms, title)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Sent key {key}",
            "input": {"key": key},
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
            results.append(run_action(hwnd, action))
    except ActionExecutionError as exc:
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
            results.append(run_action(hwnd, action))
    except ActionExecutionError as exc:
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
        }
    )


if __name__ == "__main__":
    main_v2()
