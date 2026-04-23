from __future__ import annotations

import ast
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_PATH = PROJECT_ROOT / "scripts" / "windows_input_worker.py"
OUTPUT_ROOT = PROJECT_ROOT / "tmp" / "ui_audit"
DESKTOP_DIR = Path(os.environ["USERPROFILE"]) / "Desktop"


@dataclass(frozen=True)
class AuditFrame:
    label: str
    second: float
    points: tuple[str, ...]
    frame_count: int = 5
    frame_interval_ms: int = 200


VIDEO_AUDIT_PLAN: dict[str, tuple[AuditFrame, ...]] = {
    "地图键盘和点击位.mp4": (
        AuditFrame("map_y_input", 3.0, ("map_coord_y_input",)),
        AuditFrame("map_keypad_vertical", 6.0, ("vertical:3", "vertical:9", "vertical:8", "vertical:confirm")),
        AuditFrame("map_x_input", 10.0, ("map_coord_x_input",)),
        AuditFrame("map_keypad_horizontal", 13.0, ("horizontal:3", "horizontal:9", "horizontal:8", "horizontal:confirm")),
        AuditFrame("map_go", 18.0, ("map_go",)),
        AuditFrame("teleport_confirm", 24.0, ("teleport_confirm",)),
    ),
    "货商买货（墨和散酒）.mp4": (
        AuditFrame("vendor_purchase_option", 8.5, ("vendor_purchase_option",)),
        AuditFrame("vendor_item_moding", 10.0, ("vendor_purchase_item_moding",)),
        AuditFrame("vendor_item_sanjiu", 14.0, ("vendor_purchase_item_sanjiu",)),
        AuditFrame("vendor_quantity", 12.5, ("vendor_purchase_max_quantity",)),
        AuditFrame("vendor_buy", 20.0, ("vendor_purchase_buy",)),
        AuditFrame("vendor_close", 24.0, ("vendor_purchase_close",)),
    ),
    "选人-点查看放大镜-拉起右下角UI-交易买一次卖一次-赠礼-聊天.mp4": (
        AuditFrame("trade_entry", 13.0, ("trade",)),
        AuditFrame("trade_flow_left", 18.0, ("trade_left_item_tab", "trade_left_item_slot", "trade_left_up_shelf_button")),
        AuditFrame("trade_flow_right", 24.0, ("trade_right_money_slot", "trade_scale_button", "trade_right_up_shelf_button")),
        AuditFrame("trade_submit", 29.0, ("trade_final_submit_button",)),
        AuditFrame("gift_entry", 36.0, ("gift",)),
        AuditFrame("gift_panel", 43.0, ("gift_first_slot", "gift_submit", "close_panel")),
        AuditFrame("talk_entry", 53.0, ("talk", "small_talk")),
        AuditFrame("chat_confirm", 57.0, ("small_talk_confirm_dialog", "small_talk_cancel_dialog")),
        AuditFrame("chat_send", 62.0, ("chat_input", "chat_send", "chat_exit")),
    ),
    "叫卖.mp4": (
        AuditFrame("hawking_inventory", 8.0, ("hawking_inventory_first_slot",)),
        AuditFrame("hawking_quantity", 9.5, ("hawking_max_quantity",)),
    ),
    "潜行-妙取.mp4": (
        AuditFrame("steal_button_1", 4.0, ("steal_button_1",)),
        AuditFrame("steal_button_2", 6.0, ("steal_button_2",)),
        AuditFrame("steal_button_3", 8.0, ("steal_button_3",)),
        AuditFrame("steal_button_4", 10.0, ("steal_button_4",)),
    ),
    "退出潜行.mp4": (
        AuditFrame("exit_stealth", 2.2, ("exit_stealth",)),
    ),
    "潜行-闷棍-扛起-放下-搜刮.mp4": (
        AuditFrame("drop_carried_target", 22.0, ("drop_carried_target",)),
        AuditFrame("loot_transfer", 29.0, ("loot_transfer_item",)),
        AuditFrame("loot_put_in", 33.0, ("loot_put_in",)),
        AuditFrame("loot_submit", 37.0, ("loot_submit",)),
    ),
}


def eval_expr(node: ast.AST, env: dict[str, float]) -> float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return float(node.value)
    if isinstance(node, ast.Name):
        return float(env[node.id])
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        return -eval_expr(node.operand, env)
    if isinstance(node, ast.BinOp):
        left = eval_expr(node.left, env)
        right = eval_expr(node.right, env)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
    raise ValueError(f"Unsupported expression: {ast.dump(node)}")


