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
TMP_DIR = PROJECT_ROOT / "tmp" / "gift_flow"
GAME_WINDOW_TITLE = "天涯明月刀手游"
ITERATIONS = 2
MAX_TARGET_ATTEMPTS = 2
WAIT_AFTER_TARGET_CLICK_MS = 200
WAIT_AFTER_UI_CLICK_MS = 350


def detect_gift_button_visible(full_image) -> dict:
    roi_image = vis.crop_roi(full_image, input_worker.NPC_STAGE_ROIS["bottom_right_actions"])
    texts = [vis.normalize_name(item["text"]) for item in input_worker.ocr_items(roi_image)]
    joined = "".join(texts)
    return {
        "visible": "赠礼" in joined,
        "texts": texts,
    }


def detect_gift_screen(full_image) -> dict:
    roi_image = vis.crop_roi(full_image, input_worker.NPC_STAGE_ROIS["gift_panel"])
    texts = [vis.normalize_name(item["text"]) for item in input_worker.ocr_items(roi_image)]
    joined = "".join(texts)
    return {
        "visible": ("赠礼" in joined) or ("好感度" in joined) or ("选择礼物" in joined),
        "texts": texts,
    }


def build_named_point(hwnd: int, point_name: str) -> dict:
    x_ratio, y_ratio = input_worker.ACTION_POINTS[point_name]
    return vis.build_screen_point_from_ratio(hwnd, x_ratio, y_ratio)


def capture_step(hwnd: int, output_dir: Path, iteration: int, step_name: str, click_point: dict | None = None) -> str:
    image = vis.capture_full_client(hwnd)
    client_x = None if click_point is None else click_point.get("clientX")
    client_y = None if click_point is None else click_point.get("clientY")
    return vis.save_debug_image(
        image,
        f"gift-round-{iteration:02d}-{step_name}.png",
        client_x,
        client_y,
        output_dir,
    )


def execute_round(hwnd: int, iteration: int, output_dir: Path) -> dict:
    attempt_logs = []

    for target_attempt in range(1, MAX_TARGET_ATTEMPTS + 1):
        vis.reset_to_world(hwnd)
        capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-world")

        target = vis.find_random_npc_target(hwnd, iteration + target_attempt - 1)
        if target is None:
            attempt_logs.append(
                {
                    "targetAttempt": target_attempt,
                    "status": "FAIL",
                    "reason": "RANDOM_TARGET_NOT_FOUND",
                }
            )
            continue

        target_click = vis.build_target_click_from_bbox(hwnd, target)
        vis.click_screen_point(hwnd, target_click["screenX"], target_click["screenY"])
        time.sleep(WAIT_AFTER_TARGET_CLICK_MS / 1000.0)
        selected_shot = capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-selected", target_click)
        selected_image = vis.capture_full_client(hwnd)
        selected_state = vis.detect_selection_state(selected_image, target_click)
        if not selected_state["selected"]:
            attempt_logs.append(
                {
                    "targetAttempt": target_attempt,
                    "targetName": target["name"],
                    "status": "FAIL",
                    "reason": "SELECT_NOT_REACHED",
                    "selectedScreenshot": selected_shot,
                }
            )
            continue

        view_click = input_worker.find_view_button_near_click(hwnd, target_click["screenX"], target_click["screenY"])
        if view_click is None:
            attempt_logs.append(
                {
                    "targetAttempt": target_attempt,
                    "targetName": target["name"],
                    "status": "FAIL",
                    "reason": "VIEW_BUTTON_NOT_FOUND",
                    "selectedScreenshot": selected_shot,
                }
            )
            continue

        bounds = vis.get_window_bounds(hwnd)
        view_click["clientX"] = int(view_click["screenX"] - bounds["left"])
        view_click["clientY"] = int(view_click["screenY"] - bounds["top"])
        vis.click_screen_point(hwnd, view_click["screenX"], view_click["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)

        detail_shot = capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-after-view", view_click)
        detail_image = vis.capture_full_client(hwnd)
        gift_button_state = detect_gift_button_visible(detail_image)
        if not gift_button_state["visible"]:
            attempt_logs.append(
                {
                    "targetAttempt": target_attempt,
                    "targetName": target["name"],
                    "status": "FAIL",
                    "reason": "GIFT_BUTTON_NOT_VISIBLE_AFTER_VIEW",
                    "selectedScreenshot": selected_shot,
                    "detailScreenshot": detail_shot,
                    "viewClick": view_click,
                }
            )
            continue

        gift_click = build_named_point(hwnd, "gift")
        vis.click_screen_point(hwnd, gift_click["screenX"], gift_click["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
        gift_open_shot = capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-gift-open", gift_click)
        gift_open_image = vis.capture_full_client(hwnd)
        gift_open_state = detect_gift_screen(gift_open_image)
        if not gift_open_state["visible"]:
            attempt_logs.append(
                {
                    "targetAttempt": target_attempt,
                    "targetName": target["name"],
                    "status": "FAIL",
                    "reason": "GIFT_SCREEN_NOT_OPENED",
                    "giftOpenScreenshot": gift_open_shot,
                }
            )
            continue

        slot_click = build_named_point(hwnd, "gift_first_slot")
        vis.click_screen_point(hwnd, slot_click["screenX"], slot_click["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
        gift_select_shot = capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-gift-selected", slot_click)

        submit_click = build_named_point(hwnd, "gift_submit")
        vis.click_screen_point(hwnd, submit_click["screenX"], submit_click["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
        submit_shot = capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-gift-submitted", submit_click)

        close_click = build_named_point(hwnd, "close_panel")
        vis.click_screen_point(hwnd, close_click["screenX"], close_click["screenY"])
        time.sleep(WAIT_AFTER_UI_CLICK_MS / 1000.0)
        close_shot = capture_step(hwnd, output_dir, iteration, f"attempt-{target_attempt}-closed", close_click)

        return {
            "iteration": iteration,
            "targetAttempt": target_attempt,
            "targetName": target["name"],
            "status": "SUCCESS",
            "reason": "",
            "selectedScreenshot": selected_shot,
            "detailScreenshot": detail_shot,
            "giftOpenScreenshot": gift_open_shot,
            "giftSelectedScreenshot": gift_select_shot,
            "giftSubmittedScreenshot": submit_shot,
            "closedScreenshot": close_shot,
            "targetClick": target_click,
            "viewClick": view_click,
            "giftClick": gift_click,
            "slotClick": slot_click,
            "submitClick": submit_click,
            "closeClick": close_click,
            "attemptLogs": attempt_logs,
        }

    return {
        "iteration": iteration,
        "status": "FAIL",
        "reason": "ROUND_EXHAUSTED",
        "attemptLogs": attempt_logs,
    }


def main() -> int:
    hwnd = input_worker.find_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        raise RuntimeError("GAME_WINDOW_NOT_FOUND")

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    input_worker.focus_window(hwnd)

    results = []
    success_count = 0
    for iteration in range(1, ITERATIONS + 1):
        row = execute_round(hwnd, iteration, TMP_DIR)
        results.append(row)
        if row["status"] == "SUCCESS":
            success_count += 1
        print(json.dumps({"phase": "gift_round", **row}, ensure_ascii=False))

    summary = {
        "phase": "gift_summary",
        "totalRounds": ITERATIONS,
        "successCount": success_count,
        "failureCount": ITERATIONS - success_count,
        "resultDir": str(TMP_DIR),
        "results": results,
    }
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
