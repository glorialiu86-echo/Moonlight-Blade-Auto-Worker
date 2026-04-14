import base64
import io
import json
import os
import re
import sys
import traceback

import numpy as np
from PIL import Image
from rapidocr_onnxruntime import RapidOCR


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def build_engine():
    engine = RapidOCR()
    emit(
        {
            "type": "ready",
            "engine": "rapidocr_onnxruntime",
            "max_side": int(os.getenv("LOCAL_OCR_MAX_IMAGE_SIDE", "1600")),
        }
    )
    return engine


def decode_image(image_input):
    if not isinstance(image_input, str) or not image_input.startswith("data:image/"):
        raise ValueError("image_input must be a data:image/... URL")

    _, encoded = image_input.split(",", 1)
    image = Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGB")
    max_side = int(os.getenv("LOCAL_OCR_MAX_IMAGE_SIDE", "1600"))

    if max_side > 0:
        width, height = image.size
        longest = max(width, height)
        if longest > max_side:
            scale = max_side / float(longest)
            resized = (
                max(1, int(round(width * scale))),
                max(1, int(round(height * scale))),
            )
            image = image.resize(resized, Image.Resampling.LANCZOS)

    return np.array(image)


def normalize_text(text):
    text = str(text or "").strip()
    text = re.sub(r"\s+", " ", text)
    return text


def run_ocr(engine, request):
    image_array = decode_image(request.get("image_input"))
    result = engine(image_array)[0]

    if not result:
        return {
            "text": "",
            "lines": [],
        }

    lines = []
    for item in result:
        if len(item) < 3:
            continue

        text = item[1]
        score = item[2]
        normalized = normalize_text(text)
        if not normalized:
            continue

        lines.append(
            {
                "text": normalized,
                "score": float(score),
            }
        )

    return {
        "text": "\n".join(line["text"] for line in lines),
        "lines": lines,
    }


def main():
    try:
        engine = build_engine()
    except Exception as error:
        emit(
            {
                "type": "fatal",
                "error": str(error),
                "traceback": traceback.format_exc(),
            }
        )
        return 1

    for line in sys.stdin:
        raw = line.strip()

        if not raw:
            continue

        request = json.loads(raw)
        request_id = request.get("id")

        try:
            if request.get("type") != "ocr":
                raise ValueError("Unsupported request type")

            payload = run_ocr(engine, request)
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    **payload,
                }
            )
        except Exception as error:
            emit(
                {
                    "type": "error",
                    "id": request_id,
                    "error": str(error),
                    "traceback": traceback.format_exc(),
                }
            )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
