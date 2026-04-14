import json
import sys
import time
from typing import Any

import mss
import numpy as np
import pydirectinput
import pyperclip
import win32con
import win32gui
from rapidocr_onnxruntime import RapidOCR


pydirectinput.FAILSAFE = False
DEFAULT_POST_DELAY_MS = 350
DEFAULT_MOVE_PULSE_MS = 160
DEFAULT_INTERACT_TIMEOUT_MS = 4500
DEFAULT_SCAN_INTERVAL_MS = 180
DEFAULT_CAMERA_DRAG_MS = 220
OCR_ENGINE = None
NPC_STAGE_ROIS = {
    "look_button": (0.26, 0.48, 0.40, 0.62),
    "bottom_right_actions": (0.64, 0.70, 0.98, 0.98),
    "confirm_dialog": (0.16, 0.10, 0.84, 0.84),
    "chat_panel": (0.00, 0.00, 0.46, 0.98),
}


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

        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        area = max(0, right - left) * max(0, bottom - top)
        matches.append((hwnd, title, area))
        return True

    win32gui.EnumWindows(callback, 0)

    if not matches:
        return None

    matches.sort(key=lambda item: item[2], reverse=True)
    return matches[0][0]


def get_window_bounds(hwnd: int) -> dict[str, Any]:
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    return {
        "left": left,
        "top": top,
        "width": right - left,
        "height": bottom - top,
        "title": win32gui.GetWindowText(hwnd).strip(),
    }


def focus_window(hwnd: int) -> dict[str, Any]:
    bounds = get_window_bounds(hwnd)

    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
        time.sleep(0.2)

    try:
        win32gui.SetForegroundWindow(hwnd)
        bounds["focusMethod"] = "set_foreground"
        return bounds
    except Exception:
        center_x = bounds["left"] + max(1, bounds["width"]) // 2
        center_y = bounds["top"] + max(1, bounds["height"]) // 2
        pydirectinput.click(x=center_x, y=center_y)
        time.sleep(0.2)
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


def detect_dialog(hwnd: int) -> dict[str, Any]:
    title_text = ocr_text(capture_window_region(hwnd, (0.18, 0.08, 0.82, 0.36)))
    middle_text = ocr_text(capture_window_region(hwnd, (0.12, 0.18, 0.88, 0.62)))
    full_text = f"{title_text} {middle_text}".strip()

    keywords = [
        "对话",
        "交谈",
        "继续",
        "关闭",
        "任务",
        "接受",
        "提交",
        "剧情",
        "路人",
        "少侠",
    ]

    return {
        "visible": any(keyword in full_text for keyword in keywords),
        "text": full_text,
    }


