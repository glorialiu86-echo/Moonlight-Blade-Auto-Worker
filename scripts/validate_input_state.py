import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import win32api
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import windows_input_worker as input_worker


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = PROJECT_ROOT / "tmp"
DATA_DIR = PROJECT_ROOT / "data"
ITERATIONS = 20
WAIT_AFTER_CLICK_MS = 300
GAME_WINDOW_TITLE = "\u5929\u6daf\u660e\u6708\u5200\u624b\u6e38"
TARGET_NAME = "\u535c\u7389\u4eba"
TARGET_TEMPLATE_PATH = DATA_DIR / "buyuren-name-template.png"
TARGET_BODY_X_PROBE_RATIOS = [0.0, -0.18, 0.18, -0.36, 0.36]
TARGET_BODY_Y_PROBE_RATIOS = [2.4, 3.0, 3.6, 4.2, 4.8]
TARGET_TEMPLATE_THRESHOLD = 0.30

SELECTED_PANEL_ROI = (0.20, 0.10, 0.42, 0.26)
SELECTED_NAME_ROI = (0.26, 0.12, 0.36, 0.20)
SELECTED_HP_ROI = (0.26, 0.19, 0.39, 0.23)
CROSS_TEMPLATE_ROI = (0.35, 0.11, 0.39, 0.18)
CROSS_SEARCH_ROI = (0.31, 0.08, 0.42, 0.22)


def normalize_name(text: str) -> str:
    normalized = re.sub(r"\s+", "", str(text or ""))
    normalized = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9<>]", "", normalized)
    return normalized


def save_debug_image(image: np.ndarray, name: str) -> str:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    output_path = TMP_DIR / name
    rgb = image[:, :, ::-1]
    Image.fromarray(rgb.astype(np.uint8), mode="RGB").save(output_path)
    return str(output_path)


def crop_roi(image: np.ndarray, roi: tuple[float, float, float, float]) -> np.ndarray:
    height, width = image.shape[:2]
    left = max(0, min(width, int(width * roi[0])))
    top = max(0, min(height, int(height * roi[1])))
    right = max(left + 1, min(width, int(width * roi[2])))
    bottom = max(top + 1, min(height, int(height * roi[3])))
    return image[top:bottom, left:right].copy()


def crop_rect(image: np.ndarray, left: int, top: int, right: int, bottom: int) -> np.ndarray:
    height, width = image.shape[:2]
    bounded_left = max(0, min(width, int(left)))
    bounded_top = max(0, min(height, int(top)))
    bounded_right = max(bounded_left + 1, min(width, int(right)))
    bounded_bottom = max(bounded_top + 1, min(height, int(bottom)))
    return image[bounded_top:bounded_bottom, bounded_left:bounded_right].copy()


def roi_to_screen_point(hwnd: int, roi: tuple[float, float, float, float], local_x: int, local_y: int) -> tuple[int, int]:
    bounds = input_worker.get_window_bounds(hwnd)
    roi_left = bounds["left"] + int(bounds["width"] * roi[0])
    roi_top = bounds["top"] + int(bounds["height"] * roi[1])
    return roi_left + int(local_x), roi_top + int(local_y)


def capture_full_client(hwnd: int) -> np.ndarray:
    return input_worker.capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))


def extract_best_name(image: np.ndarray) -> str:
    candidates = []
    for item in input_worker.ocr_items(image):
        text = normalize_name(item["text"])
        if not re.fullmatch(r"[\u4e00-\u9fff]{2,4}", text):
            continue
        candidates.append((float(item["score"]), text))

    if not candidates:
        return ""

    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def detect_avatar_block(panel_image: np.ndarray) -> bool:
    height, width = panel_image.shape[:2]
    avatar = panel_image[0:max(8, int(height * 0.85)), 0:max(8, int(width * 0.28))]
    gray = cv2.cvtColor(avatar, cv2.COLOR_BGR2GRAY)
    edge_ratio = float(np.count_nonzero(cv2.Canny(gray, 60, 140))) / float(gray.size)
    return edge_ratio >= 0.03


def detect_cross_symbol(cross_image: np.ndarray) -> bool:
    gray = cv2.cvtColor(cross_image, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 150, 255, cv2.THRESH_BINARY)
    lines = cv2.HoughLinesP(binary, 1, np.pi / 180, threshold=12, minLineLength=8, maxLineGap=3)
    if lines is None:
        return False

    positive = 0
    negative = 0
    for line in lines[:, 0]:
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
    return positive >= 1 and negative >= 1


