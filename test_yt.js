/**
 * Test kịch bản: "Mở YouTube tìm trao cho anh rồi bấm vào video đầu tiên"
 * Chạy trọn vẹn luồng Computer-Use: Mở tìm kiếm -> Nhìn màn hình -> Bỏ qua Ads/Shorts -> Bấm video đầu tiên -> Kiểm tra phát
 */
const path = require('path');
const fs = require('fs');
const { AuraLLMRouter } = require('./src/module_e_brain/llm_providers');
const { AuraComputerUseService } = require('./src/module_e_brain/computer_use_service');

const projectRoot = path.resolve('D:/AURA_Assistant');
const logFile = path.join(projectRoot, 'logs', 'aura_actions.log');

function writeLog(cat, msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 23);
  const line = `[${ts}] [${cat}] ${msg}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (_) {}
}

async function runTest() {
  writeLog('TEST_YT_START', '=== BẮT ĐẦU TEST: "Mở YouTube tìm trao cho anh rồi bấm vào video đầu tiên" ===');
  const t0 = Date.now();

  const router = new AuraLLMRouter(projectRoot, writeLog);
  const cuService = new AuraComputerUseService({
    projectRoot,
    pythonPath: path.join(projectRoot, 'runtime', 'python', 'python.exe'),
    writeLog,
    llmRouter: router,
    onStateChange: (st) => writeLog('CU_STATE', JSON.stringify(st)),
    onScreenshotToast: () => writeLog('CU_TOAST', 'Screenshot taken in RAM'),
    onSpokenNotice: (text, emo) => writeLog('CU_SPOKEN', `Aura nói: "${text}" (emotion=${emo})`)
  });

  router.toolExecutor.setComputerUseService(cuService);
  cuService.setAutoPilot(true);

  // Đợi worker Python sẵn sàng
  await new Promise((r) => setTimeout(r, 1500));

  const userPrompt = 'Mở YouTube tìm trao cho anh rồi bấm vào video đầu tiên';
  writeLog('TEST_USER_INPUT', `User: "${userPrompt}"`);

  // Chạy luồng hội thoại chatWithMemory (tự động phân tích tool, mở search, và nối sang computer-use loop)
  const result = await router.chatWithMemory(userPrompt, { lang: 'vi' });

  const totalDuration = Date.now() - t0;
  writeLog('TEST_YT_FINISH', `Kết thúc nhiệm vụ sau ${totalDuration}ms. OK=${result.ok} | Emotion=${result.emotion}`);
  writeLog('TEST_YT_REPLY', `Aura trả lời: "${result.text}"`);

  // Trích xuất log chi tiết các bước Computer-Use
  const auditLogs = cuService.taskAuditLogs;
  writeLog('TEST_YT_STEPS_COUNT', `Tổng số bước Computer-Use: ${auditLogs.length}`);
  auditLogs.forEach((entry, idx) => {
    writeLog(
      'TEST_YT_STEP_DETAIL',
      `Bước ${entry.step}: Action=${entry.action} | Target="${entry.description}" | Coords=${JSON.stringify(entry.coords)} | ScreenDiff=${entry.diffPercent}% | Success=${entry.success}`
    );
  });

  if (cuService.workerProc) {
    try { cuService.workerProc.kill(); } catch (_) {}
  }

  process.exit(0);
}

runTest().catch((err) => {
  writeLog('TEST_YT_ERROR', err.stack || err.message);
  process.exit(1);
});

