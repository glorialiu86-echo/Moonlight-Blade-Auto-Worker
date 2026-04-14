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


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = PROJECT_ROOT / "tmp"
DATA_DIR = PROJECT_ROOT / "data"
GAME_WINDOW_TITLE = "天涯明月刀手游"
TARGET_NAME = "卜玉人"
TARGET_TEMPLATE_PATH = DATA_DIR / "buyuren-name-template.png"
ITERATIONS = 20
TARGET_TEMPLATE_THRESHOLD = 0.30
TARGET_BODY_RATIO_X = 0.0
TARGET_BODY_RATIO_Y = 4.8
TRADE_BUTTON_CLIENT_RATIO_X = 2139 / 2537
TRADE_BUTTON_CLIENT_RATIO_Y = 1139 / 1384
EXIT_BUTTON_CLIENT_RATIO_X = 2233 / 2537
EXIT_BUTTON_CLIENT_RATIO_Y = 1022 / 1384
CROSS_CLIENT_RATIO_X = 959 / 2537
CROSS_CLIENT_RATIO_Y = 312 / 1384
WAIT_AFTER_TARGET_CLICK_MS = 150
WAIT_AFTER_UI_CLICK_MS = 300
FIXED_FAILURE_DIR = TMP_DIR / "fixed_npc_failures"
RANDOM_FAILURE_DIR = TMP_DIR / "random_npc_failures"
SELECTED_PANEL_ROI = (0.20, 0.10, 0.42, 0.26)
SELECTED_NAME_ROI = (0.26, 0.12, 0.36, 0.20)
SELECTED_HP_ROI = (0.26, 0.19, 0.39, 0.23)
DETAIL_EXIT_ROI = (0.82, 0.66, 0.99, 0.80)
RANDOM_NAME_SEARCH_ROI = (0.15, 0.18, 0.84, 0.74)
IGNORED_WORLD_TEXTS = {
    "查看",
    "退出",
    "详情",
    "交易",
    "赠礼",
    "交谈",
    "战斗",
    "邀请",
    "潜行",
    "感知",
    "叫卖",
    "动作",
    "社交",
    "拍照",
    "快捷",
    "菜单",
    "背包",
    "任务",
    "体力",
    "武力",
    "已时",
    "申时",
    "酉时",
    "西时",
    "我",
    "籽小刀",
}


def normalize_name(text: str) -> str:
    normalized = re.sub(r"\s+", "", str(text or ""))
    normalized = re.sub(r"[^\u4e00-\u9fffA-Za-z0-9<>]", "", normalized)
    return normalized


def draw_click_marker(image: np.ndarray, client_x: int, client_y: int) -> np.ndarray:
    marked = image.copy()
    center = (int(client_x), int(client_y))
    color = (0, 0, 255)
    cv2.circle(marked, center, 7, color, thickness=2)
    cv2.line(marked, (center[0] - 10, center[1]), (center[0] + 10, center[1]), color, thickness=2)
    cv2.line(marked, (center[0], center[1] - 10), (center[0], center[1] + 10), color, thickness=2)
    return marked


def save_debug_image(
    image: np.ndarray,
    name: str,
    client_x: int | None = None,
    client_y: int | None = None,
    output_dir: Path | None = None,
) -> str:
    save_dir = output_dir or TMP_DIR
    save_dir.mkdir(parents=True, exist_ok=True)
    output_path = save_dir / name
    output_image = image
    if client_x is not None and client_y is not None:
        output_image = draw_click_marker(image, client_x, client_y)
    Image.fromarray(output_image[:, :, ::-1].astype(np.uint8), mode="RGB").save(output_path)
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


def capture_full_client(hwnd: int) -> np.ndarray:
    return input_worker.capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))


