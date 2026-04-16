import base64
import ctypes
import io
import json
from pathlib import Path
import re
import sys
import time
from typing import Any

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
    "scene_npc_search": (0.18, 0.14, 0.88, 0.78),
}

MAP_STAGE_ROIS = {
    "left_panel": (0.00, 0.05, 0.40, 0.90),
    "route_panel": (0.60, 0.76, 0.86, 0.96),
    "keypad_panel": (0.36, 0.50, 0.78, 0.94),
}

ACTION_POINTS = {
    "view": (0.32, 0.57),
    "talk": (1870 / 2537, 1252 / 1384),
    "small_talk": (1677 / 2537, 1081 / 1384),
    "confirm_small_talk": (1481 / 2537, 1018 / 1384),
    "trade": (2139 / 2537, 1139 / 1384),
    "gift": (2404 / 2537, 1141 / 1384),
    "target_close": (1115 / 2537, 691 / 1384),
    "close_panel": (2494 / 2537, 48 / 1384),
    "trade_left_slot": (0.27, 0.33),
    "trade_left_up_shelf": (0.38, 0.82),
    "trade_right_slot": (0.82, 0.20),
    "trade_right_currency_slot": (0.69, 0.57),
    "trade_right_up_shelf": (0.82, 0.82),
    "trade_submit": (0.53, 0.92),
    "vendor_purchase_plus": (625 / 1848, 550 / 1020),
    "vendor_purchase_buy": (634 / 1848, 716 / 1020),
    "vendor_purchase_option": (1468 / 1870, 154 / 976),
    "vendor_purchase_item_moding": (1558 / 1870, 379 / 976),
    "hawking_inventory_first_slot": (0.84, 0.20),
    "hawking_stock_button": (0.615, 0.742),
    "hawking_submit": (0.92, 0.95),
    "gift_first_slot": (1721 / 2537, 580 / 1384),
    "gift_plus": (0.82, 0.92),
    "gift_submit": (2289 / 2537, 1216 / 1384),
    "chat_input": (652 / 2537, 1294 / 1384),
    # Send is fixed UI, but it only becomes actionable after valid text input.
    # Keep the point calibrated now; do not assume the button is clickable
    # until the text-entry chain is wired in.
    "chat_send": (938 / 2537, 1289 / 1384),
    "map_coord_y_input": (1300 / 1870, 843 / 976),
    "map_coord_x_input": (1421 / 1870, 843 / 976),
    "map_go": (1518 / 1870, 841 / 976),
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
        "1": (899 / 1870, 553 / 976),
        "2": (1015 / 1870, 553 / 976),
        "3": (1131 / 1870, 553 / 976),
        "4": (899 / 1870, 665 / 976),
        "5": (1015 / 1870, 665 / 976),
        "6": (1131 / 1870, 665 / 976),
        "7": (899 / 1870, 777 / 976),
        "8": (1015 / 1870, 777 / 976),
        "9": (1131 / 1870, 777 / 976),
        "0": (1247 / 1870, 665 / 976),
        "delete": (1247 / 1870, 553 / 976),
        "confirm": (1247 / 1870, 777 / 976),
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
CONFIRM_KEYWORDS = ["确认", "闲聊", "取消"]
MAP_KEYWORDS = ["点击输入坐标寻路", "前往", "灵犀盏追踪目标", "通缉追踪目标"]
VENDOR_PURCHASE_KEYWORDS = ["进货", "购买", "购买数量", "每日进货体力消耗上限", "单价", "总价"]


HAWKING_SCREEN_KEYWORDS = ["上货", "货架", "库存", "出摊"]


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def get_ocr_engine() -> RapidOCR:
    global OCR_ENGINE
    if OCR_ENGINE is None:
        OCR_ENGINE = RapidOCR()
    return OCR_ENGINE


def find_window(window_title_keyword: str) -> int | None:
    matches: list[tuple[int, str, int]] = []
    keyword = window_title_keyword.lower()

    def callback(hwnd: int, _lparam: int) -> bool:
        if not win32gui.IsWindowVisible(hwnd):
            return True

        title = win32gui.GetWindowText(hwnd).strip()
        if not title or keyword not in title.lower():
            return True

        try:
            _client_left, _client_top = win32gui.ClientToScreen(hwnd, (0, 0))
            _client_x, _client_y, client_right, client_bottom = win32gui.GetClientRect(hwnd)
        except Exception:
            return True

        area = max(0, client_right) * max(0, client_bottom)
        if area <= 0:
            return True
        matches.append((hwnd, title, area))
        return True

    win32gui.EnumWindows(callback, 0)

    if not matches:
        return None

    matches.sort(key=lambda item: item[2], reverse=True)
    return matches[0][0]


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


def clear_map_coordinate_field(hwnd: int, layout: dict[str, Any], repeat: int, title: str) -> None:
    delete_button = layout["buttons"]["delete"]
    for _ in range(max(1, repeat)):
        click_screen_point(hwnd, int(delete_button["screenX"]), int(delete_button["screenY"]), "left")
        INPUT_GUARD.guarded_sleep(60, title)


def input_map_coordinate_field(
    hwnd: int,
    point_name: str,
    control_name: str,
    coordinate_value: int,
    field_name: str,
    title: str,
) -> dict[str, Any]:
    click_state = click_map_route_control(hwnd, control_name, point_name)
    INPUT_GUARD.guarded_sleep(220, title)
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

    clear_map_coordinate_field(hwnd, layout, 4, title)

    typed_digits: list[dict[str, Any]] = []
    for digit in digits:
        button = layout["buttons"].get(digit)
        if not button:
            raise RuntimeError(f"Map keypad button for digit {digit} was not found")
        click_screen_point(hwnd, int(button["screenX"]), int(button["screenY"]), "left")
        INPUT_GUARD.guarded_sleep(80, title)
        typed_digits.append({
            "digit": digit,
            "screenX": int(button["screenX"]),
            "screenY": int(button["screenY"]),
        })

    return {
        "fieldName": field_name,
        "value": int(coordinate_value),
        "fieldClick": click_state,
        "activationAttempts": [click_state],
        "typedDigits": typed_digits,
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
    INPUT_GUARD.guarded_sleep(max(200, wait_after_go_ms), title)

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


def run_open_named_vendor_purchase(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "open_named_vendor_purchase")
    target_name = str(action.get("targetName") or "").strip()
    option_text = str(action.get("optionText") or "进些货物").strip()

    if not target_name:
        raise RuntimeError("open_named_vendor_purchase action requires targetName")

    focus_window(hwnd)
    npc_anchor = find_named_npc_in_scene(hwnd, target_name)
    if not npc_anchor:
        raise RuntimeError(f"Failed to locate named NPC in scene: {target_name}")

    click_state = click_screen_point(hwnd, int(npc_anchor["screenX"]), int(npc_anchor["screenY"]), "left")
    INPUT_GUARD.guarded_sleep(450, title)

    option_click = click_named_point(hwnd, "vendor_purchase_option")
    INPUT_GUARD.guarded_sleep(500, title)

    purchase_state = detect_vendor_purchase_screen(hwnd)
    if not purchase_state["visible"]:
        raise RuntimeError(
            "Vendor purchase option did not open purchase screen."
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Reached vendor purchase screen for {target_name}",
        "input": {
            "mode": "open_named_vendor_purchase",
            "targetName": target_name,
            "optionText": option_text,
            "npcAnchor": npc_anchor,
            "npcClick": click_state,
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
    INPUT_GUARD.guarded_sleep(300, title)

    plus_clicks: list[dict[str, Any]] = []
    for _ in range(max(0, quantity - 1)):
        plus_click = click_named_point(hwnd, "vendor_purchase_plus")
        plus_clicks.append(plus_click)
        INPUT_GUARD.guarded_sleep(120, title)

    buy_click = click_named_point(hwnd, "vendor_purchase_buy")
    INPUT_GUARD.guarded_sleep(900, title)
    after_text = ocr_text(capture_window_region(hwnd, NPC_STAGE_ROIS["trade_panel"]))

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": f"Bought current vendor item with quantity {quantity}",
        "input": {
            "mode": "buy_current_vendor_item",
            "itemName": item_name,
            "quantity": quantity,
            "itemButton": item_button,
            "itemClick": item_click,
            "plusClicks": plus_clicks,
            "buyClick": buy_click,
            "beforeText": purchase_state["text"],
            "afterText": after_text,
        },
    }


def run_close_vendor_panel(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "close_vendor_panel")
    click_state = click_named_point(hwnd, "close_panel")
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 800), title)
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
    INPUT_GUARD.guarded_sleep(250, title)
    stock_click = click_named_point(hwnd, "hawking_stock_button")
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 700), title)

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Selected first hawking inventory item and clicked the stock button",
        "input": {
            "mode": "stock_first_hawking_item",
            "beforeText": hawking_state["text"],
            "inventoryClick": inventory_click,
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
    INPUT_GUARD.guarded_sleep(int(action.get("postDelayMs") or 800), title)

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


def ensure_npc_action_menu(hwnd: int, timeout_ms: int, move_pulse_ms: int, scan_interval_ms: int) -> dict[str, Any]:
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
    camera_drags = 0
    click_point_attempts: list[dict[str, float]] = []
    selectionAttempts: list[dict[str, Any]] = []
    viewAttempts: list[dict[str, Any]] = []
    stage_history: list[str] = []
    start_time = time.time()
    last_stage = "none"
    last_npc_click: dict[str, Any] | None = None

    focus_window(hwnd)

    while (time.time() - start_time) * 1000 < timeout_ms:
        INPUT_GUARD.check_or_raise("ensure_npc_action_menu")
        elapsed_ms = (time.time() - start_time) * 1000
        stage_state = detect_npc_interaction_stage(hwnd)
        last_stage = stage_state["stage"]
        stage_history.append(last_stage)
        target_info = detect_target_threshold(hwnd)

        if last_stage in ["npc_action_menu", "small_talk_menu", "chat_ready", "gift_screen", "trade_screen"]:
            return {
                "stage": last_stage,
                "stageTexts": stage_state["texts"],
                "stageHistory": stage_history,
                "clickAttempts": click_attempts,
                "moveAttempts": move_attempts,
                "cameraDrags": camera_drags,
                "clickPointAttempts": click_point_attempts,
                "selectionAttempts": selectionAttempts,
                "viewAttempts": viewAttempts,
                "targetText": target_info["text"],
            }

        if last_stage == "npc_selected" or has_selected_target(target_info):
            moving_view = None
            if last_npc_click and names_match(last_npc_click.get("targetName", ""), target_info["text"]):
                moving_view = find_view_button_near_click(
                    hwnd,
                    int(last_npc_click["screenX"]),
                    int(last_npc_click["screenY"]),
                )
            if moving_view:
                click_screen_point(hwnd, moving_view["screenX"], moving_view["screenY"], "left")
                viewAttempts.append(moving_view)
                INPUT_GUARD.guarded_sleep(80, "ensure_npc_action_menu")
                quick_menu_state = detect_bottom_right_menu_stage(hwnd)
                stage_history.append(quick_menu_state["stage"])
                if quick_menu_state["stage"] in ["npc_action_menu", "small_talk_menu"]:
                    return {
                        "stage": quick_menu_state["stage"],
                        "stageTexts": {
                            **stage_state["texts"],
                            "bottom_right_actions": quick_menu_state["text"],
                        },
                        "stageHistory": stage_history,
                        "clickAttempts": click_attempts + 1,
                        "moveAttempts": move_attempts,
                        "cameraDrags": camera_drags,
                        "clickPointAttempts": click_point_attempts,
                        "selectionAttempts": selectionAttempts,
                        "viewAttempts": viewAttempts,
                        "targetText": target_info["text"],
                    }
            click_attempts += 1
            INPUT_GUARD.guarded_sleep(120, "ensure_npc_action_menu")
            stage_state = detect_npc_interaction_stage(hwnd)
            last_stage = stage_state["stage"]
            stage_history.append(last_stage)
            if last_stage in ["npc_action_menu", "small_talk_menu", "chat_ready", "gift_screen", "trade_screen"]:
                return {
                    "stage": last_stage,
                    "stageTexts": stage_state["texts"],
                    "stageHistory": stage_history,
                    "clickAttempts": click_attempts,
                    "moveAttempts": move_attempts,
                    "cameraDrags": camera_drags,
                    "clickPointAttempts": click_point_attempts,
                    "selectionAttempts": selectionAttempts,
                    "viewAttempts": viewAttempts,
                    "targetText": target_info["text"],
                }
            continue

        x_ratio, y_ratio = click_points[click_attempts % len(click_points)]
        last_npc_click = click_npc_candidate(hwnd, x_ratio, y_ratio, "left")
        click_point_attempts.append({"xRatio": x_ratio, "yRatio": y_ratio})
        click_target = find_click_target_name(
            hwnd,
            int(last_npc_click["screenX"]),
            int(last_npc_click["screenY"]),
        )
        if click_target:
            selection_result = verify_npc_selection(hwnd, last_npc_click, click_target["text"])
            selection_result["targetProbe"] = click_target
            selectionAttempts.append(selection_result)
            if selection_result["selected"]:
                last_npc_click = {
                    **last_npc_click,
                    "targetName": selection_result["actualName"],
                }
            else:
                last_npc_click = None
        else:
            selectionAttempts.append(
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
        INPUT_GUARD.guarded_sleep(100, "ensure_npc_action_menu")

        if click_attempts % len(click_points) == 0:
            move_attempts += 1
            pulse_forward(hwnd, move_pulse_ms)
            INPUT_GUARD.guarded_sleep(80, "ensure_npc_action_menu")

        INPUT_GUARD.guarded_sleep(min(scan_interval_ms, 90), "ensure_npc_action_menu")

    raise RuntimeError(
        "Failed to open NPC action menu before timeout. "
        f"Last stage: {last_stage or 'none'}"
    )


def try_enter_chat(hwnd: int, timeout_ms: int, move_pulse_ms: int, scan_interval_ms: int) -> dict[str, Any]:
    current_stage = detect_npc_interaction_stage(hwnd)
    if current_stage["stage"] == "chat_ready":
        dialog_state = detect_dialog(hwnd)
        return {
            "success": True,
            "stage": "chat_ready",
            "dialogText": dialog_state["text"],
            "stageHistory": ["chat_ready"],
            "menuState": {
                "stage": "chat_ready",
                "stageTexts": current_stage["texts"],
                "clickAttempts": 0,
                "moveAttempts": 0,
                "cameraDrags": 0,
                "clickPointAttempts": [],
                "selectionAttempts": [],
                "viewAttempts": [],
                "targetText": "",
            },
        }

    menu_state = ensure_npc_action_menu(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history = list(menu_state["stageHistory"])

    if menu_state["stage"] == "chat_ready":
        dialog_state = detect_dialog(hwnd)
        return {
            "success": True,
            "stage": "chat_ready",
            "dialogText": dialog_state["text"],
            "stageHistory": stage_history,
            "menuState": menu_state,
        }

    if menu_state["stage"] == "small_talk_menu":
        click_named_point(hwnd, "small_talk")
        INPUT_GUARD.guarded_sleep(140, "try_enter_chat")
    else:
        click_named_point(hwnd, "talk")
        INPUT_GUARD.guarded_sleep(120, "try_enter_chat")
        click_named_point(hwnd, "small_talk")
        INPUT_GUARD.guarded_sleep(140, "try_enter_chat")

    post_talk_state = detect_npc_interaction_stage(hwnd)
    stage_history.append(post_talk_state["stage"])

    if post_talk_state["stage"] == "small_talk_confirm":
        click_named_point(hwnd, "confirm_small_talk")
        INPUT_GUARD.guarded_sleep(250, "try_enter_chat")
        post_talk_state = detect_npc_interaction_stage(hwnd)
        stage_history.append(post_talk_state["stage"])

    if post_talk_state["stage"] == "chat_ready":
        # After confirming small talk, do not immediately click the chat input.
        # The NPC may still need time to walk into position and fully open the
        # chat screen. Only use the fixed chat_input point once chat_ready is
        # actually reached.
        dialog_state = detect_dialog(hwnd)
        return {
            "success": True,
            "stage": "chat_ready",
            "dialogText": dialog_state["text"],
            "stageHistory": stage_history,
            "menuState": menu_state,
        }

    return {
        "success": False,
        "stage": post_talk_state["stage"],
        "dialogText": "",
        "stageHistory": stage_history,
        "menuState": menu_state,
    }


def run_click_npc_interact(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_npc_interact")
    timeout_ms = int(action.get("timeoutMs") or DEFAULT_INTERACT_TIMEOUT_MS)
    move_pulse_ms = int(action.get("movePulseMs") or DEFAULT_MOVE_PULSE_MS)
    scan_interval_ms = int(action.get("scanIntervalMs") or DEFAULT_SCAN_INTERVAL_MS)

    result = try_enter_chat(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    if not result["success"]:
        raise RuntimeError(
            "Local click NPC interaction loop timed out before the chat screen was reached. "
            f"Last stage: {result['stage'] or 'none'}"
        )

    return {
        "id": action_id,
        "title": title,
        "status": "performed",
        "detail": "Reached road NPC chat screen.",
        "input": {
            "mode": "click_npc_interact",
            "stage": "chat_ready",
            "dialogText": result["dialogText"],
            "stageHistory": result["stageHistory"],
            "clickAttempts": result["menuState"]["clickAttempts"],
            "moveAttempts": result["menuState"]["moveAttempts"],
            "cameraDrags": result["menuState"]["cameraDrags"],
            "clickPointAttempts": result["menuState"]["clickPointAttempts"],
        },
    }


def run_town_npc_social_loop(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "town_npc_social_loop")
    timeout_ms = int(action.get("timeoutMs") or DEFAULT_INTERACT_TIMEOUT_MS)
    move_pulse_ms = int(action.get("movePulseMs") or DEFAULT_MOVE_PULSE_MS)
    scan_interval_ms = int(action.get("scanIntervalMs") or DEFAULT_SCAN_INTERVAL_MS)

    threshold_info = detect_target_threshold(hwnd)
    stage_history: list[str] = []
    trade_attempted = False
    trade_completed = False
    gift_attempts = 0
    gift_completed = False
    favor_before = None
    favor_after = None

    chat_attempt = try_enter_chat(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history.extend(chat_attempt["stageHistory"])
    if chat_attempt["success"]:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Reached road NPC chat screen without trade or gift.",
            "input": {
                "mode": "town_npc_social_loop",
                "stage": "chat_ready",
                "dialogText": chat_attempt["dialogText"],
                "stageHistory": stage_history,
                "tradeAttempted": trade_attempted,
                "tradeCompleted": trade_completed,
                "giftAttempts": gift_attempts,
                "giftCompleted": gift_completed,
                "favorBefore": favor_before,
                "favorAfter": favor_after,
                "targetThreshold": threshold_info["threshold"],
                "isSpecialNpc": threshold_info["isSpecialNpc"],
                "targetText": threshold_info["text"],
            },
        }

    menu_state = ensure_npc_action_menu(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history.extend(menu_state["stageHistory"])
    click_named_point(hwnd, "gift")
    INPUT_GUARD.guarded_sleep(350, "town_npc_social_loop")
    gift_state = detect_npc_interaction_stage(hwnd)
    stage_history.append(gift_state["stage"])

    if gift_state["stage"] == "gift_screen":
        favor_before = parse_favor_value(gift_state["texts"]["gift_panel"])
        favor_after = favor_before
        if favor_before is not None and favor_before >= threshold_info["threshold"]:
            exit_panel(hwnd)
            retry_chat = try_enter_chat(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
            stage_history.extend(retry_chat["stageHistory"])
            if retry_chat["success"]:
                return {
                    "id": action_id,
                    "title": title,
                    "status": "performed",
                    "detail": "Reached chat screen after reading favor threshold.",
                    "input": {
                        "mode": "town_npc_social_loop",
                        "stage": "chat_ready",
                        "dialogText": retry_chat["dialogText"],
                        "stageHistory": stage_history,
                        "tradeAttempted": trade_attempted,
                        "tradeCompleted": trade_completed,
                        "giftAttempts": gift_attempts,
                        "giftCompleted": gift_completed,
                        "favorBefore": favor_before,
                        "favorAfter": favor_after,
                        "targetThreshold": threshold_info["threshold"],
                        "isSpecialNpc": threshold_info["isSpecialNpc"],
                        "targetText": threshold_info["text"],
                    },
                }
        exit_panel(hwnd)

    menu_state = ensure_npc_action_menu(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history.extend(menu_state["stageHistory"])
    click_named_point(hwnd, "trade")
    trade_attempted = True
    INPUT_GUARD.guarded_sleep(350, "town_npc_social_loop")
    trade_state = detect_npc_interaction_stage(hwnd)
    stage_history.append(trade_state["stage"])

    if trade_state["stage"] == "trade_screen":
        click_named_point(hwnd, "trade_left_slot")
        INPUT_GUARD.guarded_sleep(200, "town_npc_social_loop")
        click_named_point(hwnd, "trade_left_up_shelf")
        INPUT_GUARD.guarded_sleep(250, "town_npc_social_loop")
        click_named_point(hwnd, "trade_right_slot")
        INPUT_GUARD.guarded_sleep(200, "town_npc_social_loop")
        click_named_point(hwnd, "trade_right_currency_slot")
        INPUT_GUARD.guarded_sleep(150, "town_npc_social_loop")
        click_named_point(hwnd, "trade_right_up_shelf")
        INPUT_GUARD.guarded_sleep(250, "town_npc_social_loop")
        click_named_point(hwnd, "trade_submit")
        INPUT_GUARD.guarded_sleep(350, "town_npc_social_loop")
        trade_completed = True
        exit_panel(hwnd)

    menu_state = ensure_npc_action_menu(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history.extend(menu_state["stageHistory"])
    click_named_point(hwnd, "gift")
    INPUT_GUARD.guarded_sleep(350, "town_npc_social_loop")

    for _ in range(3):
        gift_state = detect_npc_interaction_stage(hwnd)
        stage_history.append(gift_state["stage"])

        if gift_state["stage"] != "gift_screen":
            break

        current_favor = parse_favor_value(gift_state["texts"]["gift_panel"])
        if favor_before is None:
            favor_before = current_favor
        favor_after = current_favor

        if current_favor is not None and current_favor >= threshold_info["threshold"]:
            break

        click_named_point(hwnd, "gift_first_slot")
        INPUT_GUARD.guarded_sleep(150, "town_npc_social_loop")
        click_named_point(hwnd, "gift_submit")
        gift_attempts += 1
        gift_completed = True
        INPUT_GUARD.guarded_sleep(450, "town_npc_social_loop")

        updated_gift_state = detect_npc_interaction_stage(hwnd)
        stage_history.append(updated_gift_state["stage"])
        favor_after = parse_favor_value(updated_gift_state["texts"]["gift_panel"])
        if favor_after is not None and favor_after >= threshold_info["threshold"]:
            break

    if detect_npc_interaction_stage(hwnd)["stage"] == "gift_screen":
        exit_panel(hwnd)

    retry_chat = try_enter_chat(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history.extend(retry_chat["stageHistory"])
    if retry_chat["success"]:
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": "Reached road NPC chat screen after trade and gift flow.",
            "input": {
                "mode": "town_npc_social_loop",
                "stage": "chat_ready",
                "dialogText": retry_chat["dialogText"],
                "stageHistory": stage_history,
                "tradeAttempted": trade_attempted,
                "tradeCompleted": trade_completed,
                "giftAttempts": gift_attempts,
                "giftCompleted": gift_completed,
                "favorBefore": favor_before,
                "favorAfter": favor_after,
                "targetThreshold": threshold_info["threshold"],
                "isSpecialNpc": threshold_info["isSpecialNpc"],
                "targetText": threshold_info["text"],
            },
        }

    raise RuntimeError(
        "Town NPC social loop did not reach the chat screen after trade and gift attempts. "
        f"Last stage: {retry_chat['stage'] or 'none'}"
    )


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

    if action_type == "click_npc_interact":
        return run_click_npc_interact(hwnd, action)

    if action_type == "town_npc_social_loop":
        return run_town_npc_social_loop(hwnd, action)

    if action_type == "map_route_to_coordinate":
        return run_map_route_to_coordinate(hwnd, action)

    if action_type == "open_named_npc_trade":
        return run_open_named_npc_trade(hwnd, action)

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


if __name__ == "__main__":
    main()