def detect_world_hp_bar(full_image: np.ndarray, fixed_target: dict | None) -> bool:
    if fixed_target is None:
        return False

    target = fixed_target["target"]
    bbox_x = int(target["bboxX"])
    bbox_y = int(target["bboxY"])
    bbox_width = int(target["bboxWidth"])
    bbox_height = int(target["bboxHeight"])
    roi = crop_rect(
        full_image,
        bbox_x - round(bbox_width * 1.4),
        bbox_y - round(bbox_height * 2.2),
        bbox_x + round(bbox_width * 2.4),
        bbox_y + round(bbox_height * 0.8),
    )

    blue_mask = (
        (roi[:, :, 0] >= 150)
        & (roi[:, :, 1] >= 145)
        & (roi[:, :, 2] <= 150)
    ).astype(np.uint8) * 255
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
    contours, _hierarchy = cv2.findContours(blue_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_width = max(24, round(bbox_width * 0.45))
    max_height = max(12, round(bbox_height * 0.5))

    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        if width < min_width:
            continue
        if height < 3 or height > max_height:
            continue
        if (width / max(height, 1)) < 3.0:
            continue
        return True

    return False


def detect_selected_state(full_image: np.ndarray, fixed_target: dict | None = None) -> dict:
    panel_image = crop_roi(full_image, SELECTED_PANEL_ROI)
    name_image = crop_roi(full_image, SELECTED_NAME_ROI)
    cross_image = crop_roi(full_image, CROSS_TEMPLATE_ROI)

    name_text = extract_best_name(name_image)
    has_avatar = detect_avatar_block(panel_image)
    has_cross = detect_cross_symbol(cross_image)
    has_world_hp_bar = detect_world_hp_bar(full_image, fixed_target)
    selected = (has_cross and (has_avatar or bool(name_text))) or has_world_hp_bar
    return {
        "selected": selected,
        "name": name_text,
        "hasAvatar": has_avatar,
        "hasCross": has_cross,
        "hasWorldHpBar": has_world_hp_bar,
    }


def build_cross_template(full_image: np.ndarray) -> np.ndarray:
    return crop_roi(full_image, CROSS_TEMPLATE_ROI)


def match_cross(hwnd: int, full_image: np.ndarray, template: np.ndarray) -> dict | None:
    search_image = crop_roi(full_image, CROSS_SEARCH_ROI)
    result = cv2.matchTemplate(search_image, template, cv2.TM_CCOEFF_NORMED)
    _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(result)
    if float(max_val) < 0.72:
        return None

    template_height, template_width = template.shape[:2]
    local_center_x = max_loc[0] + template_width // 2
    local_center_y = max_loc[1] + template_height // 2
    screen_x, screen_y = roi_to_screen_point(hwnd, CROSS_SEARCH_ROI, local_center_x, local_center_y)
    return {
        "screenX": int(screen_x),
        "screenY": int(screen_y),
        "score": round(float(max_val), 4),
    }


def load_target_template() -> np.ndarray:
    if not TARGET_TEMPLATE_PATH.exists():
        raise RuntimeError(f"TARGET_TEMPLATE_NOT_FOUND: {TARGET_TEMPLATE_PATH}")
    encoded = np.fromfile(str(TARGET_TEMPLATE_PATH), dtype=np.uint8)
    template = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if template is None:
        raise RuntimeError(f"TARGET_TEMPLATE_DECODE_FAILED: {TARGET_TEMPLATE_PATH}")
    return template


def find_target_by_template(hwnd: int, full_image: np.ndarray, template: np.ndarray) -> dict | None:
    bounds = input_worker.get_window_bounds(hwnd)
    result = cv2.matchTemplate(full_image, template, cv2.TM_CCOEFF_NORMED)
    _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(result)
    if float(max_val) < TARGET_TEMPLATE_THRESHOLD:
        return None

    template_height, template_width = template.shape[:2]
    bbox_x = int(max_loc[0])
    bbox_y = int(max_loc[1])
    bbox_width = int(template_width)
    bbox_height = int(template_height)
    center_x = bbox_x + bbox_width // 2
    return {
        "name": TARGET_NAME,
        "centerX": int(center_x),
        "nameBottomY": int(bbox_y + bbox_height),
        "bboxX": int(bbox_x),
        "bboxY": int(bbox_y),
        "bboxWidth": int(bbox_width),
        "bboxHeight": int(bbox_height),
        "score": round(float(max_val), 4),
    }


def lock_fixed_world_target(hwnd: int) -> dict | None:
    full_image = capture_full_client(hwnd)
    template = load_target_template()
    target = find_target_by_template(hwnd, full_image, template)
    if target is None:
        return None
    return {
        "targetName": target["name"],
        "target": target,
    }


def build_click_target(hwnd: int, fixed_target: dict, probe_ratio_x: float, probe_ratio_y: float) -> dict:
    bounds = input_worker.get_window_bounds(hwnd)
    target = fixed_target["target"]
    probe_offset_x = round(target["bboxWidth"] * probe_ratio_x)
    probe_offset_y = round(target["bboxHeight"] * probe_ratio_y)
    client_x = max(0, min(bounds["width"] - 1, target["centerX"] + probe_offset_x))
    client_y = max(0, min(bounds["height"] - 1, target["nameBottomY"] + probe_offset_y))
    return {
        **target,
        "clientX": int(client_x),
        "clientY": int(client_y),
        "screenX": int(bounds["left"] + client_x),
        "screenY": int(bounds["top"] + client_y),
        "probeRatioX": float(probe_ratio_x),
        "probeRatioY": float(probe_ratio_y),
        "probeOffsetX": int(probe_offset_x),
        "probeOffsetY": int(probe_offset_y),
    }


def click_target(hwnd: int, click_target: dict, target_name: str) -> dict:
    bounds = input_worker.get_window_bounds(hwnd)
    mouse_before_x, mouse_before_y = win32api.GetCursorPos()
    click_state = input_worker.click_screen_point(hwnd, click_target["screenX"], click_target["screenY"], "left")
    mouse_after_x, mouse_after_y = win32api.GetCursorPos()
    return {
        "clicked": True,
        "targetName": target_name,
        "target": click_target,
        "click": click_state,
        "debug": {
            "bounds": {
                "left": int(bounds["left"]),
                "top": int(bounds["top"]),
                "width": int(bounds["width"]),
                "height": int(bounds["height"]),
            },
            "targetBbox": {
                "x": int(click_target["bboxX"]),
                "y": int(click_target["bboxY"]),
                "width": int(click_target["bboxWidth"]),
                "height": int(click_target["bboxHeight"]),
            },
            "clickAbsolute": {
                "x": int(click_target["screenX"]),
                "y": int(click_target["screenY"]),
            },
            "mouseBefore": {
                "x": int(mouse_before_x),
                "y": int(mouse_before_y),
            },
            "mouseAfter": {
                "x": int(mouse_after_x),
                "y": int(mouse_after_y),
            },
        },
    }


def try_close_current_selection(hwnd: int, fixed_target: dict | None = None) -> None:
    image = capture_full_client(hwnd)
    state = detect_selected_state(image, fixed_target)
    if not state["selected"]:
        return
    template = build_cross_template(image)
    cross_match = match_cross(hwnd, image, template)
    if cross_match is None:
        return
    input_worker.click_screen_point(hwnd, cross_match["screenX"], cross_match["screenY"], "left")
    time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)


