import json
import re
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import windows_input_worker as input_worker


TMP_DIR = Path(__file__).resolve().parents[1] / "tmp"
ITERATIONS = 20
WAIT_AFTER_CLICK_MS = 300
GAME_WINDOW_TITLE = "天涯明月刀手游"

SELECTED_PANEL_ROI = (0.17, 0.16, 0.43, 0.32)
SELECTED_NAME_ROI = (0.20, 0.18, 0.42, 0.36)
SELECTED_HP_ROI = (0.27, 0.235, 0.40, 0.285)
CROSS_TEMPLATE_ROI = (0.295, 0.195, 0.34, 0.275)
CROSS_SEARCH_ROI = (0.23, 0.16, 0.38, 0.30)
WORLD_NAME_SEARCH_ROI = (0.36, 0.14, 0.88, 0.72)
SELECT_CLICK_Y_OFFSET_RATIO = 0.055
WORLD_TARGET_BLOCKLIST = {
    "籽小刀",
    "查看",
    "生机",
    "体力",
    "功力",
    "任务",
    "菜单",
    "背包",
    "感知",
    "潜行",
}


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


def detect_hp_bar(image: np.ndarray) -> bool:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([15, 60, 120]), np.array([45, 255, 255]))
    ratio = float(np.count_nonzero(mask)) / float(mask.size)
    return ratio >= 0.10


def detect_avatar_block(panel_image: np.ndarray) -> bool:
    height, width = panel_image.shape[:2]
    avatar = panel_image[0:max(8, int(height * 0.62)), 0:max(8, int(width * 0.28))]
    gray = cv2.cvtColor(avatar, cv2.COLOR_BGR2GRAY)
    edge_ratio = float(np.count_nonzero(cv2.Canny(gray, 60, 140))) / float(gray.size)
    return edge_ratio >= 0.045


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


def detect_selected_state(full_image: np.ndarray) -> dict:
    panel_image = crop_roi(full_image, SELECTED_PANEL_ROI)
    name_image = crop_roi(full_image, SELECTED_NAME_ROI)
    hp_image = crop_roi(full_image, SELECTED_HP_ROI)
    cross_image = crop_roi(full_image, CROSS_TEMPLATE_ROI)

    name_text = extract_best_name(name_image)
    has_hp_bar = detect_hp_bar(hp_image)
    has_avatar = detect_avatar_block(panel_image)
    has_cross = detect_cross_symbol(cross_image)
    has_panel_structure = has_avatar and has_cross and has_hp_bar
    selected = has_panel_structure or bool(name_text)
    return {
        "selected": selected,
        "name": name_text,
        "hasPanelStructure": has_panel_structure,
        "hasAvatar": has_avatar,
        "hasCross": has_cross,
        "hasHpBar": has_hp_bar,
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


def find_clickable_world_target(hwnd: int, full_image: np.ndarray) -> dict | None:
    bounds = input_worker.get_window_bounds(hwnd)
    image = crop_roi(full_image, WORLD_NAME_SEARCH_ROI)
    items = input_worker.ocr_items(image)
    best_match = None
    best_score = None

    for item in items:
        text = normalize_name(item["text"])
        if not re.fullmatch(r"[\u4e00-\u9fff]{2,4}", text):
            continue
        if text in WORLD_TARGET_BLOCKLIST:
            continue
        if item["centerY"] < 12:
            continue

        score = float(item["score"])
        if best_score is None or score > best_score:
            best_score = score
            best_match = {
                "text": text,
                "item": item,
            }

    if best_match is None:
        return None

    roi_left = bounds["left"] + int(bounds["width"] * WORLD_NAME_SEARCH_ROI[0])
    roi_top = bounds["top"] + int(bounds["height"] * WORLD_NAME_SEARCH_ROI[1])
    item = best_match["item"]
    click_x = round(roi_left + item["centerX"])
    click_y = round(roi_top + item["maxY"] + bounds["height"] * SELECT_CLICK_Y_OFFSET_RATIO)
    return {
        "name": best_match["text"],
        "screenX": int(click_x),
        "screenY": int(click_y),
        "clientX": int(click_x - bounds["left"]),
        "clientY": int(click_y - bounds["top"]),
        "score": round(float(item["score"]), 4),
    }


def lock_fixed_world_target(hwnd: int) -> dict:
    full_image = capture_full_client(hwnd)
    target = find_clickable_world_target(hwnd, full_image)
    if target is None:
        return None
    return {
        "targetName": target["name"],
        "target": target,
    }


def click_fixed_target(hwnd: int, fixed_target: dict) -> dict:
    target = fixed_target["target"]
    click_state = input_worker.click_screen_point(hwnd, target["screenX"], target["screenY"], "left")
    return {
        "clicked": True,
        "targetName": fixed_target["targetName"],
        "target": target,
        "click": click_state,
    }


def run_phase_one(hwnd: int, fixed_target: dict) -> dict:
    phase_results = []
    success_count = 0

    for index in range(1, ITERATIONS + 1):
        click_result = click_fixed_target(hwnd, fixed_target)
        time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
        full_image = capture_full_client(hwnd)
        selected_state = detect_selected_state(full_image)
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
            "hasPanelStructure": selected_state["hasPanelStructure"],
            "hasAvatar": selected_state["hasAvatar"],
            "hasCross": selected_state["hasCross"],
            "hasHpBar": selected_state["hasHpBar"],
            "targetName": click_result.get("targetName", ""),
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


def run_phase_two(hwnd: int, fixed_target: dict) -> dict:
    template = None
    phase_results = []
    success_count = 0

    for index in range(1, ITERATIONS + 1):
        click_result = click_fixed_target(hwnd, fixed_target)
        time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
        selected_image = capture_full_client(hwnd)
        selected_state = detect_selected_state(selected_image)
        if not selected_state["selected"]:
            row = {
                "phase": 2,
                "iteration": index,
                "status": "FAIL",
                "reason": "RESELECT_FAILED",
                "ocrName": selected_state["name"],
                "targetName": click_result.get("targetName", ""),
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
                "targetName": click_result.get("targetName", ""),
                "targetClientX": click_result["target"]["clientX"],
                "targetClientY": click_result["target"]["clientY"],
            }
            phase_results.append(row)
            print(json.dumps(row, ensure_ascii=False))
            continue

        input_worker.click_screen_point(hwnd, cross_match["screenX"], cross_match["screenY"], "left")
        time.sleep(WAIT_AFTER_CLICK_MS / 1000.0)
        after_image = capture_full_client(hwnd)
        after_state = detect_selected_state(after_image)
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
            "crossScore": cross_match["score"],
            "targetName": click_result.get("targetName", ""),
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
        raise RuntimeError("NO_WORLD_TARGET_FOUND")
    print(
        json.dumps(
            {
                "phase": "setup",
                "logic": "lock_once_then_fixed_coordinate_closed_loop",
                "selectedStateOwner": "single_fullscreen_frame",
                "closeOwner": "template_match_cross_only",
                "fixedTargetName": fixed_target["targetName"],
                "fixedTargetClientX": fixed_target["target"]["clientX"],
                "fixedTargetClientY": fixed_target["target"]["clientY"],
            },
            ensure_ascii=False,
        )
    )
    phase_one = run_phase_one(hwnd, fixed_target)
    print(json.dumps({"phase": "phase1_summary", **phase_one}, ensure_ascii=False))

    if not phase_one["passed"]:
        return 2

    phase_two = run_phase_two(hwnd, fixed_target)
    print(json.dumps({"phase": "phase2_summary", **phase_two}, ensure_ascii=False))
    return 0 if phase_two["passed"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
