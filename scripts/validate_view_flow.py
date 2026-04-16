import json
import sys
import time
from pathlib import Path

import pydirectinput

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import validate_input_state as vis
import windows_input_worker as input_worker


PROJECT_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = PROJECT_ROOT / "tmp" / "view_flow"
GAME_WINDOW_TITLE = "天涯明月刀手游"
WAIT_AFTER_TARGET_CLICK_MS = 200
WAIT_AFTER_UI_CLICK_MS = 350
VIEW_RIGHT_OF_NAME_X = -0.902
VIEW_RIGHT_OF_NAME_Y = 4.635
VIEW_LEFT_OF_NAME_X = 0.839
VIEW_LEFT_OF_NAME_Y = 4.511
SIDE_SUITES = [("left", 2), ("right", 2)]


def capture_step(hwnd: int, output_dir: Path, suite_name: str, iteration: int, step_name: str, click_point: dict | None = None) -> str:
    image = vis.capture_full_client(hwnd)
    client_x = None if click_point is None else click_point.get("clientX")
    client_y = None if click_point is None else click_point.get("clientY")
    return vis.save_debug_image(
        image,
        f"{suite_name}-round-{iteration:02d}-{step_name}.png",
        client_x,
        client_y,
        output_dir,
    )


def build_geometric_view_click(hwnd: int, target: dict, side: str) -> dict:
    bounds = vis.get_window_bounds(hwnd)
    bbox_width = int(target["bboxWidth"])
    bbox_height = int(target["bboxHeight"])
    name_center_x = int(target["centerX"])
    name_bottom_y = int(target["nameBottomY"])

    if side == "right":
        offset_x = round(bbox_width * VIEW_RIGHT_OF_NAME_X)
        offset_y = round(bbox_height * VIEW_RIGHT_OF_NAME_Y)
    else:
        offset_x = round(bbox_width * VIEW_LEFT_OF_NAME_X)
        offset_y = round(bbox_height * VIEW_LEFT_OF_NAME_Y)

    client_x = max(0, min(bounds["width"] - 1, name_center_x + offset_x))
    client_y = max(0, min(bounds["height"] - 1, name_bottom_y + offset_y))
    return {
        "clientX": int(client_x),
        "clientY": int(client_y),
        "screenX": int(bounds["left"] + client_x),
        "screenY": int(bounds["top"] + client_y),
        "offsetX": int(offset_x),
        "offsetY": int(offset_y),
        "side": side,
    }


def press_escape(hwnd: int) -> dict:
    input_worker.focus_window(hwnd)
    pydirectinput.press("esc")
    bounds = vis.get_window_bounds(hwnd)
    return {
        "clientX": 0,
        "clientY": 0,
        "screenX": int(bounds["left"]),
        "screenY": int(bounds["top"]),
        "key": "esc",
    }


def execute_round(hwnd: int, suite_name: str, iteration: int, side: str, output_dir: Path) -> dict:
    vis.reset_to_world(hwnd)
    capture_step(hwnd, output_dir, suite_name, iteration, "world")

    target = vis.find_random_npc_target(hwnd, iteration, preferred_side=side)
    if target is None:
        return {
            "suite": suite_name,
            "iteration": iteration,
            "side": side,
            "status": "FAIL",
            "reason": "TARGET_NOT_FOUND",
        }

    target_click = vis.build_target_click_from_bbox(hwnd, target)
    vis.click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
    time.sleep(WAIT_AFTER_TARGET_CLICK_MS / 1000.0)
    selected_shot = capture_step(hwnd, output_dir, suite_name, iteration, "selected", target_click)
    selected_image = vis.capture_full_client(hwnd)
    selected_state = vis.detect_selection_state(selected_image, target_click)
    if not selected_state["selected"]:
        return {
            "suite": suite_name,
            "iteration": iteration,
            "side": side,
            "targetName": target["name"],
            "status": "FAIL",
            "reason": "SELECT_NOT_REACHED",
            "selectedScreenshot": selected_shot,
            "targetClick": target_click,
        }

    view_click = build_geometric_view_click(hwnd, target, side)
    vis.click_screen_point(hwnd, view_click["screenX"], view_click["screenY"])
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    detail_shot = capture_step(hwnd, output_dir, suite_name, iteration, "after-view", view_click)
    detail_image = vis.capture_full_client(hwnd)
    detail_state = vis.detect_exit_button_state(detail_image)
    if not detail_state["visible"]:
        return {
            "suite": suite_name,
            "iteration": iteration,
            "side": side,
            "targetName": target["name"],
            "status": "FAIL",
            "reason": "DETAIL_NOT_OPENED",
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "targetClick": target_click,
            "viewClick": view_click,
        }

    esc_press = press_escape(hwnd)
    time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
    after_esc_shot = capture_step(hwnd, output_dir, suite_name, iteration, "after-esc", esc_press)
    after_esc_image = vis.capture_full_client(hwnd)
    after_esc_state = vis.detect_exit_button_state(after_esc_image)
    if after_esc_state["visible"]:
        return {
            "suite": suite_name,
            "iteration": iteration,
            "side": side,
            "targetName": target["name"],
            "status": "FAIL",
            "reason": "ESC_NOT_CLOSED",
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "afterEscScreenshot": after_esc_shot,
            "targetClick": target_click,
            "viewClick": view_click,
        }

    return {
        "suite": suite_name,
        "iteration": iteration,
        "side": side,
        "targetName": target["name"],
        "status": "SUCCESS",
        "reason": "",
        "selectedScreenshot": selected_shot,
        "detailScreenshot": detail_shot,
        "afterEscScreenshot": after_esc_shot,
        "targetClick": target_click,
        "viewClick": view_click,
    }


def main() -> int:
    hwnd = input_worker.find_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        raise RuntimeError("GAME_WINDOW_NOT_FOUND")

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    input_worker.focus_window(hwnd)

    results = []
    for side, count in SIDE_SUITES:
        for iteration in range(1, count + 1):
            row = execute_round(hwnd, side, iteration, side, TMP_DIR)
            results.append(row)
            print(json.dumps({"phase": "view_round", **row}, ensure_ascii=False))

    summary = {
        "phase": "view_summary",
        "totalRounds": len(results),
        "successCount": sum(1 for row in results if row["status"] == "SUCCESS"),
        "failureCount": sum(1 for row in results if row["status"] != "SUCCESS"),
        "resultDir": str(TMP_DIR),
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