def extract_assignments() -> tuple[dict[str, tuple[float, float]], dict[str, dict[str, tuple[float, float]]]]:
    source = SOURCE_PATH.read_text(encoding="utf-8")
    module = ast.parse(source, filename=str(SOURCE_PATH))
    env = {
        "GAME_FIXED_CLIENT_WIDTH": 2560.0,
        "GAME_FIXED_CLIENT_HEIGHT": 1440.0,
    }
    action_points: dict[str, tuple[float, float]] = {}
    keypad_points: dict[str, dict[str, tuple[float, float]]] = {}
    for node in module.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1 or not isinstance(node.targets[0], ast.Name):
            continue
        name = node.targets[0].id
        if name == "ACTION_POINTS":
            assert isinstance(node.value, ast.Dict)
            for key_node, value_node in zip(node.value.keys, node.value.values):
                if not isinstance(key_node, ast.Constant) or not isinstance(key_node.value, str):
                    continue
                assert isinstance(value_node, ast.Tuple) and len(value_node.elts) == 2
                action_points[key_node.value] = (
                    eval_expr(value_node.elts[0], env),
                    eval_expr(value_node.elts[1], env),
                )
        if name == "MAP_KEYPAD_POINTS":
            assert isinstance(node.value, ast.Dict)
            for key_node, value_node in zip(node.value.keys, node.value.values):
                if not isinstance(key_node, ast.Constant) or not isinstance(key_node.value, str):
                    continue
                assert isinstance(value_node, ast.Dict)
                field_name = key_node.value
                keypad_points[field_name] = {}
                for sub_key_node, sub_value_node in zip(value_node.keys, value_node.values):
                    if not isinstance(sub_key_node, ast.Constant) or not isinstance(sub_key_node.value, str):
                        continue
                    assert isinstance(sub_value_node, ast.Tuple) and len(sub_value_node.elts) == 2
                    keypad_points[field_name][sub_key_node.value] = (
                        eval_expr(sub_value_node.elts[0], env),
                        eval_expr(sub_value_node.elts[1], env),
                    )
    return action_points, keypad_points


def point_ratio(point_name: str, action_points: dict[str, tuple[float, float]], keypad_points: dict[str, dict[str, tuple[float, float]]]) -> tuple[float, float]:
    if ":" in point_name:
        field_name, key_name = point_name.split(":", 1)
        return keypad_points[field_name][key_name]
    if point_name not in action_points:
        raise KeyError(f"Unknown fixed action point in audit plan: {point_name}")
    return action_points[point_name]


def draw_cross(image: np.ndarray, x: int, y: int, color: tuple[int, int, int]) -> None:
    cv2.line(image, (x - 20, y), (x + 20, y), color, 3, cv2.LINE_AA)
    cv2.line(image, (x, y - 20), (x, y + 20), color, 3, cv2.LINE_AA)
    cv2.circle(image, (x, y), 8, color, 2, cv2.LINE_AA)


def annotate_frame(
    frame: np.ndarray,
    frame_label: str,
    frame_second: float,
    points: tuple[str, ...],
    action_points: dict[str, tuple[float, float]],
    keypad_points: dict[str, dict[str, tuple[float, float]]],
) -> tuple[np.ndarray, list[dict[str, object]]]:
    annotated = frame.copy()
    height, width = annotated.shape[:2]
    metadata: list[dict[str, object]] = []
    colors = [
        (0, 0, 255),
        (0, 200, 0),
        (255, 80, 0),
        (255, 0, 255),
        (0, 180, 255),
        (255, 255, 0),
    ]
    cv2.putText(
        annotated,
        f"{frame_label} @ {frame_second:.1f}s",
        (28, 46),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.1,
        (255, 255, 255),
        3,
        cv2.LINE_AA,
    )
    for index, point_name in enumerate(points):
        x_ratio, y_ratio = point_ratio(point_name, action_points, keypad_points)
        x = round(width * x_ratio)
        y = round(height * y_ratio)
        color = colors[index % len(colors)]
        draw_cross(annotated, x, y, color)
        label = f"{point_name} ({x},{y})"
        text_y = 90 + index * 34
        cv2.putText(annotated, label, (28, text_y), cv2.FONT_HERSHEY_SIMPLEX, 0.84, color, 2, cv2.LINE_AA)
        metadata.append(
            {
                "pointName": point_name,
                "xRatio": round(x_ratio, 6),
                "yRatio": round(y_ratio, 6),
                "pixelX": x,
                "pixelY": y,
            }
        )
    return annotated, metadata


