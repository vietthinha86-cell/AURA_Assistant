/**
 * ============================================================================
 * MODULE D: TTS SERVICE (edge-tts mặc định: vi-VN-HoaiMyNeural & en-US-AriaNeural)
 * Thực thi giao diện ITTSProvider:
 * - Tự động nhận diện ngôn ngữ Tiếng Việt (vi) / Tiếng Anh (en)
 * - Tự động phát theo từng câu (Pipelining / Streaming Playback Queue):
 *   + Tách văn bản thành các câu độc lập
 *   + Tạo và phát câu đầu tiên NGAY LẬP TỨC (Timeout 6s cho câu đầu, thử lại 1 lần nếu lỗi)
 *   + Các câu sau được tạo SONG SONG ở background và xếp vào hàng đợi phát liên tục
 *   + Không để khoảng lặng giữa các câu
 * - Tận dụng bộ nhớ RAM Cache của Worker cho các câu ngắn hay dùng (~1ms)
 * - Đồng bộ Lip-Sync qua AnalyserNode của Module B (VRMAvatarEngine)
 * ============================================================================
 */
import { ITTSProvider, AURA_EMOTIONS } from '../interfaces/aura_contracts.js';

export class EdgeTTSService extends ITTSProvider {
  constructor(eventBus, avatarEngine, config = {}) {
    super();
    this.eventBus = eventBus;
    this.avatar = avatarEngine;
    this.provider = config.provider || 'edge-tts';
    this.voiceVi = config.voiceVi || 'vi-VN-HoaiMyNeural';
    this.voiceEn = config.voiceEn || 'en-US-AriaNeural';
    this.rate = config.rate || '+8%';
    this.pitch = config.pitch || '+5Hz';
    this.currentAudio = null;
    this.reqCounter = 0;
    this.playbackSessionId = 0;
  }

  /**
   * Tự động nhận diện ngôn ngữ Tiếng Việt ('vi') hoặc Tiếng Anh ('en')
   */
  detectLanguage(text) {
    const viDiacriticRegex = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
    if (viDiacriticRegex.test(text)) return 'vi';

    const viWords = new Set([
      'xin', 'chao', 'toi', 'ban', 'anh', 'chi', 'em', 'sep', 'hom', 'nay',
      'ngay', 'thang', 'nam', 'cam', 'on', 'vui', 'buon', 'khong', 'duoc',
      'giup', 'may', 'tinh', 'tieng', 'viet', 'noi', 'nghe', 'la', 'cua',
      'cho', 'oi', 'nha', 'nhe', 'rat', 'tot', 'dep'
    ]);
    const words = (text.toLowerCase().match(/[a-z]+/g) || []);
    const hits = words.filter(w => viWords.has(w)).length;
    if (hits >= 2 || (words.length <= 3 && hits >= 1)) return 'vi';
    return 'en';
  }

  /**
   * Tự động nhận diện biểu cảm phù hợp với nội dung câu nói
   */
  detectEmotion(text) {
    const lower = text.toLowerCase();
    if (/xin lỗi|xin loi|sorry|apologize|tiếc|unfortunately/.test(lower)) {
      return AURA_EMOTIONS.APOLOGETIC;
    }
    if (/cảnh báo|nghiêm túc|nguy hiểm|lỗi|warning|critical|error|serious/.test(lower)) {
      return AURA_EMOTIONS.SERIOUS;
    }
    if (/vui|tuyệt|cảm ơn|cam on|chào|chao|happy|great|wonderful|hello|welcome|awesome/.test(lower)) {
      return AURA_EMOTIONS.HAPPY;
    }
    return AURA_EMOTIONS.NEUTRAL;
  }

