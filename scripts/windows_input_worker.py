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
}

ACTION_POINTS = {
    "view": (0.32, 0.57),
    "talk": (0.74, 0.89),
    "small_talk": (0.69, 0.77),
    "confirm_small_talk": (0.59, 0.80),
    "trade": (0.84, 0.89),
    "gift": (0.95, 0.89),
    "close_panel": (0.98, 0.05),
    "trade_left_slot": (0.27, 0.33),
    "trade_left_up_shelf": (0.38, 0.82),
    "trade_right_slot": (0.82, 0.20),
    "trade_right_currency_slot": (0.69, 0.57),
    "trade_right_up_shelf": (0.82, 0.82),
    "trade_submit": (0.53, 0.92),
    "gift_first_slot": (0.78, 0.46),
    "gift_plus": (0.82, 0.92),
    "gift_submit": (0.91, 0.92),
    "chat_input": (0.18, 0.94),
}

CHAT_KEYWORDS = ["点击输入聊天", "发送", "第一次见面", "好感度"]
GIFT_KEYWORDS = ["赠礼", "选择礼物", "赠送", "好感度"]
TRADE_KEYWORDS = ["交易结果预览", "交易倒计时", "上架", "我的", "总价"]
CONFIRM_KEYWORDS = ["确认", "闲聊", "取消"]


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
    return {
        "button": button,
        "screenX": screen_x,
        "screenY": screen_y,
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
    time.sleep(move_pulse_ms / 1000)
    pydirectinput.keyUp("w")
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
        time.sleep(0.04)

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


def exit_panel(hwnd: int) -> None:
    click_named_point(hwnd, "close_panel")
    time.sleep(0.25)


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
                time.sleep(0.08)
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
            time.sleep(0.12)
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
        time.sleep(0.1)

        if click_attempts % len(click_points) == 0:
            move_attempts += 1
            pulse_forward(hwnd, move_pulse_ms)
            time.sleep(0.08)

        time.sleep(min(scan_interval_ms, 90) / 1000)

    raise RuntimeError(
        "Failed to open NPC action menu before timeout. "
        f"Last stage: {last_stage or 'none'}"
    )


def try_enter_chat(hwnd: int, timeout_ms: int, move_pulse_ms: int, scan_interval_ms: int) -> dict[str, Any]:
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
        time.sleep(0.14)
    else:
        click_named_point(hwnd, "talk")
        time.sleep(0.12)
        click_named_point(hwnd, "small_talk")
        time.sleep(0.14)

    post_talk_state = detect_npc_interaction_stage(hwnd)
    stage_history.append(post_talk_state["stage"])

    if post_talk_state["stage"] == "small_talk_confirm":
        click_named_point(hwnd, "confirm_small_talk")
        time.sleep(0.25)
        post_talk_state = detect_npc_interaction_stage(hwnd)
        stage_history.append(post_talk_state["stage"])

    if post_talk_state["stage"] == "chat_ready":
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
    time.sleep(0.35)
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
    time.sleep(0.35)
    trade_state = detect_npc_interaction_stage(hwnd)
    stage_history.append(trade_state["stage"])

    if trade_state["stage"] == "trade_screen":
        click_named_point(hwnd, "trade_left_slot")
        time.sleep(0.20)
        click_named_point(hwnd, "trade_left_up_shelf")
        time.sleep(0.25)
        click_named_point(hwnd, "trade_right_slot")
        time.sleep(0.20)
        click_named_point(hwnd, "trade_right_currency_slot")
        time.sleep(0.15)
        click_named_point(hwnd, "trade_right_up_shelf")
        time.sleep(0.25)
        click_named_point(hwnd, "trade_submit")
        time.sleep(0.35)
        trade_completed = True
        exit_panel(hwnd)

    menu_state = ensure_npc_action_menu(hwnd, timeout_ms, move_pulse_ms, scan_interval_ms)
    stage_history.extend(menu_state["stageHistory"])
    click_named_point(hwnd, "gift")
    time.sleep(0.35)

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
        time.sleep(0.15)
        click_named_point(hwnd, "gift_submit")
        gift_attempts += 1
        gift_completed = True
        time.sleep(0.45)

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
            time.sleep(0.08)

        pyperclip.copy(text)
        pydirectinput.keyDown("ctrl")
        pydirectinput.press("v")
        pydirectinput.keyUp("ctrl")

        if bool(action.get("pressEnter", False)):
            time.sleep(0.08)
            pydirectinput.press("enter")

        time.sleep(post_delay_ms / 1000)
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

    if action_type == "press_key":
        key = str(action.get("key") or "").strip().lower()
        if not key:
            raise RuntimeError("press_key action requires key")
        focus_window(hwnd)
        pydirectinput.press(key)
        time.sleep(post_delay_ms / 1000)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"Sent key {key}",
            "input": {"key": key},
        }

    if action_type == "click_relative":
        x_ratio = float(action.get("xRatio"))
        y_ratio = float(action.get("yRatio"))
        button = str(action.get("button") or "left").strip().lower()
        bounds = focus_window(hwnd)
        click_x = round(bounds["left"] + bounds["width"] * x_ratio)
        click_y = round(bounds["top"] + bounds["height"] * y_ratio)
        pydirectinput.click(x=click_x, y=click_y, button=button)
        time.sleep(post_delay_ms / 1000)
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
        time.sleep(duration_ms / 1000)
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
