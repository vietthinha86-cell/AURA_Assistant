# -*- coding: utf-8 -*-
"""
============================================================================
MODULE D: EDGE-TTS STREAMING WORKER (Python Async Daemon)
- Hỗ trợ textBase64 để đảm bảo 100% tiếng Việt có dấu không bao giờ lỗi mã hoá
- Tự động nhận diện ngôn ngữ Tiếng Việt (vi-VN-HoaiMyNeural) / Tiếng Anh (en-US-AriaNeural)
- Trích xuất mốc thời gian từng từ (WordBoundary: offsetMs, durationMs, text)
  để đồng bộ khẩu hình miệng (Viseme / Diphthong Lip-Sync) chính xác tới từng mili-giây
- Lưu trữ tự động độ lệch đồng hồ hệ thống (DRM.clock_skew_seconds)
- Hỗ trợ xử lý song song nhiều câu (Concurrent Tasks) qua asyncio.create_task
- Bộ đệm RAM In-Memory Cache và Preload các câu ngắn hay dùng để phát tức thì ~1ms
- Hỗ trợ timeout cấu hình cho câu đầu (mặc định 6.0s) và retry nhanh
============================================================================
"""
import sys
import os
import json
import time
import re
import hashlib
import asyncio
import base64
import edge_tts
from edge_tts.drm import DRM

if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

VI_DIACRITIC_RE = re.compile(
    r"[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]",
    re.IGNORECASE,
)

VI_COMMON_WORDS = {
    "xin", "chao", "toi", "ban", "anh", "chi", "em", "sep", "hom", "nay",
    "ngay", "thang", "nam", "cam", "on", "vui", "buon", "khong", "duoc",
    "giup", "may", "tinh", "tieng", "viet", "noi", "nghe", "la", "cua",
    "cho", "oi", "nha", "nhe", "rat", "tot", "dep", "lam", "gi", "dau",
    "sao", "the", "nao", "mot", "hai", "ba", "bon", "nam", "sau", "bay"
}

# Khóa đồng bộ xuất dữ liệu ra stdout tránh xen kẽ dòng khi chạy song song
STDOUT_LOCK = asyncio.Lock()

# Bộ nhớ RAM Cache cho các câu đã tạo (đặc biệt là các câu ngắn hay dùng)
MEMORY_CACHE = {}

# Danh sách các câu ngắn thông dụng được nạp sẵn khi khởi động
FREQUENT_CACHED_PHRASES = [
    ("Em mở rồi ạ.", "vi"),
    ("Em mở rồi ạ", "vi"),
    ("Dạ vâng.", "vi"),
    ("Dạ vâng", "vi"),
    ("Em chưa làm được việc này.", "vi"),
    ("Em chưa làm được việc này", "vi"),
    ("Em mở video cho anh rồi ạ.", "vi"),
    ("Em đang mở trực tiếp cho anh ạ.", "vi"),
    ("Dạ em làm xong rồi ạ.", "vi"),
    ("Dạ vâng em làm ngay ạ.", "vi"),
    ("I opened it for you.", "en"),
    ("Yes, right away.", "en"),
    ("I could not do this.", "en")
]


def detect_language(text: str) -> str:
    if VI_DIACRITIC_RE.search(text):
        return "vi"
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if not words:
        return "vi"
    vi_hits = sum(1 for w in words if w in VI_COMMON_WORDS)
    if vi_hits >= 2 or (len(words) <= 3 and vi_hits >= 1):
        return "vi"
    return "en"


def detect_emotion(text: str) -> str:
    lower = text.lower()
    if any(k in lower for k in ["xin lỗi", "xin loi", "sorry", "apologize", "tiếc", "unfortunately"]):
        return "apologetic"
    if any(k in lower for k in ["cảnh báo", "nghiêm túc", "nguy hiểm", "lỗi", "warning", "critical", "error", "serious"]):
        return "serious"
    if any(k in lower for k in ["vui", "tuyệt", "cảm ơn", "cam on", "chào", "chao", "happy", "great", "wonderful", "hello", "welcome", "awesome"]):
        return "happy"
    return "neutral"