  /**
   * Tách câu trả lời thành mảng các câu hoàn chỉnh
   * Xử lý ngoại lệ chữ viết tắt, số thập phân và ngắt câu quá dài
   */
  splitIntoSentences(text) {
    const clean = (text || '').trim();
    if (!clean) return [];

    // Bảo vệ số thập phân (3.5) và các chữ viết tắt phổ biến
    const protectedText = clean
      .replace(/(\b[A-Za-z0-9]+)\.([A-Za-z0-9]+)\b/g, '$1__DOT__$2')
      .replace(/\b(v\.v|e\.g|i\.e|dr|mr|mrs|ms|tp|approx)\./gi, '$1__DOT__');

    // Tách theo dấu kết thúc câu (. ! ? … \n)
    const rawParts = protectedText.split(/(?<=[.!?…\n])\s+/);
    const sentences = [];

    for (const p of rawParts) {
      const restored = p.replace(/__DOT__/g, '.').trim();
      if (!restored) continue;

      // Nếu câu quá dài (> 120 ký tự) và có dấu phẩy/chấm phẩy, tách nhỏ để câu đầu ra cực nhanh
      if (restored.length > 120 && /[,;]/.test(restored)) {
        const sub = restored.split(/(?<=[,;])\s+/);
        for (const s of sub) {
          const cleanS = s.trim();
          if (cleanS) sentences.push(cleanS);
        }
      } else {
        sentences.push(restored);
      }
    }

    return sentences.length > 0 ? sentences : [clean];
  }

  /**
   * Tổng hợp âm thanh cho 1 câu đơn lẻ với cơ chế thử lại (Retry) và Timeout
   */
  async _synthesizeSingleSentence(sentenceText, options = {}) {
    const reqId = options.id || `tts_sent_${Date.now()}_${++this.reqCounter}`;
    const timeoutMs = options.timeoutMs || (options.isFirstSentence ? 6000 : 12000);
    const maxRetries = options.isFirstSentence ? 1 : 2; // Câu đầu thử lại tối đa 1 lần (tổng 2 lượt)

    let lastErr = null;
    let res = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const tStart = performance.now();
        res = await window.auraElectron.synthesizeSpeech({
          id: `${reqId}_att${attempt}`,
          text: sentenceText,
          lang: options.lang || 'auto',
          voiceVi: options.voiceVi || this.voiceVi,
          voiceEn: options.voiceEn || this.voiceEn,
          rate: options.rate || this.rate,
          pitch: options.pitch || this.pitch,
          emotion: options.emotion || 'neutral',
          timeoutMs,
          isFirstSentence: Boolean(options.isFirstSentence),
          noCache: attempt > 0
        });

        if (res && res.type === 'result' && res.audioBase64) {
          res.totalLatencyMs = Math.round(performance.now() - tStart);
          return res;
        }
        lastErr = new Error(res?.error || 'No audio received');
      } catch (err) {
        lastErr = err;
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    throw lastErr || new Error(`Lỗi tổng hợp giọng nói cho câu: "${sentenceText.substring(0, 30)}..."`);
  }

  /**
   * Phát 1 đoạn âm thanh đã tổng hợp trên Avatar và đợi kết thúc
   */
  _playSentenceAudio(sentenceText, res, emotion, sessionId) {
    return new Promise((resolve, reject) => {
      if (this.playbackSessionId !== sessionId) {
        return resolve({ aborted: true });
      }

      const audioSrc = `data:audio/mp3;base64,${res.audioBase64}`;
      const audioEl = new Audio(audioSrc);
      audioEl.crossOrigin = 'anonymous';
      this.currentAudio = audioEl;

      audioEl.addEventListener(
        'canplay',
        async () => {
          if (this.playbackSessionId !== sessionId) {
            return resolve({ aborted: true });
          }
          try {
            await this.avatar.speak(
              sentenceText,
              res.emotion || emotion,
              audioEl,
              res.wordBoundaries || []
            );
            await audioEl.play();
          } catch (playErr) {
            this.avatar.stop();
            reject(playErr);
          }
        },
        { once: true }
      );

      audioEl.addEventListener(
        'ended',
        () => {
          if (this.currentAudio === audioEl) {
            this.currentAudio = null;
          }
          resolve({ durationSec: Number((audioEl.duration || 0).toFixed(2)) });
        },
        { once: true }
      );

      audioEl.addEventListener(
        'error',
        () => {
          this.avatar.stop();
          reject(new Error('Lỗi giải mã âm thanh MP3 trên trình phát.'));
        },
        { once: true }
      );
    });
  }

