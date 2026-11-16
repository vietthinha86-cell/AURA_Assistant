# -*- coding: utf-8 -*-
"""
============================================================================
MODULE C: FASTER-WHISPER STT WORKER (Python, chạy CPU, int8)
- Model "small", compute_type="int8", device="cpu"
- CHỈ nạp model khi nhận lệnh "load" hoặc "transcribe" (lazy-load)
- Giao tiếp JSON-lines qua stdin/stdout (audio gửi dạng PCM Int16 16kHz mono Base64)
- Tự nhận diện ngôn ngữ, giới hạn trong {vi, en}
- Việc GIẢI PHÓNG model do tiến trình chủ (Electron) quyết định: sau ~30 giây
  không dùng sẽ tắt hẳn tiến trình Python này để trả toàn bộ RAM cho hệ thống.
============================================================================
"""
import sys
import os
import json
import time
import base64
import ctypes
from ctypes import wintypes

if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("HF_HOME", os.path.join(PROJECT_ROOT, "models", "hf_cache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

MODEL_DIR = os.path.join(PROJECT_ROOT, "models", "whisper")
MODEL_SIZE = os.environ.get("STT_MODEL_SIZE", "small")
COMPUTE_TYPE = os.environ.get("STT_COMPUTE_TYPE", "int8")
CPU_THREADS = int(os.environ.get("STT_CPU_THREADS", str(min(8, os.cpu_count() or 4))))
ALLOWED_LANGS = ("vi", "en")
DEFAULT_INITIAL_PROMPT = "Aura, YouTube, Chrome, Notepad, Thịnh, SWT301, thư mục, ổ D, mở, tìm."

_model = None


def emit(obj):
    print(json.dumps(obj, ensure_ascii=True), flush=True)


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def working_set_mb() -> float:
    """RAM thực (Working Set) của chính tiến trình Python này, đơn vị MB."""
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [
            wintypes.HANDLE,
            ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
            wintypes.DWORD,
        ]
        psapi.GetProcessMemoryInfo.restype = wintypes.BOOL

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        handle = kernel32.GetCurrentProcess()
        ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
        if ok:
            return round(counters.WorkingSetSize / (1024 * 1024), 1)
    except Exception:
        pass
    return -1.0


def ensure_model():
    """Nạp model nếu chưa có. Trả về (model, loadMs, justLoaded)."""
    global _model
    if _model is not None:
        return _model, 0, False
    t0 = time.perf_counter()
    from faster_whisper import WhisperModel

    os.makedirs(MODEL_DIR, exist_ok=True)
    _model = WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type=COMPUTE_TYPE,
        cpu_threads=CPU_THREADS,
        download_root=MODEL_DIR,
    )
    load_ms = round((time.perf_counter() - t0) * 1000)
    return _model, load_ms, True


def pick_vi_en(info):
    """Chỉ cho phép vi/en: nếu Whisper đoán ngôn ngữ khác, chọn vi hoặc en có xác suất cao hơn."""
    lang = info.language
    if lang in ALLOWED_LANGS:
        return lang
    probs = dict(info.all_language_probs or [])
    return "vi" if probs.get("vi", 0.0) >= probs.get("en", 0.0) else "en"


def handle_transcribe(req):
    import numpy as np

    req_id = req.get("id", "0")
    t_req = time.perf_counter()
    model, load_ms, just_loaded = ensure_model()

    raw = base64.b64decode(req["pcmBase64"])
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    audio_sec = round(len(pcm) / 16000.0, 2)

    forced_lang = req.get("lang")
    if forced_lang not in ALLOWED_LANGS:
        forced_lang = None

    prompt = req.get("initial_prompt") or DEFAULT_INITIAL_PROMPT
    beam_size = int(req.get("beam_size", 1))

    t0 = time.perf_counter()
    segments, info = model.transcribe(
        pcm,
        language=forced_lang,
        beam_size=beam_size,
        best_of=beam_size,
        temperature=0.0,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200},
        condition_on_previous_text=False,
        without_timestamps=True,
        initial_prompt=prompt,
    )
    text = " ".join(seg.text.strip() for seg in segments).strip()
    lang = forced_lang or pick_vi_en(info)
    lang_prob = round(float(info.language_probability or 0.0), 3)

    # Whisper đoán sai sang ngôn ngữ khác (không phải vi/en) -> chạy lại với vi/en đã chọn
    if forced_lang is None and info.language not in ALLOWED_LANGS:
        segments, info = model.transcribe(
            pcm,
            language=lang,
            beam_size=beam_size,
            best_of=beam_size,
            temperature=0.0,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300, "speech_pad_ms": 200},
            condition_on_previous_text=False,
            without_timestamps=True,
            initial_prompt=prompt,
        )
        text = " ".join(seg.text.strip() for seg in segments).strip()

    transcribe_ms = round((time.perf_counter() - t0) * 1000)
    emit({
        "id": req_id,
        "type": "result",
        "text": text,
        "lang": lang,
        "langProb": lang_prob,
        "audioSec": audio_sec,
        "transcribeMs": transcribe_ms,
        "loadMs": load_ms,
        "justLoaded": just_loaded,
        "workerTotalMs": round((time.perf_counter() - t_req) * 1000),
        "rssMb": working_set_mb(),
    })


def main():
    emit({"type": "ready", "status": "stt worker online (model chưa nạp)", "rssMb": working_set_mb()})
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        req_id = "0"
        try:
            req = json.loads(line)
            req_id = req.get("id", "0")
            cmd = req.get("cmd", "transcribe")
            if cmd == "quit":
                break
            elif cmd == "load":
                rss_before = working_set_mb()
                _, load_ms, just_loaded = ensure_model()
                emit({
                    "id": req_id,
                    "type": "loaded",
                    "loadMs": load_ms,
                    "justLoaded": just_loaded,
                    "rssBeforeMb": rss_before,
                    "rssMb": working_set_mb(),
                    "model": MODEL_SIZE,
                    "computeType": COMPUTE_TYPE,
                })
            elif cmd == "transcribe":
                handle_transcribe(req)
        except Exception as exc:
            emit({"id": req_id, "type": "error", "error": "%s: %s" % (type(exc).__name__, exc)})


if __name__ == "__main__":
    main()

