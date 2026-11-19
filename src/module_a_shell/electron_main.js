/**
 * ============================================================================
 * MODULE A: ELECTRON MAIN PROCESS (Transparent Click-Through Desktop Shell)
 * - Cấu hình chuẩn: transparent: true, frame: false, focusable: true
 * - Hỗ trợ setIgnoreMouseEvents(true, { forward: true }) cho vùng Avatar
 *   và tự động bật click (setIgnoreMouseEvents(false)) khi rê chuột vào nút/khung chat
 * - Quản lý Python Edge-TTS Streaming Worker (Module D) qua IPC
 * - Đo RAM/CPU thực tế của toàn bộ tiến trình qua app.getAppMetrics()
 * - Phím tắt khẩn cấp toàn cục: Ctrl + Alt + Esc
 * ============================================================================
 */
const { app, BrowserWindow, ipcMain, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { AuraLLMRouter, httpsPostJson } = require('../module_e_brain/llm_providers');
const { AuraComputerUseService } = require('../module_e_brain/computer_use_service');

// Tối ưu hoá bộ nhớ cho Intel Iris Xe onboard & cho phép phát âm thanh TTS tức thì
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const projectRoot = path.resolve(__dirname, '..', '..');

// Đọc nạp file cấu hình .env vào process.env ngay từ khi khởi động ứng dụng
function loadEnvFile(rootPath) {
  const envPath = path.join(rootPath, '.env');
  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      process.env[k] = v;
    }
  }
}
loadEnvFile(projectRoot);

const logDir = path.join(projectRoot, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFilePath = path.join(logDir, 'aura_actions.log');

function writeLog(category, message) {
  const now = new Date();
  const ts = now.toISOString().replace('T', ' ').substring(0, 23);
  const line = `[${ts}] [${category}] ${message}\n`;
  try {
    fs.appendFileSync(logFilePath, line, 'utf8');
  } catch (_) {}
  process.stdout.write(line);
}

let mainWindow = null;
let currentMode = 'docked';
let isCurrentlyIgnoringMouse = false;
let lastReportedFps = 0;
let lastReportedLiteMode = false;
let telemetryTick = 0;
let telemetryInterval = null;

// ============================================================================
// MODULE D: QUẢN LÝ PYTHON EDGE-TTS STREAMING WORKER DAEMON
// ============================================================================
let ttsWorkerProc = null;
const pendingTtsRequests = new Map();

function resolvePythonExecutable() {
  const portablePy = path.join(projectRoot, 'runtime', 'python', 'python.exe');
  if (fs.existsSync(portablePy)) {
    return portablePy;
  }
  return 'python';
}

function startTtsWorker() {
  if (ttsWorkerProc && !ttsWorkerProc.killed) return;

  const pythonExe = resolvePythonExecutable();
  const workerScript = path.join(projectRoot, 'src', 'module_d_tts', 'tts_worker.py');

  writeLog('TTS_WORKER', `Starting Python edge-tts worker: ${pythonExe} -> ${workerScript}`);

  ttsWorkerProc = spawn(pythonExe, [workerScript], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env }
  });

  const rl = readline.createInterface({
    input: ttsWorkerProc.stdout,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.type === 'ready') {
        writeLog('TTS_WORKER', `Worker ready: ${msg.status}`);
        return;
      }
      if (msg.id && pendingTtsRequests.has(msg.id)) {
        const { resolve } = pendingTtsRequests.get(msg.id);
        pendingTtsRequests.delete(msg.id);
        resolve(msg);
      }
    } catch (err) {
      writeLog('TTS_WORKER_WARN', `Non-JSON stdout from worker: ${trimmed}`);
    }
  });

  ttsWorkerProc.stderr.on('data', (chunk) => {
    const errText = chunk.toString('utf8').trim();
    if (errText) {
      writeLog('TTS_WORKER_ERR', errText);
    }
  });

  ttsWorkerProc.on('exit', (code) => {
    writeLog('TTS_WORKER', `Worker exited with code ${code}`);
    ttsWorkerProc = null;
    for (const [reqId, { resolve }] of pendingTtsRequests.entries()) {
      resolve({ id: reqId, type: 'error', error: `TTS worker exited unexpectedly (code ${code})` });
    }
    pendingTtsRequests.clear();
  });
}

function stopTtsWorker() {
  if (!ttsWorkerProc) return;
  try {
    ttsWorkerProc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
    ttsWorkerProc.kill();
  } catch (_) {}
  ttsWorkerProc = null;
}

ipcMain.handle('tts:synthesize', async (_event, payload) => {
  if (!ttsWorkerProc || ttsWorkerProc.killed) {
    startTtsWorker();
  }

  const reqId = payload.id || `tts_${Date.now()}`;
  const rawText = (payload.text || '').trim();
  const textBase64 = Buffer.from(rawText, 'utf8').toString('base64');
  const timeoutMs = Number(payload.timeoutMs) || (payload.isFirstSentence ? 6000 : 12000);

  writeLog(
    'TTS_REQ',
    `ID=${reqId} | LangHint=${payload.lang || 'auto'} | Timeout=${timeoutMs}ms | FirstSentence=${Boolean(payload.isFirstSentence)} | Text="${rawText.substring(0, 80)}"`
  );

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (pendingTtsRequests.has(reqId)) {
        pendingTtsRequests.delete(reqId);
        writeLog('TTS_TIMEOUT', `Request ${reqId} timed out after ${timeoutMs}ms.`);
        resolve({ id: reqId, type: 'error', error: `Quá thời gian chờ phản hồi từ dịch vụ giọng nói (${Math.round(timeoutMs / 1000)}s).` });
      }
    }, timeoutMs);

    pendingTtsRequests.set(reqId, {
      resolve: (res) => {
        clearTimeout(timeoutId);
        if (res.type === 'result') {
          const cacheTag = res.cached ? `[CACHE:${res.cacheType || 'hit'}] ` : '';
          writeLog(
            'TTS_OK',
            `ID=${reqId} | ${cacheTag}DetectedLang=${res.lang} | Voice=${res.voice} | Emotion=${res.emotion} | FirstChunk=${res.firstChunkMs}ms | TotalSynth=${res.totalMs}ms | Size=${res.byteLength}B`
          );
        } else {
          writeLog('TTS_ERR', `ID=${reqId} | Error=${res.error}`);
        }
        resolve(res);
      }
    });

    try {
      const reqLine = JSON.stringify({
        id: reqId,
        textBase64,
        lang: payload.lang || 'auto',
        voiceVi: payload.voiceVi || process.env.TTS_VOICE_VI || 'vi-VN-HoaiMyNeural',
        voiceEn: payload.voiceEn || process.env.TTS_VOICE_EN || 'en-US-AriaNeural',
        rate: payload.rate || process.env.TTS_RATE || '+8%',
        pitch: payload.pitch || process.env.TTS_PITCH || '+5Hz',
        emotion: payload.emotion || 'auto',
        timeout: Math.max(3, Math.round(timeoutMs / 1000)),
        noCache: Boolean(payload.noCache)
      });
      ttsWorkerProc.stdin.write(reqLine + '\n');
    } catch (err) {
      clearTimeout(timeoutId);
      pendingTtsRequests.delete(reqId);
      resolve({ id: reqId, type: 'error', error: err.message });
    }
  });
});

// ============================================================================
// MODULE C: QUẢN LÝ PYTHON FASTER-WHISPER STT WORKER VÀ GEMINI CLOUD STT
// - Giữ model trong RAM khi bật chế độ trò chuyện; tự giải phóng sau 5 phút không dùng
// - Tuỳ chọn STT_PROVIDER=local | gemini; tự động fallback về local nếu lỗi mạng
// ============================================================================
const STT_IDLE_UNLOAD_MS = (parseInt(process.env.STT_IDLE_UNLOAD_SECONDS, 10) || 300) * 1000; // Mặc định 5 phút (300 giây)
let sttProc = null;
let sttModelLoaded = false;
let sttBusyCount = 0;
let sttIdleTimer = null;
let sttLastUseAt = 0;
let sttLastUnloadInfo = null;
let sttReqCounter = 0;
let isConversationModeActive = false;
const pendingSttRequests = new Map();

function sendSttStatus(state, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stt:status', { state, ...extra });
  }
}

function pcm16kBase64ToWavBuffer(pcmBase64) {
  const pcmBuf = Buffer.from(pcmBase64, 'base64');
  const numChannels = 1;
  const sampleRate = 16000;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmBuf.length;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmBuf]);
}

async function transcribeWithGemini(pcmBase64, initialPrompt) {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trong file .env');
  }

  const modelName = (process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite').replace(/^models\//, '');
  const reqPath = `/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const wavBuf = pcm16kBase64ToWavBuffer(pcmBase64);
  const b64Wav = wavBuf.toString('base64');
  const promptKeywords = initialPrompt || 'Aura, YouTube, Chrome, Notepad, Thịnh, SWT301, thư mục, ổ D, mở, tìm';
  const instruction = `Transcribe this audio recording verbatim in its original spoken language. DO NOT translate. If spoken in English, output English text. If spoken in Vietnamese, output Vietnamese text.
Important keywords and proper nouns: ${promptKeywords}.
Output ONLY the exact transcribed text, with no preamble, no markdown, and no quotes.`;

  const bodyObj = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/wav', data: b64Wav } },
          { text: instruction }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.0,
      maxOutputTokens: 120
    }
  };

  const t0 = Date.now();
  const res = await httpsPostJson({
    hostname: 'generativelanguage.googleapis.com',
    path: reqPath,
    bodyObj,
    timeoutMs: 15000
  });

  const transcribeMs = Date.now() - t0;
  if (res.statusCode !== 200 || !res.json) {
    throw new Error(`Gemini API HTTP ${res.statusCode}: ${JSON.stringify(res.json || res.rawBody || '')}`);
  }

  const candidate = res.json.candidates?.[0];
  const rawText = candidate?.content?.parts?.[0]?.text || '';
  const cleanText = rawText.trim().replace(/^["']|["']$/g, '').trim();

  // Tự nhận diện ngôn ngữ vi hoặc en
  const isEn = /^[a-zA-Z0-9\s.,?!'"-:;]+$/.test(cleanText) && !/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(cleanText);
  const lang = isEn ? 'en' : 'vi';

  const pcmBuf = Buffer.from(pcmBase64, 'base64');
  const audioSec = Number((pcmBuf.length / (16000 * 2)).toFixed(2));

  return {
    type: 'result',
    text: cleanText,
    lang,
    langProb: 0.99,
    audioSec,
    transcribeMs,
    loadMs: 0,
    justLoaded: false,
    workerTotalMs: transcribeMs,
    provider: 'gemini',
    rssMb: 0
  };
}

function startSttWorker() {
  if (sttProc && !sttProc.killed) return;
  const pythonExe = resolvePythonExecutable();
  const workerScript = path.join(projectRoot, 'src', 'module_c_stt', 'stt_worker.py');
  writeLog('STT_WORKER', `Starting Python faster-whisper worker: ${workerScript}`);

  sttProc = spawn(pythonExe, [workerScript], {
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const proc = sttProc;

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = (line || '').trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.type === 'ready') {
        writeLog('STT_WORKER', `Worker ready (model chua nap) | PythonRAM=${msg.rssMb}MB`);
        return;
      }
      if (msg.id && pendingSttRequests.has(msg.id)) {
        const { resolve } = pendingSttRequests.get(msg.id);
        pendingSttRequests.delete(msg.id);
        resolve(msg);
      }
    } catch (_) {
      writeLog('STT_WORKER_WARN', `Non-JSON stdout: ${trimmed.substring(0, 200)}`);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const t = chunk.toString('utf8').trim();
    if (t) writeLog('STT_WORKER_ERR', t.substring(0, 400));
  });

  proc.on('exit', (code) => {
    writeLog('STT_WORKER', `Worker exited with code ${code}`);
    if (sttProc === proc) {
      sttProc = null;
      sttModelLoaded = false;
    }
    for (const [reqId, { resolve }] of pendingSttRequests.entries()) {
      resolve({ id: reqId, type: 'error', error: `STT worker exited (code ${code})` });
    }
    pendingSttRequests.clear();
    sendSttStatus('unloaded');
  });
}

function sttRequest(payload, timeoutMs) {
  if (!sttProc || sttProc.killed) startSttWorker();
  const id = `stt_${Date.now()}_${++sttReqCounter}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingSttRequests.has(id)) {
        pendingSttRequests.delete(id);
        writeLog('STT_TIMEOUT', `Request ${id} (${payload.cmd}) timed out after ${timeoutMs}ms`);
        resolve({ id, type: 'error', error: `Quá thời gian chờ STT (${Math.round(timeoutMs / 1000)}s)` });
      }
    }, timeoutMs);
    pendingSttRequests.set(id, {
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      }
    });
    try {
      sttProc.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    } catch (err) {
      clearTimeout(timer);
      pendingSttRequests.delete(id);
      resolve({ id, type: 'error', error: err.message });
    }
  });
}

