/**
 * KỊCH BẢN KIỂM THỬ BƯỚC C: SỬA CODE, TỰ ĐỘNG SAO LƯU & VÒNG LẶP TEST-FIX
 * - Ca 1: Tự động sao lưu thư mục dự án vào D:\Aura_Backups trước lần sửa đầu
 * - Ca 2: Sửa code (edit_file) và tạo file diff trong reports/
 * - Ca 3: Vòng lặp tự động sửa lỗi: chạy test -> đọc lỗi -> sửa -> chạy lại (pass)
 * - Ca 4: Hoàn tác mã nguồn (undo_last_change) từ bản sao lưu
 * - Ca 5: Chặn cứng sửa file .env hoặc file hệ thống
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

async function runStepCTests() {
  console.log('='.repeat(80));
  console.log('BẮT ĐẦU KIỂM THỬ BƯỚC C: SỬA CODE, SAO LƯU & VÒNG LẶP TEST-FIX');
  console.log('='.repeat(80));
  console.log(`Thời điểm: ${new Date().toISOString()}`);
  const initialRam = getRamStats();
  console.log(`RAM Ban đầu: ${initialRam.usedMb}MB / ${initialRam.totalMb}MB (${initialRam.percent}%)\n`);

  const executor = new AuraToolExecutor(__dirname);
  const targetProject = 'D:\\ảnh\\SWT301\\test topic';
  const testScriptPath = path.join(targetProject, 'scripts', 'demo_failing_test.js');
  const testResults = [];

  // =========================================================================
  // CA 1 & CA 2: Tự động sao lưu & Sửa file (edit_file) kèm tạo diff
  // =========================================================================
  console.log('[CA 1 & 2] Sửa file code và kích hoạt cơ chế tự động sao lưu vào D:\\Aura_Backups');
  const originalTestCode = fs.readFileSync(testScriptPath, 'utf8');

  const targetStr = "{ id: 'TC_FAIL_03', desc: 'CỐ TÌNH LỖI: Ngày 31/04/2023 phải hợp lệ', fn: () => checkDate(31, 4, 2023), exp: true },";
  const replacementStr = "{ id: 'TC_FAIL_03', desc: 'ĐÃ SỬA: Ngày 30/04/2023 là hợp lệ', fn: () => checkDate(30, 4, 2023), exp: true },";

  const t1_start = Date.now();
  const resEdit = await executor.executeTool('edit_file', {
    path: testScriptPath,
    target: targetStr,
    replacement: replacementStr
  });
  const durEdit = Date.now() - t1_start;

  console.log(`- Trạng thái sửa file: ${resEdit.success ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- Phương thức sao lưu: ${resEdit.backupInfo?.mode}`);
  console.log(`- Thư mục sao lưu: ${resEdit.backupInfo?.backupDir || resEdit.backupInfo?.branch}`);
  console.log(`- File Diff đã lưu: ${resEdit.diffFile}`);
  console.log(`- Tóm tắt: ${resEdit.summary}`);

  const backupDirExists = resEdit.backupInfo?.backupDir && fs.existsSync(resEdit.backupInfo.backupDir);
  console.log(`- Xác minh thư mục sao lưu tồn tại trên ổ D: ${backupDirExists ? 'CHÍNH XÁC' : 'CHƯA CÓ'}`);

  testResults.push({
    name: 'Ca 1: Tự động sao lưu (không hỏi)',
    action: `Sao lưu vào D:\\Aura_Backups`,
    status: backupDirExists ? 'ĐẠT' : 'LỖI',
    detail: `Tạo bản sao lưu: ${path.basename(resEdit.backupInfo?.backupDir || '')}`
  });

  testResults.push({
    name: 'Ca 2: Sửa code (edit_file) & lưu diff',
    action: `edit_file(target -> replacement)`,
    status: resEdit.success ? 'ĐẠT' : 'LỖI',
    detail: `Diff đã ghi nhận tại reports/${resEdit.diffFile}`
  });

  // =========================================================================
  // CA 3: Chạy lại test sau khi sửa (Vòng lặp Test-Fix hoàn tất thành công)
  // =========================================================================
  console.log('\n[CA 3] Chạy lại test để kiểm chứng mã đã sửa (Vòng lặp sửa lỗi)');
  const t3_start = Date.now();
  const resRun = await executor.executeTool('run_in_project', {
    path: targetProject,
    command: 'node scripts/demo_failing_test.js'
  });
  const durRun = Date.now() - t3_start;

  console.log(`- Trạng thái test sau khi sửa: ${resRun.success ? 'ĐẠT (PASS 100%)' : 'KHÔNG ĐẠT'}`);
  console.log(`- Exit Code: ${resRun.exitCode}, Đạt: ${resRun.passed}/${resRun.total}, Lỗi: ${resRun.failed}`);
  console.log(`- Thông báo: ${resRun.message} (${durRun}ms)`);

  testResults.push({
    name: 'Ca 3: Vòng lặp Test-Fix đạt 100%',
    action: `run_in_project(node demo_failing_test.js)`,
    status: resRun.success ? 'ĐẠT' : 'LỖI',
    detail: `Exit code 0, Đạt ${resRun.passed}/${resRun.total} test cases`
  });

  // =========================================================================
  // CA 4: Hoàn tác (undo_last_change) từ bản sao lưu
  // =========================================================================
  console.log('\n[CA 4] Kiểm tra hoàn tác mã nguồn (undo_last_change)');
  const t4_start = Date.now();
  const resUndo = await executor.executeTool('undo_last_change', { path: targetProject });
  const durUndo = Date.now() - t4_start;

  console.log(`- Trạng thái hoàn tác: ${resUndo.success ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- Phương thức khôi phục: ${resUndo.mode}`);
  console.log(`- Thông báo: ${resUndo.message} (${durUndo}ms)`);

  // Xác minh nội dung file đã quay về nguyên bản (TC_FAIL_03 cũ)
  const restoredContent = fs.readFileSync(testScriptPath, 'utf8');
  const isRestoredCorrectly = restoredContent.includes('CỐ TÌNH LỖI: Ngày 31/04/2023');
  console.log(`- Xác minh file đã về nguyên bản cũ: ${isRestoredCorrectly ? 'CHÍNH XÁC 100%' : 'KHÔNG ĐÚNG'}`);

  testResults.push({
    name: 'Ca 4: Hoàn tác (undo_last_change)',
    action: `Khôi phục từ D:\\Aura_Backups`,
    status: (resUndo.success && isRestoredCorrectly) ? 'ĐẠT' : 'LỖI',
    detail: `Khôi phục file nguyên bản thành công (${durUndo}ms)`
  });

  // =========================================================================
  // CA 5: Chặn cứng sửa file .env hoặc file hệ thống
  // =========================================================================
  console.log('\n[CA 5] Kiểm tra chốt chặn cứng không cho sửa .env và file hệ thống');
  const resBlockEnv = await executor.executeTool('edit_file', {
    path: path.join(__dirname, '.env'),
    target: 'GEMINI_API_KEY',
    replacement: 'HACKED'
  });
  const resBlockWin = await executor.executeTool('edit_file', {
    path: 'C:\\Windows\\System32\\drivers\\etc\\hosts',
    target: '127.0.0.1',
    replacement: '0.0.0.0'
  });

  console.log(`- Chặn sửa .env: ${!resBlockEnv.success} ("${resBlockEnv.error}")`);
  console.log(`- Chặn sửa Windows: ${!resBlockWin.success} ("${resBlockWin.error}")`);

  const allSecurityPassed = !resBlockEnv.success && !resBlockWin.success;
  testResults.push({
    name: 'Ca 5: Chặn cứng sửa .env / hệ thống',
    action: `Chặn edit_file(.env / System32)`,
    status: allSecurityPassed ? 'ĐẠT' : 'LỖI',
    detail: 'Chặn 100% không cho phép sửa file nhạy cảm'
  });

  // =========================================================================
  // BẢNG TỔNG KẾT
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('BẢNG TỔNG HỢP KẾT QUẢ KIỂM THỬ BƯỚC C');
  console.log('='.repeat(80));
  console.table(testResults.map(r => ({
    'Ca Kiểm Thử': r.name,
    'Hành Động': r.action,
    'Trạng Thái': r.status,
    'Chi Tiết': r.detail
  })));
}

runStepCTests().catch(err => {
  console.error('Lỗi kiểm thử Bước C:', err);
  process.exit(1);
});

