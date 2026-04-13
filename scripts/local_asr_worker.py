import json
import os
import sys
import traceback

from faster_whisper import WhisperModel


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def build_model():
    model_name = os.getenv("LOCAL_ASR_MODEL", "small")
    compute_type = os.getenv("LOCAL_ASR_COMPUTE_TYPE", "int8")
    cpu_threads = int(os.getenv("LOCAL_ASR_CPU_THREADS", "4"))
    download_root = os.getenv("LOCAL_ASR_MODEL_CACHE_DIR") or None

    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type=compute_type,
        cpu_threads=cpu_threads,
        download_root=download_root,
    )

    emit(
        {
            "type": "ready",
            "model": model_name,
            "compute_type": compute_type,
            "cpu_threads": cpu_threads,
        }
    )
    return model


def transcribe(model, request):
    language = request.get("language") or os.getenv("LOCAL_ASR_LANGUAGE", "zh")
    beam_size = int(request.get("beam_size") or 5)
    best_of = int(request.get("best_of") or 5)
    initial_prompt = os.getenv(
        "LOCAL_ASR_INITIAL_PROMPT",
        "以下内容是简体中文普通话口语转写，可能涉及《天涯明月刀》的任务名、NPC 名称、地名和玩家口语，请尽量按发音准确转写。",
    )
    segments, _ = model.transcribe(
        request["audio_path"],
        language=language,
        beam_size=beam_size,
        best_of=best_of,
        vad_filter=True,
        condition_on_previous_text=False,
        word_timestamps=False,
        temperature=0,
        initial_prompt=initial_prompt,
    )
    text = "".join(segment.text for segment in segments).strip()
    return text


def main():
    try:
        model = build_model()
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

            text = transcribe(model, request)
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "text": text,
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
