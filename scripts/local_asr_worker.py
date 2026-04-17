import json
import os
import sys
import traceback

from funasr import AutoModel
from funasr.utils.postprocess_utils import rich_transcription_postprocess


WHISPER_MODEL_ALIASES = {
    "tiny",
    "base",
    "small",
    "medium",
    "large",
    "large-v2",
    "large-v3",
}


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def resolve_model_name():
    model_name = os.getenv("LOCAL_ASR_MODEL", "paraformer-zh").strip() or "paraformer-zh"

    if model_name in WHISPER_MODEL_ALIASES:
        return "paraformer-zh"

    return model_name


def build_model():
    model_name = resolve_model_name()
    device = os.getenv("LOCAL_ASR_DEVICE", "cpu").strip() or "cpu"
    cpu_threads = int(os.getenv("LOCAL_ASR_CPU_THREADS", "4"))
    disable_update = os.getenv("LOCAL_ASR_DISABLE_UPDATE", "true").lower() != "false"
    model_cache_dir = os.getenv("LOCAL_ASR_MODEL_CACHE_DIR") or None
    if model_cache_dir and "faster-whisper" in model_cache_dir.lower():
        model_cache_dir = None

    model_kwargs = {
        "model": model_name,
        "device": device,
        "disable_update": disable_update,
        "hub": "ms",
        "model_revision": os.getenv("LOCAL_ASR_MODEL_REVISION", "master"),
    }

    if model_cache_dir:
        model_kwargs["model_dir"] = model_cache_dir

    vad_model = (os.getenv("LOCAL_ASR_VAD_MODEL") or "").strip()
    if vad_model:
        model_kwargs["vad_model"] = vad_model
        model_kwargs["vad_model_revision"] = os.getenv("LOCAL_ASR_VAD_MODEL_REVISION", "master")

    punc_model = (os.getenv("LOCAL_ASR_PUNC_MODEL") or "").strip()
    if punc_model:
        model_kwargs["punc_model"] = punc_model
        model_kwargs["punc_model_revision"] = os.getenv("LOCAL_ASR_PUNC_MODEL_REVISION", "master")

    model = AutoModel(**model_kwargs)

    try:
        import torch

        torch.set_num_threads(cpu_threads)
    except Exception:
        pass

    emit(
        {
            "type": "ready",
            "model": model_name,
            "device": device,
            "cpu_threads": cpu_threads,
            "engine": "funasr",
        }
    )
    return model


def transcribe(model, request):
    language = request.get("language") or os.getenv("LOCAL_ASR_LANGUAGE", "zh")
    initial_prompt = os.getenv(
        "LOCAL_ASR_INITIAL_PROMPT",
        "以下内容是简体中文普通话口语转写，可能涉及《天涯明月刀》的任务名、NPC 名称、地名和玩家口语，请尽量按发音准确转写。",
    )

    generate_kwargs = {
        "input": request["audio_path"],
        "language": language,
        "batch_size_s": 30,
        "use_itn": True,
    }

    if initial_prompt:
        generate_kwargs["hotword"] = initial_prompt

    if (os.getenv("LOCAL_ASR_VAD_MODEL") or "").strip():
        generate_kwargs["merge_vad"] = True
        generate_kwargs["merge_length_s"] = 12

    result = model.generate(**generate_kwargs)

    if not result:
        return ""

    text = str(result[0].get("text", "")).strip()
    if not text:
        return ""

    return rich_transcription_postprocess(text).strip()


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