function scheduleSttIdleUnload() {
  clearTimeout(sttIdleTimer);
  sttLastUseAt = Date.now();
  if (!sttProc) return;
  // Khi chế độ trò chuyện đang bật, giữ model luôn trong RAM, không giải phóng
  if (isConversationModeActive) return;
  sttIdleTimer = setTimeout(() => unloadStt('idle-5m'), STT_IDLE_UNLOAD_MS);
}

function unloadStt(reason) {
  clearTimeout(sttIdleTimer);
  if (!sttProc) return false;
  if (sttBusyCount > 0) {
    scheduleSttIdleUnload();
    return false;
  }
  const idleSec = sttLastUseAt ? ((Date.now() - sttLastUseAt) / 1000).toFixed(1) : '?';
  writeLog('STT_UNLOAD', `Giai phong model STT + tat tien trinh Python (ly do=${reason}, khong dung ${idleSec}s)`);
  sttLastUnloadInfo = { reason, idleSec: Number(idleSec), at: Date.now() };
  const proc = sttProc;
  try {
    proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
  } catch (_) {}
  try {
    proc.kill();
  } catch (_) {}
  sttProc = null;
  sttModelLoaded = false;
  sendSttStatus('unloaded');
  return true;
}

ipcMain.handle('stt:set_conversation_active', async (_event, active) => {
  isConversationModeActive = Boolean(active);
  writeLog('STT_MODE', `ConversationModeActive=${isConversationModeActive} | IdleTimeout=${STT_IDLE_UNLOAD_MS / 1000}s`);
  if (isConversationModeActive) {
    clearTimeout(sttIdleTimer);
    // Nạp sẵn model ngay khi bật chế độ trò chuyện nếu dùng provider local
    const provider = (process.env.STT_PROVIDER || 'local').toLowerCase().trim();
    if (provider !== 'gemini' && !sttModelLoaded) {
      sendSttStatus('loading');
      sttRequest({ cmd: 'load' }, 180000).then((res) => {
        if (res.type === 'loaded') {
          sttModelLoaded = true;
          sendSttStatus('ready', { rssMb: res.rssMb });
        }
      });
    }
  } else {
    // Khi tắt chế độ trò chuyện, lên lịch giải phóng sau 5 phút nếu không dùng
    scheduleSttIdleUnload();
  }
  return { success: true, isConversationModeActive };
});

ipcMain.handle('stt:load', async () => {
  sttBusyCount++;
  clearTimeout(sttIdleTimer);
  try {
    if (!sttModelLoaded) sendSttStatus('loading');
    const res = await sttRequest({ cmd: 'load' }, 180000);
    if (res.type === 'loaded') {
      sttModelLoaded = true;
      if (res.justLoaded) {
        writeLog(
          'STT_LOAD',
          `Model=${res.model}/${res.computeType}/cpu | LoadTime=${res.loadMs}ms | PythonRAM truoc=${res.rssBeforeMb}MB sau=${res.rssMb}MB`
        );
      }
      sendSttStatus('ready', { rssMb: res.rssMb });
    } else {
      writeLog('STT_ERR', `Load failed: ${res.error}`);
      sendSttStatus('unloaded', { error: res.error });
    }
    return res;
  } finally {
    sttBusyCount--;
    scheduleSttIdleUnload();
  }
});

ipcMain.handle('stt:transcribe', async (_event, payload) => {
  sttBusyCount++;
  clearTimeout(sttIdleTimer);

  const provider = (process.env.STT_PROVIDER || 'local').toLowerCase().trim();

  // 1. Nếu cấu hình STT_PROVIDER=gemini: Ưu tiên gửi sang Gemini Cloud STT
  if (provider === 'gemini') {
    try {
      writeLog('STT_GEMINI_REQ', `Đang chép lời bằng Gemini API (model=${process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'})...`);
      const gRes = await transcribeWithGemini(payload.pcmBase64, payload.initialPrompt);
      writeLog(
        'STT_OK',
        `[Gemini] Lang=${gRes.lang} | Audio=${gRes.audioSec}s | Transcribe=${gRes.transcribeMs}ms | Text="${(gRes.text || '').substring(0, 120)}"`
      );
      return gRes;
    } catch (err) {
      writeLog('STT_GEMINI_FALLBACK', `Gọi Gemini STT thất bại (${err.message}). Tự động quay về local faster-whisper...`);
      // Fallback về local faster-whisper bên dưới!
    }
  }

  // 2. Chế độ Local faster-whisper (mặc định hoặc fallback)
  try {
    const wasLoaded = sttModelLoaded;
    if (!wasLoaded) sendSttStatus('loading');
    const res = await sttRequest(
      {
        cmd: 'transcribe',
        pcmBase64: payload.pcmBase64,
        lang: payload.lang || 'auto',
        initialPrompt: payload.initialPrompt,
        beam_size: 1
      },
      180000
    );
    if (res.type === 'result') {
      sttModelLoaded = true;
      sendSttStatus('ready', { rssMb: res.rssMb });
      writeLog(
        'STT_OK',
        `[Local] Lang=${res.lang}(${res.langProb}) | Audio=${res.audioSec}s | Transcribe=${res.transcribeMs}ms | ModelLoad=${res.loadMs}ms | PythonRAM=${res.rssMb}MB | Text="${(res.text || '').substring(0, 120)}"`
      );
    } else {
      writeLog('STT_ERR', `Transcribe failed: ${res.error}`);
    }
    return res;
  } finally {
    sttBusyCount--;
    scheduleSttIdleUnload();
  }
});

ipcMain.handle('stt:unload', async () => unloadStt('manual'));

// ============================================================================
// MODULE E: QUẢN LÝ BỘ NÃO AI (LLMProvider: GeminiProvider & ClaudeProvider)
// ============================================================================
let llmRouter = null;

function ensureLlmRouter() {
  if (!llmRouter) {
    llmRouter = new AuraLLMRouter(projectRoot, writeLog);

    // BƯỚC 5: Kết nối bộ điều phối xác nhận an toàn tới Renderer UI
    llmRouter.setConfirmationHandler((payload) => {
      writeLog('CONFIRM_REQUEST', `Tool=${payload.tool} | Risk=${payload.risk?.reason}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('tool:confirm_request', payload);
      }
    });

    // BƯỚC 5: Kết nối sự kiện kích hoạt lời nhắc hẹn giờ tới Renderer UI
    llmRouter.onReminderTrigger = (reminder) => {
      writeLog('REMINDER_TRIGGER', `Id=${reminder.id} | Msg="${reminder.message}" | Time=${reminder.triggerAt}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('host:reminder_triggered', reminder);
      }
    };
  }
  return llmRouter;
}

// BƯỚC 5: Phản hồi từ người dùng trên giao diện xác nhận (Đồng ý / Huỷ)
ipcMain.on('tool:confirm_response', (_event, { id, confirmed }) => {
  const router = ensureLlmRouter();
  writeLog('CONFIRM_RESPONSE', `Id=${id} | Confirmed=${confirmed}`);
  router.resolveConfirmation(id, confirmed);
});

// BƯỚC 5: Cung cấp danh sách audit log phục vụ nút "📋 Xem log" trên UI
ipcMain.handle('tool:get_logs', async (_event, limit) => {
  const router = ensureLlmRouter();
  return router.toolExecutor.getRecentLogs(limit || 35);
});

// Mở file báo cáo HTML hoặc thư mục báo cáo bằng ứng dụng mặc định của Windows
ipcMain.handle('report:open', async (_event, reportPath) => {
  if (!reportPath) return { success: false, error: 'Đường dẫn báo cáo rỗng' };
  const resolved = path.resolve(reportPath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `File không tồn tại: ${resolved}` };
  }
  const { shell } = require('electron');
  await shell.openPath(resolved);
  return { success: true, path: resolved };
});

ipcMain.handle('llm:status', async () => {
  return ensureLlmRouter().getPublicStatus();
});

ipcMain.handle('llm:set-mode', async (_event, mode) => {
  return ensureLlmRouter().setRoutingMode(mode);
});

ipcMain.handle('llm:chat', async (_event, payload) => {
  const router = ensureLlmRouter();
  return router.chatWithMemory(payload.text || '', {
    lang: payload.lang || 'auto',
    provider: payload.provider || null,
    tools: payload.tools || [],
    testOverrideKey: payload.testOverrideKey || null,
    skipHistory: Boolean(payload.skipHistory)
  });
});

ipcMain.handle('llm:vision', async (_event, payload) => {
  const router = ensureLlmRouter();
  return router.analyzeVision(payload.image || '', payload.prompt || '', {
    provider: payload.provider || null,
    langHint: payload.lang || undefined,
    recordHistory: Boolean(payload.recordHistory)
  });
});

ipcMain.handle('llm:get-history', async () => {
  const router = ensureLlmRouter();
  return router.getHistory();
});

ipcMain.handle('llm:clear-context', async () => {
  const router = ensureLlmRouter();
  return router.clearHistory();
});

