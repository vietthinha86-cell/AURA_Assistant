/**
 * ============================================================================
 * TEST STEP 6 (PHẦN BỔ SUNG): KIỂM THỬ TOOL open_youtube_video(query)
 * - Chạy thực tế 3 yêu cầu:
 *   1. "Mở YouTube bài Trao cho anh"
 *   2. "Mở clip Me at the zoo"
 *   3. "Xem phim hài trên YouTube"
 * - Kiểm tra:
 *   + Gọi open_youtube_video ngay trong 1 lượt (không dừng ở tìm kiếm, không nhờ chọn)
 *   + Không hỏi xác nhận (risk: safe)
 *   + Mở thẳng URL https://www.youtube.com/watch?v=<id>
 *   + Báo rõ tiêu đề video trong câu trả lời
 *   + Ghi log đầy đủ thời gian, kết quả, độ trễ
 * ============================================================================
 */
const path = require('path');
const fs = require('fs');
const { AuraLLMRouter } = require('./src/module_e_brain/llm_providers');

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

async function runSingleTest(router, queryIndex, userPrompt) {
  writeLog('TEST_QUERY_START', `=== TEST [${queryIndex}/3]: "${userPrompt}" ===`);
  const t0 = Date.now();

  const result = await router.chatWithMemory(userPrompt, { lang: 'vi' });
  const latency = Date.now() - t0;

  const lastTrace = result.toolExecutions || (result.lastTool ? [result.lastTool] : []);
  const primaryTool = lastTrace.find((t) => t.tool === 'open_youtube_video') || lastTrace[0] || null;

  const testReport = {
    index: queryIndex,
    prompt: userPrompt,
    toolCalled: primaryTool ? primaryTool.tool : 'none',
    toolArgs: primaryTool ? primaryTool.args : null,
    isSafe: primaryTool ? !primaryTool.isHighRisk : true,
    confirmed: primaryTool ? primaryTool.confirmed : true,
    toolSuccess: primaryTool ? primaryTool.result?.success : false,
    videoId: primaryTool?.result?.videoId || null,
    videoTitle: primaryTool?.result?.title || null,
    openedUrl: primaryTool?.result?.url || null,
    lookupSource: primaryTool?.result?.source || null,
    replyText: result.text,
    emotion: result.emotion,
    totalLatencyMs: latency,
    success: primaryTool && primaryTool.tool === 'open_youtube_video' && primaryTool.result?.success && Boolean(primaryTool.result?.videoId)
  };

  writeLog(
    'TEST_QUERY_RESULT',
    `Test [${queryIndex}/3] Result: Tool=${testReport.toolCalled} | VideoId=${testReport.videoId} | Title="${testReport.videoTitle}" | Latency=${latency}ms | OK=${testReport.success}`
  );
  writeLog('TEST_QUERY_REPLY', `Aura: "${result.text}"`);

  return testReport;
}

async function main() {
  writeLog('TEST_SUITE_START', '=== BẮT ĐẦU CHẠY THỰC TẾ 3 TEST OPEN_YOUTUBE_VIDEO ===');
  const router = new AuraLLMRouter(projectRoot, writeLog);

  const testQueries = [
    'Mở YouTube bài Trao cho anh',
    'Mở clip Me at the zoo',
    'Xem phim hài trên YouTube'
  ];

  const results = [];

  for (let i = 0; i < testQueries.length; i++) {
    const r = await runSingleTest(router, i + 1, testQueries[i]);
    results.push(r);
    // Tạm nghỉ 1s giữa các lượt
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  writeLog('TEST_SUITE_SUMMARY', '=== TỔNG KẾT KIỂM THỬ THỰC TẾ ===');
  console.log('\n================================ BÁO CÁO TỔNG KẾT ================================');
  console.table(
    results.map((r) => ({
      STT: r.index,
      'Yêu cầu': r.prompt,
      'Tool thực thi': r.toolCalled,
      'Không hỏi xác nhận': r.isSafe ? 'ĐẠT (Safe)' : 'KHÔNG ĐẠT',
      'Video ID': r.videoId,
      'Tiêu đề video': (r.videoTitle || '').substring(0, 35) + '...',
      'Độ trễ (ms)': r.totalLatencyMs,
      'Kết quả': r.success ? 'THÀNH CÔNG' : 'THẤT BẠI'
    }))
  );

  console.log('\n--- CHI TIẾT PHẢN HỒI CỦA AURA ---');
  results.forEach((r) => {
    console.log(`[${r.index}] "${r.prompt}"`);
    console.log(`    -> URL: ${r.openedUrl}`);
    console.log(`    -> Tiêu đề: ${r.videoTitle}`);
    console.log(`    -> Aura trả lời: "${r.replyText}"\n`);
  });

  const allPassed = results.every((r) => r.success);
  writeLog('TEST_SUITE_END', `Hoàn thành kiểm thử. Tất cả đạt: ${allPassed}`);
  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  writeLog('TEST_SUITE_FATAL', err.stack || err.message);
  process.exit(1);
});