  /**
   * INTERFACE BẮT BUỘC: synthesizeStream(text, language, voiceOverride, emotionOverride)
   * Tách câu trả lời, tạo và phát câu đầu ngay, các câu sau tạo song song (hàng đợi phát liên tục)
   */
  async synthesizeStream(text, language = 'auto', voiceOverride = null, emotionOverride = null) {
    const cleanText = (text || '').trim();
    if (!cleanText) return null;

    // Dừng phiên phát âm thanh trước đó
    this.stop();

    const currentSession = ++this.playbackSessionId;
    const detectedLang = language === 'auto' ? this.detectLanguage(cleanText) : language;
    const selectedVoice = voiceOverride || (detectedLang === 'vi' ? this.voiceVi : this.voiceEn);
    const normalizedOverride =
      emotionOverride === 'sorry' ? AURA_EMOTIONS.APOLOGETIC : emotionOverride;
    const detectedEmotion = normalizedOverride || this.detectEmotion(cleanText);

    // 1. Tách văn bản thành mảng câu
    const sentences = this.splitIntoSentences(cleanText);
    const reqBaseId = `tts_${Date.now()}_${++this.reqCounter}`;
    const tStartOverall = performance.now();

    if (this.eventBus) {
      this.eventBus.emit('tts:synthesizing', {
        id: reqBaseId,
        text: cleanText,
        sentencesCount: sentences.length,
        lang: detectedLang,
        voice: selectedVoice,
        emotion: detectedEmotion
      });
    }

    if (!window.auraElectron || !window.auraElectron.synthesizeSpeech) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.synthesizeSpeech');
    }

    // Trường hợp 1: Chỉ có 1 câu duy nhất
    if (sentences.length === 1) {
      let res0 = null;
      try {
        res0 = await this._synthesizeSingleSentence(sentences[0], {
          id: `${reqBaseId}_s0`,
          lang: detectedLang,
          voiceVi: this.voiceVi,
          voiceEn: this.voiceEn,
          rate: this.rate,
          pitch: this.pitch,
          emotion: detectedEmotion,
          timeoutMs: 6000,
          isFirstSentence: true
        });
      } catch (errFirst) {
        if (this.eventBus) {
          this.eventBus.emit('tts:error_fallback', { text: cleanText, error: errFirst.message });
        }
        throw errFirst;
      }

      if (this.playbackSessionId !== currentSession) return null;

      const firstChunkMs = res0.firstChunkMs;
      const totalLatencyMs = Math.round(performance.now() - tStartOverall);

      if (this.eventBus) {
        this.eventBus.emit('tts:playing', {
          id: reqBaseId,
          text: cleanText,
          lang: res0.lang,
          voice: res0.voice,
          emotion: res0.emotion || detectedEmotion,
          firstChunkMs,
          totalLatencyMs,
          byteLength: res0.byteLength,
          cached: Boolean(res0.cached)
        });
      }

      const playRes = await this._playSentenceAudio(sentences[0], res0, detectedEmotion, currentSession);
      this.avatar.stop();

      if (this.eventBus) {
        this.eventBus.emit('tts:ended', {
          id: reqBaseId,
          lang: res0.lang,
          voice: res0.voice,
          durationSec: playRes.durationSec || 0,
          totalLatencyMs
        });
      }

      return {
        id: reqBaseId,
        lang: res0.lang,
        voice: res0.voice,
        emotion: res0.emotion || detectedEmotion,
        firstChunkMs,
        totalLatencyMs,
        durationSec: playRes.durationSec || 0
      };
    }