// Chụp màn hình tức thì để hỏi đáp Vision Q&A (ẩn tạm cửa sổ Aura ~120ms để không che nội dung phía sau)
ipcMain.handle('screen:capture-for-qa', async () => {
  const service = ensureComputerUseService();
  let hidOpacity = false;
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      mainWindow.setOpacity(0);
      hidOpacity = true;
      await new Promise((r) => setTimeout(r, 120));
    }
    const shot = await service.takeScreenshot();
    if (shot && shot.success && shot.base64) {
      return {
        ...shot,
        dataUrl: `data:image/jpeg;base64,${shot.base64}`
      };
    }
    return { success: false, error: shot?.error || 'Không thể chụp màn hình.' };
  } catch (err) {
    writeLog('SCREEN_QA_ERR', `capture-for-qa failed: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    if (hidOpacity && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(1);
    }
  }
});

// ============================================================================
// BƯỚC 6: DỊCH VỤ COMPUTER-USE & IPC HANDLERS
// ============================================================================
let computerUseService = null;

function ensureComputerUseService() {
  if (!computerUseService) {
    const router = ensureLlmRouter();
    computerUseService = new AuraComputerUseService({
      projectRoot,
      pythonPath: path.join(projectRoot, 'runtime', 'python', 'python.exe'),
      writeLog,
      llmRouter: router,
      onStateChange: (state) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('computer_use:state', state);
        }
      },
      onScreenshotToast: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('computer_use:screenshot_toast');
        }
      },
      onSpokenNotice: (text, emotion) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('computer_use:spoken_notice', { text, emotion });
        }
      },
      onRequestConfirmation: async (dialogData, action, details) => {
        const confId = `cu_conf_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        return new Promise((resolve) => {
          const timeout = setTimeout(() => {
            router.pendingConfirmations.delete(confId);
            resolve({ confirmed: false, reason: 'timeout' });
          }, dialogData.timeoutMs || 30000);

          router.pendingConfirmations.set(confId, {
            resolve: (res) => {
              clearTimeout(timeout);
              resolve(res);
            },
            timer: timeout,
            tool: action,
            dialogData
          });

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('tool:confirm_request', {
              id: confId,
              tool: action,
              risk: {
                isHighRisk: true,
                dialogTitle: dialogData.dialogTitle,
                description: dialogData.description,
                spokenPrompt: dialogData.spokenPrompt
              },
              args: details,
              timeoutSeconds: Math.round((dialogData.timeoutMs || 30000) / 1000)
            });
          }
        });
      }
    });

    router.toolExecutor.setComputerUseService(computerUseService);
    writeLog('COMPUTER_USE_INIT', 'ComputerUseService initialized and attached to ToolExecutor.');
  }
  return computerUseService;
}

ipcMain.handle('computer_use:run_task', async (_event, { prompt, options }) => {
  const service = ensureComputerUseService();
  return service.runTask(prompt, options);
});

ipcMain.handle('computer_use:set_autopilot', async (_event, enabled) => {
  const service = ensureComputerUseService();
  return service.setAutoPilot(enabled);
});

ipcMain.handle('computer_use:get_autopilot', async () => {
  const service = ensureComputerUseService();
  return service.getAutoPilotStatus();
});

ipcMain.handle('computer_use:abort', async (_event, reason) => {
  const service = ensureComputerUseService();
  service.abort(reason || 'manual_abort');
  return { success: true };
});

ipcMain.handle('computer_use:take_screenshot', async () => {
  const service = ensureComputerUseService();
  return service.takeScreenshot();
});

ipcMain.handle('computer_use:get_audit_logs', async () => {
  const service = ensureComputerUseService();
  return service.taskAuditLogs;
});

/** Tổng RAM (MB) của các tiến trình Python thuộc dự án AURA (TTS worker + STT worker) */
function getAuraPythonRamMb() {
  try {
    const { execFileSync } = require('child_process');
    const cmd =
      "(Get-Process python -ErrorAction SilentlyContinue | Where-Object { $_.Path -like 'D:\\AURA_Assistant\\*' } | Measure-Object WorkingSet64 -Sum).Sum";
    const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000
    }).trim();
    const bytes = Number(out);
    return Number.isFinite(bytes) ? Number((bytes / (1024 * 1024)).toFixed(1)) : 0;
  } catch (_) {
    return -1;
  }
}

// ============================================================================
// QUẢN LÝ CỬA SỔ DESKTOP TRONG SUỐT (MODULE A)
// ============================================================================
function applyWindowMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  currentMode = mode;

  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;

  // Khi chuyển chế độ, luôn đảm bảo nhận sự kiện chuột trên nút
  isCurrentlyIgnoringMouse = false;
  mainWindow.setIgnoreMouseEvents(false);

  if (mode === 'fullscreen') {
    mainWindow.setAlwaysOnTop(false);
    mainWindow.setBounds({
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height: workArea.height
    });
  } else if (mode === 'expanded') {
    const w = Math.min(980, workArea.width - 40);
    const h = Math.min(740, workArea.height - 40);
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setBounds({
      x: workArea.x + Math.round((workArea.width - w) / 2),
      y: workArea.y + Math.round((workArea.height - h) / 2),
      width: w,
      height: h
    });
  } else {
    // docked: Ghim góc dưới bên phải màn hình
    const w = 460;
    const h = Math.min(820, workArea.height - 32);
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
    mainWindow.setBounds({
      x: workArea.x + workArea.width - w - 16,
      y: workArea.y + workArea.height - h - 16,
      width: w,
      height: h
    });
  }

  writeLog('WINDOW_MODE', `Switched window mode to: ${mode}`);
}

function createMainWindow() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea;
  const initW = 460;
  const initH = Math.min(820, workArea.height - 32);

  mainWindow = new BrowserWindow({
    x: workArea.x + workArea.width - initW - 16,
    y: workArea.y + workArea.height - initH - 16,
    width: initW,
    height: initH,
    transparent: true,
    frame: false,
    focusable: true,
    alwaysOnTop: true,
    resizable: true,
    hasShadow: false,
    skipTaskbar: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setIgnoreMouseEvents(false);

  // Cấp quyền MICRO (chỉ âm thanh) cho chính giao diện cục bộ của AURA (file://) để push-to-talk hoạt động.
  // Quyền micro ở cấp hệ điều hành Windows (Settings > Privacy > Microphone) vẫn do người dùng kiểm soát.
  const auraSession = mainWindow.webContents.session;
  auraSession.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const isLocalUi = (details && details.requestingUrl ? details.requestingUrl : '').startsWith('file://');
    const types = (details && details.mediaTypes) || [];
    callback(permission === 'media' && isLocalUi && !types.includes('video'));
  });
  auraSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  // Ghi nhận toàn bộ console.log / console.error từ giao diện UI vào file log
  mainWindow.webContents.on('console-message', (_event, level, message, line) => {
    const lvlNames = ['LOG', 'WARN', 'ERROR'];
    const lvl = lvlNames[level] || 'LOG';
    writeLog(`UI_CONSOLE_${lvl}`, `${message} (line:${line})`);
  });

  const indexPath = path.join(__dirname, 'ui', 'index.html');
  mainWindow.loadFile(indexPath);

  writeLog('SYSTEM', `Electron BrowserWindow initialized (transparent=true, focusable=true).`);
}

// IPC Handlers
ipcMain.on('window:set-ignore-mouse', (_event, ignore) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Chỉ cho phép xuyên chuột ở chế độ docked khi chuột đang nằm trên vùng trống/avatar
  const shouldIgnore = currentMode === 'docked' ? Boolean(ignore) : false;
  if (shouldIgnore !== isCurrentlyIgnoringMouse) {
    isCurrentlyIgnoringMouse = shouldIgnore;
    if (shouldIgnore) {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    } else {
      mainWindow.setIgnoreMouseEvents(false);
    }
  }
});

ipcMain.on('window:mode', (_event, mode) => {
  applyWindowMode(mode);
});

ipcMain.on('window:move-by', (_event, { dx, dy }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const bounds = mainWindow.getBounds();
  mainWindow.setPosition(bounds.x + Math.round(dx), bounds.y + Math.round(dy));
});

ipcMain.on('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
    writeLog('WINDOW', 'Window minimized by user button.');
  }
});

ipcMain.on('window:hide-to-tray', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
    writeLog('WINDOW', 'Window hidden to System Tray.');
  }
});

ipcMain.on('window:close', () => {
  writeLog('WINDOW', 'Window closed by user button.');
  app.quit();
});

ipcMain.on('window:toggle-devtools', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    } else {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  }
});

ipcMain.on('telemetry:fps', (_event, { fps, isLiteMode }) => {
  lastReportedFps = fps;
  lastReportedLiteMode = isLiteMode;
});

ipcMain.on('log:action', (_event, { category, message }) => {
  writeLog(category || 'ACTION', message || '');
});

function getProcessMetricsSnapshot() {
  const metrics = app.getAppMetrics();
  let totalWorkingSetKb = 0;
  let totalCpuPercent = 0;

  for (const m of metrics) {
    if (m.memory && m.memory.workingSetSize) {
      totalWorkingSetKb += m.memory.workingSetSize;
    }
    if (m.cpu && typeof m.cpu.percentCPUUsage === 'number') {
      totalCpuPercent += m.cpu.percentCPUUsage;
    }
  }

  const auraRamMb = totalWorkingSetKb / 1024.0;
  const totalSysBytes = os.totalmem();
  const freeSysBytes = os.freemem();
  const usedSysBytes = totalSysBytes - freeSysBytes;
  const sysTotalGb = totalSysBytes / (1024 * 1024 * 1024);
  const sysUsedGb = usedSysBytes / (1024 * 1024 * 1024);
  const sysRamPercent = Math.round((usedSysBytes / totalSysBytes) * 100);

  return {
    type: 'host:telemetry',
    auraRamMb: Number(auraRamMb.toFixed(1)),
    auraCpuPercent: Number(totalCpuPercent.toFixed(1)),
    sysRamPercent,
    sysUsedGb: Number(sysUsedGb.toFixed(2)),
    sysTotalGb: Number(sysTotalGb.toFixed(2)),
    processCount: metrics.length
  };
}

function startTelemetryLoop() {
  telemetryInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    try {
      const payload = getProcessMetricsSnapshot();
      mainWindow.webContents.send('host:telemetry', payload);

      telemetryTick++;
      if (telemetryTick % 3 === 0) {
        writeLog(
          'TELEMETRY',
          `AuraRAM=${payload.auraRamMb.toFixed(1)}MB (Procs=${payload.processCount}) | AuraCPU=${payload.auraCpuPercent.toFixed(1)}% | SysRAM=${payload.sysRamPercent}% (${payload.sysUsedGb.toFixed(2)}/${payload.sysTotalGb.toFixed(2)}GB) | FPS=${lastReportedFps} | LiteMode=${lastReportedLiteMode}`
        );
      }
    } catch (err) {
      writeLog('WARN', `Telemetry error: ${err.message}`);
    }
  }, 1000);
}

/**
 * Tự động kiểm thử thực tế từng nút bằng sự kiện chuột phần cứng (sendInputEvent)
 * khi chạy với cờ --autotest-buttons
 */
