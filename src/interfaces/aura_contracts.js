/**
 * ============================================================================
 * AURA DESKTOP ASSISTANT - MODULE CONTRACTS & INTERFACES
 * Kiến trúc 5 Module tách biệt, giao tiếp qua Interface & EventBus chuẩn.
 * Cho phép thay thế từng module (VD: đổi VRM sang HeyGen/Tavus/Unreal,
 * đổi edge-tts sang ElevenLabs/Azure, đổi STT/LLM) mà không sửa module khác.
 * ============================================================================
 */

export const AURA_EMOTIONS = Object.freeze({
  NEUTRAL: 'neutral',
  HAPPY: 'happy',
  SERIOUS: 'serious',
  APOLOGETIC: 'apologetic',
  SURPRISED: 'surprised'
});

export const WINDOW_MODES = Object.freeze({
  DOCKED: 'docked',       // Ghim góc màn hình (trong suốt, gọn nhẹ)
  EXPANDED: 'expanded',   // Cửa sổ tiêu chuẩn có bảng điều khiển
  FULLSCREEN: 'fullscreen' // Phóng to toàn màn hình
});

/**
 * EventBus trung gian giúp 5 module giao tiếp lỏng (decoupled)
 */
export class AuraEventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  emit(event, payload) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(payload);
        } catch (err) {
          console.error(`[AuraEventBus] Error in listener for ${event}:`, err);
        }
      }
    }
  }
}

/**
 * MODULE A INTERFACE: Desktop Shell Bridge (WebView2 / Native OS Host)
 */
export class IShellBridge {
  async setWindowMode(mode) { throw new Error('Not implemented'); }
  async setAlwaysOnTop(enabled) { throw new Error('Not implemented'); }
  async startWindowDrag() { throw new Error('Not implemented'); }
  async logAction(category, message, metadata = {}) { throw new Error('Not implemented'); }
  async getHardwareTelemetry() { throw new Error('Not implemented'); }
}

/**
 * MODULE B INTERFACE: Avatar Provider (VRM Local / HeyGen / Tavus / Unreal MetaHuman)
 * Bắt buộc giữ nguyên chữ ký: speak(text, emotion), setEmotion(emotion), stop()
 */
export class IAvatarProvider {
  async init(containerElement, config = {}) { throw new Error('Not implemented'); }
  async loadModel(modelUrl) { throw new Error('Not implemented'); }
  async speak(text, emotion = AURA_EMOTIONS.NEUTRAL, audioElementOrNode = null) { throw new Error('Not implemented'); }
  setEmotion(emotion = AURA_EMOTIONS.NEUTRAL) { throw new Error('Not implemented'); }
  stop() { throw new Error('Not implemented'); }
  setLiteMode(enabled, reason = '') { throw new Error('Not implemented'); }
  setGazeTarget(normalizedX, normalizedY) { throw new Error('Not implemented'); }
  triggerNod(intensity = 1.0) { throw new Error('Not implemented'); }
  getStats() { throw new Error('Not implemented'); }
}

/**
 * MODULE C INTERFACE: Speech-to-Text Provider (faster-whisper small int8 CPU)
 */
export class ISTTProvider {
  async startListening(options = { mode: 'push-to-talk' }) { throw new Error('Not implemented'); }
  async stopListening() { throw new Error('Not implemented'); }
  async unloadModel() { throw new Error('Not implemented'); }
  getStatus() { throw new Error('Not implemented'); }
}

/**
 * MODULE D INTERFACE: Text-to-Speech Provider (edge-tts / Azure / ElevenLabs / FPT.AI)
 */
export class ITTSProvider {
  async synthesizeStream(text, language = 'auto', voiceOverride = null) { throw new Error('Not implemented'); }
  stop() { throw new Error('Not implemented'); }
}

/**
 * MODULE E INTERFACE: Brain & Tool Use Provider (Gemini / Claude API + OS/Web/QA Tools)
 */
export class LLMProvider {
  async chat(messages, tools = []) { throw new Error('Not implemented'); }
  async vision(image, prompt) { throw new Error('Not implemented'); }
}

export class IBrainProvider {
  async processUserMessage(text, language = 'auto', context = {}) { throw new Error('Not implemented'); }
  async confirmPendingAction(actionId, approved = false) { throw new Error('Not implemented'); }
  emergencyStopAllTools() { throw new Error('Not implemented'); }
  clearMemory() { throw new Error('Not implemented'); }
}

