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
TMP_DIR = PROJECT_ROOT / "tmp" / "trade_gift_chat_debug"
GAME_WINDOW_TITLE = "天涯明月刀手游"
MAX_TARGET_ATTEMPTS = 6
PREFERRED_TARGET_NAMES = ["轩辕静安", "乔疯", "梅清流", "净尘", "梅沧寒"]
WAIT_AFTER_TARGET_CLICK_MS = 220
WAIT_AFTER_UI_CLICK_MS = 360
LEFT_UP_SHELF_OFFSETS = [
    (0, -24),
    (0, 0),
    (0, -40),
    (16, -24),
    (-16, -24),
    (0, 18),
]
RIGHT_UP_SHELF_OFFSETS = [
    (0, 0),
    (0, -24),
    (0, -24),
    (16, -24),
    (-16, -24),
    (0, 18),
    (0, -40),
]
RIGHT_MONEY_SLOT_OFFSETS = [
    (0, 0),
    (16, 0),
    (-16, 0),
    (0, 18),
    (0, -18),
]
CHAT_LINES = [
    "我先拿点小生意当见面礼，别嫌我手黑。",
    "你这人看着稳，我想和你多来往几回。",
    "今儿先聊到这，改天我再带点好东西来。",
]


def emit(row: dict) -> None:
    print(json.dumps(row, ensure_ascii=False))


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


def detect_trade_popup(hwnd: int) -> dict:
    image = vis.capture_full_client(hwnd)
    popup_roi = vis.crop_roi(image, (0.22, 0.18, 0.57, 0.85))
    text = input_worker.ocr_text(popup_roi)
    normalized = vis.normalize_name(text)
    visible = any(keyword in normalized for keyword in ["单价", "数量", "总价", "上架"])
    return {
        "visible": visible,
        "text": text,
        "normalizedText": normalized,
    }


def record_before_after(hwnd: int, output_dir: Path, step_name: str, click_point: dict | None = None) -> dict:
    before = capture_step(hwnd, output_dir, f"{step_name}-before.jpg", click_point)
    return {
        "beforeScreenshot": before,
        "beforeStage": stage_snapshot(hwnd),
    }


def record_after(hwnd: int, output_dir: Path, step_name: str, click_point: dict | None = None) -> dict:
    after = capture_step(hwnd, output_dir, f"{step_name}-after.jpg", click_point)
    return {
        "afterScreenshot": after,
        "afterStage": stage_snapshot(hwnd),
    }


def click_and_verify(hwnd: int, output_dir: Path, step_name: str, point: dict, wait_ms: int = WAIT_AFTER_UI_CLICK_MS) -> dict:
    row = {
        "step": step_name,
        "clickPoint": point,
    }
    row.update(record_before_after(hwnd, output_dir, step_name, point))
    vis.click_screen_point(hwnd, point["screenX"], point["screenY"])
    time.sleep(wait_ms / 1000.0)
    row.update(record_after(hwnd, output_dir, step_name, point))
    return row


def with_offset(point: dict, offset_x: int, offset_y: int) -> dict:
    adjusted = dict(point)
    adjusted["clientX"] = int(point["clientX"] + offset_x)
    adjusted["clientY"] = int(point["clientY"] + offset_y)
    adjusted["screenX"] = int(point["screenX"] + offset_x)
    adjusted["screenY"] = int(point["screenY"] + offset_y)
    adjusted["offsetX"] = int(offset_x)
    adjusted["offsetY"] = int(offset_y)
    return adjusted


def ensure_chat_ready(hwnd: int, output_dir: Path, step_prefix: str) -> dict:
    row = {
        "step": f"{step_prefix}-ensure-chat",
    }
    row.update(record_before_after(hwnd, output_dir, f"{step_prefix}-ensure-chat"))

    talk_click = build_named_point(hwnd, "talk")
    vis.click_screen_point(hwnd, talk_click["screenX"], talk_click["screenY"])
    time.sleep(0.18)
    row["talkClick"] = talk_click

    small_talk_click = build_named_point(hwnd, "small_talk")
    vis.click_screen_point(hwnd, small_talk_click["screenX"], small_talk_click["screenY"])
    time.sleep(0.18)
    row["smallTalkClick"] = small_talk_click

    confirm_click = build_named_point(hwnd, "small_talk_confirm_dialog")
    vis.click_screen_point(hwnd, confirm_click["screenX"], confirm_click["screenY"])
    time.sleep(0.35)
    row["confirmClick"] = confirm_click

    row.update(record_after(hwnd, output_dir, f"{step_prefix}-ensure-chat", confirm_click))
    if row["afterStage"]["stage"] != "chat_ready":
        raise RuntimeError(f"CHAT_NOT_READY_AFTER_TALK: {row['afterStage']['stage']}")
    return row