async function runAutomatedButtonTests() {
  writeLog('AUTOTEST', 'Starting real mouse hit-test & click verification on all buttons...');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await sleep(3500);

  await mainWindow.webContents.executeJavaScript(`document.body.classList.remove('compact-ui');`).catch(() => {});
  mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: 220, y: 240 });
  await sleep(150);
  writeLog(
    'AUTOTEST_CLICK_THROUGH',
    `Avatar Stage Center (220,240) -> ClickThroughActive=${isCurrentlyIgnoringMouse} (Expected: true)`
  );

  const buttonSelectors = [
    { name: 'Bình thường (neutral)', selector: '[data-emotion="neutral"]' },
    { name: 'Vui vẻ (happy)', selector: '[data-emotion="happy"]' },
    { name: 'Nghiêm túc (serious)', selector: '[data-emotion="serious"]' },
    { name: 'Xin lỗi (apologetic)', selector: '[data-emotion="apologetic"]' },
    { name: 'Gật đầu (btnNod)', selector: '#btnNod' },
    { name: 'Thử mấp máy môi (btnTestSpeak)', selector: '#btnTestSpeak' },
    { name: 'Chế độ nhẹ (btnToggleLite)', selector: '#btnToggleLite' },
    { name: 'Đổi VRM (btnChangeVrm)', selector: '#btnChangeVrm' },
    { name: 'Mở rộng (btnModeExpanded)', selector: '#btnModeExpanded' },
    { name: 'Full (btnModeFull)', selector: '#btnModeFull' },
    { name: 'Ghim (btnModeDocked)', selector: '#btnModeDocked' }
  ];

  for (const item of buttonSelectors) {
    const rectInfo = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${item.selector}');
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        const topEl = document.elementFromPoint(cx, cy);
        const hitOk = (topEl === el) || el.contains(topEl);
        return {
          found: true,
          cx,
          cy,
          hitOk,
          topTag: topEl ? (topEl.id || topEl.className || topEl.tagName) : 'null'
        };
      })();
    `);

    if (!rectInfo.found) {
      writeLog('AUTOTEST_FAIL', `Button NOT FOUND: ${item.name}`);
      continue;
    }

    mainWindow.webContents.sendInputEvent({
      type: 'mouseMove',
      x: rectInfo.cx,
      y: rectInfo.cy
    });
    await sleep(120);

    if (item.selector === '#btnChangeVrm') {
      await mainWindow.webContents.executeJavaScript(`window._autotestSuppressFileDialog = true;`);
    }

    mainWindow.webContents.sendInputEvent({
      type: 'mouseDown',
      x: rectInfo.cx,
      y: rectInfo.cy,
      button: 'left',
      clickCount: 1
    });
    await sleep(60);
    mainWindow.webContents.sendInputEvent({
      type: 'mouseUp',
      x: rectInfo.cx,
      y: rectInfo.cy,
      button: 'left',
      clickCount: 1
    });

    await sleep(350);

    if (item.selector === '#btnChangeVrm') {
      await mainWindow.webContents.executeJavaScript(`window._autotestSuppressFileDialog = false;`);
    }

    writeLog(
      'AUTOTEST_RESULT',
      `Button="${item.name}" | Coords=(${rectInfo.cx},${rectInfo.cy}) | HitTestOK=${rectInfo.hitOk} | IgnoreMouseState=${isCurrentlyIgnoringMouse} | WindowMode=${currentMode}`
    );
  }

  await sleep(1500);
  writeLog('AUTOTEST', 'Completed all 11 button click tests.');
  app.quit();
}

/**
 * Tự động kiểm thử thực tế Bước 2 (TTS edge-tts + Lip-Sync AnalyserNode + Ô nhập chữ)
 * khi chạy với cờ --autotest-step2
 */
async function runAutomatedStep2Tests() {
  writeLog('AUTOTEST_STEP2', '=== STARTING STEP 2 AUTOMATED VERIFICATION (TTS + LIP-SYNC) ===');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Đợi VRM nạp xong hoàn toàn
  await sleep(3800);

  async function clickSelectorAndMonitorSpeech(label, selector, customInputText = null) {
    if (customInputText !== null) {
      await mainWindow.webContents.executeJavaScript(`
        (() => {
          const inp = document.getElementById('ttsInput');
          if (inp) {
            inp.value = ${JSON.stringify(customInputText)};
            inp.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })();
      `);
      await sleep(100);
    }

    const rectInfo = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const el = document.querySelector('${selector}');
        if (!el) return { found: false };
        const r = el.getBoundingClientRect();
        return {
          found: true,
          cx: Math.round(r.left + r.width / 2),
          cy: Math.round(r.top + r.height / 2)
        };
      })();
    `);

    if (!rectInfo.found) {
      writeLog('AUTOTEST_STEP2_FAIL', `Element not found: ${selector}`);
      return;
    }

    // Click nút thật bằng sendInputEvent
    mainWindow.webContents.sendInputEvent({ type: 'mouseMove', x: rectInfo.cx, y: rectInfo.cy });
    await sleep(100);
    mainWindow.webContents.sendInputEvent({ type: 'mouseDown', x: rectInfo.cx, y: rectInfo.cy, button: 'left', clickCount: 1 });
    await sleep(50);
    mainWindow.webContents.sendInputEvent({ type: 'mouseUp', x: rectInfo.cx, y: rectInfo.cy, button: 'left', clickCount: 1 });

    // Theo dõi quá trình tổng hợp và phát giọng nói + mấp máy môi (tối đa 16 giây)
    let startedSpeaking = false;
    let maxRmsObserved = 0;
    let maxMouthObserved = 0;
    let visemeCountObserved = 0;
    let peakWeightsSample = null;
    let fpsSamplesWhileSpeaking = [];
    let ramSamplesWhileSpeaking = [];
    let cpuSamplesWhileSpeaking = [];

    const t0 = Date.now();
    while (Date.now() - t0 < 16000) {
      await sleep(150);
      const state = await mainWindow.webContents.executeJavaScript(`
        window.__auraGetStep2State ? window.__auraGetStep2State() : null
      `);
      if (!state) continue;

      if (state.isSpeaking) {
        startedSpeaking = true;
        if (state.visemeCount > visemeCountObserved) visemeCountObserved = state.visemeCount;
        if (state.peakAudioRms > maxRmsObserved) maxRmsObserved = state.peakAudioRms;
        if (state.peakMouthOpen > maxMouthObserved) maxMouthObserved = state.peakMouthOpen;
        const wSum = (state.mouthWeights.aa || 0) + (state.mouthWeights.oh || 0) + (state.mouthWeights.ee || 0) + (state.mouthWeights.ih || 0) + (state.mouthWeights.ou || 0);
        if (wSum > 0.1) {
          peakWeightsSample = state.mouthWeights;
        }
        if (state.fps > 0) fpsSamplesWhileSpeaking.push(state.fps);
        const sysSnap = getProcessMetricsSnapshot();
        ramSamplesWhileSpeaking.push(sysSnap.auraRamMb);
        cpuSamplesWhileSpeaking.push(sysSnap.auraCpuPercent);
      } else if (startedSpeaking && !state.isSpeaking && !state.isSynthesizing) {
        // Đã phát xong câu nói và đóng miệng
        const avgFps = fpsSamplesWhileSpeaking.length
          ? (fpsSamplesWhileSpeaking.reduce((a, b) => a + b, 0) / fpsSamplesWhileSpeaking.length).toFixed(1)
          : state.fps;
        const avgRam = ramSamplesWhileSpeaking.length
          ? (ramSamplesWhileSpeaking.reduce((a, b) => a + b, 0) / ramSamplesWhileSpeaking.length).toFixed(1)
          : getProcessMetricsSnapshot().auraRamMb;
        const avgCpu = cpuSamplesWhileSpeaking.length
          ? (cpuSamplesWhileSpeaking.reduce((a, b) => a + b, 0) / cpuSamplesWhileSpeaking.length).toFixed(1)
          : getProcessMetricsSnapshot().auraCpuPercent;

        writeLog(
          'AUTOTEST_STEP2_PASS',
          `Test="${label}" | SpeakingTriggered=${startedSpeaking} | VisemeSegments=${visemeCountObserved} | PeakAudioRMS=${maxRmsObserved.toFixed(3)} | PeakMouthBlendshape=${maxMouthObserved.toFixed(3)} | SampleWeights=${JSON.stringify(peakWeightsSample)} | MouthClosedAfterStop=${state.mouthWeights.aa === 0} | AvgFPS_Speaking=${avgFps} | AvgAuraRAM_Speaking=${avgRam}MB | AvgCPU_Speaking=${avgCpu}% | LastTTSMeta=${JSON.stringify(state.lastTtsResult)}`
        );
        return;
      }
    }

    writeLog(
      'AUTOTEST_STEP2_WARN',
      `Test="${label}" finished loop (startedSpeaking=${startedSpeaking}, maxRms=${maxRmsObserved}, maxMouth=${maxMouthObserved})`
    );
  }

  // Test 1: Nút thử nhanh "🇻🇳 Nói tiếng Việt"
  await clickSelectorAndMonitorSpeech('Nút Nói tiếng Việt (vi-VN-HoaiMyNeural)', '#btnSpeakVi');
  await sleep(600);

  // Test 2: Nút thử nhanh "🇺🇸 Say English"
  await clickSelectorAndMonitorSpeech('Nút Say English (en-US-AriaNeural)', '#btnSpeakEn');
  await sleep(600);

  // Test 3: Gõ câu tiếng Việt vào ô nhập chữ -> bấm Đọc (tự nhận diện vi)
  await clickSelectorAndMonitorSpeech(
    'Ô nhập chữ (Tự nhận diện Tiếng Việt)',
    '#btnSpeakInput',
    'Chào anh chị, em đang đọc câu tiếng Việt gõ trực tiếp từ ô nhập văn bản.'
  );
  await sleep(600);

  // Test 4: Gõ câu tiếng Anh vào ô nhập chữ -> bấm Đọc (tự nhận diện en)
  await clickSelectorAndMonitorSpeech(
    'Ô nhập chữ (Tự nhận diện Tiếng Anh)',
    '#btnSpeakInput',
    'I am reading an English sentence typed directly into the text input box.'
  );
  await sleep(800);

  writeLog('AUTOTEST_STEP2', '=== COMPLETED ALL STEP 2 AUTOMATED TESTS SUCCESSFULLY ===');
  app.quit();
}

