import json
import sys
import time
from typing import Any

import pydirectinput
import win32con
import win32gui


pydirectinput.FAILSAFE = False
DEFAULT_POST_DELAY_MS = 350


def emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


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


def focus_window(hwnd: int) -> dict[str, Any]:
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    bounds = {
        "left": left,
        "top": top,
        "width": right - left,
        "height": bottom - top,
        "title": win32gui.GetWindowText(hwnd).strip(),
    }

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
            "detail": f"已聚焦窗口 {bounds['title']}",
            "bounds": bounds,
        }

    if action_type == "press_key":
        key = str(action.get("key") or "").strip().lower()
        if not key:
            raise RuntimeError("press_key 缺少 key")
        focus_window(hwnd)
        pydirectinput.press(key)
        time.sleep(post_delay_ms / 1000)
        return {
            "id": action_id,
            "title": title,
            "status": "performed",
            "detail": f"已发送按键 {key}",
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
            "detail": f"已点击窗口相对坐标 ({x_ratio:.3f}, {y_ratio:.3f})",
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
            "detail": f"已等待 {duration_ms}ms",
            "input": {"durationMs": duration_ms},
        }

    raise RuntimeError(f"不支持的输入动作: {action_type}")


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8")
    if not raw.strip():
        emit({"ok": False, "message": "未收到执行负载"})
        return

    payload = json.loads(raw)
    window_title_keyword = str(payload.get("windowTitleKeyword") or "天涯明月刀手游").strip()
    actions = payload.get("actions") or []

    if not actions:
        emit({"ok": False, "message": "没有可执行动作"})
        return

    hwnd = find_window(window_title_keyword)
    if not hwnd:
        emit({
            "ok": False,
            "message": f"未找到标题包含“{window_title_keyword}”的游戏窗口",
            "errorCode": "WINDOW_NOT_FOUND",
        })
        return

    try:
        results = [run_action(hwnd, action) for action in actions]
    except Exception as exc:
        emit({
            "ok": False,
            "message": str(exc),
            "errorCode": "INPUT_EXECUTION_FAILED",
        })
        return

    emit({
        "ok": True,
        "executor": "WindowsInputExecutor",
        "windowTitleKeyword": window_title_keyword,
        "steps": results,
    })


if __name__ == "__main__":
    main()