def send_chat_round(hwnd: int, output_dir: Path, round_index: int, text: str) -> dict:
    step_name = f"chat-round-{round_index:02d}"
    row = {
        "step": step_name,
        "text": text,
    }
    row.update(record_before_after(hwnd, output_dir, step_name))
    send_state = input_worker.send_chat_message(hwnd, text, False, 0)
    time.sleep(0.24)
    row["sendState"] = send_state
    row.update(record_after(hwnd, output_dir, step_name))
    if row["afterStage"]["stage"] != "chat_ready":
        raise RuntimeError(f"CHAT_LEFT_READY_AFTER_SEND: {row['afterStage']['stage']}")
    return row


def close_chat(hwnd: int, output_dir: Path) -> dict:
    point = build_named_point(hwnd, "chat_exit")
    return click_and_verify(hwnd, output_dir, "chat-close", point, 280)


def attempt_full_flow(hwnd: int, attempt_index: int) -> dict:
    output_dir = TMP_DIR / f"attempt_{attempt_index:02d}"
    output_dir.mkdir(parents=True, exist_ok=True)
    input_worker.focus_window(hwnd)
    vis.reset_to_world(hwnd)

    result = {
        "attempt": attempt_index,
        "outputDir": str(output_dir),
        "steps": [],
    }

    result["steps"].append({
        "step": "world-reset",
        **record_after(hwnd, output_dir, "world-reset"),
    })

    target_candidates: list[tuple[dict, dict]] = []
    bounds = vis.get_window_bounds(hwnd)
    for preferred_name in PREFERRED_TARGET_NAMES:
        named_anchor = input_worker.find_named_npc_in_scene(hwnd, preferred_name)
        if not named_anchor:
            continue
        target_candidates.append((
            {"name": preferred_name},
            {
                "screenX": int(named_anchor["screenX"]),
                "screenY": int(named_anchor["screenY"]),
                "clientX": int(named_anchor["screenX"] - bounds["left"]),
                "clientY": int(named_anchor["screenY"] - bounds["top"]),
                "name": preferred_name,
                "source": "preferred_named_anchor",
            },
        ))
    for candidate_index in range(1, 6):
        random_target = vis.find_random_npc_target(hwnd, attempt_index + candidate_index - 1)
        if random_target is None:
            continue
        target_candidates.append((random_target, vis.build_target_click_from_bbox(hwnd, random_target)))

    if not target_candidates:
        raise RuntimeError("RANDOM_TARGET_NOT_FOUND")

    selected_state = None
    selected_click = None
    target = None
    target_click = None
    view_click = None

    for candidate_number, (candidate_target, candidate_click) in enumerate(target_candidates, start=1):
        result["steps"].append({
            "step": f"candidate-{candidate_number}",
            "targetName": candidate_target["name"],
            "targetClick": candidate_click,
        })
        for select_attempt in range(1, 4):
            named_anchor = input_worker.find_named_npc_in_scene(hwnd, candidate_target["name"])
            if named_anchor:
                selected_click = {
                    "screenX": int(named_anchor["screenX"]),
                    "screenY": int(named_anchor["screenY"]),
                    "clientX": int(named_anchor["screenX"] - bounds["left"]),
                    "clientY": int(named_anchor["screenY"] - bounds["top"]),
                    "name": candidate_target["name"],
                    "source": "named_anchor",
                }
            else:
                selected_click = candidate_click
            result["steps"].append(
                click_and_verify(
                    hwnd,
                    output_dir,
                    f"candidate-{candidate_number}-select-attempt-{select_attempt}",
                    selected_click,
                    WAIT_AFTER_TARGET_CLICK_MS,
                )
            )
            selected_state = vis.detect_selection_state(vis.capture_full_client(hwnd), candidate_click)
            if selected_state["selected"]:
                break
        if not selected_state or not selected_state["selected"]:
            vis.reset_to_world(hwnd)
            continue

        tentative_view_click = input_worker.find_view_button_near_target(hwnd, candidate_target["name"])
        if tentative_view_click is None:
            tentative_view_click = input_worker.find_view_button_near_click(hwnd, selected_click["screenX"], selected_click["screenY"])
        if tentative_view_click is None:
            vis.reset_to_world(hwnd)
            continue

        target = candidate_target
        target_click = candidate_click
        view_click = tentative_view_click
        break

    if target is None or selected_click is None or view_click is None:
        raise RuntimeError("VIEW_BUTTON_NOT_FOUND")

    result["target"] = target_click
    bounds = vis.get_window_bounds(hwnd)
    view_click["clientX"] = int(view_click["screenX"] - bounds["left"])
    view_click["clientY"] = int(view_click["screenY"] - bounds["top"])
    result["steps"].append(click_and_verify(hwnd, output_dir, "open-view", view_click))

    trade_click = build_named_point(hwnd, "trade")
    result["steps"].append(click_and_verify(hwnd, output_dir, "open-trade", trade_click))
    trade_stage = stage_snapshot(hwnd)
    if trade_stage["stage"] != "trade_screen":
        raise RuntimeError(f"TRADE_SCREEN_NOT_OPENED: {trade_stage['stage']}")

    trade_points = [
        "trade_left_item_tab",
        "trade_left_item_slot",
        "trade_right_money_slot",
        "trade_scale_button",
        "trade_final_submit_button",
    ]
    for point_name in trade_points[:2]:
        step = click_and_verify(hwnd, output_dir, point_name, build_named_point(hwnd, point_name))
        result["steps"].append(step)
        if step["afterStage"]["stage"] != "trade_screen":
            raise RuntimeError(f"TRADE_STEP_LEFT_SCREEN: {point_name} -> {step['afterStage']['stage']}")

    left_up_shelf_base = build_named_point(hwnd, "trade_item_popup_shelf_button")
    left_offset = LEFT_UP_SHELF_OFFSETS[(attempt_index - 1) % len(LEFT_UP_SHELF_OFFSETS)]
    left_up_shelf_point = with_offset(left_up_shelf_base, left_offset[0], left_offset[1])
    left_up_shelf_step = click_and_verify(
        hwnd,
        output_dir,
        f"trade_item_popup_shelf_button_offset_{left_offset[0]}_{left_offset[1]}",
        left_up_shelf_point,
    )
    result["steps"].append(left_up_shelf_step)
    if left_up_shelf_step["afterStage"]["stage"] != "trade_screen":
        raise RuntimeError(
            f"LEFT_UP_SHELF_OFFSET_FAILED: {left_offset[0]},{left_offset[1]} -> {left_up_shelf_step['afterStage']['stage']}"
        )

    for point_name in trade_points[2:4]:
        step = click_and_verify(hwnd, output_dir, point_name, build_named_point(hwnd, point_name))
        result["steps"].append(step)
        if step["afterStage"]["stage"] != "trade_screen":
            raise RuntimeError(f"TRADE_STEP_LEFT_SCREEN: {point_name} -> {step['afterStage']['stage']}")

    left_popup_state = detect_trade_popup(hwnd)
    result["steps"].append({
        "step": "trade-left-popup-check",
        "popupState": left_popup_state,
        **record_after(hwnd, output_dir, "trade-left-popup-check"),
    })
    if left_popup_state["visible"]:
        raise RuntimeError(f"LEFT_UP_SHELF_POPUP_STILL_VISIBLE: {left_popup_state['text']}")

    money_slot_base = build_named_point(hwnd, "trade_right_money_slot")
    money_offset = RIGHT_MONEY_SLOT_OFFSETS[(attempt_index - 1) % len(RIGHT_MONEY_SLOT_OFFSETS)]
    money_slot_point = with_offset(money_slot_base, money_offset[0], money_offset[1])
    money_step = click_and_verify(
        hwnd,
        output_dir,
        f"trade_right_money_slot_offset_{money_offset[0]}_{money_offset[1]}",
        money_slot_point,
    )
    result["steps"].append(money_step)
    money_popup_state = detect_trade_popup(hwnd)
    result["steps"].append({
        "step": "trade-right-popup-open-check",
        "popupState": money_popup_state,
        **record_after(hwnd, output_dir, "trade-right-popup-open-check"),
    })
    if not money_popup_state["visible"]:
        raise RuntimeError(f"RIGHT_MONEY_SLOT_DID_NOT_OPEN_POPUP: {money_popup_state['text']}")

    scale_step = click_and_verify(hwnd, output_dir, "trade_scale_button", build_named_point(hwnd, "trade_scale_button"))
    result["steps"].append(scale_step)
    scale_popup_state = detect_trade_popup(hwnd)
    result["steps"].append({
        "step": "trade-scale-popup-check",
        "popupState": scale_popup_state,
        **record_after(hwnd, output_dir, "trade-scale-popup-check"),
    })
    if not scale_popup_state["visible"]:
        raise RuntimeError(f"TRADE_SCALE_LEFT_POPUP: {scale_popup_state['text']}")

    right_up_shelf_base = build_named_point(hwnd, "trade_coin_popup_shelf_button")
    right_offset = RIGHT_UP_SHELF_OFFSETS[(attempt_index - 1) % len(RIGHT_UP_SHELF_OFFSETS)]
    right_up_shelf_point = with_offset(right_up_shelf_base, right_offset[0], right_offset[1])
    right_up_shelf_step = click_and_verify(
        hwnd,
        output_dir,
        f"trade_coin_popup_shelf_button_offset_{right_offset[0]}_{right_offset[1]}",
        right_up_shelf_point,
    )
    result["steps"].append(right_up_shelf_step)
    right_popup_state = detect_trade_popup(hwnd)
    result["steps"].append({
        "step": "trade-right-popup-close-check",
        "popupState": right_popup_state,
        **record_after(hwnd, output_dir, "trade-right-popup-close-check"),
    })
    if right_popup_state["visible"] or right_up_shelf_step["afterStage"]["stage"] != "trade_screen":
        raise RuntimeError(
            f"RIGHT_UP_SHELF_OFFSET_FAILED: {right_offset[0]},{right_offset[1]} -> "
            f"{right_up_shelf_step['afterStage']['stage']} popup={right_popup_state['text']}"
        )

    final_submit_step = click_and_verify(
        hwnd,
        output_dir,
        "trade_final_submit_button",
        build_named_point(hwnd, "trade_final_submit_button"),
    )
    result["steps"].append(final_submit_step)

    input_worker.exit_panel(hwnd)
    time.sleep(0.35)
    result["steps"].append({
        "step": "trade-exit-panel",
        **record_after(hwnd, output_dir, "trade-exit-panel"),
    })

    gift_click = build_named_point(hwnd, "gift")
    result["steps"].append(click_and_verify(hwnd, output_dir, "open-gift", gift_click))
    gift_state = stage_snapshot(hwnd)
    if gift_state["stage"] != "gift_screen":
        raise RuntimeError(f"GIFT_SCREEN_NOT_OPENED: {gift_state['stage']}")

    threshold_info = input_worker.detect_target_threshold(hwnd)
    favor_before = input_worker.parse_favor_value(gift_state["texts"].get("gift_panel", ""))
    result["thresholdInfo"] = threshold_info
    result["favorBefore"] = favor_before

    gift_round = 0
    while True:
        gift_round += 1
        slot_step = click_and_verify(hwnd, output_dir, f"gift-slot-{gift_round:02d}", build_named_point(hwnd, "gift_first_slot"), 180)
        result["steps"].append(slot_step)
        submit_step = click_and_verify(hwnd, output_dir, f"gift-submit-{gift_round:02d}", build_named_point(hwnd, "gift_submit"), 460)
        result["steps"].append(submit_step)
        updated_state = stage_snapshot(hwnd)
        if updated_state["stage"] != "gift_screen":
            raise RuntimeError(f"GIFT_SCREEN_LEFT_EARLY: {updated_state['stage']}")
        favor_after = input_worker.parse_favor_value(updated_state["texts"].get("gift_panel", ""))
        result["favorAfter"] = favor_after
        result["giftRounds"] = gift_round
        if favor_after is not None and favor_after >= threshold_info["threshold"]:
            break
        if gift_round >= 6:
            break

    input_worker.exit_panel(hwnd)
    time.sleep(0.35)
    result["steps"].append({
        "step": "gift-exit-panel",
        **record_after(hwnd, output_dir, "gift-exit-panel"),
    })

    result["steps"].append(ensure_chat_ready(hwnd, output_dir, "talk"))
    for index, line in enumerate(CHAT_LINES, start=1):
        result["steps"].append(send_chat_round(hwnd, output_dir, index, line))
    result["steps"].append(close_chat(hwnd, output_dir))
    result["finalStage"] = stage_snapshot(hwnd)
    return result


def main() -> int:
    hwnd, activation = input_worker.resolve_game_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        raise RuntimeError("GAME_WINDOW_NOT_FOUND")

    TMP_DIR.mkdir(parents=True, exist_ok=True)
    input_worker.INPUT_GUARD.configure(False)

    attempts = []
    for attempt_index in range(1, MAX_TARGET_ATTEMPTS + 1):
        try:
            row = attempt_full_flow(hwnd, attempt_index)
            attempts.append({"status": "SUCCESS", **row, "activationFallback": activation})
            emit({"phase": "full_flow_success", **attempts[-1]})
            return 0
        except Exception as exc:
            failure = {
                "phase": "full_flow_failure",
                "attempt": attempt_index,
                "status": "FAIL",
                "error": str(exc),
                "activationFallback": activation,
            }
            attempts.append(failure)
            emit(failure)
            try:
                vis.reset_to_world(hwnd)
            except Exception as reset_exc:
                emit({
                    "phase": "reset_failure",
                    "attempt": attempt_index,
                    "error": str(reset_exc),
                })

    emit({
        "phase": "full_flow_summary",
        "status": "FAIL",
        "attempts": attempts,
        "resultDir": str(TMP_DIR),
    })
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