def extract_best_name(image: np.ndarray) -> str:
    candidates: list[tuple[float, str]] = []
    for item in input_worker.ocr_items(image):
        text = normalize_name(item["text"])
        if not re.fullmatch(r"[\u4e00-\u9fff]{2,4}", text):
            continue
        candidates.append((float(item["score"]), text))

    if not candidates:
        return ""

    candidates.sort(key=lambda value: value[0], reverse=True)
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
    bright_ratio = float(np.count_nonzero(binary)) / float(binary.size)
    lines = cv2.HoughLinesP(binary, 1, np.pi / 180, threshold=12, minLineLength=8, maxLineGap=3)
    if lines is None:
        return bright_ratio >= 0.04

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
    return (positive >= 1 and negative >= 1) or bright_ratio >= 0.08


def detect_hp_bar(panel_hp_image: np.ndarray) -> bool:
    blue_mask = (
        (panel_hp_image[:, :, 0] >= 140)
        & (panel_hp_image[:, :, 1] >= 140)
        & (panel_hp_image[:, :, 2] <= 150)
    ).astype(np.uint8) * 255
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
    contours, _hierarchy = cv2.findContours(blue_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for contour in contours:
        _x, _y, width, height = cv2.boundingRect(contour)
        if width >= 40 and 3 <= height <= 16 and (width / max(height, 1)) >= 4.0:
            return True
    return False


def detect_left_top_selected_state(full_image: np.ndarray) -> dict:
    panel_image = crop_roi(full_image, SELECTED_PANEL_ROI)
    name_image = crop_roi(full_image, SELECTED_NAME_ROI)
    hp_image = crop_roi(full_image, SELECTED_HP_ROI)
    cross_image = crop_roi(full_image, (0.35, 0.11, 0.39, 0.18))
    name_text = extract_best_name(name_image)
    has_avatar = detect_avatar_block(panel_image)
    has_cross = detect_cross_symbol(cross_image)
    has_hp_bar = detect_hp_bar(hp_image)
    selected = (has_cross and has_avatar) or (has_avatar and has_hp_bar) or (has_avatar and bool(name_text))
    return {
        "selected": selected,
        "name": name_text,
        "hasAvatar": has_avatar,
        "hasCross": has_cross,
        "hasHpBar": has_hp_bar,
    }


def detect_world_hp_bar(full_image: np.ndarray, target: dict | None) -> bool:
    if target is None:
        return False

    bbox_x = int(target["bboxX"])
    bbox_y = int(target["bboxY"])
    bbox_width = int(target["bboxWidth"])
    bbox_height = int(target["bboxHeight"])
    roi = crop_rect(
        full_image,
        bbox_x - round(bbox_width * 1.2),
        bbox_y - round(bbox_height * 2.2),
        bbox_x + round(bbox_width * 2.2),
        bbox_y + round(bbox_height * 0.4),
    )
    blue_mask = (
        (roi[:, :, 0] >= 145)
        & (roi[:, :, 1] >= 145)
        & (roi[:, :, 2] <= 155)
    ).astype(np.uint8) * 255
    blue_mask = cv2.morphologyEx(blue_mask, cv2.MORPH_OPEN, np.ones((3, 3), dtype=np.uint8))
    contours, _hierarchy = cv2.findContours(blue_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_width = max(22, round(bbox_width * 0.40))
    max_height = max(12, round(bbox_height * 0.55))

    for contour in contours:
        _x, _y, width, height = cv2.boundingRect(contour)
        if width < min_width:
            continue
        if height < 3 or height > max_height:
            continue
        if (width / max(height, 1)) < 3.0:
            continue
        return True

    return False


def detect_selection_state(full_image: np.ndarray, target: dict | None) -> dict:
    panel_state = detect_left_top_selected_state(full_image)
    has_world_hp_bar = detect_world_hp_bar(full_image, target)
    return {
        **panel_state,
        "hasWorldHpBar": has_world_hp_bar,
        "selected": bool(panel_state["selected"] or has_world_hp_bar),
    }


def detect_exit_button_state(full_image: np.ndarray) -> dict:
    roi_image = crop_roi(full_image, DETAIL_EXIT_ROI)
    texts = [normalize_name(item["text"]) for item in input_worker.ocr_items(roi_image)]
    joined = "".join(texts)
    visible = "退出" in joined
    return {
        "visible": visible,
        "texts": texts,
    }


def get_window_bounds(hwnd: int) -> dict:
    return input_worker.get_window_bounds(hwnd)


def build_screen_point_from_ratio(hwnd: int, x_ratio: float, y_ratio: float) -> dict:
    bounds = get_window_bounds(hwnd)
    client_x = int(round(bounds["width"] * x_ratio))
    client_y = int(round(bounds["height"] * y_ratio))
    return {
        "clientX": client_x,
        "clientY": client_y,
        "screenX": int(bounds["left"] + client_x),
        "screenY": int(bounds["top"] + client_y),
    }


def click_screen_point(hwnd: int, screen_x: int, screen_y: int) -> dict:
    bounds = get_window_bounds(hwnd)
    result = input_worker.click_screen_point(hwnd, int(screen_x), int(screen_y), "left")
    result["clientX"] = int(screen_x - bounds["left"])
    result["clientY"] = int(screen_y - bounds["top"])
    return result


def locate_manual_exit_point(hwnd: int) -> dict:
    # Exit is a fixed UI button. Once the user manually marks a stable truth point,
    # we should click it directly by relative coordinates instead of waiting for
    # another screenshot-driven confirmation step.
    return build_screen_point_from_ratio(hwnd, EXIT_BUTTON_CLIENT_RATIO_X, EXIT_BUTTON_CLIENT_RATIO_Y)


def locate_manual_trade_point(hwnd: int) -> dict:
    # Trade is a fixed button inside the opened NPC detail UI. After the user
    # manually marks a stable truth point, restore it from relative coordinates
    # and click directly instead of adding a second vision-based locator.
    return build_screen_point_from_ratio(hwnd, TRADE_BUTTON_CLIENT_RATIO_X, TRADE_BUTTON_CLIENT_RATIO_Y)


def locate_cross_point(hwnd: int, _full_image: np.ndarray) -> dict:
    # The close "X" is also fixed UI. It should be treated the same way as exit:
    # restore from relative coordinates and blind-click directly, rather than
    # layering extra vision logic on top of a manually validated fixed position.
    return build_screen_point_from_ratio(hwnd, CROSS_CLIENT_RATIO_X, CROSS_CLIENT_RATIO_Y)


def load_target_template() -> np.ndarray:
    if not TARGET_TEMPLATE_PATH.exists():
        raise RuntimeError(f"TARGET_TEMPLATE_NOT_FOUND: {TARGET_TEMPLATE_PATH}")
    encoded = np.fromfile(str(TARGET_TEMPLATE_PATH), dtype=np.uint8)
    template = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
    if template is None:
        raise RuntimeError(f"TARGET_TEMPLATE_DECODE_FAILED: {TARGET_TEMPLATE_PATH}")
    return template


def find_target_by_template(full_image: np.ndarray, template: np.ndarray) -> dict | None:
    result = cv2.matchTemplate(full_image, template, cv2.TM_CCOEFF_NORMED)
    _min_val, max_val, _min_loc, max_loc = cv2.minMaxLoc(result)
    if float(max_val) < TARGET_TEMPLATE_THRESHOLD:
        return None

    template_height, template_width = template.shape[:2]
    bbox_x = int(max_loc[0])
    bbox_y = int(max_loc[1])
    bbox_width = int(template_width)
    bbox_height = int(template_height)
    return {
        "name": TARGET_NAME,
        "bboxX": bbox_x,
        "bboxY": bbox_y,
        "bboxWidth": bbox_width,
        "bboxHeight": bbox_height,
        "centerX": int(bbox_x + bbox_width / 2),
        "nameBottomY": int(bbox_y + bbox_height),
        "score": round(float(max_val), 4),
    }


def lock_fixed_world_target(hwnd: int) -> dict:
    full_image = capture_full_client(hwnd)
    template = load_target_template()
    target = find_target_by_template(full_image, template)
    if target is None:
        raise RuntimeError("TARGET_TEMPLATE_MATCH_NOT_FOUND")
    return target


def build_target_click_from_bbox(hwnd: int, target: dict) -> dict:
    bounds = get_window_bounds(hwnd)
    probe_offset_x = round(target["bboxWidth"] * TARGET_BODY_RATIO_X)
    probe_offset_y = round(target["bboxHeight"] * TARGET_BODY_RATIO_Y)
    client_x = max(0, min(bounds["width"] - 1, target["centerX"] + probe_offset_x))
    client_y = max(0, min(bounds["height"] - 1, target["nameBottomY"] + probe_offset_y))
    return {
        **target,
        "probeOffsetX": int(probe_offset_x),
        "probeOffsetY": int(probe_offset_y),
        "clientX": int(client_x),
        "clientY": int(client_y),
        "screenX": int(bounds["left"] + client_x),
        "screenY": int(bounds["top"] + client_y),
    }


def find_random_npc_target(hwnd: int, iteration: int) -> dict | None:
    bounds = get_window_bounds(hwnd)
    full_image = capture_full_client(hwnd)
    roi_left = int(bounds["width"] * RANDOM_NAME_SEARCH_ROI[0])
    roi_top = int(bounds["height"] * RANDOM_NAME_SEARCH_ROI[1])
    roi_image = crop_roi(full_image, RANDOM_NAME_SEARCH_ROI)
    candidates = []

    for item in input_worker.ocr_items(roi_image):
        text = normalize_name(item["text"])
        if not re.fullmatch(r"[\u4e00-\u9fff]{2,4}", text):
            continue
        if text in IGNORED_WORLD_TEXTS:
            continue
        width = int(item["maxX"] - item["minX"])
        height = int(item["maxY"] - item["minY"])
        if width < 18 or height < 12:
            continue
        center_x = roi_left + int(item["centerX"])
        center_y = roi_top + int(item["centerY"])
        distance_penalty = abs(center_x - bounds["width"] * 0.5) + abs(center_y - bounds["height"] * 0.5) * 0.5
        candidates.append(
            {
                "name": text,
                "bboxX": roi_left + int(item["minX"]),
                "bboxY": roi_top + int(item["minY"]),
                "bboxWidth": width,
                "bboxHeight": height,
                "centerX": center_x,
                "nameBottomY": roi_top + int(item["maxY"]),
                "score": float(item["score"]),
                "rankScore": float(item["score"]) * 1000.0 - distance_penalty,
            }
        )

    if not candidates:
        return None

    candidates.sort(key=lambda value: value["rankScore"], reverse=True)
    top_candidates = candidates[: min(5, len(candidates))]
    return top_candidates[(iteration - 1) % len(top_candidates)]


def reset_to_world(hwnd: int) -> None:
    image = capture_full_client(hwnd)
    exit_state = detect_exit_button_state(image)
    if exit_state["visible"]:
        exit_point = locate_manual_exit_point(hwnd)
        click_screen_point(hwnd, exit_point["screenX"], exit_point["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)

    image = capture_full_client(hwnd)
    selected_state = detect_selection_state(image, None)
    if selected_state["selected"]:
        cross_point = locate_cross_point(hwnd, image)
        click_screen_point(hwnd, cross_point["screenX"], cross_point["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)


def record_round_failure(
    failure_dir: Path,
    suite_name: str,
    iteration: int,
    step_name: str,
    image: np.ndarray,
    click_point: dict | None,
) -> str:
    client_x = None
    client_y = None
    if click_point is not None:
        client_x = click_point.get("clientX")
        client_y = click_point.get("clientY")
    return save_debug_image(
        image,
        f"{suite_name}-round-{iteration:02d}-{step_name}.png",
        client_x,
        client_y,
        failure_dir,
    )


def execute_round(
    hwnd: int,
    suite_name: str,
    iteration: int,
    target_click: dict,
    view_click: dict,
    failure_dir: Path,
    target_name: str,
) -> dict:
    click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
    time.sleep(WAIT_AFTER_TARGET_CLICK_MS / 1000.0)

    selected_image = capture_full_client(hwnd)
    selected_state = detect_selection_state(selected_image, target_click)
    selected_shot = save_debug_image(
        selected_image,
        f"{suite_name}-round-{iteration:02d}-selected.png",
        target_click["clientX"],
        target_click["clientY"],
    )
    if not selected_state["selected"]:
        failure_shot = record_round_failure(failure_dir, suite_name, iteration, "select-fail", selected_image, target_click)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": False,
            "viewOpened": False,
            "exitClosed": False,
            "crossCleared": False,
            "reason": "SELECT_NOT_REACHED",
            "selectedState": selected_state,
            "targetClick": target_click,
            "viewClick": view_click,
            "selectedScreenshot": selected_shot,
            "failureScreenshot": failure_shot,
        }

    return finish_round_after_selection(
        hwnd,
        suite_name,
        iteration,
        target_name,
        target_click,
        view_click,
        selected_state,
        selected_shot,
        failure_dir,
    )


def finish_round_after_selection(
    hwnd: int,
    suite_name: str,
    iteration: int,
    target_name: str,
    target_click: dict,
    view_click: dict,
    selected_state: dict,
    selected_shot: str,
    failure_dir: Path,
) -> dict:
    click_screen_point(hwnd, view_click["screenX"], view_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)

    detail_image = capture_full_client(hwnd)
    detail_state = detect_exit_button_state(detail_image)
    detail_shot = save_debug_image(
        detail_image,
        f"{suite_name}-round-{iteration:02d}-detail-open.png",
        view_click["clientX"],
        view_click["clientY"],
    )
    if not detail_state["visible"]:
        failure_shot = record_round_failure(failure_dir, suite_name, iteration, "detail-open-fail", detail_image, view_click)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": True,
            "viewOpened": False,
            "exitClosed": False,
            "crossCleared": False,
            "reason": "DETAIL_NOT_OPENED",
            "selectedState": selected_state,
            "detailState": detail_state,
            "targetClick": target_click,
            "viewClick": view_click,
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "failureScreenshot": failure_shot,
        }

    exit_click = locate_manual_exit_point(hwnd)
    click_screen_point(hwnd, exit_click["screenX"], exit_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)

    after_exit_image = capture_full_client(hwnd)
    after_exit_state = detect_exit_button_state(after_exit_image)
    after_exit_shot = save_debug_image(
        after_exit_image,
        f"{suite_name}-round-{iteration:02d}-after-exit.png",
        exit_click["clientX"],
        exit_click["clientY"],
    )
    if after_exit_state["visible"]:
        failure_shot = record_round_failure(failure_dir, suite_name, iteration, "exit-fail", after_exit_image, exit_click)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": True,
            "viewOpened": True,
            "exitClosed": False,
            "crossCleared": False,
            "reason": "EXIT_NOT_CLOSED",
            "selectedState": selected_state,
            "detailState": detail_state,
            "afterExitState": after_exit_state,
            "targetClick": target_click,
            "viewClick": view_click,
            "exitClick": exit_click,
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "afterExitScreenshot": after_exit_shot,
            "failureScreenshot": failure_shot,
        }

    cross_click = locate_cross_point(hwnd, after_exit_image)
    if cross_click is None:
        failure_shot = record_round_failure(failure_dir, suite_name, iteration, "cross-not-found", after_exit_image, None)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": True,
            "viewOpened": True,
            "exitClosed": True,
            "crossCleared": False,
            "reason": "CROSS_NOT_FOUND",
            "selectedState": selected_state,
            "detailState": detail_state,
            "afterExitState": after_exit_state,
            "targetClick": target_click,
            "viewClick": view_click,
            "exitClick": exit_click,
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "afterExitScreenshot": after_exit_shot,
            "failureScreenshot": failure_shot,
        }
    click_screen_point(hwnd, cross_click["screenX"], cross_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)

    after_cross_image = capture_full_client(hwnd)
    after_cross_state = detect_selection_state(after_cross_image, target_click)
    after_cross_shot = save_debug_image(
        after_cross_image,
        f"{suite_name}-round-{iteration:02d}-after-cross.png",
        cross_click["clientX"],
        cross_click["clientY"],
    )
    if after_cross_state["selected"]:
        failure_shot = record_round_failure(failure_dir, suite_name, iteration, "cross-fail", after_cross_image, cross_click)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": True,
            "viewOpened": True,
            "exitClosed": True,
            "crossCleared": False,
            "reason": "CROSS_NOT_CLEARED",
            "selectedState": selected_state,
            "detailState": detail_state,
            "afterExitState": after_exit_state,
            "afterCrossState": after_cross_state,
            "targetClick": target_click,
            "viewClick": view_click,
            "exitClick": exit_click,
            "crossClick": cross_click,
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "afterExitScreenshot": after_exit_shot,
            "afterCrossScreenshot": after_cross_shot,
            "failureScreenshot": failure_shot,
        }

    return {
        "iteration": iteration,
        "targetName": target_name,
        "status": "SUCCESS",
        "selectedReached": True,
        "viewOpened": True,
        "exitClosed": True,
        "crossCleared": True,
        "selectedState": selected_state,
        "detailState": detail_state,
        "afterExitState": after_exit_state,
        "afterCrossState": after_cross_state,
        "targetClick": target_click,
        "viewClick": view_click,
        "exitClick": exit_click,
        "crossClick": cross_click,
        "selectedScreenshot": selected_shot,
        "detailScreenshot": detail_shot,
        "afterExitScreenshot": after_exit_shot,
        "afterCrossScreenshot": after_cross_shot,
    }


def execute_random_round(
    hwnd: int,
    iteration: int,
    target_click: dict,
    failure_dir: Path,
    target_name: str,
) -> dict:
    click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
    time.sleep(WAIT_AFTER_TARGET_CLICK_MS / 1000.0)

    selected_image = capture_full_client(hwnd)
    selected_state = detect_selection_state(selected_image, target_click)
    selected_shot = save_debug_image(
        selected_image,
        f"random-round-{iteration:02d}-selected.png",
        target_click["clientX"],
        target_click["clientY"],
    )
    if not selected_state["selected"]:
        failure_shot = record_round_failure(failure_dir, "random", iteration, "select-fail", selected_image, target_click)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": False,
            "viewOpened": False,
            "exitClosed": False,
            "crossCleared": False,
            "reason": "SELECT_NOT_REACHED",
            "selectedState": selected_state,
            "targetClick": target_click,
            "selectedScreenshot": selected_shot,
            "failureScreenshot": failure_shot,
        }

    view_click = input_worker.find_view_button_near_click(hwnd, target_click["screenX"], target_click["screenY"])
    if view_click is None:
        failure_shot = record_round_failure(failure_dir, "random", iteration, "view-not-found", selected_image, target_click)
        return {
            "iteration": iteration,
            "targetName": target_name,
            "status": "FAIL",
            "selectedReached": True,
            "viewOpened": False,
            "exitClosed": False,
            "crossCleared": False,
            "reason": "VIEW_BUTTON_NOT_FOUND",
            "selectedState": selected_state,
            "targetClick": target_click,
            "selectedScreenshot": selected_shot,
            "failureScreenshot": failure_shot,
        }

    bounds = get_window_bounds(hwnd)
    view_click["clientX"] = int(view_click["screenX"] - bounds["left"])
    view_click["clientY"] = int(view_click["screenY"] - bounds["top"])

    row = finish_round_after_selection(
        hwnd,
        "random",
        iteration,
        target_name,
        target_click,
        view_click,
        selected_state,
        selected_shot,
        failure_dir,
    )
    row["viewMatchSource"] = view_click.get("source")
    row["viewMatchScore"] = view_click.get("score")
    row["viewMatchDebugImage"] = view_click.get("debugImage")
    row["viewSearchRect"] = view_click.get("searchRect")
    return row


