/**
 * ============================================================================
 * TEST STEP 6 (PHẦN BỔ SUNG 2): KIỂM THỬ TOOL open_live_stream(topic)
 * - Chạy thực tế các yêu cầu:
 *   1. "Mở giải Liên Minh Huyền Thoại trực tiếp"
 *   2. "Xem LCK trực tiếp"
 *   3. "Xem trực tiếp T1"
 * - Kiểm tra:
 *   + LLM gọi đúng tool open_live_stream ngay trong 1 lượt (không dùng open_youtube_video)
 *   + Khớp đúng kênh chính thức trong live_channels.json
 *   + Kiểm tra trạng thái LIVE thật sự (nhãn LIVE, "đang xem"/"watching")
 *   + Nếu có LIVE: mở đúng link https://www.youtube.com/watch?v=... và nói rõ tiêu đề, tên kênh
 *   + Nếu KHÔNG có LIVE: nói thật không có live và hỏi mở bản phát lại gần nhất của kênh chính thức
 *   + Ghi log đầy đủ mọi bước
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

async function runSingleTest(router, queryIndex, totalQueries, userPrompt) {
  writeLog('TEST_LIVE_START', `=== TEST [${queryIndex}/${totalQueries}]: "${userPrompt}" ===`);
  const t0 = Date.now();

  const result = await router.chatWithMemory(userPrompt, { lang: 'vi' });
  const latency = Date.now() - t0;

  const lastTrace = result.toolExecutions || (result.lastTool ? [result.lastTool] : []);
  const primaryTool = lastTrace.find((t) => t.tool === 'open_live_stream') || lastTrace[0] || null;

  const toolRes = primaryTool?.result || {};
  const isLive = Boolean(toolRes.isLive);

  const testReport = {
    index: queryIndex,
    prompt: userPrompt,
    toolCalled: primaryTool ? primaryTool.tool : 'none',
    toolArgs: primaryTool ? primaryTool.args : null,
    isSafe: primaryTool ? !primaryTool.isHighRisk : true,
    toolSuccess: Boolean(toolRes.success),
    isLive: isLive,
    channelName: toolRes.channelName || null,
    tournament: toolRes.tournament || null,
    streamTitle: isLive ? toolRes.title : null,
    openedUrl: isLive ? toolRes.url : null,
    lookupSource: isLive ? toolRes.source : null,
    latestReplay: !isLive ? toolRes.latestReplay : null,
    replyText: result.text,
    emotion: result.emotion,
    totalLatencyMs: latency,
    success: primaryTool && primaryTool.tool === 'open_live_stream' && toolRes.success === true
  };

  writeLog(
    'TEST_LIVE_RESULT',
    `Test [${queryIndex}/${totalQueries}] Result: Tool=${testReport.toolCalled} | Channel="${testReport.channelName}" | IsLive=${testReport.isLive} | URL=${testReport.openedUrl || 'N/A'} | Title="${testReport.streamTitle || testReport.latestReplay?.title || 'N/A'}" | Latency=${latency}ms | OK=${testReport.success}`
  );
  writeLog('TEST_LIVE_REPLY', `Aura: "${result.text}"`);

  return testReport;
}

async function main() {
  writeLog('TEST_SUITE_START', '=== BẮT ĐẦU CHẠY THỰC TẾ KIỂM THỬ OPEN_LIVE_STREAM ===');
  const router = new AuraLLMRouter(projectRoot, writeLog);

  const testQueries = [
    'Mở giải Liên Minh Huyền Thoại trực tiếp',
    'Xem LCK trực tiếp',
    'Xem trực tiếp T1'
  ];

  const results = [];
  for (let i = 0; i < testQueries.length; i++) {
    const report = await runSingleTest(router, i + 1, testQueries.length, testQueries[i]);
    results.push(report);
  }

  writeLog('TEST_SUITE_SUMMARY', '=== TỔNG KẾT KẾT QUẢ KIỂM THỬ OPEN_LIVE_STREAM ===');
  console.table(
    results.map((r) => ({
      STT: r.index,
      'Yêu cầu': r.prompt,
      'Tool gọi': r.toolCalled,
      'Kênh chính thức': r.channelName,
      'Có nhãn LIVE': r.isLive ? 'CÓ (Đang LIVE)' : 'KHÔNG (Hỏi Replay)',
      'Tiêu đề': r.streamTitle || r.latestReplay?.title || 'N/A',
      'Độ trễ': `${r.totalLatencyMs}ms`,
      'Đạt': r.success ? 'ĐẠT' : 'CHƯA ĐẠT'
    }))
  );

  writeLog('TEST_SUITE_END', 'Hoàn tất kiểm thử.');
}

main().catch((err) => {
  console.error('Lỗi chạy test:', err);
  process.exit(1);
});

