import json
import os
import sys
import traceback

from faster_whisper import WhisperModel

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def optional_env(name, fallback=""):
    value = os.getenv(name, "").strip()
    return value or fallback


def parse_int(name, fallback):
    raw = optional_env(name, str(fallback))
    try:
        return int(raw)
    except ValueError:
        return fallback


def build_model():
    model_name = optional_env("LOCAL_ASR_MODEL", "medium")
    device = optional_env("LOCAL_ASR_DEVICE", "cpu")
    compute_type = optional_env("LOCAL_ASR_COMPUTE_TYPE", "int8")
    cpu_threads = parse_int("LOCAL_ASR_CPU_THREADS", 4)
    model_cache_dir = optional_env("LOCAL_ASR_MODEL_CACHE_DIR", "")

    return WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=cpu_threads,
        download_root=model_cache_dir or None,
    )


def normalize_text(text):
    return " ".join(str(text or "").strip().split())


def transcribe_audio(model, request):
    audio_path = str(request.get("audio_path") or "").strip()
    if not audio_path:
        raise ValueError("audio_path is required")

    language = str(request.get("language") or optional_env("LOCAL_ASR_LANGUAGE", "zh")).strip() or "zh"
    initial_prompt = optional_env("LOCAL_ASR_INITIAL_PROMPT", "")

    segments, info = model.transcribe(
        audio_path,
        language=language,
        initial_prompt=initial_prompt or None,
        vad_filter=True,
        condition_on_previous_text=False,
        without_timestamps=True,
    )

    text = normalize_text("".join(segment.text for segment in segments))
    return {
        "text": text,
        "language": getattr(info, "language", language),
        "duration": float(getattr(info, "duration", 0.0) or 0.0),
    }


def main():
    try:
        build = build_model()
        emit(
            {
                "type": "ready",
                "engine": "faster-whisper",
                "model": optional_env("LOCAL_ASR_MODEL", "medium"),
                "device": optional_env("LOCAL_ASR_DEVICE", "cpu"),
                "compute_type": optional_env("LOCAL_ASR_COMPUTE_TYPE", "int8"),
            }
        )
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
            if request.get("type") != "transcribe":
                raise ValueError("Unsupported request type")

            payload = transcribe_audio(build, request)
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