def run_fixed_npc_suite(hwnd: int) -> dict:
    failure_dir = FIXED_FAILURE_DIR
    failure_dir.mkdir(parents=True, exist_ok=True)
    fixed_target = lock_fixed_world_target(hwnd)
    fixed_click = build_target_click_from_bbox(hwnd, fixed_target)
    rows = []
    success_count = 0

    print(
        json.dumps(
            {
                "phase": "fixed_setup",
                "targetName": fixed_target["name"],
                "targetBbox": {
                    "x": fixed_target["bboxX"],
                    "y": fixed_target["bboxY"],
                    "width": fixed_target["bboxWidth"],
                    "height": fixed_target["bboxHeight"],
                },
                "targetClick": fixed_click,
                "exitClick": locate_manual_exit_point(hwnd),
                "crossClick": locate_cross_point(hwnd, capture_full_client(hwnd)),
            },
            ensure_ascii=False,
        )
    )

    for iteration in range(1, ITERATIONS + 1):
        reset_to_world(hwnd)
        row = execute_random_round(hwnd, iteration, fixed_click, failure_dir, fixed_target["name"])
        rows.append(row)
        if row["status"] == "SUCCESS":
            success_count += 1
        print(json.dumps({"phase": "fixed_round", **row}, ensure_ascii=False))

    return {
        "suite": "fixed_npc",
        "targetName": fixed_target["name"],
        "totalRounds": ITERATIONS,
        "successCount": success_count,
        "failureCount": ITERATIONS - success_count,
        "successRate": round(success_count * 100.0 / ITERATIONS, 2),
        "passed": success_count >= 18,
        "failureDir": str(failure_dir),
        "results": rows,
    }