def contains_any_keyword(text: str, keywords: list[str]) -> bool:
    normalized = str(text or "").replace(" ", "")
    return any(keyword in normalized for keyword in keywords)


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

    if contains_any_keyword(chat_panel_text, ["点击输入聊天", "发送", "第一次见面", "好感度"]):
        stage = "chat_ready"
    elif contains_any_keyword(confirm_text, ["确认", "闲聊", "取消"]):
        stage = "small_talk_confirm"
    elif contains_any_keyword(bottom_right_text, ["闲聊", "交谈"]):
        stage = "small_talk_menu"
    elif contains_any_keyword(bottom_right_text, ["交谈", "赠礼", "邀请", "战斗"]):
        stage = "npc_action_menu"
    elif contains_any_keyword(look_text, ["查看"]):
        stage = "npc_selected"
    else:
        stage = "none"

    return {
        "stage": stage,
        "texts": stage_texts,
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


def run_click_npc_interact(hwnd: int, action: dict[str, Any]) -> dict[str, Any]:
    action_id = str(action.get("id") or "")
    title = str(action.get("title") or "click_npc_interact")
    timeout_ms = int(action.get("timeoutMs") or DEFAULT_INTERACT_TIMEOUT_MS)
    move_pulse_ms = int(action.get("movePulseMs") or DEFAULT_MOVE_PULSE_MS)
    scan_interval_ms = int(action.get("scanIntervalMs") or DEFAULT_SCAN_INTERVAL_MS)

    click_points = [
        (0.50, 0.44),
        (0.47, 0.46),
        (0.53, 0.46),
        (0.50, 0.50),
    ]

    click_attempts = 0
    move_attempts = 0
    start_time = time.time()
    last_stage = "none"
    stage_history: list[str] = []
    click_point_attempts: list[dict[str, float]] = []
    camera_drags = 0

    focus_window(hwnd)

    while (time.time() - start_time) * 1000 < timeout_ms:
        stage_state = detect_npc_interaction_stage(hwnd)
        last_stage = stage_state["stage"]
        stage_history.append(last_stage)

        if last_stage == "chat_ready":
            dialog_state = detect_dialog(hwnd)
            return {
                "id": action_id,
                "title": title,
                "status": "performed",
                "detail": "Reached road NPC chat screen.",
                "input": {
                    "mode": "click_npc_interact",
                    "clickAttempts": click_attempts,
                    "moveAttempts": move_attempts,
                    "cameraDrags": camera_drags,
                    "stage": "chat_ready",
                    "stageHistory": stage_history,
                    "stageTexts": stage_state["texts"],
                    "dialogText": dialog_state["text"],
                },
            }

        if last_stage == "small_talk_confirm":
            confirm_click = click_npc_candidate(hwnd, 0.59, 0.80, "left")
            time.sleep(0.25)
            post_confirm_stage = detect_npc_interaction_stage(hwnd)
            stage_history.append(post_confirm_stage["stage"])
            if post_confirm_stage["stage"] == "chat_ready":
                dialog_state = detect_dialog(hwnd)
                return {
                    "id": action_id,
                    "title": title,
                    "status": "performed",
                    "detail": "Completed road NPC small-talk click chain.",
                    "input": {
                        "mode": "click_npc_interact",
                        "clickAttempts": click_attempts,
                        "moveAttempts": move_attempts,
                        "cameraDrags": camera_drags,
                        "stage": "chat_ready",
                        "stageHistory": stage_history,
                        "stageTexts": post_confirm_stage["texts"],
                        "confirmClick": confirm_click,
                        "dialogText": dialog_state["text"],
                        "postConfirmStage": post_confirm_stage["stage"],
                    },
                }
            continue

        if last_stage == "small_talk_menu":
            click_npc_candidate(hwnd, 0.69, 0.77, "left")
            click_attempts += 1
            time.sleep(0.22)
            continue

        if last_stage == "npc_action_menu":
            click_npc_candidate(hwnd, 0.74, 0.89, "left")
            click_attempts += 1
            time.sleep(0.22)
            continue

        if last_stage == "npc_selected":
            click_npc_candidate(hwnd, 0.32, 0.57, "left")
            click_attempts += 1
            time.sleep(0.22)
            continue

        x_ratio, y_ratio = click_points[click_attempts % len(click_points)]
        click_state = click_npc_candidate(hwnd, x_ratio, y_ratio, "left")
        click_point_attempts.append(
            {
                "xRatio": x_ratio,
                "yRatio": y_ratio,
            }
        )
        click_attempts += 1
        time.sleep(0.12)

        if click_attempts % len(click_points) == 0:
            move_attempts += 1
            pulse_forward(hwnd, move_pulse_ms)
            camera_drags += 1
            drag_camera(hwnd, (0.52, 0.48), (0.66, 0.48), DEFAULT_CAMERA_DRAG_MS)

        time.sleep(scan_interval_ms / 1000)

    raise RuntimeError(
        "Local click NPC interaction loop timed out before the chat screen was reached. "
        f"Last stage: {last_stage or 'none'}"
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

    try:
        results = [run_action(hwnd, action) for action in actions]
    except Exception as exc:
        emit(
            {
                "ok": False,
                "message": str(exc),
                "errorCode": "INPUT_EXECUTION_FAILED",
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