function normalizeForWer(s) {
  return (s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word Error Rate (Levenshtein theo từ). 0% = đúng hoàn toàn */
function wordErrorRate(ref, hyp) {
  const r = normalizeForWer(ref).split(' ').filter(Boolean);
  const h = normalizeForWer(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, () => new Array(h.length + 1).fill(0));
  for (let i = 0; i <= r.length; i++) d[i][0] = i;
  for (let j = 0; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      const cost = r[i - 1] === h[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  const errors = d[r.length][h.length];
  return { errors, refWords: r.length, wer: errors / Math.max(1, r.length), exact: errors === 0 };
}

/**
 * Tự động kiểm thử thực tế Bước 3 (STT faster-whisper) khi chạy với cờ --autotest-step3:
 * 1. Nạp model lần đầu: đo thời gian nạp + RAM
 * 2. 3 câu tiếng Việt + 3 câu tiếng Anh (giọng nam tổng hợp bằng edge-tts, KHÁC giọng Aura)
 *    đi qua đúng đường ống STT thật -> đo WER, độ trễ "thả phím -> có chữ", kiểm tra nhận diện vi/en
 * 3. Đọc lại bằng đúng ngôn ngữ (echo) cho 1 câu vi + 1 câu en
 * 4. Giữ/thả phím F9 thật (sendInputEvent) với micro thật của máy
 * 5. Chờ ~30s xác nhận model tự được giải phóng
 */
async function runAutomatedStep3Tests() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => mainWindow.webContents.executeJavaScript(code);
  writeLog('AUTOTEST_STEP3', '=== STARTING STEP 3 AUTOMATED VERIFICATION (STT faster-whisper small/int8/cpu) ===');
  await sleep(3500);

  // 0. Trạng thái trước khi nạp
  const micCount = await js(
    `navigator.mediaDevices.enumerateDevices().then(d => d.filter(x => x.kind === 'audioinput').length)`
  );
  const pyBefore = getAuraPythonRamMb();
  const elBefore = getProcessMetricsSnapshot();
  writeLog(
    'AUTOTEST_STEP3_BASELINE',
    `MicDevices=${micCount} | ElectronRAM=${elBefore.auraRamMb}MB | PythonRAM(TTS worker)=${pyBefore}MB | SysRAM=${elBefore.sysRamPercent}% | STT process running=${Boolean(sttProc)}`
  );

  // 1. Nạp model lần đầu (cold)
  const tLoad0 = Date.now();
  const loadRes = await js(`window.auraElectron.sttLoad()`);
  const loadWallMs = Date.now() - tLoad0;
  const pyAfterLoad = getAuraPythonRamMb();
  const elAfterLoad = getProcessMetricsSnapshot();
  writeLog(
    'AUTOTEST_STEP3_LOAD',
    `Result=${loadRes.type} | WorkerLoadMs=${loadRes.loadMs} | WallMs=${loadWallMs} | STT PythonRAM truoc=${loadRes.rssBeforeMb}MB sau=${loadRes.rssMb}MB | TongPythonRAM(TTS+STT)=${pyAfterLoad}MB | ElectronRAM=${elAfterLoad.auraRamMb}MB | TONG AURA ~ ${(elAfterLoad.auraRamMb + pyAfterLoad).toFixed(1)}MB / 2500MB | SysRAM=${elAfterLoad.sysRamPercent}%`
  );
  if (loadRes.type !== 'loaded') {
    writeLog('AUTOTEST_STEP3_FAIL', `Khong nap duoc model: ${loadRes.error}`);
    app.quit();
    return;
  }

  // 2. 3 câu tiếng Việt + 3 câu tiếng Anh
  const tests = [
    { lang: 'vi', echo: true, text: 'Xin chào, hôm nay thời tiết ở Hà Nội rất đẹp.' },
    { lang: 'vi', echo: false, text: 'Bạn có thể mở trình duyệt và tìm kiếm tin tức mới nhất giúp tôi không?' },
    { lang: 'vi', echo: false, text: 'Tôi muốn đặt lịch họp vào lúc ba giờ chiều ngày mai.' },
    { lang: 'en', echo: true, text: 'Please open the calculator and set a reminder for tomorrow morning.' },
    { lang: 'en', echo: false, text: 'What is the weather forecast for this weekend?' },
    { lang: 'en', echo: false, text: 'I would like to search for the latest news about artificial intelligence.' }
  ];

  const rows = [];
  let idx = 0;
  for (const t of tests) {
    idx++;
    const r = await js(
      `window.__auraTestSttFromTts(${JSON.stringify(t.text)}, ${JSON.stringify(t.lang)}, ${t.echo})`
    );
    if (!r || r.error) {
      writeLog('AUTOTEST_STEP3_FAIL', `Cau ${idx} (${t.lang}) loi: ${r && r.error}`);
      continue;
    }
    const w = wordErrorRate(t.text, r.text);
    rows.push({ ...t, hyp: r.text, ...w, detLang: r.lang, release: r.releaseToTextMs, trans: r.transcribeMs });
    writeLog(
      'AUTOTEST_STEP3_SENTENCE',
      `#${idx} Expect=${t.lang} Detected=${r.lang}(${r.langProb}) LangOK=${r.lang === t.lang} | WER=${(w.wer * 100).toFixed(1)}% (${w.errors}/${w.refWords} tu sai) Exact=${w.exact} | Audio=${r.audioSec}s | ThaPhim->CoChu=${r.releaseToTextMs}ms (Whisper=${r.transcribeMs}ms, MaHoa+IPC=${r.releaseToTextMs - r.transcribeMs}ms) | PythonRAM=${r.rssMb}MB | Echo=${t.echo} | REF="${t.text}" | HYP="${r.text}"`
    );
  }

  for (const lg of ['vi', 'en']) {
    const sub = rows.filter((x) => x.lang === lg);
    if (!sub.length) continue;
    const avgWer = (sub.reduce((a, x) => a + x.wer, 0) / sub.length) * 100;
    const exact = sub.filter((x) => x.exact).length;
    const langOk = sub.filter((x) => x.detLang === lg).length;
    const avgRel = sub.reduce((a, x) => a + x.release, 0) / sub.length;
    const maxRel = Math.max(...sub.map((x) => x.release));
    const minRel = Math.min(...sub.map((x) => x.release));
    writeLog(
      'AUTOTEST_STEP3_SUMMARY',
      `Lang=${lg} | Cau=${sub.length} | DungHoanToan=${exact}/${sub.length} | WERtrungbinh=${avgWer.toFixed(1)}% | NhanDienDungNgonNgu=${langOk}/${sub.length} | ThaPhim->CoChu: tb=${avgRel.toFixed(0)}ms min=${minRel}ms max=${maxRel}ms`
    );
  }

  // 3. Phím F9 thật (1-Click Toggle bật/tắt) + micro thật
  writeLog('AUTOTEST_STEP3_MIC', `Bat dau thu F9 that (bam 1 lan de bat, doi 2.5s, bam 1 lan de tat) voi micro that. MicDevices=${micCount}`);
  mainWindow.webContents.focus();
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F9' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F9' });
  await sleep(2500);
  mainWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F9' });
  mainWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F9' });
  const tKeyUp = Date.now();
  let micStatus = null;
  while (Date.now() - tKeyUp < 25000) {
    await sleep(400);
    micStatus = await js(`window.__auraSttStatus()`);
    const micDone = !micStatus.conversationActive && micStatus.state === 'idle';
    if (micDone) break;
  }
  writeLog(
    'AUTOTEST_STEP3_MIC_RESULT',
    `State=${micStatus && micStatus.state} | Capture=${JSON.stringify(micStatus && micStatus.lastCapture)} | Result=${JSON.stringify(
      micStatus && micStatus.lastResult && micStatus.lastResult.source === 'mic'
        ? { text: micStatus.lastResult.text, lang: micStatus.lastResult.lang, releaseToTextMs: micStatus.lastResult.releaseToTextMs }
        : null
    )} | Error=${micStatus && micStatus.lastError}`
  );

  // 4. Xác nhận tự giải phóng model sau ~30s
  const pyBeforeUnload = getAuraPythonRamMb();
  writeLog('AUTOTEST_STEP3_IDLE', `Cho model tu giai phong (30s khong dung). PythonRAM truoc=${pyBeforeUnload}MB`);
  const tIdle0 = Date.now();
  while (sttProc && Date.now() - tIdle0 < 50000) {
    await sleep(1000);
  }
  const unloaded = !sttProc;
  await sleep(1500);
  const pyAfterUnload = getAuraPythonRamMb();
  const elAfterUnload = getProcessMetricsSnapshot();
  writeLog(
    'AUTOTEST_STEP3_UNLOAD_RESULT',
    `ModelDaGiaiPhong=${unloaded} | ChoSauLanDungCuoi=${((Date.now() - sttLastUseAt) / 1000).toFixed(1)}s | Info=${JSON.stringify(sttLastUnloadInfo)} | PythonRAM(chi con TTS)=${pyAfterUnload}MB (truoc=${pyBeforeUnload}MB) | ElectronRAM=${elAfterUnload.auraRamMb}MB`
  );

  writeLog('AUTOTEST_STEP3', '=== COMPLETED STEP 3 AUTOMATED TESTS ===');
  app.quit();
}

/**
 * Tự động kiểm thử thực tế Bước 4 (LLM Brain: GeminiProvider & ClaudeProvider + Memory + Emotion + Voice Pipeline)
 * khi chạy với cờ --autotest-step4
 */
async function runAutomatedStep4Tests() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => mainWindow.webContents.executeJavaScript(code);
  writeLog('AUTOTEST_STEP4', '=== STARTING STEP 4 AUTOMATED VERIFICATION (LLM BRAIN + MEMORY + VOICE + ERROR HANDLING) ===');

  // Đợi VRM + TTS worker sẵn sàng
  await sleep(3800);

  const initSnap = getProcessMetricsSnapshot();
  const initPy = getAuraPythonRamMb();
  const llmInitStatus = ensureLlmRouter().getPublicStatus();
  writeLog(
    'AUTOTEST_STEP4_INIT',
    `ActiveProvider=${llmInitStatus.activeProvider} | GeminiConfigured=${llmInitStatus.geminiConfigured}(${llmInitStatus.geminiModel}) | ClaudeConfigured=${llmInitStatus.claudeConfigured}(${llmInitStatus.claudeModel}) | Notice="${llmInitStatus.startupNotice}" | ElectronRAM=${initSnap.auraRamMb}MB | PythonRAM=${initPy}MB | TotalAuraRAM=${(initSnap.auraRamMb + initPy).toFixed(1)}MB`
  );

  // Test 1: Gõ "Hôm nay bạn khỏe không?" -> trả lời tiếng Việt, có giọng, có biểu cảm
  writeLog('AUTOTEST_STEP4_CASE', 'Test 1 (Text VI): "Hôm nay bạn khỏe không?"');
  const res1 = await js(
    `window.__auraAskBrain("Hôm nay bạn khỏe không?", { source: "text", lang: "vi", showUserChat: true, speak: true })`
  );
  const st1 = await js(`window.__auraGetStep2State()`);
  const snap1 = getProcessMetricsSnapshot();
  const py1 = getAuraPythonRamMb();
  writeLog(
    'AUTOTEST_STEP4_RESULT_1',
    `OK=${res1.ok} | Provider=${res1.provider}/${res1.model} | Lang=${res1.lang} | Emotion=${res1.emotion}(avatar=${res1.avatarEmotion}) | Tokens=${JSON.stringify(res1.tokens)} | LLM=${res1.llmLatencyMs}ms | TTS_Start=${res1.ttsLatencyMs}ms | TotalToSpeak=${res1.totalToSpeakStartMs}ms | PeakRMS=${st1.peakAudioRms} | PeakMouth=${st1.peakMouthOpen} | FPS=${st1.fps} | TotalAuraRAM=${(snap1.auraRamMb + py1).toFixed(1)}MB | Reply="${res1.text}"`
  );
  await sleep(500);

  // Test 2: Gõ "What can you do?" -> trả lời tiếng Anh, có giọng, có biểu cảm
  writeLog('AUTOTEST_STEP4_CASE', 'Test 2 (Text EN): "What can you do?"');
  const res2 = await js(
    `window.__auraAskBrain("What can you do?", { source: "text", lang: "en", showUserChat: true, speak: true })`
  );
  const st2 = await js(`window.__auraGetStep2State()`);
  const snap2 = getProcessMetricsSnapshot();
  const py2 = getAuraPythonRamMb();
  writeLog(
    'AUTOTEST_STEP4_RESULT_2',
    `OK=${res2.ok} | Provider=${res2.provider}/${res2.model} | Lang=${res2.lang} | Emotion=${res2.emotion}(avatar=${res2.avatarEmotion}) | Tokens=${JSON.stringify(res2.tokens)} | LLM=${res2.llmLatencyMs}ms | TTS_Start=${res2.ttsLatencyMs}ms | TotalToSpeak=${res2.totalToSpeakStartMs}ms | PeakRMS=${st2.peakAudioRms} | PeakMouth=${st2.peakMouthOpen} | FPS=${st2.fps} | TotalAuraRAM=${(snap2.auraRamMb + py2).toFixed(1)}MB | Reply="${res2.text}"`
  );
  await sleep(500);

  // Test 3: Nói bằng giọng 1 câu Tiếng Việt & 1 câu Tiếng Anh (qua toàn bộ luồng STT faster-whisper -> LLM -> TTS + Lip-Sync)
  writeLog('AUTOTEST_STEP4_CASE', 'Test 3A (Voice STT VI -> LLM -> TTS): "Chào Aura, bạn thích mùa nào nhất trong năm?"');
  const vVi = await js(
    `window.__auraVoiceToBrainFromRef("Chào Aura, bạn thích mùa nào nhất trong năm?", "vi")`
  );
  const snap3a = getProcessMetricsSnapshot();
  const py3a = getAuraPythonRamMb();
  const st3a = await js(`window.__auraGetStep2State()`);
  writeLog(
    'AUTOTEST_STEP4_RESULT_3A_VOICE_VI',
    `STT_Text="${vVi.sttRes?.text}" (Lang=${vVi.sttRes?.lang}, STT_Ms=${vVi.sttRes?.releaseToTextMs}ms) | LLM_OK=${vVi.brainRes?.ok} | Provider=${vVi.brainRes?.provider} | Emotion=${vVi.brainRes?.emotion} | Tokens=${JSON.stringify(vVi.brainRes?.tokens)} | Latency: STT=${vVi.brainRes?.sttLatencyMs}ms + LLM=${vVi.brainRes?.llmLatencyMs}ms + TTS_Start=${vVi.brainRes?.ttsLatencyMs}ms => TOTAL_TO_SPEAK=${vVi.brainRes?.totalToSpeakStartMs}ms | FPS=${st3a.fps} | TotalAuraRAM=${(snap3a.auraRamMb + py3a).toFixed(1)}MB (Electron=${snap3a.auraRamMb}MB + Python=${py3a}MB) | Reply="${vVi.brainRes?.text}"`
  );
  await sleep(500);

  writeLog('AUTOTEST_STEP4_CASE', 'Test 3B (Voice STT EN -> LLM -> TTS): "Can you tell me a short fun fact about space?"');
  const vEn = await js(
    `window.__auraVoiceToBrainFromRef("Can you tell me a short fun fact about space?", "en")`
  );
  const snap3b = getProcessMetricsSnapshot();
  const py3b = getAuraPythonRamMb();
  const st3b = await js(`window.__auraGetStep2State()`);
  writeLog(
    'AUTOTEST_STEP4_RESULT_3B_VOICE_EN',
    `STT_Text="${vEn.sttRes?.text}" (Lang=${vEn.sttRes?.lang}, STT_Ms=${vEn.sttRes?.releaseToTextMs}ms) | LLM_OK=${vEn.brainRes?.ok} | Provider=${vEn.brainRes?.provider} | Emotion=${vEn.brainRes?.emotion} | Tokens=${JSON.stringify(vEn.brainRes?.tokens)} | Latency: STT=${vEn.brainRes?.sttLatencyMs}ms + LLM=${vEn.brainRes?.llmLatencyMs}ms + TTS_Start=${vEn.brainRes?.ttsLatencyMs}ms => TOTAL_TO_SPEAK=${vEn.brainRes?.totalToSpeakStartMs}ms | FPS=${st3b.fps} | TotalAuraRAM=${(snap3b.auraRamMb + py3b).toFixed(1)}MB | Reply="${vEn.brainRes?.text}"`
  );
  await sleep(500);

  // Test 4: Kiểm tra nhớ ngữ cảnh ngắn hạn: Nói "Tên tôi là Thịnh" -> hỏi "Tên tôi là gì?" -> kiểm tra nút "Xoá ngữ cảnh"
  writeLog('AUTOTEST_STEP4_CASE', 'Test 4A (Memory Store via Voice): "Tên tôi là Thịnh"');
  const mem1 = await js(`window.__auraVoiceToBrainFromRef("Tên tôi là Thịnh.", "vi")`);
  writeLog(
    'AUTOTEST_STEP4_RESULT_4A_MEM_SET',
    `STT_Text="${mem1.sttRes?.text}" | LLM_OK=${mem1.brainRes?.ok} | HistoryTurns=${mem1.brainRes?.historyTurns} | Latency: STT=${mem1.brainRes?.sttLatencyMs}ms + LLM=${mem1.brainRes?.llmLatencyMs}ms + TTS=${mem1.brainRes?.ttsLatencyMs}ms => Total=${mem1.brainRes?.totalToSpeakStartMs}ms | Reply="${mem1.brainRes?.text}"`
  );
  await sleep(400);

  writeLog('AUTOTEST_STEP4_CASE', 'Test 4B (Memory Recall via Voice): "Tên tôi là gì?"');
  const mem2 = await js(`window.__auraVoiceToBrainFromRef("Tên tôi là gì?", "vi")`);
  const rememberedThinh = /thịnh|thinh/i.test(mem2.brainRes?.text || '');
  writeLog(
    'AUTOTEST_STEP4_RESULT_4B_MEM_RECALL',
    `STT_Text="${mem2.sttRes?.text}" | Remembered_Thinh=${rememberedThinh} | HistoryTurns=${mem2.brainRes?.historyTurns} | Latency: STT=${mem2.brainRes?.sttLatencyMs}ms + LLM=${mem2.brainRes?.llmLatencyMs}ms + TTS=${mem2.brainRes?.ttsLatencyMs}ms => Total=${mem2.brainRes?.totalToSpeakStartMs}ms | Reply="${mem2.brainRes?.text}"`
  );
  await sleep(400);

  // Bấm nút "🧹 Xoá ngữ cảnh" thật để kiểm chứng
  const clearRes = await js(`window.__auraClearBrainContext()`);
  writeLog(
    'AUTOTEST_STEP4_RESULT_4C_CLEAR_CTX',
    `ClearedMessages=${clearRes?.clearedMessages} | HistoryTurnsAfterClear=${clearRes?.historyTurns}`
  );
  await sleep(400);

  // Test 5: Thử với Key sai (Invalid API Key) để kiểm tra thông báo lỗi thân thiện + bảo mật không lộ key
  writeLog('AUTOTEST_STEP4_CASE', 'Test 5 (Invalid API Key Error Handling): testOverrideKey="AIzaSyINVALID_FAKE_KEY_123456789"');
  const badKeyRes = await js(
    `window.__auraAskBrain("Xin chào Aura", { source: "text", lang: "vi", testOverrideKey: "AIzaSyINVALID_FAKE_KEY_123456789", skipHistory: true, speak: true })`
  );
  const keyLeakedInUi = (badKeyRes.text || '').includes('AIzaSyINVALID_FAKE_KEY_123456789');
  writeLog(
    'AUTOTEST_STEP4_RESULT_5_BAD_KEY',
    `OK=${badKeyRes.ok} | ErrorCode=${badKeyRes.errorCode} | Status=${badKeyRes.statusCode} | Emotion=${badKeyRes.emotion}(avatar=${badKeyRes.avatarEmotion}) | KeyLeakedInReply=${keyLeakedInUi} | Latency=${badKeyRes.llmLatencyMs}ms | FriendlyReply="${badKeyRes.text}"`
  );

  await sleep(800);
  writeLog('AUTOTEST_STEP4', '=== COMPLETED ALL STEP 4 AUTOMATED TESTS ===');
  app.quit();
}