    // Trường hợp 2: Có từ 2 câu trở lên -> Pipelining & Streaming Queue
    // BẮT ĐẦU TỔNG HỢP SONG SONG TẤT CẢ CÁC CÂU NGAY TỪ ĐẦU
    const synthPromises = sentences.map((sentence, idx) =>
      this._synthesizeSingleSentence(sentence, {
        id: `${reqBaseId}_s${idx}`,
        lang: detectedLang,
        voiceVi: this.voiceVi,
        voiceEn: this.voiceEn,
        rate: this.rate,
        pitch: this.pitch,
        emotion: detectedEmotion,
        timeoutMs: idx === 0 ? 6000 : 12000,
        isFirstSentence: idx === 0
      })
    );

    // Chờ câu 1 hoàn tất -> Phát ngay lập tức!
    let resFirst = null;
    try {
      resFirst = await synthPromises[0];
    } catch (errFirst) {
      if (this.eventBus) {
        this.eventBus.emit('tts:error_fallback', { text: cleanText, error: errFirst.message });
      }
      throw errFirst;
    }

    if (this.playbackSessionId !== currentSession) return null;

    const firstAudioStartMs = Math.round(performance.now() - tStartOverall);

    if (this.eventBus) {
      this.eventBus.emit('tts:playing', {
        id: reqBaseId,
        text: cleanText,
        currentSentence: sentences[0],
        sentenceIndex: 0,
        sentencesTotal: sentences.length,
        lang: resFirst.lang,
        voice: resFirst.voice,
        emotion: resFirst.emotion || detectedEmotion,
        firstChunkMs: resFirst.firstChunkMs,
        totalLatencyMs: firstAudioStartMs,
        isPipelined: true,
        cached: Boolean(resFirst.cached)
      });
    }

    // Bắt đầu phát câu 1
    let totalDuration = 0;
    const playFirst = await this._playSentenceAudio(sentences[0], resFirst, detectedEmotion, currentSession);
    totalDuration += (playFirst.durationSec || 0);

    // Phát tuần tự các câu tiếp theo từ hàng đợi (trong lúc câu trước phát, câu sau đã sẵn sàng)
    for (let i = 1; i < sentences.length; i++) {
      if (this.playbackSessionId !== currentSession) break;

      let nextRes = null;
      try {
        nextRes = await synthPromises[i];
      } catch (errNext) {
        console.warn(`[TTS_QUEUE] Lỗi tổng hợp câu ${i + 1}/${sentences.length}:`, errNext.message);
        continue; // Bỏ qua câu lỗi, phát tiếp các câu khác nếu có
      }

      if (this.playbackSessionId !== currentSession) break;

      const playNext = await this._playSentenceAudio(sentences[i], nextRes, detectedEmotion, currentSession);
      totalDuration += (playNext.durationSec || 0);
    }

    this.avatar.stop();

    if (this.eventBus && this.playbackSessionId === currentSession) {
      this.eventBus.emit('tts:ended', {
        id: reqBaseId,
        lang: resFirst.lang,
        voice: resFirst.voice,
        durationSec: Number(totalDuration.toFixed(2)),
        totalLatencyMs: firstAudioStartMs
      });
    }

    return {
      id: reqBaseId,
      lang: resFirst.lang,
      voice: resFirst.voice,
      emotion: resFirst.emotion || detectedEmotion,
      firstChunkMs: resFirst.firstChunkMs,
      totalLatencyMs: firstAudioStartMs,
      durationSec: Number(totalDuration.toFixed(2))
    };
  }

  /**
   * INTERFACE BẮT BUỘC: stop()
   */
  stop() {
    this.playbackSessionId++;
    if (this.currentAudio) {
      try {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
      } catch (_) {}
      this.currentAudio = null;
    }
    if (this.avatar) {
      this.avatar.stop();
    }
  }
}