def calibrate_body_probe(hwnd: int, fixed_target: dict) -> dict:
    calibration_results = []
    for probe_ratio_y in TARGET_BODY_Y_PROBE_RATIOS:
        for probe_ratio_x in TARGET_BODY_X_PROBE_RATIOS:
            try_close_current_selection(hwnd, fixed_target)
            click_target_state = build_click_target(hwnd, fixed_target, probe_ratio_x, probe_ratio_y)
            click_result = click_target(hwnd, click_target_state, fixed_target["targetName"])
            time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
            image = capture_full_client(hwnd)
            selected_state = detect_selected_state(image, fixed_target)
            result = {
                "probeRatioX": probe_ratio_x,
                "probeRatioY": probe_ratio_y,
                "probeOffsetX": click_target_state["probeOffsetX"],
                "probeOffsetY": click_target_state["probeOffsetY"],
                "selected": bool(selected_state["selected"]),
                "ocrName": selected_state["name"],
                "hasWorldHpBar": selected_state["hasWorldHpBar"],
                "clickClientX": click_target_state["clientX"],
                "clickClientY": click_target_state["clientY"],
            }
            calibration_results.append(result)
            print(json.dumps({"phase": "calibration", **result}, ensure_ascii=False))
            if selected_state["selected"]:
                try_close_current_selection(hwnd, fixed_target)
                return {
                    "probeRatioX": probe_ratio_x,
                    "probeRatioY": probe_ratio_y,
                    "probeOffsetX": click_target_state["probeOffsetX"],
                    "probeOffsetY": click_target_state["probeOffsetY"],
                    "results": calibration_results,
                }
    return {
        "probeRatioX": None,
        "probeRatioY": None,
        "probeOffsetX": None,
        "probeOffsetY": None,
        "results": calibration_results,
    }


