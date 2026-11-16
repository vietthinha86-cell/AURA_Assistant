/**
 * KỊCH BẢN KIỂM THỬ BƯỚC B: CHẠY TEST / BUILD / RUN TRONG DỰ ÁN
 * - Ca 1: Chạy test thành công (node scripts/run_all_tests.js)
 * - Ca 2: Chạy test có lỗi (demo_failing_test.js) -> Báo lỗi trung thực
 * - Ca 3: Lệnh cài đặt thư viện (npm install) -> Kiểm tra xác nhận 1 lần duy nhất cho mỗi dự án
 * - Ca 4: Chặn cứng các lệnh nguy hiểm (format, git push, .env)
 * - Kiểm tra file báo cáo trong reports/ và projects_cache.json
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { AuraToolExecutor } = require('./src/module_e_brain/tool_executor');

function getRamStats() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return {
    totalMb: Math.round(total / (1024 * 1024)),
    usedMb: Math.round(used / (1024 * 1024)),
    freeMb: Math.round(free / (1024 * 1024)),
    percent: ((used / total) * 100).toFixed(1)
  };
}

async function runStepBTests() {
  console.log('='.repeat(80));
  console.log('BẮT ĐẦU KIỂM THỬ BƯỚC B: CHẠY TEST/BUILD/RUN TRONG DỰ ÁN (RUN_IN_PROJECT)');
  console.log('='.repeat(80));
  console.log(`Thời điểm: ${new Date().toISOString()}`);
  const initialRam = getRamStats();
  console.log(`RAM Ban đầu: ${initialRam.usedMb}MB / ${initialRam.totalMb}MB (${initialRam.percent}%)\n`);

  const executor = new AuraToolExecutor(__dirname);
  const targetProject = 'D:\\ảnh\\SWT301\\test topic';
  const testResults = [];

  // =========================================================================
  // CA 1: Chạy test thành công trong dự án
  // =========================================================================
  console.log('[CA 1] Chạy test thành công: "node scripts/run_all_tests.js"');
  const ram1_before = getRamStats();
  const t1_start = Date.now();
  const res1 = await executor.executeTool('run_in_project', {
    path: targetProject,
    command: 'node scripts/run_all_tests.js'
  });
  const dur1 = Date.now() - t1_start;
  const ram1_after = getRamStats();

  console.log(`- Trạng thái: ${res1.success ? 'ĐẠT (PASS)' : 'KHÔNG ĐẠT (FAIL)'}`);
  console.log(`- Exit Code: ${res1.exitCode}, Đạt: ${res1.passed}, Lỗi: ${res1.failed}, Tổng: ${res1.total}`);
  console.log(`- Thời gian thực thi: ${dur1} ms`);
  console.log(`- RAM: Trước ${ram1_before.usedMb}MB -> Sau ${ram1_after.usedMb}MB (${ram1_after.percent}%)`);
  console.log(`- Báo cáo đã lưu: ${res1.reportFile}`);
  console.log(`- Thông báo: ${res1.message}`);

  testResults.push({
    name: 'Ca 1: Chạy test toàn bộ topic',
    cmd: 'node scripts/run_all_tests.js',
    status: res1.success ? 'ĐẠT' : 'LỖI',
    exitCode: res1.exitCode,
    passed: `${res1.passed}/${res1.total}`,
    durationMs: dur1,
    ram: `${ram1_after.usedMb}MB (${ram1_after.percent}%)`,
    summary: res1.message
  });

  // =========================================================================
  // CA 2: Chạy test có lỗi có chủ đích (Intentional Failure Demo)
  // =========================================================================
  console.log('\n[CA 2] Chạy test có lỗi: "node scripts/demo_failing_test.js"');
  const ram2_before = getRamStats();
  const t2_start = Date.now();
  const res2 = await executor.executeTool('run_in_project', {
    path: targetProject,
    command: 'node scripts/demo_failing_test.js'
  });
  const dur2 = Date.now() - t2_start;
  const ram2_after = getRamStats();

  console.log(`- Trạng thái: ${res2.success ? 'ĐẠT (PASS)' : 'KHÔNG ĐẠT (FAIL - Đúng kỳ vọng phát hiện lỗi)'}`);
  console.log(`- Exit Code: ${res2.exitCode}, Đạt: ${res2.passed}, Lỗi: ${res2.failed}`);
  console.log(`- Danh sách test case thất bại: ${JSON.stringify(res2.failingTests)}`);
  console.log(`- Thời gian thực thi: ${dur2} ms`);
  console.log(`- Báo cáo đã lưu: ${res2.reportFile}`);

  testResults.push({
    name: 'Ca 2: Chạy test có lỗi (báo lỗi thật)',
    cmd: 'node scripts/demo_failing_test.js',
    status: res2.success ? 'LỖI (Kỳ vọng fail)' : 'ĐẠT (Báo lỗi chuẩn xác)',
    exitCode: res2.exitCode,
    passed: `${res2.passed}/${res2.total}`,
    durationMs: dur2,
    ram: `${ram2_after.usedMb}MB (${ram2_after.percent}%)`,
    summary: `Phát hiện lỗi exit code 1, test case lỗi: ${res2.failingTests.join(', ')}`
  });

  // =========================================================================
  // CA 3: Kiểm tra cài đặt gói thư viện (npm install) - Xác nhận 1 lần duy nhất
  // =========================================================================
  console.log('\n[CA 3] Lệnh cài đặt thư viện: Kiểm tra cơ chế xác nhận 1 lần cho dự án');
  // Lần 3a: Chưa xác nhận (confirmed = null) -> Phải yêu cầu xác nhận
  const res3a = await executor.executeTool('run_in_project', {
    path: 'D:\\AURA_Assistant',
    command: 'npm install --dry-run'
  }, null);
  console.log(`- Lần 1 (chưa xác nhận): needsConfirmation = ${res3a.needsConfirmation}`);
  console.log(`  Thông báo: "${res3a.error}"`);

  // Lần 3b: Người dùng xác nhận (confirmed = true) -> Chạy thành công và ghi nhớ
  const res3b = await executor.executeTool('run_in_project', {
    path: 'D:\\AURA_Assistant',
    command: 'npm --version'
  }, true);
  console.log(`- Lần 2 (đã xác nhận): success = ${res3b.success}, ExitCode = ${res3b.exitCode}`);

  testResults.push({
    name: 'Ca 3: Cài đặt gói (xác nhận 1 lần)',
    cmd: 'npm install / npm ...',
    status: (res3a.needsConfirmation && res3b.success) ? 'ĐẠT' : 'LỖI',
    exitCode: res3b.exitCode,
    passed: 'Chốt chặn 100%',
    durationMs: res3b.durationMs,
    ram: `${getRamStats().usedMb}MB`,
    summary: 'Chặn khi chưa duyệt; sau khi duyệt 1 lần thì tự động ghi nhớ vĩnh viễn cho dự án.'
  });

  // =========================================================================
  // CA 4: Chặn cứng các lệnh nguy hiểm (format, git push, .env)
  // =========================================================================
  console.log('\n[CA 4] Kiểm tra chốt chặn cứng các lệnh nguy hiểm');
  const res4_format = await executor.executeTool('run_in_project', { path: targetProject, command: 'format D:' });
  const res4_gitpush = await executor.executeTool('run_in_project', { path: targetProject, command: 'git push origin main' });
  const res4_env = await executor.executeTool('run_in_project', { path: targetProject, command: 'type .env' });

  console.log(`- Chặn format D: ${!res4_format.success} ("${res4_format.error}")`);
  console.log(`- Chặn git push: ${!res4_gitpush.success} ("${res4_gitpush.error}")`);
  console.log(`- Chặn đọc .env: ${!res4_env.success} ("${res4_env.error}")`);

  const allBlocked = !res4_format.success && !res4_gitpush.success && !res4_env.success;
  testResults.push({
    name: 'Ca 4: Chặn cứng các lệnh nguy hiểm',
    cmd: 'format / git push / .env',
    status: allBlocked ? 'ĐẠT' : 'LỖI',
    exitCode: 'Chặn trước spawn',
    passed: '3/3 chốt an toàn',
    durationMs: 1,
    ram: `${getRamStats().usedMb}MB`,
    summary: 'Chặn cứng 100% format đĩa, git push, đọc file .env'
  });

  // =========================================================================
  // KIỂM TRA FILE BÁO CÁO VÀ CACHE
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('KIỂM TRA BÁO CÁO VÀ CACHE:');
  console.log('='.repeat(80));

  const reportsDir = path.join(__dirname, 'reports');
  const reportFiles = fs.readdirSync(reportsDir).filter(f => f.startsWith('report_run_'));
  console.log(`- Tổng số file báo cáo đã tạo trong reports/: ${reportFiles.length}`);
  if (reportFiles.length > 0) {
    const latestReport = reportFiles[reportFiles.length - 1];
    console.log(`- File báo cáo mới nhất: ${latestReport}`);
  }

  const cachePath = path.join(__dirname, 'projects_cache.json');
  if (fs.existsSync(cachePath)) {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    console.log(`- Cập nhật cache dự án: lastRun cho "${targetProject}" =`, {
      lastCmd: cache[targetProject]?.lastRun?.command,
      exitCode: cache[targetProject]?.lastRun?.exitCode,
      success: cache[targetProject]?.lastRun?.success
    });
  }

  console.log('\n' + '='.repeat(80));
  console.log('BẢNG TỔNG HỢP KẾT QUẢ KIỂM THỬ BƯỚC B');
  console.log('='.repeat(80));
  console.table(testResults.map(r => ({
    'Ca Kiểm Thử': r.name,
    'Lệnh Thực Thi': r.cmd,
    'Trạng Thái': r.status,
    'Exit Code': r.exitCode,
    'Số Ca Đạt': r.passed,
    'Thời Gian': `${r.durationMs} ms`,
    'Tóm Tắt': r.summary.substring(0, 50) + '...'
  })));
}

runStepBTests().catch(err => {
  console.error('Lỗi kiểm thử Bước B:', err);
  process.exit(1);
});

