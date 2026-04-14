import json
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
GAME_WINDOW_TITLE = "\u5929\u6daf\u660e\u6708\u5200\u624b\u6e38"


def draw_click_marker(image: np.ndarray, client_x: int, client_y: int) -> np.ndarray:
    marked = image.copy()
    center = (int(client_x), int(client_y))
    color = (0, 0, 255)
    cv2.circle(marked, center, 7, color, thickness=2)
    cv2.line(marked, (center[0] - 10, center[1]), (center[0] + 10, center[1]), color, thickness=2)
    cv2.line(marked, (center[0], center[1] - 10), (center[0], center[1] + 10), color, thickness=2)
    return marked


def save_image(image: np.ndarray, path: Path) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    rgb = image[:, :, ::-1]
    Image.fromarray(rgb.astype(np.uint8), mode="RGB").save(path)
    return str(path)


def main() -> int:
    hwnd = input_worker.find_window(GAME_WINDOW_TITLE)
    if hwnd is None:
        raise RuntimeError("GAME_WINDOW_NOT_FOUND")

    bounds = input_worker.get_window_bounds(hwnd)
    print(json.dumps({"phase": "ready", "message": "Place cursor and keep still for 3 seconds."}, ensure_ascii=False))
    time.sleep(3.0)

    screen_x, screen_y = win32api.GetCursorPos()
    client_x = int(screen_x - bounds["left"])
    client_y = int(screen_y - bounds["top"])

    image = input_worker.capture_window_region(hwnd, (0.0, 0.0, 1.0, 1.0))
    marked = draw_click_marker(image, client_x, client_y)
    screenshot = save_image(marked, TMP_DIR / "cursor-probe.png")

    print(
        json.dumps(
            {
                "phase": "captured",
                "screenX": int(screen_x),
                "screenY": int(screen_y),
                "clientX": int(client_x),
                "clientY": int(client_y),
                "screenshot": screenshot,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
