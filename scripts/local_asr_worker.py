import json
import os
import re
import sys
import traceback
import wave

import numpy as np

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


def load_wav_audio(audio_path):
    with wave.open(audio_path, "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        pcm_bytes = wav_file.readframes(frame_count)

    if sample_width != 2:
        raise ValueError(f"Unsupported wav sample width: {sample_width}")

    samples = np.frombuffer(pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    return samples, sample_rate


def normalize_transcript(text):
    normalized = str(text or "").strip()
    if not normalized:
        return ""

    normalized = normalized.replace("\u3000", " ")
    normalized = re.sub(r"\s+", " ", normalized)
    normalized = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])", "", normalized)
    normalized = re.sub(r"(?<=[\u4e00-\u9fff])\s+(?=[，。！？；：、])", "", normalized)
    normalized = re.sub(r"(?<=[，。！？；：、])\s+", "", normalized)
    normalized = re.sub(r"([，。！？；：、,.!?])\1+", r"\1", normalized)
    normalized = re.sub(r"(好的){2,}", "好的", normalized)
    normalized = re.sub(r"(对){3,}", "对", normalized)
    normalized = re.sub(r"(嗯){3,}", "嗯", normalized)
    normalized = re.sub(r"(啊){3,}", "啊", normalized)

    normalized = normalized.strip(" ，。！？；：、")
    if not normalized:
        return ""

    if re.search(r"[，。！？；：、,.!?]$", normalized) is None:
        if re.search(r"(吗|呢|吧|呀|啊|么)$", normalized):
            normalized = f"{normalized}？"
        elif len(normalized) >= 12:
            normalized = f"{normalized}。"

    return normalized


def transcribe(model, request):
    language = request.get("language") or os.getenv("LOCAL_ASR_LANGUAGE", "zh")
    initial_prompt = os.getenv(
        "LOCAL_ASR_INITIAL_PROMPT",
        "以下内容是简体中文普通话口语转写，可能涉及《天涯明月刀》的任务名、NPC 名称、地名和玩家口语，请尽量按发音准确转写。",
    )

    audio_samples, sample_rate = load_wav_audio(request["audio_path"])

    generate_kwargs = {
        "input": audio_samples,
        "sample_rate": sample_rate,
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

    return normalize_transcript(rich_transcription_postprocess(text).strip())


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