def run_random_npc_suite(hwnd: int) -> dict:
    failure_dir = RANDOM_FAILURE_DIR
    failure_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    success_count = 0

    for iteration in range(1, ITERATIONS + 1):
        reset_to_world(hwnd)
        target = find_random_npc_target(hwnd, iteration)
        if target is None:
            image = capture_full_client(hwnd)
            failure_shot = record_round_failure(failure_dir, "random", iteration, "target-not-found", image, None)
            row = {
                "iteration": iteration,
                "status": "FAIL",
                "selectedReached": False,
                "viewOpened": False,
                "exitClosed": False,
                "crossCleared": False,
                "reason": "RANDOM_TARGET_NOT_FOUND",
                "failureScreenshot": failure_shot,
            }
            rows.append(row)
            print(json.dumps({"phase": "random_round", **row}, ensure_ascii=False))
            continue

        target_click = build_target_click_from_bbox(hwnd, target)
        row = execute_random_round(hwnd, iteration, target_click, failure_dir, target["name"])
        rows.append(row)
        if row["status"] == "SUCCESS":
            success_count += 1
        print(json.dumps({"phase": "random_round", **row}, ensure_ascii=False))

    return {
        "suite": "random_npc",
        "totalRounds": ITERATIONS,
        "successCount": success_count,
        "failureCount": ITERATIONS - success_count,
        "successRate": round(success_count * 100.0 / ITERATIONS, 2),
        "passed": success_count >= 18,
        "failureDir": str(failure_dir),
        "results": rows,
    }


def main() -> int:
    hwnd = input_worker.find_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        raise RuntimeError("GAME_WINDOW_NOT_FOUND")

    input_worker.focus_window(hwnd)
    reset_to_world(hwnd)

    fixed_summary = run_fixed_npc_suite(hwnd)
    random_summary = run_random_npc_suite(hwnd)
    final_summary = {
        "phase": "final_summary",
        "fixed": {
            "totalRounds": fixed_summary["totalRounds"],
            "successCount": fixed_summary["successCount"],
            "failureCount": fixed_summary["failureCount"],
            "successRate": fixed_summary["successRate"],
            "passed": fixed_summary["passed"],
            "failureDir": fixed_summary["failureDir"],
        },
        "random": {
            "totalRounds": random_summary["totalRounds"],
            "successCount": random_summary["successCount"],
            "failureCount": random_summary["failureCount"],
            "successRate": random_summary["successRate"],
            "passed": random_summary["passed"],
            "failureDir": random_summary["failureDir"],
        },
    }
    print(json.dumps(final_summary, ensure_ascii=False))
    return 0 if fixed_summary["passed"] and random_summary["passed"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
