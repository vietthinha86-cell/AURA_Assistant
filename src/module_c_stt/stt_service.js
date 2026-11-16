/**
 * ============================================================================
 * MODULE C: STT SERVICE (faster-whisper "small", int8, CPU) - phía giao diện
 * Thực thi giao diện ISTTProvider:
 * - Chế độ Trò chuyện Giọng nói Rảnh tay (1-Click Toggle Voice Conversation):
 *   + Bấm 1 lần nút Micro (hoặc nhấn F9 / Ctrl+Space 1 lần) để BẬT chế độ trò chuyện.
 *   + Tự động phát hiện khi người dùng bắt đầu nói (VAD + Pre-roll 380ms không mất chữ đầu)
 *     và tự động ngắt câu khi người dùng ngừng nói ~0.9 giây để gửi sang faster-whisper.
 *   + Tự động tạm dừng thu micro trong lúc Aura đang phát giọng trả lời (tránh vọng âm)
 *     và tự động nghe tiếp câu sau ngay khi Aura nói xong.
 *   + Bấm thêm 1 lần nữa để TẮT chế độ trò chuyện (nếu đang nói dở câu thì vẫn xử lý nốt câu đó).
 * - Model được GIẢI PHÓNG bởi tiến trình chủ sau ~30 giây không dùng.
 * ============================================================================
 */
import { ISTTProvider } from '../interfaces/aura_contracts.js';

const TARGET_RATE = 16000;
const FRAME_SIZE = 2048; // ~128ms mỗi khung ở 16kHz
const PRE_ROLL_FRAMES = 3; // Giữ ~384ms âm thanh trước khi phát hiện giọng nói để không mất âm đầu
const SILENCE_HANGOVER_MS = 920; // Ngừng nói ~0.92s sẽ tự động chốt câu và nhận diện
const MIN_SPEECH_MS = 320;
const MAX_UTTERANCE_MS = 18000;

function floatToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function concatFloat32(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export class WhisperSTTService extends ISTTProvider {
  constructor(eventBus, config = {}) {
    super();
    this.eventBus = eventBus;
    this.model = config.model || 'small';
    this.computeType = config.computeType || 'int8';

    // Trạng thái: idle | starting | listening | speaking | processing
    this.state = 'idle';
    this.isConversationActive = false;
    this.isPausedForReply = false;
    this.modelState = 'unloaded';

    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.processor = null;

    // Bộ dò giọng nói tự động (VAD)
    this.preRollChunks = [];
    this.utteranceChunks = [];
    this.inUtterance = false;
    this.utteranceStartAt = 0;
    this.speechActiveMs = 0;
    this.silenceMs = 0;
    this.noiseFloor = 0.006;

    this.lastResult = null;
    this.lastError = null;
    this.lastCapture = null;
    this.lastLoad = null;

    if (window.auraElectron && window.auraElectron.onSttStatus) {
      window.auraElectron.onSttStatus((s) => {
        this.modelState = s.state;
        if (this.eventBus) this.eventBus.emit('stt:model', s);
      });
    }
  }

  /** Giải mã file âm thanh (mp3/wav) thành PCM Float32 16kHz mono (dùng cho kiểm thử) */
  static async decodeToPcm16k(arrayBuffer) {
    const ctx = new AudioContext({ sampleRate: TARGET_RATE });
    try {
      const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const ch0 = buf.getChannelData(0);
      if (buf.numberOfChannels === 1) return new Float32Array(ch0);
      const mixed = new Float32Array(buf.length);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) mixed[i] += d[i] / buf.numberOfChannels;
      }
      return mixed;
    } finally {
      ctx.close();
    }
  }

  async requestModelLoad() {
    if (!window.auraElectron || !window.auraElectron.sttLoad) return null;
    try {
      const res = await window.auraElectron.sttLoad();
      if (res && res.type === 'loaded') this.lastLoad = res;
      return res;
    } catch (err) {
      this.lastError = `Nạp model lỗi: ${err.message}`;
      return null;
    }
  }

  _teardownCapture() {
    try { if (this.processor) { this.processor.onaudioprocess = null; this.processor.disconnect(); } } catch (_) {}
    try { if (this.source) this.source.disconnect(); } catch (_) {}
    try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    this.processor = null;
    this.source = null;
    this.stream = null;
    this.preRollChunks = [];
    this.utteranceChunks = [];
    this.inUtterance = false;
    this.speechActiveMs = 0;
    this.silenceMs = 0;
  }

  /**
   * Tạm dừng thu âm khi Aura đang phát tiếng nói trả lời (tránh micro thu lại loa ngoài)
   */
  setPausedForReply(paused) {
    this.isPausedForReply = Boolean(paused);
    if (this.isPausedForReply) {
      this.preRollChunks = [];
      this.utteranceChunks = [];
      this.inUtterance = false;
      this.speechActiveMs = 0;
      this.silenceMs = 0;
    } else if (this.isConversationActive) {
      this.state = 'listening';
      if (this.eventBus) this.eventBus.emit('stt:listening', { mode: 'continuous' });
    }
  }

  /**
   * Bấm 1 lần để BẬT / TẮT chế độ Trò chuyện Giọng nói (Toggle)
   */
  async toggleConversation() {
    if (this.isConversationActive || this.state === 'starting') {
      return await this.stopListening();
    } else {
      return await this.startListening({ mode: 'continuous' });
    }
  }

  /**
   * INTERFACE: Bắt đầu mở Micro & lắng nghe tự động (1-Click Start)
   */
  async startListening(options = { mode: 'continuous' }) {
    if (this.isConversationActive || this.state === 'starting') return true;
    this.state = 'starting';
    this.lastError = null;

    // Kích hoạt nạp model faster-whisper ngay khi bật chế độ trò chuyện
    if (options.warmModel !== false) {
      this.requestModelLoad();
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (!this.ctx) this.ctx = new AudioContext({ sampleRate: TARGET_RATE });
      if (this.ctx.state === 'suspended') await this.ctx.resume();

      this.preRollChunks = [];
      this.utteranceChunks = [];
      this.inUtterance = false;
      this.speechActiveMs = 0;
      this.silenceMs = 0;
      this.noiseFloor = 0.006;
      this.isPausedForReply = false;
      this.isConversationActive = true;

      this.source = this.ctx.createMediaStreamSource(this.stream);
      this.processor = this.ctx.createScriptProcessor(FRAME_SIZE, 1, 1);

      this.processor.onaudioprocess = (e) => {
        this._onAudioFrame(e.inputBuffer.getChannelData(0));
      };

      this.source.connect(this.processor);
      this.processor.connect(this.ctx.destination);

      this.state = 'listening';
      if (window.auraElectron && window.auraElectron.sttSetConversationActive) {
        window.auraElectron.sttSetConversationActive(true);
      }
      if (this.eventBus) {
        this.eventBus.emit('stt:conversation_state', { active: true });
        this.eventBus.emit('stt:listening', { mode: 'continuous' });
      }
      return true;
    } catch (err) {
      this._teardownCapture();
      this.isConversationActive = false;
      this.state = 'idle';
      this.lastError = `${err.name}: ${err.message}`;
      if (this.eventBus) {
        this.eventBus.emit('stt:conversation_state', { active: false });
        this.eventBus.emit('stt:error', { error: this.lastError });
      }
      return false;
    }
  }

  _onAudioFrame(inputChannel) {
    if (!this.isConversationActive || this.isPausedForReply || this.state === 'processing') {
      return;
    }

    const frame = new Float32Array(inputChannel);
    const frameMs = (frame.length / TARGET_RATE) * 1000;

    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i];
      sumSq += v * v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / Math.max(1, frame.length));

    // Ngưỡng phát hiện tiếng nói thích nghi theo độ ồn nền của phòng
    const threshold = Math.min(0.042, Math.max(0.014, this.noiseFloor * 2.5));
    const isVoiceFrame = rms >= threshold || peak >= threshold * 3.2;

    if (this.eventBus) {
      this.eventBus.emit('stt:mic_level', {
        rms: Number(rms.toFixed(4)),
        threshold: Number(threshold.toFixed(4)),
        inUtterance: this.inUtterance
      });
    }

    if (!this.inUtterance) {
      if (isVoiceFrame) {
        // Bắt đầu phát hiện người dùng cất tiếng nói -> ghép thêm preRollChunks để không mất âm đầu
        this.inUtterance = true;
        this.state = 'speaking';
        this.utteranceStartAt = performance.now();
        this.speechActiveMs = frameMs;
        this.silenceMs = 0;
        this.utteranceChunks = [...this.preRollChunks, frame];
        this.preRollChunks = [];
        if (this.eventBus) {
          this.eventBus.emit('stt:utterance_start', {});
        }
      } else {
        // Cập nhật nền nhiễu phòng khi đang im lặng
        this.noiseFloor = this.noiseFloor * 0.94 + rms * 0.06;
        this.preRollChunks.push(frame);
        if (this.preRollChunks.length > PRE_ROLL_FRAMES) {
          this.preRollChunks.shift();
        }
      }
    } else {
      // Đang thu câu nói của người dùng
      this.utteranceChunks.push(frame);
      if (isVoiceFrame) {
        this.speechActiveMs += frameMs;
        this.silenceMs = 0;
      } else {
        this.silenceMs += frameMs;
      }

      const totalUtteranceMs = performance.now() - this.utteranceStartAt;
      if (this.silenceMs >= SILENCE_HANGOVER_MS || totalUtteranceMs >= MAX_UTTERANCE_MS) {
        // Người dùng đã ngừng nói ~0.92s -> Tự động chốt câu và gửi sang Whisper!
        this._flushCurrentUtterance('auto-vad');
      }
    }
  }

  async _flushCurrentUtterance(triggerReason = 'auto-vad') {
    const tRelease = performance.now();
    const chunks = this.utteranceChunks;
    const activeMs = this.speechActiveMs;
    const holdMs = Math.round(tRelease - (this.utteranceStartAt || tRelease));

    this.utteranceChunks = [];
    this.preRollChunks = [];
    this.inUtterance = false;
    this.speechActiveMs = 0;
    this.silenceMs = 0;

    if (!chunks.length) {
      if (this.isConversationActive) this.state = 'listening';
      return null;
    }

    const pcm = concatFloat32(chunks);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      sumSq += pcm[i] * pcm[i];
      const a = Math.abs(pcm[i]);
      if (a > peak) peak = a;
    }

    this.lastCapture = {
      triggerReason,
      holdMs,
      speechActiveMs: Math.round(activeMs),
      durationSec: Number((pcm.length / TARGET_RATE).toFixed(2)),
      rms: Number(Math.sqrt(sumSq / Math.max(1, pcm.length)).toFixed(4)),
      peak: Number(peak.toFixed(3))
    };

    if (activeMs < MIN_SPEECH_MS || pcm.length < TARGET_RATE * 0.3) {
      if (this.isConversationActive) {
        this.state = 'listening';
        if (this.eventBus) this.eventBus.emit('stt:listening', { mode: 'continuous' });
      } else {
        this.state = 'idle';
      }
      return { text: '', empty: true, reason: 'quá ngắn', capture: this.lastCapture };
    }

    this.state = 'processing';
    if (this.eventBus) {
      this.eventBus.emit('stt:processing', { capture: this.lastCapture });
    }

    try {
      const res = await this.transcribePcm(pcm, { tRelease, source: 'mic' });
      res.capture = this.lastCapture;
      return res;
    } catch (err) {
      this.lastError = err.message;
      if (this.eventBus) this.eventBus.emit('stt:error', { error: err.message });
      return null;
    } finally {
      if (this.isConversationActive) {
        this.state = 'listening';
        if (!this.isPausedForReply && this.eventBus) {
          this.eventBus.emit('stt:listening', { mode: 'continuous' });
        }
      } else {
        this.state = 'idle';
      }
    }
  }

  /**
   * INTERFACE: Tắt chế độ trò chuyện giọng nói (1-Click Stop)
   * Nếu người dùng vừa nói 1 câu rồi bấm Tắt ngay (chưa kịp hết 0.9s im lặng),
   * hệ thống vẫn xử lý nốt câu nói đó rồi đóng Micro.
   */
  async stopListening() {
    const tRelease = performance.now();
    if (!this.isConversationActive && this.state === 'idle') return null;

    // Thu thập toàn bộ âm thanh đang nói dở (hoặc trong pre-roll) trước khi đóng mic
    const pendingChunks = this.inUtterance
      ? this.utteranceChunks
      : this.preRollChunks;
    const hadUtterance = this.inUtterance && this.speechActiveMs >= MIN_SPEECH_MS;
    const holdMs = Math.round(tRelease - (this.utteranceStartAt || tRelease));

    this.isConversationActive = false;
    this.isPausedForReply = false;
    this._teardownCapture();

    if (window.auraElectron && window.auraElectron.sttSetConversationActive) {
      window.auraElectron.sttSetConversationActive(false);
    }

    if (this.eventBus) {
      this.eventBus.emit('stt:conversation_state', { active: false });
    }

    if (hadUtterance && pendingChunks.length > 0) {
      const pcm = concatFloat32(pendingChunks);
      let sumSq = 0;
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) {
        sumSq += pcm[i] * pcm[i];
        const a = Math.abs(pcm[i]);
        if (a > peak) peak = a;
      }
      this.lastCapture = {
        triggerReason: 'manual-stop',
        holdMs,
        durationSec: Number((pcm.length / TARGET_RATE).toFixed(2)),
        rms: Number(Math.sqrt(sumSq / Math.max(1, pcm.length)).toFixed(4)),
        peak: Number(peak.toFixed(3))
      };

      this.state = 'processing';
      if (this.eventBus) this.eventBus.emit('stt:processing', { capture: this.lastCapture });
      try {
        const res = await this.transcribePcm(pcm, { tRelease, source: 'mic' });
        res.capture = this.lastCapture;
        return res;
      } catch (err) {
        this.lastError = err.message;
        if (this.eventBus) this.eventBus.emit('stt:error', { error: err.message });
        return null;
      } finally {
        this.state = 'idle';
      }
    }

    this.lastCapture = {
      triggerReason: 'manual-stop-silent',
      holdMs: Math.max(0, holdMs),
      durationSec: 0,
      rms: Number(this.noiseFloor.toFixed(4)),
      peak: 0
    };
    this.state = 'idle';
    if (this.eventBus) this.eventBus.emit('stt:stopped', {});
    return { text: '', empty: true, reason: 'stopped', capture: this.lastCapture };
  }

  /** Gửi PCM Float32 16kHz mono sang Python worker; đo độ trễ từ lúc chốt câu đến lúc có chữ */
  async transcribePcm(pcm, opts = {}) {
    const tRelease = opts.tRelease ?? performance.now();
    const tEnc = performance.now();
    const b64 = int16ToBase64(floatToInt16(pcm));
    const encodeMs = Math.round(performance.now() - tEnc);

    const res = await window.auraElectron.sttTranscribe({
      pcmBase64: b64,
      lang: opts.lang || 'auto',
      initialPrompt: 'Aura, YouTube, Chrome, Notepad, Thịnh, SWT301, thư mục, ổ D, mở, tìm'
    });
    if (!res || res.type === 'error') {
      throw new Error(res?.error || 'STT worker trả về lỗi');
    }
    const out = {
      ...res,
      encodeMs,
      releaseToTextMs: Math.round(performance.now() - tRelease),
      source: opts.source || 'mic',
      empty: !res.text
    };
    this.lastResult = out;
    if (this.eventBus) this.eventBus.emit('stt:result', out);
    return out;
  }

  /** INTERFACE: giải phóng model ngay (tiến trình chủ cũng tự giải phóng sau ~30s) */
  async unloadModel() {
    if (window.auraElectron && window.auraElectron.sttUnload) {
      await window.auraElectron.sttUnload();
    }
  }

  cancel() {
    this.isConversationActive = false;
    this.isPausedForReply = false;
    this._teardownCapture();
    this.state = 'idle';
    if (this.eventBus) {
      this.eventBus.emit('stt:conversation_state', { active: false });
      this.eventBus.emit('stt:stopped', {});
    }
  }

  getStatus() {
    return {
      state: this.state,
      isConversationActive: this.isConversationActive,
      isPausedForReply: this.isPausedForReply,
      modelState: this.modelState,
      model: this.model,
      computeType: this.computeType,
      lastResult: this.lastResult,
      lastError: this.lastError,
      lastCapture: this.lastCapture,
      lastLoad: this.lastLoad
    };
  }
}