def run_phase_one(hwnd: int, fixed_target: dict, probe_ratio_x: float, probe_ratio_y: float) -> dict:
    phase_results = []
    success_count = 0

    for index in range(1, ITERATIONS + 1):
        click_target_state = build_click_target(hwnd, fixed_target, probe_ratio_x, probe_ratio_y)
        click_result = click_target(hwnd, click_target_state, fixed_target["targetName"])
        time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
        full_image = capture_full_client(hwnd)
        selected_state = detect_selected_state(full_image, fixed_target)
        screenshot_path = save_debug_image(full_image, f"phase1-{index:02d}.png")

        success = bool(selected_state["selected"])
        if success:
            success_count += 1

        row = {
            "phase": 1,
            "iteration": index,
            "clicked": click_result["clicked"],
            "detectedSelected": success,
            "ocrName": selected_state["name"],
            "hasAvatar": selected_state["hasAvatar"],
            "hasCross": selected_state["hasCross"],
            "hasWorldHpBar": selected_state["hasWorldHpBar"],
            "targetName": click_result["targetName"],
            "probeRatioX": probe_ratio_x,
            "probeRatioY": probe_ratio_y,
            "probeOffsetX": click_target_state["probeOffsetX"],
            "probeOffsetY": click_target_state["probeOffsetY"],
            "targetClientX": click_result["target"]["clientX"],
            "targetClientY": click_result["target"]["clientY"],
            "clientBounds": click_result["debug"]["bounds"],
            "targetBbox": click_result["debug"]["targetBbox"],
            "clickAbsolute": click_result["debug"]["clickAbsolute"],
            "mouseBefore": click_result["debug"]["mouseBefore"],
            "mouseAfter": click_result["debug"]["mouseAfter"],
            "screenshot": screenshot_path,
        }
        phase_results.append(row)
        print(json.dumps(row, ensure_ascii=False))

    return {
        "successCount": success_count,
        "passed": success_count >= 18,
        "results": phase_results,
    }