def save_contact_sheet(image_paths: list[Path], output_path: Path) -> None:
    images = [imread_unicode(path) for path in image_paths]
    images = [img for img in images if img is not None]
    if not images:
        return
    thumb_width = 960
    thumb_height = round(images[0].shape[0] * (thumb_width / images[0].shape[1]))
    cols = 2
    rows = math.ceil(len(images) / cols)
    sheet = np.zeros((rows * thumb_height, cols * thumb_width, 3), dtype=np.uint8)
    for idx, image in enumerate(images):
        resized = cv2.resize(image, (thumb_width, thumb_height), interpolation=cv2.INTER_AREA)
        row = idx // cols
        col = idx % cols
        y = row * thumb_height
        x = col * thumb_width
        sheet[y : y + thumb_height, x : x + thumb_width] = resized
    imwrite_unicode(output_path, sheet)


def extract_frame(video_path: Path, second: float) -> np.ndarray:
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video: {video_path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    frame_count = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 1
    target_frame = max(0, min(int(round(second * fps)), int(frame_count) - 1))
    cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)
    ok, frame = cap.read()
    cap.release()
    if not ok or frame is None:
        raise RuntimeError(f"Could not read frame {target_frame} from {video_path.name}")
    return frame


def sample_seconds(anchor_second: float, frame_count: int, frame_interval_ms: int) -> list[float]:
    interval_seconds = frame_interval_ms / 1000.0
    return [anchor_second + index * interval_seconds for index in range(max(1, frame_count))]


def imwrite_unicode(path: Path, image: np.ndarray) -> None:
    suffix = path.suffix or ".png"
    ok, encoded = cv2.imencode(suffix, image)
    if not ok:
        raise RuntimeError(f"Could not encode image for {path}")
    encoded.tofile(str(path))


def imread_unicode(path: Path) -> np.ndarray | None:
    if not path.exists():
        return None
    data = np.fromfile(str(path), dtype=np.uint8)
    if data.size == 0:
        return None
    return cv2.imdecode(data, cv2.IMREAD_COLOR)


def main() -> None:
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    action_points, keypad_points = extract_assignments()
    summary: dict[str, object] = {
        "source": str(SOURCE_PATH),
        "videos": {},
    }
    for video_name, frames in VIDEO_AUDIT_PLAN.items():
        video_path = DESKTOP_DIR / video_name
        if not video_path.exists():
            continue
        video_dir = OUTPUT_ROOT / video_path.stem
        video_dir.mkdir(parents=True, exist_ok=True)
        saved_paths: list[Path] = []
        frame_summaries: list[dict[str, object]] = []
        for audit_frame in frames:
            sampled_seconds = sample_seconds(
                audit_frame.second,
                audit_frame.frame_count,
                audit_frame.frame_interval_ms,
            )
            sequence_paths: list[Path] = []
            sequence_frames: list[dict[str, object]] = []
            for frame_index, frame_second in enumerate(sampled_seconds, start=1):
                frame = extract_frame(video_path, frame_second)
                annotated, point_meta = annotate_frame(
                    frame,
                    f"{audit_frame.label} [{frame_index}/{len(sampled_seconds)}]",
                    frame_second,
                    audit_frame.points,
                    action_points,
                    keypad_points,
                )
                output_path = video_dir / f"{audit_frame.label}_{frame_index:02d}.png"
                imwrite_unicode(output_path, annotated)
                saved_paths.append(output_path)
                sequence_paths.append(output_path)
                sequence_frames.append(
                    {
                        "second": round(frame_second, 3),
                        "image": str(output_path.relative_to(PROJECT_ROOT)),
                        "points": point_meta,
                    }
                )
            frame_summaries.append(
                {
                    "label": audit_frame.label,
                    "anchorSecond": audit_frame.second,
                    "frameCount": audit_frame.frame_count,
                    "frameIntervalMs": audit_frame.frame_interval_ms,
                    "frames": sequence_frames,
                    "sequenceImages": [str(path.relative_to(PROJECT_ROOT)) for path in sequence_paths],
                }
            )
        contact_sheet_path = video_dir / "_contact_sheet.png"
        save_contact_sheet(saved_paths, contact_sheet_path)
        summary["videos"][video_name] = {
            "frames": frame_summaries,
            "contactSheet": str(contact_sheet_path.relative_to(PROJECT_ROOT)),
        }
    (OUTPUT_ROOT / "audit_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print((OUTPUT_ROOT / "audit_summary.json").resolve())


if __name__ == "__main__":
    main()
