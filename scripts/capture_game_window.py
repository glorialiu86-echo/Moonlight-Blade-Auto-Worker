import argparse
import base64
import ctypes
import io
import json
import sys
from ctypes import wintypes

from PIL import ImageGrab

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", wintypes.LONG),
        ("top", wintypes.LONG),
        ("right", wintypes.LONG),
        ("bottom", wintypes.LONG),
    ]


class POINT(ctypes.Structure):
    _fields_ = [
        ("x", wintypes.LONG),
        ("y", wintypes.LONG),
    ]


EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

user32.EnumWindows.argtypes = [EnumWindowsProc, wintypes.LPARAM]
user32.EnumWindows.restype = wintypes.BOOL
user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
user32.GetWindowTextLengthW.restype = ctypes.c_int
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetWindowRect.restype = wintypes.BOOL
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(RECT)]
user32.GetClientRect.restype = wintypes.BOOL
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(POINT)]
user32.ClientToScreen.restype = wintypes.BOOL
user32.IsWindowVisible.argtypes = [wintypes.HWND]
user32.IsWindowVisible.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
user32.SetProcessDPIAware.argtypes = []
user32.SetProcessDPIAware.restype = wintypes.BOOL
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL
kernel32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def get_window_text(hwnd):
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return ""
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value.strip()


def get_virtual_screen():
    left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    width = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    height = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    return {
        "left": left,
        "top": top,
        "right": left + width,
        "bottom": top + height,
    }


def get_window_process_name(hwnd):
    process_id = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(process_id))
    if process_id.value == 0:
        return ""

    process_handle = kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, process_id.value
    )
    if not process_handle:
        return ""

    try:
        buffer_size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(buffer_size.value)
        if not kernel32.QueryFullProcessImageNameW(
            process_handle, 0, buffer, ctypes.byref(buffer_size)
        ):
            return ""
        full_path = buffer.value[: buffer_size.value]
        return full_path.rsplit("\\", 1)[-1].lower()
    finally:
        kernel32.CloseHandle(process_handle)


def collect_matching_windows(title_keyword):
    matches = []

    @EnumWindowsProc
    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True

        title = get_window_text(hwnd)
        process_name = get_window_process_name(hwnd)
        title_match = bool(title and title_keyword in title)
        process_match = process_name == "qsgame.exe"
        if not title_match and not process_match:
            return True

        window_rect = RECT()
        client_rect = RECT()
        client_origin = POINT(0, 0)

        if not user32.GetWindowRect(hwnd, ctypes.byref(window_rect)):
            return True
        if not user32.GetClientRect(hwnd, ctypes.byref(client_rect)):
            return True
        if not user32.ClientToScreen(hwnd, ctypes.byref(client_origin)):
            return True

        width = window_rect.right - window_rect.left
        height = window_rect.bottom - window_rect.top
        client_width = client_rect.right - client_rect.left
        client_height = client_rect.bottom - client_rect.top

        matches.append(
            {
                "title": title,
                "is_minimized": bool(user32.IsIconic(hwnd)),
                "left": window_rect.left,
                "top": window_rect.top,
                "width": width,
                "height": height,
                "client_left": client_origin.x,
                "client_top": client_origin.y,
                "client_width": client_width,
                "client_height": client_height,
                "area": width * height,
                "exact_title_match": title == title_keyword,
                "title_match": title_match,
                "process_name": process_name,
                "process_match": process_match,
            }
        )
        return True

    user32.EnumWindows(callback, 0)
    return matches


def capture_to_data_url(bounds):
    image = ImageGrab.grab(
        bbox=(
            bounds["left"],
            bounds["top"],
            bounds["left"] + bounds["width"],
            bounds["top"] + bounds["height"],
        ),
        all_screens=True,
    ).convert("RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=88, optimize=True)
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--window-title-keyword", required=True)
    parser.add_argument("--min-width", type=int, default=640)
    parser.add_argument("--min-height", type=int, default=360)
    args = parser.parse_args()

    user32.SetProcessDPIAware()

    matches = collect_matching_windows(args.window_title_keyword)
    if not matches:
        emit(
            {
                "ok": False,
                "errorCode": "WINDOW_NOT_FOUND",
                "message": "No visible window matched the requested title keyword.",
            }
        )
        return 0

    selected = sorted(
        matches,
        key=lambda item: (
            1 if item["exact_title_match"] else 0,
            1 if item["title_match"] else 0,
            1 if item["process_match"] else 0,
            item["area"],
        ),
        reverse=True,
    )[0]

    if selected["is_minimized"]:
        emit(
            {
                "ok": False,
                "errorCode": "WINDOW_MINIMIZED",
                "message": "The target window is minimized and cannot be captured.",
                "windowTitle": selected["title"],
                "processName": selected["process_name"],
            }
        )
        return 0

    if selected["client_width"] < args.min_width or selected["client_height"] < args.min_height:
        emit(
            {
                "ok": False,
                "errorCode": "INVALID_BOUNDS",
                "message": "The target client area is smaller than the minimum capture size.",
                "windowTitle": selected["title"],
                "processName": selected["process_name"],
                "bounds": {
                    "left": selected["client_left"],
                    "top": selected["client_top"],
                    "width": selected["client_width"],
                    "height": selected["client_height"],
                },
            }
        )
        return 0

    virtual = get_virtual_screen()
    left = max(selected["client_left"], virtual["left"])
    top = max(selected["client_top"], virtual["top"])
    right = min(selected["client_left"] + selected["client_width"], virtual["right"])
    bottom = min(selected["client_top"] + selected["client_height"], virtual["bottom"])
    width = right - left
    height = bottom - top

    if width < args.min_width or height < args.min_height:
        emit(
            {
                "ok": False,
                "errorCode": "INVALID_BOUNDS",
                "message": "The visible area of the target client area is too small to capture.",
                "windowTitle": selected["title"],
                "processName": selected["process_name"],
                "bounds": {
                    "left": left,
                    "top": top,
                    "width": width,
                    "height": height,
                },
            }
        )
        return 0

    emit(
        {
            "ok": True,
            "windowTitle": selected["title"],
            "processName": selected["process_name"],
            "bounds": {
                "left": left,
                "top": top,
                "width": width,
                "height": height,
            },
            "imageDataUrl": capture_to_data_url(
                {"left": left, "top": top, "width": width, "height": height}
            ),
            "capturedAt": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
