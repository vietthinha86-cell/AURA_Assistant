/**
 * ============================================================================
 * TEST SỬA LỖI LIST_DIRECTORY & FILE_SEARCH
 * Kiểm tra toàn diện 5 yêu cầu:
 * 1. Tái hiện và in chi tiết (a), (b), (c)
 * 2. Xác nhận khắc phục các nguyên nhân gốc
 * 3. Kiểm tra mã lỗi rõ ràng, không nuốt lỗi
 * 4. Kiểm tra file_search đa cấp, không dấu, type
 * 5. Chạy thật 3 lệnh hội thoại qua Gemini LLM:
 *    - "Liệt kê D:\AURA_Assistant"
 *    - "Liệt kê D:\ảnh\SWT301"
 *    - "Tìm thư mục SWT301 trong ổ D"
 * ============================================================================
 */
const path = require('path');
const fs = require('fs');
const { AuraLLMRouter } = require('./src/module_e_brain/llm_providers');
const { AuraToolExecutor } = require('./src/module_e_brain/tool_executor');

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

async function main() {
  writeLog('TEST_START', '=== BẮT ĐẦU KIỂM THỬ SỬA LỖI LIST_DIRECTORY & FILE_SEARCH ===');
  const executor = new AuraToolExecutor(projectRoot, writeLog);

  // --------------------------------------------------------------------------
  // MỤC 1 & 2: TÁI HIỆN VÀ PHÂN TÍCH NGUYÊN NHÂN GỐC
  // --------------------------------------------------------------------------
  writeLog('REPRO_ANALYSIS', '--- 1. TÁI HIỆN CHI TIẾT ĐƯỜNG DẪN VÀ DANH SÁCH CHO PHÉP ---');
  const testPaths = ['D:\\AURA_Assistant', 'D:\\ảnh\\SWT301'];

  for (const tp of testPaths) {
    const codePoints = Array.from(tp).map(
      (c) => `${c} (U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')})`
    );
    writeLog('REPRO_PATH_A', `(a) Đường dẫn: "${tp}" | Code points: ${codePoints.join(', ')}`);

    const exists = fs.existsSync(tp);
    let rawItemsCount = 0;
    let rawItems = [];
    let readErr = null;
    try {
      rawItems = fs.readdirSync(tp);
      rawItemsCount = rawItems.length;
    } catch (e) {
      readErr = `${e.code}: ${e.message}`;
    }
    writeLog(
      'REPRO_FS_B',
      `(b) fs.existsSync=${exists} | fs.readdirSync count=${rawItemsCount} (Trước khi lọc) | Sample=[${rawItems.slice(0, 5).join(', ')}] | Error=${readErr || 'NONE'}`
    );

    const allowed = executor.getAllowedFolders();
    writeLog(
      'REPRO_ALLOWED_C',
      `(c) allowed_folders=${JSON.stringify(allowed)} | LoadedAt=${executor._allowedFoldersLoadedAt || 'just_now'} | IsInside=${executor._isPathInsideAllowed(tp)}`
    );
  }

  // --------------------------------------------------------------------------
  // MỤC 3: KIỂM THỬ KHÔNG NUỐT LỖI
  // --------------------------------------------------------------------------
  writeLog('TEST_ERROR_HANDLING', '--- 3. KIỂM THỬ MÃ LỖI (KHÔNG NUỐT LỖI) ---');
  const notFoundRes = await executor.executeListDirectory('D:\\thu_muc_khong_ton_tai_999');
  writeLog('TEST_ERR_NOT_FOUND', `Not Found Test: Success=${notFoundRes.success} | Code=${notFoundRes.errorCode} | Msg="${notFoundRes.message}"`);

  const outsideRes = await executor.executeListDirectory('C:\\Windows\\System32');
  writeLog('TEST_ERR_OUTSIDE', `Outside Allowed Test: Success=${outsideRes.success} | Code=${outsideRes.errorCode} | Msg="${outsideRes.message}"`);

  // --------------------------------------------------------------------------
  // MỤC 4: KIỂM THỬ FILE_SEARCH ĐA CẤP, KHÔNG DẤU, TYPE
  // --------------------------------------------------------------------------
  writeLog('TEST_FILE_SEARCH', '--- 4. KIỂM THỬ FILE_SEARCH (ĐA CẤP, KHÔNG DẤU, TYPE) ---');
  const searchSwtRes = await executor.executeFileSearch('SWT301', 'D:\\', 'folder');
  writeLog(
    'TEST_SEARCH_SWT',
    `Search SWT301 in D:\\ (type=folder): Count=${searchSwtRes.count} | Matches=[${searchSwtRes.files.map((f) => f.path).join(' ; ')}]`
  );

  const searchUnaccentedRes = await executor.executeFileSearch('anh', 'D:\\', 'folder');
  writeLog(
    'TEST_SEARCH_UNACCENT',
    `Search "anh" (không dấu) in D:\\: Count=${searchUnaccentedRes.count} | Sample=[${searchUnaccentedRes.files.slice(0, 3).map((f) => f.path).join(' ; ')}]`
  );

  // --------------------------------------------------------------------------
  // MỤC 5: CHẠY THẬT 3 LỆNH HỘI THOẠI QUA LLM (AURA)
  // --------------------------------------------------------------------------
  writeLog('TEST_LLM_SUITE', '--- 5. CHẠY THẬT 3 LỆNH HỘI THOẠI QUA LLM VỚI LOG ĐẦY ĐỦ ---');
  const router = new AuraLLMRouter(projectRoot, writeLog);

  const commands = [
    { id: 1, prompt: 'Liệt kê D:\\AURA_Assistant', checkKey: 'package.json' },
    { id: 2, prompt: 'Liệt kê D:\\ảnh\\SWT301', checkKey: 'labs' },
    { id: 3, prompt: 'Tìm thư mục SWT301 trong ổ D', checkKey: 'D:\\ảnh\\SWT301' }
  ];

  const reportResults = [];

  for (const cmd of commands) {
    writeLog('LLM_PROMPT_START', `>>> BẮT ĐẦU LỆNH [${cmd.id}/3]: "${cmd.prompt}" <<<`);
    const t0 = Date.now();
    const result = await router.chatWithMemory(cmd.prompt, { lang: 'vi' });
    const latency = Date.now() - t0;

    const executions = result.toolExecutions || (result.lastTool ? [result.lastTool] : []);
    const primaryTool = executions[0] || null;

    let itemsPreview = '';
    let successCriteria = false;

    if (cmd.id === 1) {
      const items = primaryTool?.result?.items || [];
      const hasReadme = items.some((i) => i.name.toLowerCase().includes('readme'));
      const hasPackage = items.some((i) => i.name.toLowerCase().includes('package.json'));
      itemsPreview = items.slice(0, 6).map((i) => i.name).join(', ') + '...';
      successCriteria = primaryTool?.tool === 'list_directory' && primaryTool?.result?.success && hasReadme && hasPackage;
    } else if (cmd.id === 2) {
      const items = primaryTool?.result?.items || [];
      const hasLabs = items.some((i) => i.name.toLowerCase().includes('labs'));
      const hasTestTopic = items.some((i) => i.name.toLowerCase().includes('test topic'));
      itemsPreview = items.map((i) => i.name).join(', ');
      successCriteria = primaryTool?.tool === 'list_directory' && primaryTool?.result?.success && hasLabs && hasTestTopic;
    } else if (cmd.id === 3) {
      const files = primaryTool?.result?.files || [];
      const foundSwt = files.some((f) => f.path.toLowerCase().includes('swt301'));
      itemsPreview = files.map((f) => f.path).join(' ; ');
      successCriteria = primaryTool?.tool === 'file_search' && primaryTool?.result?.success && foundSwt;
    }

    reportResults.push({
      stt: cmd.id,
      prompt: cmd.prompt,
      toolCalled: primaryTool ? primaryTool.tool : 'none',
      toolSuccess: primaryTool ? primaryTool.result?.success : false,
      errorCode: primaryTool?.result?.errorCode || 'NONE',
      count: primaryTool?.result?.totalCount ?? primaryTool?.result?.count ?? 0,
      preview: itemsPreview,
      spokenReply: result.text,
      latencyMs: latency,
      passed: successCriteria
    });

    writeLog('LLM_PROMPT_END', `Lệnh [${cmd.id}/3] hoàn tất sau ${latency}ms | OK=${successCriteria}`);
    writeLog('LLM_SPOKEN_REPLY', `Aura trả lời: "${result.text}"`);
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log('\n================================ BÁO CÁO KIỂM THỬ THỰC TẾ ================================');
  console.table(
    reportResults.map((r) => ({
      STT: r.stt,
      'Câu lệnh': r.prompt,
      'Tool thực thi': r.toolCalled,
      'Mã lỗi': r.errorCode,
      'Số mục tìm thấy': r.count,
      'Các mục chính': r.preview.substring(0, 40) + '...',
      'Độ trễ (ms)': r.latencyMs,
      'Đánh giá': r.passed ? 'ĐẠT' : 'KHÔNG ĐẠT'
    }))
  );

  console.log('\n--- CHI TIẾT CÂU TRẢ LỜI CỦA AURA ---');
  reportResults.forEach((r) => {
    console.log(`[Lệnh ${r.stt}] "${r.prompt}"`);
    console.log(`    -> Tool: ${r.toolCalled} (count=${r.count})`);
    console.log(`    -> Danh sách: ${r.preview}`);
    console.log(`    -> Lời thoại Aura: "${r.spokenReply}"\n`);
  });

  const allPassed = reportResults.every((r) => r.passed);
  writeLog('TEST_END', `Kiểm thử kết thúc. Tất cả đạt: ${allPassed}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  writeLog('TEST_FATAL', err.stack || err.message);
  process.exit(1);
});