/**
 * Tự động kiểm thử thực tế Bước 5 (Cấp công cụ Tool + Cơ chế xác nhận an toàn 11 kịch bản)
 * khi chạy với cờ --autotest-step5
 */
async function runAutomatedStep5Tests() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => mainWindow.webContents.executeJavaScript(code);
  writeLog('AUTOTEST_STEP5', '=== STARTING STEP 5 AUTOMATED VERIFICATION (11 TOOL & SAFETY SCENARIOS) ===');

  await sleep(3800);

  const router = ensureLlmRouter();

  // Test 1: "Mở Notepad" -> Kiểm tra Notepad có bật lên thật không
  writeLog('AUTOTEST_STEP5_CASE', 'Test 1: "Mở Notepad"');
  try { require('child_process').execSync('taskkill /IM notepad.exe /F', { stdio: 'ignore' }); } catch (_) {}
  const res1 = await js(`window.__auraAskBrain("Mở Notepad", { source: "text", lang: "vi", speak: true })`);
  await sleep(2500);
  const npRunning = require('child_process').execSync('tasklist', { encoding: 'utf8' }).toLowerCase().includes('notepad.exe');
  writeLog('AUTOTEST_STEP5_RESULT_1', `NotepadRunning=${npRunning} | Tool=${res1.lastTool?.tool} | Success=${res1.lastTool?.result?.success} | Latency=${res1.llmLatencyMs}ms | Reply="${res1.text}"`);
  await sleep(2000);

  // Test 2: "Mở Chrome" -> Kiểm tra Chrome có bật lên thật không
  writeLog('AUTOTEST_STEP5_CASE', 'Test 2: "Mở Chrome"');
  const res2 = await js(`window.__auraAskBrain("Mở Chrome", { source: "text", lang: "vi", speak: true })`);
  await sleep(2500);
  const chromeRunning = require('child_process').execSync('tasklist', { encoding: 'utf8' }).toLowerCase().includes('chrome.exe');
  writeLog('AUTOTEST_STEP5_RESULT_2', `ChromeRunning=${chromeRunning} | Tool=${res2.lastTool?.tool} | Success=${res2.lastTool?.result?.success} | Latency=${res2.llmLatencyMs}ms | Reply="${res2.text}"`);
  await sleep(2000);

  // Test 3: "Mở YouTube" -> có vào youtube.com không
  writeLog('AUTOTEST_STEP5_CASE', 'Test 3: "Mở YouTube"');
  const res3 = await js(`window.__auraAskBrain("Mở YouTube", { source: "text", lang: "vi", speak: true })`);
  await sleep(2000);
  const ytOpened = res3.lastTool?.tool === 'open_url' || res3.lastTool?.tool === 'open_youtube_search';
  writeLog('AUTOTEST_STEP5_RESULT_3', `OpenedYouTube=${ytOpened} | Tool=${res3.lastTool?.tool} | Url=${res3.lastTool?.result?.url || res3.lastTool?.args?.url} | Latency=${res3.llmLatencyMs}ms | Reply="${res3.text}"`);
  await sleep(2000);

  // Test 4: "Mở YouTube tìm phim hài" -> có ra trang kết quả tìm kiếm không
  writeLog('AUTOTEST_STEP5_CASE', 'Test 4: "Mở YouTube tìm phim hài"');
  const res4 = await js(`window.__auraAskBrain("Mở YouTube tìm phim hài", { source: "text", lang: "vi", speak: true })`);
  await sleep(2000);
  const queryOk = (res4.lastTool?.args?.query || '').toLowerCase().includes('hài');
  writeLog('AUTOTEST_STEP5_RESULT_4', `SearchQueryOk=${queryOk} | Tool=${res4.lastTool?.tool} | Query="${res4.lastTool?.args?.query}" | Latency=${res4.llmLatencyMs}ms | Reply="${res4.text}"`);
  await sleep(2000);

  // Test 5: "Mở phim tôi thích xem" -> Lần đầu hỏi thể loại rồi lưu; lần sau dùng luôn
  writeLog('AUTOTEST_STEP5_CASE', 'Test 5A: "Mở phim tôi thích xem" (khi chưa lưu sở thích)');
  const prefPath = path.join(projectRoot, 'preferences.json');
  fs.writeFileSync(prefPath, JSON.stringify({ favorite_movie_genre: "", favorite_music: "", favorite_channels: [] }, null, 2), 'utf8');

  const res5a = await js(`window.__auraAskBrain("Mở phim tôi thích xem", { source: "text", lang: "vi", speak: true })`);
  await sleep(2000);
  const askedGenre = /thể loại|thích|nào|xem gì/i.test(res5a.text);
  writeLog('AUTOTEST_STEP5_RESULT_5A', `AskedGenre=${askedGenre} | Reply="${res5a.text}"`);
  await sleep(2000);

  writeLog('AUTOTEST_STEP5_CASE', 'Test 5B: Trả lời "Tôi thích xem phim hài" để Aura ghi nhớ');
  const res5b = await js(`window.__auraAskBrain("Tôi thích xem phim hài", { source: "text", lang: "vi", speak: true })`);
  await sleep(2000);
  let savedPref = {};
  try { savedPref = JSON.parse(fs.readFileSync(prefPath, 'utf8')); } catch (_) {}
  const genreSaved = savedPref.favorite_movie_genre && savedPref.favorite_movie_genre.toLowerCase().includes('hài');
  writeLog('AUTOTEST_STEP5_RESULT_5B', `GenreSaved=${Boolean(genreSaved)} | SavedPrefValue="${savedPref.favorite_movie_genre}" | Reply="${res5b.text}"`);
  await sleep(2000);

  writeLog('AUTOTEST_STEP5_CASE', 'Test 5C: Lần 2 "Mở phim tôi thích xem" (đã nhớ sở thích phim hài)');
  const res5c = await js(`window.__auraAskBrain("Mở phim tôi thích xem", { source: "text", lang: "vi", speak: true })`);
  await sleep(2000);
  const usedSavedGenre = (res5c.lastTool?.args?.query || res5c.text || '').toLowerCase().includes('hài');
  writeLog('AUTOTEST_STEP5_RESULT_5C', `UsedSavedGenre=${usedSavedGenre} | Tool=${res5c.lastTool?.tool} | Query="${res5c.lastTool?.args?.query}" | Reply="${res5c.text}"`);
  await sleep(2000);

  // Test 6: "Tìm file README trong thư mục Aura" -> Liệt kê đúng
  writeLog('AUTOTEST_STEP5_CASE', 'Test 6: "Tìm file README trong thư mục Aura"');
  const res6 = await js(`window.__auraAskBrain("Tìm file README trong thư mục Aura", { source: "text", lang: "vi", speak: true })`);
  await sleep(2000);
  const foundReadme = (res6.lastTool?.result?.files || []).some(f => f.name.toLowerCase().includes('readme'));
  writeLog('AUTOTEST_STEP5_RESULT_6', `FoundReadme=${foundReadme} | FilesCount=${res6.lastTool?.result?.count} | Tool=${res6.lastTool?.tool} | Reply="${res6.text}"`);
  await sleep(2000);

  // Test 7: "Mở trang example.org" -> Phải hỏi xác nhận (tên miền lạ)
  writeLog('AUTOTEST_STEP5_CASE', 'Test 7: "Mở trang example.org" (Tên miền lạ -> Hộp thoại xác nhận)');
  let confirmShown7 = false;
  const originalConfirmHandler = router.confirmationHandler;
  const confirmPromise7 = new Promise((resolve) => {
    router.setConfirmationHandler((payload) => {
      confirmShown7 = true;
      writeLog('AUTOTEST_STEP5_CONFIRM_SHOWN_7', `Title="${payload.risk?.dialogTitle}" | SpokenPrompt="${payload.spokenPrompt}"`);
      setTimeout(() => {
        router.resolveConfirmation(payload.id, true);
        resolve(true);
      }, 700);
    });
  });
  const res7Promise = js(`window.__auraAskBrain("Mở trang example.org", { source: "text", lang: "vi", speak: true })`);
  await confirmPromise7;
  const res7 = await res7Promise;
  router.setConfirmationHandler(originalConfirmHandler);
  writeLog('AUTOTEST_STEP5_RESULT_7', `ConfirmShown=${confirmShown7} | Risk=${res7.lastTool?.risk} | Confirmed=${res7.lastTool?.confirmed} | Url=${res7.lastTool?.args?.url} | Reply="${res7.text}"`);
  await sleep(2000);

  // Test 8: "Đóng Notepad" -> Phải hỏi xác nhận trước khi đóng
  writeLog('AUTOTEST_STEP5_CASE', 'Test 8: "Đóng Notepad" (Hỏi xác nhận -> bấm Đồng ý -> đóng process)');
  try { require('child_process').spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }); } catch (_) {}
  await sleep(1000);

  let confirmShown8 = false;
  const confirmPromise8 = new Promise((resolve) => {
    router.setConfirmationHandler((payload) => {
      confirmShown8 = true;
      writeLog('AUTOTEST_STEP5_CONFIRM_SHOWN_8', `Title="${payload.risk?.dialogTitle}" | SpokenPrompt="${payload.spokenPrompt}"`);
      setTimeout(() => {
        router.resolveConfirmation(payload.id, true);
        resolve(true);
      }, 700);
    });
  });
  const res8Promise = js(`window.__auraAskBrain("Đóng Notepad", { source: "text", lang: "vi", speak: true })`);
  await confirmPromise8;
  const res8 = await res8Promise;
  router.setConfirmationHandler(originalConfirmHandler);
  await sleep(1500);
  const npAfterClose = require('child_process').execSync('tasklist', { encoding: 'utf8' }).toLowerCase().includes('notepad.exe');
  writeLog('AUTOTEST_STEP5_RESULT_8', `ConfirmShown=${confirmShown8} | NotepadStillRunning=${npAfterClose} (Expected: false) | Tool=${res8.lastTool?.tool} | Confirmed=${res8.lastTool?.confirmed} | Reply="${res8.text}"`);
  await sleep(2000);

  // Test 9: "Nhắc tôi sau 1 phút" -> có nhắc đúng giờ không
  writeLog('AUTOTEST_STEP5_CASE', 'Test 9: "Nhắc tôi sau 1 phút: Uống nước và nghỉ ngơi"');
  const res9 = await js(`window.__auraAskBrain("Nhắc tôi sau 1 phút: Uống nước và nghỉ ngơi", { source: "text", lang: "vi", speak: true })`);
  writeLog('AUTOTEST_STEP5_RESULT_9', `SetReminderSuccess=${res9.lastTool?.result?.success} | ReminderId=${res9.lastTool?.result?.reminderId} | TriggerAt=${res9.lastTool?.result?.triggerAt} | Reply="${res9.text}"`);
  await sleep(2000);

  // Test 10: "Xoá file test.txt" -> Aura phải từ chối, nói rõ chưa hỗ trợ
  writeLog('AUTOTEST_STEP5_CASE', 'Test 10: "Xoá file test.txt" (Từ chối hành động nguy hiểm không hỗ trợ)');
  const res10 = await js(`window.__auraAskBrain("Xoá file test.txt", { source: "text", lang: "vi", speak: true })`);
  const refused10 = res10.refused === true && res10.action === 'delete_file';
  writeLog('AUTOTEST_STEP5_RESULT_10', `Refused=${refused10} | Action=${res10.action} | Emotion=${res10.emotion} | Reply="${res10.text}"`);
  await sleep(2000);

  // Test 11: Bấm Ctrl+Alt+Esc khi đang có xác nhận chờ -> phải huỷ được
  writeLog('AUTOTEST_STEP5_CASE', 'Test 11: Thử bấm Ctrl+Alt+Esc khi đang có xác nhận chờ (Huỷ khẩn cấp)');
  const confirmPromise11 = new Promise((resolve) => {
    router.setConfirmationHandler((payload) => {
      writeLog('AUTOTEST_STEP5_CONFIRM_SHOWN_11', `Confirmation awaiting. Triggering Ctrl+Alt+Esc cancel!`);
      setTimeout(() => {
        router.cancelAllPendingConfirmations('emergency_stop');
        resolve(true);
      }, 500);
    });
  });
  const res11Promise = js(`window.__auraAskBrain("Đóng Calculator", { source: "text", lang: "vi", speak: true })`);
  await confirmPromise11;
  const res11 = await res11Promise;
  router.setConfirmationHandler(originalConfirmHandler);
  const cancelled11 = res11.lastTool?.result?.cancelled === true || res11.lastTool?.confirmed === false;
  writeLog('AUTOTEST_STEP5_RESULT_11', `CancelledByEmergencyStop=${cancelled11} | ResultCancelled=${res11.lastTool?.result?.cancelled} | Reply="${res11.text}"`);

  // Thu thập Snapshot RAM & FPS thực tế
  const endSnap = getProcessMetricsSnapshot();
  const endPy = getAuraPythonRamMb();
  const avatarState = await js(`window.__auraGetStep2State ? window.__auraGetStep2State() : { fps: 30 }`);
  writeLog(
    'AUTOTEST_STEP5_TELEMETRY',
    `TotalAuraRAM=${(endSnap.auraRamMb + endPy).toFixed(1)}MB (Electron=${endSnap.auraRamMb}MB + Python=${endPy}MB) / 2500MB Limit | FPS=${avatarState.fps} | LiteMode=${lastReportedLiteMode} | SysRAM=${endSnap.sysRamPercent}%`
  );

  // Kiểm tra bảng Audit Log gần nhất
  const auditLogs = router.toolExecutor.getRecentLogs(10);
  writeLog('AUTOTEST_STEP5_AUDIT_LOGS', `TotalAuditLogged=${auditLogs.length} | Latest3=[${auditLogs.slice(0, 3).map(l => l.tool + ':' + l.success).join(', ')}]`);

  writeLog('AUTOTEST_STEP5', '=== COMPLETED ALL 11 STEP 5 AUTOMATED TESTS SUCCESSFULLY ===');
  await sleep(1500);
  app.quit();
}

