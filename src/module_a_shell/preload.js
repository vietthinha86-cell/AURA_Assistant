const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('auraElectron', {
  setIgnoreMouseEvents: (ignore) => ipcRenderer.send('window:set-ignore-mouse', ignore),
  setWindowMode: (mode) => ipcRenderer.send('window:mode', mode),
  moveWindowBy: (dx, dy) => ipcRenderer.send('window:move-by', { dx, dy }),
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  toggleDevTools: () => ipcRenderer.send('window:toggle-devtools'),
  reportFps: (fps, isLiteMode) => ipcRenderer.send('telemetry:fps', { fps, isLiteMode }),
  logAction: (category, message) => ipcRenderer.send('log:action', { category, message }),
  synthesizeSpeech: (payload) => ipcRenderer.invoke('tts:synthesize', payload),
  sttLoad: () => ipcRenderer.invoke('stt:load'),
  sttTranscribe: (payload) => ipcRenderer.invoke('stt:transcribe', payload),
  sttUnload: () => ipcRenderer.invoke('stt:unload'),
  sttSetConversationActive: (active) => ipcRenderer.invoke('stt:set_conversation_active', active),
  llmStatus: () => ipcRenderer.invoke('llm:status'),
  llmChat: (payload) => ipcRenderer.invoke('llm:chat', payload),
  llmVision: (payload) => ipcRenderer.invoke('llm:vision', payload),
  llmClearContext: () => ipcRenderer.invoke('llm:clear-context'),
  onSttStatus: (callback) => ipcRenderer.on('stt:status', (_event, data) => callback(data)),
  onTelemetry: (callback) => ipcRenderer.on('host:telemetry', (_event, data) => callback(data)),
  onEmergencyStop: (callback) => ipcRenderer.on('host:emergency_stop', () => callback()),

  // BƯỚC 5: IPC CÔNG CỤ & CƠ CHẾ XÁC NHẬN AN TOÀN
  toolConfirmResponse: (id, confirmed) => ipcRenderer.send('tool:confirm_response', { id, confirmed }),
  onToolConfirmRequest: (callback) => ipcRenderer.on('tool:confirm_request', (_event, data) => callback(data)),
  onToolConfirmCancel: (callback) => ipcRenderer.on('tool:confirm_cancel', (_event, data) => callback(data)),
  getToolLogs: (limit) => ipcRenderer.invoke('tool:get_logs', limit),
  onReminderTrigger: (callback) => ipcRenderer.on('host:reminder_triggered', (_event, data) => callback(data)),

  // BƯỚC 6: IPC COMPUTER-USE (NHÌN MÀN HÌNH & ĐIỀU KHIỂN CHUỘT / PHÍM)
  computerUseRunTask: (prompt, options) => ipcRenderer.invoke('computer_use:run_task', { prompt, options }),
  computerUseSetAutoPilot: (enabled) => ipcRenderer.invoke('computer_use:set_autopilot', enabled),
  computerUseGetAutoPilot: () => ipcRenderer.invoke('computer_use:get_autopilot'),
  computerUseAbort: (reason) => ipcRenderer.invoke('computer_use:abort', reason),
  computerUseTakeScreenshot: () => ipcRenderer.invoke('computer_use:take_screenshot'),
  computerUseGetAuditLogs: () => ipcRenderer.invoke('computer_use:get_audit_logs'),
  onComputerUseState: (callback) => ipcRenderer.on('computer_use:state', (_event, data) => callback(data)),
  onScreenshotToast: (callback) => ipcRenderer.on('computer_use:screenshot_toast', () => callback()),
  onSpokenNotice: (callback) => ipcRenderer.on('computer_use:spoken_notice', (_event, data) => callback(data)),
  openReport: (reportPath) => ipcRenderer.invoke('report:open', reportPath)
});
