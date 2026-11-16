# -*- coding: utf-8 -*-
"""
============================================================================
MODULE E: COMPUTER USE WORKER (Python RPC via stdio JSON-lines)
- Nhìn màn hình (take_screenshot): thu nhỏ <= 1280px trong RAM, trả Base64 JPEG.
- Điều khiển chuột & phím: mouse_click, double_click, scroll, type_text, press_key.
- So sánh ảnh trực tiếp trong RAM (compare_images) để phát hiện màn hình có đổi không.
- Hỗ trợ PyAutoGUI FAILSAFE: kéo chuột lên góc trên-trái (0,0) sẽ dừng khẩn cấp.
- Hỗ trợ gõ tiếng Việt có dấu chuẩn xác 100% qua clipboard (pyperclip).
- Tuyệt đối KHÔNG lưu ảnh chụp vào ổ đĩa cứng (chỉ giữ trong RAM).
============================================================================
"""
import sys
import os
import io
import json
import time
import base64
import ctypes
from ctypes import wintypes

if sys.platform == "win32":
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")

import pyautogui
from PIL import Image, ImageGrab, ImageChops, ImageStat
import pyperclip

user32 = ctypes.windll.user32 if sys.platform == "win32" else None

# Đặt cấu hình PyAutoGUI
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.04

# Đảm bảo tiến trình gắn với Windows Interactive Desktop
def ensure_desktop_station():
    try:
        if user32:
            hDesk = user32.OpenInputDesktop(0, False, 0x01FF)
            if hDesk:
                user32.SetThreadDesktop(hDesk)
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

ensure_desktop_station()

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
        ok = psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb)
        if ok:
            return round(counters.WorkingSetSize / (1024 * 1024), 2)
    except Exception:
        pass
    return 0.0

def emit(obj):
    print(json.dumps(obj, ensure_ascii=False), flush=True)

def handle_screenshot(cmd):
    ensure_desktop_station()
    img = ImageGrab.grab()
    orig_w, orig_h = img.size

    # Thu nhỏ ảnh sao cho chiều lớn nhất <= 1280px để nhẹ RAM và tiết kiệm token
    max_dim = int(cmd.get("maxDimension", 1280))
    scale = min(float(max_dim) / orig_w, float(max_dim) / orig_h, 1.0)
    scaled_w = max(1, int(round(orig_w * scale)))
    scaled_h = max(1, int(round(orig_h * scale)))

    if scale < 0.999:
        resized = img.resize((scaled_w, scaled_h), Image.Resampling.LANCZOS)
    else:
        resized = img

    buf = io.BytesIO()
    resized.convert("RGB").save(buf, format="JPEG", quality=80)
    raw_bytes = buf.getvalue()
    b64_data = base64.b64encode(raw_bytes).decode("ascii")

    return {
        "success": True,
        "base64": b64_data,
        "origW": orig_w,
        "origH": orig_h,
        "scaledW": scaled_w,
        "scaledH": scaled_h,
        "scaleFactor": round(scale, 4),
        "sizeBytes": len(raw_bytes)
    }

def handle_mouse_click(cmd):
    ensure_desktop_station()
    x = int(round(cmd["x"]))
    y = int(round(cmd["y"]))
    button = str(cmd.get("button", "left")).lower()
    if button not in ("left", "right", "middle"):
        button = "left"
    clicks = int(cmd.get("clicks", 1))

    sw, sh = pyautogui.size()
    x = max(0, min(sw - 1, x))
    y = max(0, min(sh - 1, y))

    pyautogui.click(x=x, y=y, button=button, clicks=clicks)
    return {"success": True, "x": x, "y": y, "button": button, "clicks": clicks}

def handle_double_click(cmd):
    ensure_desktop_station()
    x = int(round(cmd["x"]))
    y = int(round(cmd["y"]))
    sw, sh = pyautogui.size()
    x = max(0, min(sw - 1, x))
    y = max(0, min(sh - 1, y))

    pyautogui.doubleClick(x=x, y=y)
    return {"success": True, "x": x, "y": y}

def handle_scroll(cmd):
    ensure_desktop_station()
    amount = int(cmd.get("amount", -300))
    pyautogui.scroll(amount)
    return {"success": True, "amount": amount}

def handle_type_text(cmd):
    ensure_desktop_station()
    text = str(cmd.get("text", ""))
    if text:
        pyperclip.copy(text)
        time.sleep(0.04)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.04)
    return {"success": True, "length": len(text)}

def handle_get_clipboard(cmd):
    ensure_desktop_station()
    text = pyperclip.paste()
    return {"success": True, "text": text}

def handle_press_key(cmd):
    ensure_desktop_station()
    key_str = str(cmd.get("key", "")).strip().lower()
    if not key_str:
        return {"success": False, "error": "Khóa phím không được để trống"}

    if "+" in key_str:
        keys = [k.strip() for k in key_str.split("+") if k.strip()]
        pyautogui.hotkey(*keys)
    else:
        pyautogui.press(key_str)
    return {"success": True, "key": key_str}