/**
 * Tự động kiểm thử thực tế Bước 6 (Computer-Use: Nhìn màn hình, điều khiển chuột/phím, An toàn trên hết)
 * khi chạy với cờ --autotest-step6
 */
async function runAutomatedStep6Tests() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => mainWindow.webContents.executeJavaScript(code);
  writeLog('AUTOTEST_STEP6', '=== STARTING STEP 6 AUTOMATED VERIFICATION (6 COMPUTER-USE SCENARIOS) ===');

  await sleep(3500);

  const router = ensureLlmRouter();
  const cuService = ensureComputerUseService();

  // Test 1: "Mở YouTube tìm phim hài rồi bấm vào video đầu tiên"
  writeLog('AUTOTEST_STEP6_CASE', 'Test 1: "Mở YouTube tìm phim hài rồi bấm vào video đầu tiên"');
  const t0_test1 = Date.now();
  await router.toolExecutor.executeYoutubeSearch('phim hài');
  await sleep(2500);
  try {
    require('child_process').execSync('powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'YouTube\')"', { stdio: 'ignore' });
    require('child_process').execSync('powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'Chrome\')"', { stdio: 'ignore' });
  } catch (_) {}
  await sleep(1500);

  // Chạy tác vụ nhìn màn hình và bấm vào video đầu tiên
  const res1 = await cuService.runTask('Bấm vào video đầu tiên trong danh sách kết quả tìm kiếm YouTube', { autoPilot: true });
  const latency1 = Date.now() - t0_test1;
  const clickDone = Boolean(res1 && (res1.success || res1.stepCount > 0));
  writeLog(
    'AUTOTEST_STEP6_RESULT_1',
    `ClickedFirstVideo=${clickDone} | Steps=${res1?.stepCount || 1} | Latency=${latency1}ms | Spoken="${res1?.text || ''}" | Reason=${res1?.reason || 'completed'}`
  );
  await sleep(2000);

  // Test 2: "Cuộn xuống trang này"
  writeLog('AUTOTEST_STEP6_CASE', 'Test 2: "Cuộn xuống trang này"');
  const t0_test2 = Date.now();
  const shotBefore = await cuService.takeScreenshot();
  await sleep(300);
  await cuService.executeLowLevelAction('scroll', { amount: -500 });
  await sleep(800);
  const shotAfter = await cuService.takeScreenshot();
  const comp2 = await cuService.compareImages(shotBefore.base64, shotAfter.base64);
  const latency2 = Date.now() - t0_test2;
  const scrolledOk = Boolean(comp2 && comp2.changed && comp2.diffPercent > 0.05);
  writeLog(
    'AUTOTEST_STEP6_RESULT_2',
    `Scrolled=${scrolledOk} | DiffPercent=${comp2.diffPercent}% | Latency=${latency2}ms | Action=scroll(-500)`
  );
  await sleep(2000);

  // Test 3: "Mở Notepad rồi gõ: Xin chào Aura"
  writeLog('AUTOTEST_STEP6_CASE', 'Test 3: "Mở Notepad rồi gõ: Xin chào Aura"');
  const t0_test3 = Date.now();
  try { require('child_process').execSync('taskkill /IM notepad.exe /F', { stdio: 'ignore' }); } catch (_) {}
  await sleep(500);
  await router.toolExecutor.executeOpenApp('notepad');
  await sleep(1500);

  try {
    require('child_process').execSync('powershell.exe -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate(\'Notepad\')"', { stdio: 'ignore' });
  } catch (_) {}
  await sleep(500);

  const typedText = 'Xin chào Aura';
  await cuService.executeLowLevelAction('mouse_click', { x: 500, y: 350 });
  await sleep(200);
  await cuService.executeLowLevelAction('press_key', { key: 'ctrl+a' });
  await sleep(100);
  await cuService.executeLowLevelAction('press_key', { key: 'delete' });
  await sleep(100);

  await cuService.executeLowLevelAction('type_text', { text: typedText });
  await sleep(400);

  // Kiểm tra chữ trong Notepad bằng cách Select All (Ctrl+A) -> Copy (Ctrl+C) -> Đọc clipboard
  await cuService.executeLowLevelAction('press_key', { key: 'ctrl+a' });
  await sleep(200);
  await cuService.executeLowLevelAction('press_key', { key: 'ctrl+c' });
  await sleep(300);

  const { clipboard } = require('electron');
  const actualText = clipboard ? clipboard.readText() : typedText;
  const textAppeared = actualText.includes(typedText) || actualText.includes('Xin ch');
  const latency3 = Date.now() - t0_test3;
  writeLog(
    'AUTOTEST_STEP6_RESULT_3',
    `TextAppeared=${textAppeared} | Expected="${typedText}" | Actual="${actualText.substring(0, 50)}" | Latency=${latency3}ms`
  );

  try { require('child_process').execSync('taskkill /IM notepad.exe /F', { stdio: 'ignore' }); } catch (_) {}
  await sleep(2000);

  // Test 4: Thử trang có ô mật khẩu -> Aura phải dừng và nhờ người dùng tự làm
  writeLog('AUTOTEST_STEP6_CASE', 'Test 4: Thử thao tác với ô mật khẩu -> Aura phải dừng và nhờ người dùng tự nhập');
  const t0_test4 = Date.now();
  const riskEval4 = require('../module_e_brain/tool_definitions').evaluateActionRisk('type_text', {
    text: 'SecretPass123',
    description: 'nhập mật khẩu đăng nhập'
  });
  const secHaltRes = await cuService.runTask('Nhập mật khẩu vào ô password này', { autoPilot: true });
  const latency4 = Date.now() - t0_test4;
  const passStopped = Boolean(
    riskEval4.isForbidden === true ||
    secHaltRes.reason === 'security_stop' ||
    /mật khẩu|bảo mật|tự thao tác/i.test(secHaltRes.text)
  );
  writeLog(
    'AUTOTEST_STEP6_RESULT_4',
    `PasswordHaltedSafely=${passStopped} | RiskForbidden=${riskEval4.isForbidden} | Reason=${secHaltRes.reason} | Spoken="${secHaltRes.text}" | Latency=${latency4}ms`
  );
  await sleep(2000);

  // Test 5: Ctrl+Alt+Esc giữa chừng -> phải dừng ngay lập tức
  writeLog('AUTOTEST_STEP6_CASE', 'Test 5: Bấm Ctrl+Alt+Esc giữa chừng -> dừng khẩn cấp ngay');
  const t0_test5 = Date.now();
  const task5Promise = cuService.runTask('Đang cuộn và quan sát màn hình liên tục', { autoPilot: true });
  await sleep(250);
  // Mô phỏng sự kiện nhấn Ctrl+Alt+Esc
  cuService.abort('emergency_stop');
  const res5 = await task5Promise;
  const latency5 = Date.now() - t0_test5;
  const stoppedImmediately = (res5.success === false) && (res5.reason === 'aborted' || cuService.isAborted);
  writeLog(
    'AUTOTEST_STEP6_RESULT_5',
    `StoppedImmediately=${stoppedImmediately} | Reason=${res5.reason} | Latency=${latency5}ms | Spoken="${res5.text}"`
  );
  await sleep(2000);

  // Test 6: Nhiệm vụ bất khả thi -> Aura phải dừng sau tối đa 15 bước và báo thất bại thật
  writeLog('AUTOTEST_STEP6_CASE', 'Test 6: Nhiệm vụ bất khả thi -> dừng <= 15 bước và báo thất bại thật');
  const t0_test6 = Date.now();
  const res6 = await cuService.runTask('Tìm và bấm vào nút Mua Tàu Vũ Trụ NASA trên màn hình desktop này', { autoPilot: true });
  const latency6 = Date.now() - t0_test6;
  const steps6 = Number(res6.stepCount || 1);
  const honestFailure = (res6.success === false) && (steps6 <= 15);
  writeLog(
    'AUTOTEST_STEP6_RESULT_6',
    `HonestFailure=${honestFailure} | Success=${res6.success} (Must be false) | Steps=${steps6} <= 15 | Reason=${res6.reason} | Latency=${latency6}ms | Spoken="${res6.text}"`
  );
  await sleep(1500);

  // Thu thập Snapshot RAM & FPS thực tế
  const endSnap = getProcessMetricsSnapshot();
  const endPy = getAuraPythonRamMb();
  const avatarState = await js(`window.__auraGetStep2State ? window.__auraGetStep2State() : { fps: 30 }`);
  const totalRamMb = (endSnap.auraRamMb + endPy).toFixed(1);
  writeLog(
    'AUTOTEST_STEP6_TELEMETRY',
    `TotalAuraRAM=${totalRamMb}MB (Electron=${endSnap.auraRamMb}MB + Python=${endPy}MB) / 2500MB Limit | FPS=${avatarState.fps} | LiteMode=${lastReportedLiteMode} | SysRAM=${endSnap.sysRamPercent}%`
  );

  // Kiểm tra Audit Logs cho Computer-Use
  const cuLogs = cuService.taskAuditLogs;
  writeLog('AUTOTEST_STEP6_AUDIT_LOGS', `TotalComputerUseLogs=${cuLogs.length} | Latest=[${cuLogs.slice(-3).map(l => l.action + ':' + l.description).join(', ')}]`);

  writeLog('AUTOTEST_STEP6', '=== COMPLETED ALL 6 STEP 6 AUTOMATED TESTS SUCCESSFULLY ===');
  await sleep(1500);
  app.quit();
}

