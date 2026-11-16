const fs = require('fs');
const path = require('path');
const { AuraToolExecutor } = require('./src/module_e_brain/tool_executor');
const { AuraLLMRouter } = require('./src/module_e_brain/llm_providers');

const projectRoot = 'D:\\AURA_Assistant';
const logFile = path.join(projectRoot, 'logs', 'aura_actions.log');

function writeLog(tag, message) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 23);
  const line = `[${ts}] [${tag}] ${message}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (_) {}
}

async function runTests() {
  writeLog('TEST_START', '=== BẮT ĐẦU KIỂM THỬ TOOL OPEN_FOLDER & OPEN_FILE (BƯỚC 6 CẢI TIẾN) ===');

  const executor = new AuraToolExecutor(projectRoot, writeLog);
  const router = new AuraLLMRouter(projectRoot, writeLog);
  router.toolExecutor = executor;

  // -------------------------------------------------------------
  // Test 1: Kiểm thử trực tiếp tool open_folder với đường dẫn thật
  // -------------------------------------------------------------
  const path1 = 'D:\\ảnh\\SWT301\\test topic';
  writeLog('UNIT_TEST_1', `Gọi trực tiếp open_folder("${path1}")...`);
  const res1 = await executor.executeOpenFolder(path1);
  writeLog('UNIT_RESULT_1', `Success=${res1.success} | ErrorCode=${res1.errorCode} | Path="${res1.path}" | Message="${res1.message || res1.error}"`);

  // -------------------------------------------------------------
  // Test 2: Kiểm thử an toàn - Thư mục nằm ngoài allowed_folders.json
  // -------------------------------------------------------------
  const pathOutside = 'C:\\Program Files\\Common Files';
  writeLog('UNIT_TEST_2', `Gọi trực tiếp open_folder("${pathOutside}") (ngoài allowed_folders)...`);
  const res2 = await executor.executeOpenFolder(pathOutside);
  writeLog('UNIT_RESULT_2', `Success=${res2.success} | RequiresConfirmation=${res2.requiresConfirmation} | ErrorCode=${res2.errorCode} | Error="${res2.error}"`);

  // -------------------------------------------------------------
  // Test 3: Kiểm thử tool open_file với file trong thư mục cho phép
  // -------------------------------------------------------------
  const file1 = 'D:\\AURA_Assistant\\README.md';
  writeLog('UNIT_TEST_3', `Gọi trực tiếp open_file("${file1}")...`);
  const res3 = await executor.executeOpenFile(file1);
  writeLog('UNIT_RESULT_3', `Success=${res3.success} | ErrorCode=${res3.errorCode} | Path="${res3.path}" | Message="${res3.message || res3.error}"`);

  // -------------------------------------------------------------
  // Test 4 (Kịch bản 1 theo yêu cầu người dùng):
  // "Mở thư mục D:\ảnh\SWT301\test topic" (Đầy đủ đường dẫn)
  // -------------------------------------------------------------
  const promptA = 'Mở thư mục D:\\ảnh\\SWT301\\test topic';
  writeLog('INTEGRATION_TEST_A', `--- Kịch bản 1: "${promptA}" ---`);
  const t0A = Date.now();
  const chatResA = await router.chatWithMemory(promptA);
  const durA = Date.now() - t0A;
  writeLog('INTEGRATION_RESULT_A', `Latency=${durA}ms | ToolCalls=${chatResA.toolExecutions?.map(t => t.tool).join('->')} | Reply="${chatResA.text}"`);

  // -------------------------------------------------------------
  // Test 5 (Kịch bản 2 theo yêu cầu người dùng):
  // "Mở thư mục test topic trong thư mục ảnh ổ D" (Chưa đủ đường dẫn cụ thể, cần file_search -> open_folder)
  // -------------------------------------------------------------
  const promptB = 'Mở thư mục test topic trong thư mục ảnh ổ D';
  writeLog('INTEGRATION_TEST_B', `--- Kịch bản 2: "${promptB}" ---`);
  const t0B = Date.now();
  const chatResB = await router.chatWithMemory(promptB);
  const durB = Date.now() - t0B;
  writeLog('INTEGRATION_RESULT_B', `Latency=${durB}ms | ToolCalls=${chatResB.toolExecutions?.map(t => t.tool).join('->')} | Reply="${chatResB.text}"`);

  // -------------------------------------------------------------
  // Test 6 (Kịch bản 3 theo yêu cầu người dùng):
  // "Mở thư mục labs" (Tên thư mục có nhiều kết quả trùng nhau)
  // -------------------------------------------------------------
  const promptC = 'Mở thư mục labs';
  writeLog('INTEGRATION_TEST_C', `--- Kịch bản 3: "${promptC}" ---`);
  const t0C = Date.now();
  const chatResC = await router.chatWithMemory(promptC);
  const durC = Date.now() - t0C;
  writeLog('INTEGRATION_RESULT_C', `Latency=${durC}ms | ToolCalls=${chatResC.toolExecutions?.map(t => t.tool).join('->')} | Reply="${chatResC.text}"`);

  writeLog('TEST_DONE', '=== HOÀN TẤT KIỂM THỬ TẤT CẢ KỊCH BẢN ===');
}

runTests().catch((err) => {
  console.error('Lỗi kiểm thử:', err);
});
