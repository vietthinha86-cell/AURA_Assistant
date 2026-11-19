/**
 * ============================================================================
 * MODULE E: BỘ NÃO AI & GIAO DIỆN LLMProvider (GeminiProvider & ClaudeProvider)
 * - Cung cấp class LLMProvider với chat(messages, tools) và vision(image, prompt)
 * - Giao tiếp an toàn với Electron Main Process qua IPC (không lộ API Key ở Renderer)
 * - Quản lý luồng hội thoại ngắn hạn (10-20 lượt gần nhất) + Xoá ngữ cảnh
 * ============================================================================
 */
import { LLMProvider, IBrainProvider } from '../interfaces/aura_contracts.js';

export const APP_WHITELIST = Object.freeze([
  'notepad.exe',
  'calc.exe',
  'explorer.exe',
  'msedge.exe',
  'chrome.exe',
  'code.exe'
]);

/**
 * GeminiProvider phía Renderer (ủy quyền thực thi sang Main Process để bảo mật GEMINI_API_KEY)
 */
export class GeminiProvider extends LLMProvider {
  constructor() {
    super();
    this.providerName = 'gemini';
  }

  async chat(messages, tools = []) {
    if (!window.auraElectron || !window.auraElectron.llmChat) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.llmChat');
    }
    const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : { content: '' };
    return window.auraElectron.llmChat({
      text: lastMsg.content || '',
      tools,
      provider: 'gemini'
    });
  }

  async vision(image, prompt) {
    if (!window.auraElectron || !window.auraElectron.llmVision) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.llmVision');
    }
    return window.auraElectron.llmVision({
      image,
      prompt,
      provider: 'gemini'
    });
  }
}

/**
 * ClaudeProvider phía Renderer (ủy quyền thực thi sang Main Process để bảo mật ANTHROPIC_API_KEY)
 */
export class ClaudeProvider extends LLMProvider {
  constructor() {
    super();
    this.providerName = 'claude';
  }

  async chat(messages, tools = []) {
    if (!window.auraElectron || !window.auraElectron.llmChat) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.llmChat');
    }
    const lastMsg = Array.isArray(messages) && messages.length ? messages[messages.length - 1] : { content: '' };
    return window.auraElectron.llmChat({
      text: lastMsg.content || '',
      tools,
      provider: 'claude'
    });
  }

  async vision(image, prompt) {
    if (!window.auraElectron || !window.auraElectron.llmVision) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.llmVision');
    }
    return window.auraElectron.llmVision({
      image,
      prompt,
      provider: 'claude'
    });
  }
}

/**
 * Dịch vụ bộ não chính của AURA (Kết nối STT/Text -> LLM -> TTS + Lip-Sync + Emotion)
 */
export class AuraBrainService extends IBrainProvider {
  constructor(eventBus, config = {}) {
    super();
    this.eventBus = eventBus;
    this.gemini = new GeminiProvider();
    this.claude = new ClaudeProvider();
    this.status = null;
  }

  async init() {
    if (window.auraElectron && window.auraElectron.llmStatus) {
      this.status = await window.auraElectron.llmStatus();
      if (this.eventBus) {
        this.eventBus.emit('llm:status', this.status);
      }
    }
    return this.status;
  }

  async setRoutingMode(mode) {
    if (!window.auraElectron || !window.auraElectron.llmSetMode) {
      return null;
    }
    const res = await window.auraElectron.llmSetMode(mode);
    this.status = res;
    if (this.eventBus) {
      this.eventBus.emit('llm:status', res);
    }
    return res;
  }

  async processUserMessage(text, language = 'auto', context = {}) {
    if (!window.auraElectron || !window.auraElectron.llmChat) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.llmChat');
    }
    if (this.eventBus) {
      this.eventBus.emit('llm:thinking', { text, language });
    }
    const res = await window.auraElectron.llmChat({
      text,
      lang: language,
      provider: context.provider || null,
      tools: context.tools || [],
      testOverrideKey: context.testOverrideKey || null,
      skipHistory: Boolean(context.skipHistory)
    });
    if (this.eventBus) {
      this.eventBus.emit('llm:response', res);
    }
    return res;
  }

  async analyzeVision(image, prompt, options = {}) {
    if (!window.auraElectron || !window.auraElectron.llmVision) {
      throw new Error('Không tìm thấy cầu nối IPC window.auraElectron.llmVision');
    }
    if (this.eventBus) {
      this.eventBus.emit('llm:thinking', { text: prompt, language: options.lang || 'auto', vision: true });
    }
    const res = await window.auraElectron.llmVision({
      image,
      prompt,
      lang: options.lang || 'auto',
      provider: options.provider || null,
      recordHistory: options.recordHistory !== false
    });
    if (this.eventBus) {
      this.eventBus.emit('llm:response', res);
    }
    return res;
  }

  async getHistory() {
    if (!window.auraElectron || !window.auraElectron.llmGetHistory) {
      return { history: [], turns: 0, maxTurns: 15 };
    }
    return window.auraElectron.llmGetHistory();
  }

  async clearMemory() {
    if (!window.auraElectron || !window.auraElectron.llmClearContext) {
      return null;
    }
    const res = await window.auraElectron.llmClearContext();
    if (this.eventBus) {
      this.eventBus.emit('llm:cleared', res);
    }
    return res;
  }
}