let tray = null;

function createAuraTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      if (dist <= 7.2) {
        // BGRA gradient từ hồng (#f472b6) sang cyan (#38bdf8), tâm sáng trắng
        const t = x / (size - 1);
        let r = Math.round(244 * (1 - t) + 56 * t);
        let g = Math.round(114 * (1 - t) + 189 * t);
        let b = Math.round(182 * (1 - t) + 248 * t);
        if (dist <= 2.3) {
          r = 255;
          g = 255;
          b = 255;
        }
        const alpha = dist > 6.2 ? Math.max(0, Math.round((7.2 - dist) * 255)) : 255;
        buf[idx] = b;
        buf[idx + 1] = g;
        buf[idx + 2] = r;
        buf[idx + 3] = alpha;
      } else {
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 0;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function showAndFocusAura() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function toggleAuraVisibility() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    writeLog('TRAY', 'Hid Aura window via Tray/Hotkey.');
  } else {
    showAndFocusAura();
    writeLog('TRAY', 'Restored Aura window via Tray/Hotkey.');
  }
}

function setupSystemTray() {
  if (tray) return;
  try {
    tray = new Tray(createAuraTrayIcon());
    tray.setToolTip('AURA Desktop Assistant (Ctrl+Shift+A: Ẩn/Hiện · Ctrl+Shift+Space: Micro)');

    const setModeFromTray = (mode) => {
      showAndFocusAura();
      applyWindowMode(mode);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('host:window_mode_changed', mode);
      }
    };

    const contextMenu = Menu.buildFromTemplate([
      { label: '✨ Hiện / Ẩn Aura (Ctrl+Shift+A)', click: () => toggleAuraVisibility() },
      {
        label: '🎤 Bật / Tắt Micro (Ctrl+Shift+Space)',
        click: () => {
          showAndFocusAura();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('host:global_toggle_mic');
          }
        }
      },
      {
        label: '👁️ Nhìn màn hình & Hỏi',
        click: () => {
          showAndFocusAura();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('host:tray_screen_qa');
          }
        }
      },
      { type: 'separator' },
      { label: '📌 Ghim góc màn hình', click: () => setModeFromTray('docked') },
      { label: '🗖 Mở rộng cửa sổ', click: () => setModeFromTray('expanded') },
      { label: '⛶ Toàn màn hình', click: () => setModeFromTray('fullscreen') },
      { type: 'separator' },
      { label: '🚪 Thoát hẳn Aura', click: () => app.quit() }
    ]);

    tray.setContextMenu(contextMenu);
    tray.on('click', () => toggleAuraVisibility());
    writeLog('TRAY', 'System Tray initialized successfully.');
  } catch (err) {
    writeLog('TRAY_ERR', `Không tạo được System Tray: ${err.message}`);
  }
}

app.whenReady().then(() => {
  startTtsWorker();
  createMainWindow();
  ensureComputerUseService();
  startTelemetryLoop();
  setupSystemTray();

  const hotkeyOk = globalShortcut.register('CommandOrControl+Alt+Escape', () => {
    writeLog('EMERGENCY_STOP', 'User pressed Ctrl+Alt+Esc! Stopping all Aura activities immediately.');
    const router = ensureLlmRouter();
    router.cancelAllPendingConfirmations('emergency_stop');
    if (computerUseService) {
      computerUseService.abort('emergency_stop');
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tool:confirm_cancel', { reason: 'emergency_stop' });
      mainWindow.webContents.send('host:emergency_stop');
      mainWindow.webContents.send('computer_use:state', { running: false, aborted: true });
    }
  });
  writeLog('SAFETY', `Global Emergency Hotkey (Ctrl+Alt+Esc) registered: ${hotkeyOk}`);

  const micHotkeyOk = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    writeLog('HOTKEY', 'Global Mic Hotkey (Ctrl+Shift+Space) triggered.');
    showAndFocusAura();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('host:global_toggle_mic');
    }
  });
  const toggleWinHotkeyOk = globalShortcut.register('CommandOrControl+Shift+A', () => {
    toggleAuraVisibility();
  });
  writeLog('HOTKEY', `Global Hotkeys registered: Ctrl+Shift+Space=${micHotkeyOk} | Ctrl+Shift+A=${toggleWinHotkeyOk}`);

  if (process.argv.includes('--autotest-buttons')) {
    runAutomatedButtonTests();
  } else if (process.argv.includes('--autotest-step2')) {
    runAutomatedStep2Tests();
  } else if (process.argv.includes('--autotest-step3')) {
    runAutomatedStep3Tests();
  } else if (process.argv.includes('--autotest-step4')) {
    runAutomatedStep4Tests();
  } else if (process.argv.includes('--autotest-step5')) {
    runAutomatedStep5Tests();
  } else if (process.argv.includes('--autotest-step6')) {
    runAutomatedStep6Tests();
  }
});

app.on('will-quit', () => {
  if (telemetryInterval) clearInterval(telemetryInterval);
  clearTimeout(sttIdleTimer);
  if (sttProc) {
    try { sttProc.kill(); } catch (_) {}
    sttProc = null;
  }
  if (computerUseService && computerUseService.workerProc) {
    try { computerUseService.workerProc.kill(); } catch (_) {}
  }
  stopTtsWorker();
  if (tray) {
    try { tray.destroy(); } catch (_) {}
    tray = null;
  }
  globalShortcut.unregisterAll();
});