def handle_activate_window(cmd):
    ensure_desktop_station()
    keywords = cmd.get("keywords", ["youtube", "cốc cốc", "coc coc", "chrome", "edge"])
    if isinstance(keywords, str):
        keywords = [keywords]
    keywords = [k.lower() for k in keywords]

    found_hwnd = None
    found_title = ""
    def enum_cb(hwnd, lparam):
        nonlocal found_hwnd, found_title
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                t = buff.value.lower()
                if any(k in t for k in keywords):
                    found_hwnd = hwnd
                    found_title = buff.value
                    return False
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32.EnumWindows(WNDENUMPROC(enum_cb), 0)

    if found_hwnd:
        # Unlock SetForegroundWindow using ALT key simulation
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        user32.ShowWindow(found_hwnd, 9) # SW_RESTORE
        user32.ShowWindow(found_hwnd, 3) # SW_MAXIMIZE
        ok = user32.SetForegroundWindow(found_hwnd)
        return {"success": True, "hwnd": found_hwnd, "title": found_title, "activated": bool(ok)}
    return {"success": False, "error": f"Không tìm thấy cửa sổ nào khớp với: {keywords}"}

def handle_open_browser_url(cmd):
    ensure_desktop_station()
    url = cmd.get("url", "")
    keywords = cmd.get("keywords", ["youtube", "cốc cốc", "coc coc", "chrome", "edge"])
    if isinstance(keywords, str):
        keywords = [keywords]
    keywords = [k.lower() for k in keywords]

    found_hwnd = None
    found_title = ""
    def enum_cb(hwnd, lparam):
        nonlocal found_hwnd, found_title
        if user32 and user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                t = buff.value.lower()
                if any(k in t for k in keywords):
                    found_hwnd = hwnd
                    found_title = buff.value
                    return False
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    if user32:
        user32.EnumWindows(WNDENUMPROC(enum_cb), 0)

    if found_hwnd and user32:
        user32.keybd_event(0x12, 0, 0, 0)
        user32.keybd_event(0x12, 0, 2, 0)
        user32.ShowWindow(found_hwnd, 9) # SW_RESTORE
        user32.ShowWindow(found_hwnd, 3) # SW_MAXIMIZE
        user32.SetForegroundWindow(found_hwnd)
        time.sleep(0.4)
        pyautogui.hotkey("ctrl", "t")
        time.sleep(0.3)
        pyperclip.copy(url)
        time.sleep(0.05)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.1)
        pyautogui.press("enter")
        return {"success": True, "method": "existing_browser_tab", "hwnd": found_hwnd, "title": found_title}
    else:
        os.system(f'start "" "{url}"')
        time.sleep(2.5)
        if user32:
            user32.EnumWindows(WNDENUMPROC(enum_cb), 0)
            if found_hwnd:
                user32.ShowWindow(found_hwnd, 9)
                user32.ShowWindow(found_hwnd, 3)
                user32.SetForegroundWindow(found_hwnd)
        return {"success": True, "method": "launched_new_process"}

def handle_compare_images(cmd):
    b64_1 = cmd.get("b64_1")
    b64_2 = cmd.get("b64_2")
    if not b64_1 or not b64_2:
        return {"success": False, "error": "Thiếu dữ liệu ảnh cần so sánh"}

    img1 = Image.open(io.BytesIO(base64.b64decode(b64_1))).convert("RGB")
    img2 = Image.open(io.BytesIO(base64.b64decode(b64_2))).convert("RGB")

    if img1.size != img2.size:
        img2 = img2.resize(img1.size)

    diff = ImageChops.difference(img1, img2)
    stat = ImageStat.Stat(diff)
    diff_ratio = sum(stat.mean) / (3.0 * 255.0)
    threshold = float(cmd.get("threshold", 0.005)) # 0.5% khác biệt
    changed = diff_ratio >= threshold

    return {
        "success": True,
        "changed": changed,
        "diffRatio": round(diff_ratio, 5),
        "diffPercent": round(diff_ratio * 100, 3)
    }

def main():
    emit({"type": "ready", "pid": os.getpid(), "ramMb": working_set_mb()})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"success": False, "error": f"Invalid JSON input: {e}"})
            continue

        req_id = req.get("id")
        action = req.get("action", "")

        try:
            if action == "take_screenshot":
                res = handle_screenshot(req)
            elif action == "mouse_click":
                res = handle_mouse_click(req)
            elif action == "double_click":
                res = handle_double_click(req)
            elif action == "scroll":
                res = handle_scroll(req)
            elif action == "type_text":
                res = handle_type_text(req)
            elif action == "get_clipboard":
                res = handle_get_clipboard(req)
            elif action == "press_key":
                res = handle_press_key(req)
            elif action == "compare_images":
                res = handle_compare_images(req)
            elif action == "open_browser_url":
                res = handle_open_browser_url(req)
            elif action == "activate_window":
                res = handle_activate_window(req)
            elif action == "ping":
                res = {"success": True, "status": "ok", "ramMb": working_set_mb()}
            else:
                res = {"success": False, "error": f"Hành động không xác định: {action}"}
        except pyautogui.FailSafeException:
            res = {
                "success": False,
                "error": "PyAutoGUI FAILSAFE: Chuột đã được di chuyển vào góc màn hình! Vòng lặp dừng khẩn cấp.",
                "failSafe": True
            }
        except Exception as ex:
            res = {"success": False, "error": f"Lỗi thực thi {action}: {str(ex)}"}

        res["id"] = req_id
        emit(res)

if __name__ == "__main__":
    main()