def run_phase_two(hwnd: int, fixed_target: dict, probe_ratio_x: float, probe_ratio_y: float) -> dict:
    template = None
    phase_results = []
    success_count = 0

    for index in range(1, ITERATIONS + 1):
        click_target_state = build_click_target(hwnd, fixed_target, probe_ratio_x, probe_ratio_y)
        click_result = click_target(hwnd, click_target_state, fixed_target["targetName"])
        time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
        selected_image = capture_full_client(hwnd)
        selected_state = detect_selected_state(selected_image, fixed_target)
        if not selected_state["selected"]:
            row = {
                "phase": 2,
                "iteration": index,
                "status": "FAIL",
                "reason": "SELECT_NOT_REACHED",
                "ocrName": selected_state["name"],
                "hasWorldHpBar": selected_state["hasWorldHpBar"],
                "targetName": click_result["targetName"],
                "probeRatioX": probe_ratio_x,
                "probeRatioY": probe_ratio_y,
                "probeOffsetX": click_target_state["probeOffsetX"],
                "probeOffsetY": click_target_state["probeOffsetY"],
                "targetClientX": click_result["target"]["clientX"],
                "targetClientY": click_result["target"]["clientY"],
            }
            phase_results.append(row)
            print(json.dumps(row, ensure_ascii=False))
            continue

        if template is None:
            template = build_cross_template(selected_image)

        cross_match = match_cross(hwnd, selected_image, template)
        if cross_match is None:
            row = {
                "phase": 2,
                "iteration": index,
                "status": "FAIL",
                "reason": "CROSS_NOT_FOUND",
                "ocrName": selected_state["name"],
                "hasWorldHpBar": selected_state["hasWorldHpBar"],
                "targetName": click_result["targetName"],
                "probeRatioX": probe_ratio_x,
                "probeRatioY": probe_ratio_y,
                "probeOffsetX": click_target_state["probeOffsetX"],
                "probeOffsetY": click_target_state["probeOffsetY"],
                "targetClientX": click_result["target"]["clientX"],
                "targetClientY": click_result["target"]["clientY"],
            }
            phase_results.append(row)
            print(json.dumps(row, ensure_ascii=False))
            continue

        input_worker.click_screen_point(hwnd, cross_match["screenX"], cross_match["screenY"], "left")
        time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
        after_image = capture_full_client(hwnd)
        after_state = detect_selected_state(after_image, fixed_target)
        screenshot_path = save_debug_image(after_image, f"phase2-{index:02d}.png")

        success = not after_state["selected"]
        if success:
            success_count += 1

        row = {
            "phase": 2,
            "iteration": index,
            "status": "SUCCESS" if success else "FAIL",
            "ocrName": after_state["name"],
            "detectedSelectedAfterClose": after_state["selected"],
            "hasWorldHpBarAfterClose": after_state["hasWorldHpBar"],
            "crossScore": cross_match["score"],
            "targetName": click_result["targetName"],
            "probeRatioX": probe_ratio_x,
            "probeRatioY": probe_ratio_y,
            "probeOffsetX": click_target_state["probeOffsetX"],
            "probeOffsetY": click_target_state["probeOffsetY"],
            "targetClientX": click_result["target"]["clientX"],
            "targetClientY": click_result["target"]["clientY"],
            "screenshot": screenshot_path,
        }
        phase_results.append(row)
        print(json.dumps(row, ensure_ascii=False))

    return {
        "successCount": success_count,
        "passed": success_count >= 18,
        "results": phase_results,
    }


def main() -> int:
    hwnd = input_worker.find_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        raise RuntimeError("GAME_WINDOW_NOT_FOUND")

    input_worker.focus_window(hwnd)
    fixed_target = lock_fixed_world_target(hwnd)
    if fixed_target is None:
        raise RuntimeError("TARGET_TEMPLATE_MATCH_NOT_FOUND")

    calibration = calibrate_body_probe(hwnd, fixed_target)
    print(
        json.dumps(
            {
                "phase": "setup",
                "logic": "template_match_weishange_then_probe_under_name",
                "targetName": TARGET_NAME,
                "selectedStateOwner": "single_fullscreen_frame",
                "closeOwner": "template_match_cross_only",
                "fixedTargetCenterX": fixed_target["target"]["centerX"],
                "fixedTargetNameBottomY": fixed_target["target"]["nameBottomY"],
                "fixedTargetBbox": {
                    "x": fixed_target["target"]["bboxX"],
                    "y": fixed_target["target"]["bboxY"],
                    "width": fixed_target["target"]["bboxWidth"],
                    "height": fixed_target["target"]["bboxHeight"],
                },
                "targetMatchScore": fixed_target["target"]["score"],
                "selectedProbeRatioX": calibration["probeRatioX"],
                "selectedProbeRatioY": calibration["probeRatioY"],
                "selectedProbeOffsetX": calibration["probeOffsetX"],
                "selectedProbeOffsetY": calibration["probeOffsetY"],
            },
            ensure_ascii=False,
        )
    )

    if calibration["probeOffsetX"] is None:
        print(json.dumps({"phase": "calibration_summary", **calibration}, ensure_ascii=False))
        return 2

    print(json.dumps({"phase": "calibration_summary", **calibration}, ensure_ascii=False))
    phase_one = run_phase_one(hwnd, fixed_target, calibration["probeRatioX"], calibration["probeRatioY"])
    print(json.dumps({"phase": "phase1_summary", **phase_one}, ensure_ascii=False))

    if not phase_one["passed"]:
        return 2

    phase_two = run_phase_two(hwnd, fixed_target, calibration["probeRatioX"], calibration["probeRatioY"])
    print(json.dumps({"phase": "phase2_summary", **phase_two}, ensure_ascii=False))
    return 0 if phase_two["passed"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