def load_clock_skew(skew_file: str):
    try:
        if os.path.exists(skew_file):
            with open(skew_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                skew = float(data.get("clock_skew_seconds", 0.0))
                if skew != 0.0:
                    DRM.clock_skew_seconds = skew
    except Exception:
        pass


def save_clock_skew(skew_file: str):
    try:
        if DRM.clock_skew_seconds != 0.0:
            with open(skew_file, "w", encoding="utf-8") as f:
                json.dump({"clock_skew_seconds": DRM.clock_skew_seconds}, f)
    except Exception:
        pass


async def send_json_response(data: dict):
    line = json.dumps(data, ensure_ascii=True) + "\n"
    async with STDOUT_LOCK:
        sys.stdout.write(line)
        sys.stdout.flush()


async def _single_attempt(text: str, voice: str, rate: str, pitch: str, skew_file: str, with_boundary: bool = True, timeout: float = 6.0):
    t0 = time.perf_counter()
    first_chunk_ms = None
    audio_bytes = bytearray()
    word_boundaries = []

    conn_timeout = max(4, min(8, int(timeout)))
    communicate = edge_tts.Communicate(
        text=text,
        voice=voice,
        rate=rate,
        pitch=pitch,
        boundary="WordBoundary" if with_boundary else None,
        connect_timeout=conn_timeout,
        receive_timeout=max(6, int(timeout)),
    )
    async for chunk in communicate.stream():
        ctype = chunk.get("type")
        if ctype == "audio":
            data = chunk["data"]
            if first_chunk_ms is None:
                first_chunk_ms = round((time.perf_counter() - t0) * 1000)
            audio_bytes.extend(data)
        elif with_boundary and ctype in ("WordBoundary", "SentenceBoundary"):
            w_text = (chunk.get("text") or "").strip()
            if w_text:
                word_boundaries.append({
                    "text": w_text,
                    "offsetMs": round(chunk.get("offset", 0) / 10000),
                    "durationMs": max(60, round(chunk.get("duration", 0) / 10000)),
                })

    if len(audio_bytes) > 0:
        save_clock_skew(skew_file)
        total_ms = round((time.perf_counter() - t0) * 1000)
        return bytes(audio_bytes), word_boundaries, (first_chunk_ms or total_ms), total_ms
    raise RuntimeError("No audio bytes received")


async def synthesize_with_retry(text: str, voice: str, rate: str, pitch: str, skew_file: str, max_retries: int = 2, timeout: float = 6.0):
    last_err = None
    for attempt in range(max_retries):
        try:
            use_pitch = pitch
            if attempt > 0:
                use_pitch = "+0Hz"
                try:
                    DRM.clock_skew_seconds = 0.0
                    if os.path.exists(skew_file):
                        os.remove(skew_file)
                except Exception:
                    pass
            with_boundary = attempt < 1
            return await asyncio.wait_for(
                _single_attempt(text, voice, rate, use_pitch, skew_file, with_boundary=with_boundary, timeout=timeout),
                timeout=timeout + 1.0
            )
        except Exception as e:
            last_err = e
            if attempt < max_retries - 1:
                await asyncio.sleep(0.12 * (attempt + 1))
    raise last_err or RuntimeError("Failed to synthesize audio after retries")


async def preload_common_phrases(output_dir: str, skew_file: str):
    """Nạp sẵn âm thanh cho các câu ngắn hay dùng vào RAM Cache và Disk Cache."""
    for text, lang in FREQUENT_CACHED_PHRASES:
        try:
            voice = "vi-VN-HoaiMyNeural" if lang == "vi" else "en-US-AriaNeural"
            rate = os.environ.get("TTS_RATE", "+8%")
            pitch = os.environ.get("TTS_PITCH", "+5Hz")
            cache_key = hashlib.sha256(f"{voice}|{rate}|{pitch}|{text}".encode("utf-8")).hexdigest()[:16]
            cache_file = os.path.join(output_dir, f"tts_{lang}_{cache_key}.mp3")
            meta_file = os.path.join(output_dir, f"tts_{lang}_{cache_key}.json")

            if os.path.exists(cache_file) and os.path.exists(meta_file):
                with open(cache_file, "rb") as f:
                    audio_bytes = f.read()
                try:
                    with open(meta_file, "r", encoding="utf-8") as mf:
                        word_boundaries = json.load(mf).get("wordBoundaries", [])
                except Exception:
                    word_boundaries = []
                b64_audio = base64.b64encode(audio_bytes).decode("ascii")
                MEMORY_CACHE[cache_key] = {
                    "audioBase64": b64_audio,
                    "wordBoundaries": word_boundaries,
                    "byteLength": len(audio_bytes),
                    "filePath": cache_file,
                    "firstChunkMs": 1,
                    "totalMs": 1
                }
            else:
                audio_bytes, word_boundaries, first_chunk_ms, total_ms = await synthesize_with_retry(
                    text, voice, rate, pitch, skew_file, max_retries=2, timeout=6.0
                )
                with open(cache_file, "wb") as f:
                    f.write(audio_bytes)
                try:
                    with open(meta_file, "w", encoding="utf-8") as mf:
                        json.dump({"wordBoundaries": word_boundaries}, mf, ensure_ascii=True)
                except Exception:
                    pass
                b64_audio = base64.b64encode(audio_bytes).decode("ascii")
                MEMORY_CACHE[cache_key] = {
                    "audioBase64": b64_audio,
                    "wordBoundaries": word_boundaries,
                    "byteLength": len(audio_bytes),
                    "filePath": cache_file,
                    "firstChunkMs": 1,
                    "totalMs": 1
                }
        except Exception:
            pass


async def handle_synthesize(req: dict, output_dir: str, skew_file: str):
    req_id = req.get("id", "0")
    text = ""
    if req.get("textBase64"):
        text = base64.b64decode(req["textBase64"]).decode("utf-8")
    else:
        text = req.get("text") or ""
    text = text.strip()

    if not text:
        await send_json_response({"id": req_id, "type": "error", "error": "Empty text"})
        return

    lang = req.get("lang")
    if not lang or lang == "auto":
        lang = detect_language(text)

    voice_vi = req.get("voiceVi") or os.environ.get("TTS_VOICE_VI", "vi-VN-HoaiMyNeural")
    voice_en = req.get("voiceEn") or os.environ.get("TTS_VOICE_EN", "en-US-AriaNeural")
    voice = voice_vi if lang == "vi" else voice_en

    emotion = req.get("emotion")
    if not emotion or emotion == "auto":
        emotion = detect_emotion(text)

    rate = req.get("rate") or os.environ.get("TTS_RATE", "+10%")
    pitch = req.get("pitch") or os.environ.get("TTS_PITCH", "+0Hz")
    timeout = float(req.get("timeout") or 6.0)
    max_retries = int(req.get("maxRetries") or 2)

    os.makedirs(output_dir, exist_ok=True)
    cache_key = hashlib.sha256(f"{voice}|{rate}|{pitch}|{text}".encode("utf-8")).hexdigest()[:16]
    cache_file = os.path.join(output_dir, f"tts_{lang}_{cache_key}.mp3")
    meta_file = os.path.join(output_dir, f"tts_{lang}_{cache_key}.json")

    try:
        # 1. Kiểm tra RAM Cache (In-Memory Cache): Trả về siêu tốc ~1ms
        if cache_key in MEMORY_CACHE and not req.get("noCache"):
            cached = MEMORY_CACHE[cache_key]
            resp = {
                "id": req_id,
                "type": "result",
                "text": text,
                "lang": lang,
                "voice": voice,
                "emotion": emotion,
                "firstChunkMs": cached.get("firstChunkMs", 1),
                "totalMs": cached.get("totalMs", 1),
                "byteLength": cached.get("byteLength", 0),
                "filePath": cached.get("filePath", cache_file),
                "wordBoundaries": cached.get("wordBoundaries", []),
                "audioBase64": cached.get("audioBase64", ""),
                "cached": True,
                "cacheType": "memory"
            }
            await send_json_response(resp)
            return

        # 2. Kiểm tra Disk Cache
        if (
            os.path.exists(cache_file)
            and os.path.getsize(cache_file) > 512
            and os.path.exists(meta_file)
            and not req.get("noCache")
        ):
            t0 = time.perf_counter()
            with open(cache_file, "rb") as f:
                audio_bytes = f.read()
            try:
                with open(meta_file, "r", encoding="utf-8") as mf:
                    word_boundaries = json.load(mf).get("wordBoundaries", [])
            except Exception:
                word_boundaries = []
            first_chunk_ms = max(1, round((time.perf_counter() - t0) * 1000))
            total_ms = first_chunk_ms
            b64_audio = base64.b64encode(audio_bytes).decode("ascii")

            # Lưu vào RAM Cache cho các lần gọi tiếp theo
            MEMORY_CACHE[cache_key] = {
                "audioBase64": b64_audio,
                "wordBoundaries": word_boundaries,
                "byteLength": len(audio_bytes),
                "filePath": cache_file,
                "firstChunkMs": 1,
                "totalMs": 1
            }

            resp = {
                "id": req_id,
                "type": "result",
                "text": text,
                "lang": lang,
                "voice": voice,
                "emotion": emotion,
                "firstChunkMs": first_chunk_ms,
                "totalMs": total_ms,
                "byteLength": len(audio_bytes),
                "filePath": cache_file,
                "wordBoundaries": word_boundaries,
                "audioBase64": b64_audio,
                "cached": True,
                "cacheType": "disk"
            }
            await send_json_response(resp)
            return

        # 3. Tạo mới qua edge-tts (nếu chưa có trong cache)
        audio_bytes, word_boundaries, first_chunk_ms, total_ms = await synthesize_with_retry(
            text, voice, rate, pitch, skew_file, max_retries=max_retries, timeout=timeout
        )
        with open(cache_file, "wb") as f:
            f.write(audio_bytes)
        try:
            with open(meta_file, "w", encoding="utf-8") as mf:
                json.dump({"wordBoundaries": word_boundaries}, mf, ensure_ascii=True)
        except Exception:
            pass

        b64_audio = base64.b64encode(audio_bytes).decode("ascii")

        # Lưu ngay vào RAM Cache
        MEMORY_CACHE[cache_key] = {
            "audioBase64": b64_audio,
            "wordBoundaries": word_boundaries,
            "byteLength": len(audio_bytes),
            "filePath": cache_file,
            "firstChunkMs": 1,
            "totalMs": 1
        }

        resp = {
            "id": req_id,
            "type": "result",
            "text": text,
            "lang": lang,
            "voice": voice,
            "emotion": emotion,
            "firstChunkMs": first_chunk_ms,
            "totalMs": total_ms,
            "byteLength": len(audio_bytes),
            "filePath": cache_file,
            "wordBoundaries": word_boundaries,
            "audioBase64": b64_audio,
            "cached": False
        }
        await send_json_response(resp)
    except Exception as exc:
        await send_json_response({"id": req_id, "type": "error", "error": str(exc)})


async def main():
    project_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    output_dir = os.path.join(project_root, "logs", "tts_cache")
    os.makedirs(output_dir, exist_ok=True)

    skew_file = os.path.join(output_dir, "clock_skew.json")
    load_clock_skew(skew_file)

    # Nạp sẵn âm thanh cho các câu phổ biến chạy ngầm
    asyncio.create_task(preload_common_phrases(output_dir, skew_file))

    await send_json_response({"type": "ready", "status": "edge-tts worker online (concurrent + memory cache enabled)"})

    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get("cmd") == "quit":
                break
            # Chạy song song không chặn các request tiếp theo
            asyncio.create_task(handle_synthesize(req, output_dir, skew_file))
        except Exception as e:
            await send_json_response({"type": "error", "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
