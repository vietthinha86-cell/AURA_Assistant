/**
 * KỊCH BẢN KIỂM THỬ BƯỚC A: TÌM VÀ HIỂU DỰ ÁN
 * - Test 1: Tìm dự án "AURA_Assistant" (find_project)
 * - Test 2: Quét dự án "D:\ảnh\SWT301\test topic" (scan_project)
 * - Test 3: Quét dự án "D:\AURA_Assistant" (scan_project)
 * - Test 4: Tìm dự án "test topic" (find_project)
 * - Kiểm tra projects_cache.json và logs/aura_actions.log
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

async function runStepATests() {
  console.log('='.repeat(80));
  console.log('BẮT ĐẦU KIỂM THỬ BƯỚC A: TÌM VÀ HIỂU DỰ ÁN (FIND & SCAN PROJECT)');
  console.log('='.repeat(80));
  console.log(`Thời điểm: ${new Date().toISOString()}`);
  const initialRam = getRamStats();
  console.log(`RAM Ban đầu: ${initialRam.usedMb}MB / ${initialRam.totalMb}MB (${initialRam.percent}%)\n`);

  const executor = new AuraToolExecutor(__dirname);

  const testRuns = [];

  // =========================================================================
  // CA 1: Tìm dự án "AURA_Assistant"
  // =========================================================================
  console.log('[CA 1] Yêu cầu: "tìm dự án AURA_Assistant" (tool find_project)');
  const ram1_before = getRamStats();
  const t1_start = Date.now();
  const res1 = await executor.executeTool('find_project', { query: 'AURA_Assistant' });
  const dur1 = Date.now() - t1_start;
  const ram1_after = getRamStats();

  console.log(`- Trạng thái: ${res1.success ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- Số lượng kết quả: ${res1.count}`);
  console.log(`- Đường dẫn tìm thấy: ${res1.projectPath}`);
  console.log(`- Thời gian thực thi: ${dur1} ms`);
  console.log(`- RAM: Trước ${ram1_before.usedMb}MB -> Sau ${ram1_after.usedMb}MB (${ram1_after.percent}%)`);
  console.log(`- Thông báo: ${res1.message}`);

  testRuns.push({
    name: 'Ca 1: Tìm dự án AURA_Assistant',
    tool: 'find_project(query: "AURA_Assistant")',
    status: res1.success ? 'ĐẠT' : 'LỖI',
    durationMs: dur1,
    ram: `${ram1_after.usedMb}MB (${ram1_after.percent}%)`,
    resultSummary: `Tìm thấy ${res1.count} dự án. Đường dẫn: ${res1.projectPath}`
  });

  // =========================================================================
  // CA 2: Quét dự án trong "D:\ảnh\SWT301\test topic"
  // =========================================================================
  console.log('\n[CA 2] Yêu cầu: "quét dự án trong D:\\ảnh\\SWT301\\test topic" (tool scan_project)');
  const targetPath2 = 'D:\\ảnh\\SWT301\\test topic';
  const ram2_before = getRamStats();
  const t2_start = Date.now();
  const res2 = await executor.executeTool('scan_project', { path: targetPath2 });
  const dur2 = Date.now() - t2_start;
  const ram2_after = getRamStats();

  console.log(`- Trạng thái: ${res2.success ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- Tên dự án: ${res2.profile?.name}`);
  console.log(`- Phân loại: ${res2.profile?.type}`);
  console.log(`- Ngôn ngữ: ${res2.profile?.language}`);
  console.log(`- Trình quản lý gói: ${res2.profile?.packageManager}`);
  console.log(`- File cấu hình nhận diện: ${JSON.stringify(res2.profile?.detectedFiles)}`);
  console.log(`- Lệnh test tự đoán: ${res2.profile?.commands?.test?.fullCmd} (${res2.profile?.commands?.test?.description})`);
  console.log(`- Thời gian thực thi: ${dur2} ms`);
  console.log(`- RAM: Trước ${ram2_before.usedMb}MB -> Sau ${ram2_after.usedMb}MB (${ram2_after.percent}%)`);

  testRuns.push({
    name: 'Ca 2: Quét dự án D:\\ảnh\\SWT301\\test topic',
    tool: 'scan_project(path: "D:\\ảnh\\SWT301\\test topic")',
    status: res2.success ? 'ĐẠT' : 'LỖI',
    durationMs: dur2,
    ram: `${ram2_after.usedMb}MB (${ram2_after.percent}%)`,
    resultSummary: `Loại: ${res2.profile?.type} | Lệnh test: ${res2.profile?.commands?.test?.fullCmd}`
  });

  // =========================================================================
  // CA 3: Quét dự án "D:\AURA_Assistant" (đối chứng thêm)
  // =========================================================================
  console.log('\n[CA 3] Yêu cầu đối chứng: "quét dự án D:\\AURA_Assistant" (tool scan_project)');
  const ram3_before = getRamStats();
  const t3_start = Date.now();
  const res3 = await executor.executeTool('scan_project', { path: __dirname });
  const dur3 = Date.now() - t3_start;
  const ram3_after = getRamStats();

  console.log(`- Trạng thái: ${res3.success ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- Tên dự án: ${res3.profile?.name}`);
  console.log(`- Phân loại: ${res3.profile?.type}`);
  console.log(`- Ngôn ngữ: ${res3.profile?.language}`);
  console.log(`- Trình quản lý gói: ${res3.profile?.packageManager}`);
  console.log(`- Lệnh test tự đoán: ${res3.profile?.commands?.test?.fullCmd}`);
  console.log(`- Lệnh run tự đoán: ${res3.profile?.commands?.run?.fullCmd}`);
  console.log(`- Thời gian thực thi: ${dur3} ms`);

  testRuns.push({
    name: 'Ca 3: Quét dự án D:\\AURA_Assistant',
    tool: 'scan_project(path: "D:\\AURA_Assistant")',
    status: res3.success ? 'ĐẠT' : 'LỖI',
    durationMs: dur3,
    ram: `${ram3_after.usedMb}MB (${ram3_after.percent}%)`,
    resultSummary: `Loại: ${res3.profile?.type} | Test: ${res3.profile?.commands?.test?.fullCmd} | Run: ${res3.profile?.commands?.run?.fullCmd}`
  });

  // =========================================================================
  // CA 4: Tìm dự án "test topic" (tìm kiếm theo tên tương đối)
  // =========================================================================
  console.log('\n[CA 4] Yêu cầu: "tìm dự án test topic" (find_project theo tên)');
  const t4_start = Date.now();
  const res4 = await executor.executeTool('find_project', { query: 'test topic' });
  const dur4 = Date.now() - t4_start;

  console.log(`- Trạng thái: ${res4.success ? 'THÀNH CÔNG' : 'THẤT BẠI'}`);
  console.log(`- Số lượng tìm thấy: ${res4.count}`);
  console.log(`- Kết quả khớp nhất: ${res4.projectPath}`);
  console.log(`- Thời gian thực thi: ${dur4} ms`);

  testRuns.push({
    name: 'Ca 4: Tìm dự án test topic',
    tool: 'find_project(query: "test topic")',
    status: res4.success ? 'ĐẠT' : 'LỖI',
    durationMs: dur4,
    ram: `${getRamStats().usedMb}MB`,
    resultSummary: `Tìm thấy ${res4.count} dự án. Khớp: ${res4.projectPath}`
  });

  // =========================================================================
  // KIỂM TRA TẬP TIN CACHE VÀ LOG
  // =========================================================================
  console.log('\n' + '='.repeat(80));
  console.log('KIỂM TRA TẬP TIN CACHE VÀ AUDIT LOG TRÊN Ổ ĐĨA:');
  console.log('='.repeat(80));

  const cacheFile = path.join(__dirname, 'projects_cache.json');
  console.log(`1. Kiểm tra file cache: ${cacheFile}`);
  if (fs.existsSync(cacheFile)) {
    const cacheContent = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const cachedKeys = Object.keys(cacheContent);
    console.log(`   -> File tồn tại! Có ${cachedKeys.length} dự án đã được lưu vào cache:`);
    cachedKeys.forEach((k) => {
      console.log(`      * [${cacheContent[k].type}] ${k} (Test: ${cacheContent[k].commands?.test?.fullCmd || 'None'})`);
    });
  } else {
    console.log('   -> [LỖI] File projects_cache.json chưa được tạo!');
  }

  const logFile = path.join(__dirname, 'logs', 'aura_actions.log');
  console.log(`\n2. Kiểm tra file audit log: ${logFile}`);
  if (fs.existsSync(logFile)) {
    const logLines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    console.log(`   -> File tồn tại! Tổng số dòng log: ${logLines.length}`);
    console.log('   -> Trích xuất 4 dòng log mới nhất:');
    logLines.slice(-4).forEach((line) => console.log(`      ${line}`));
  }

  console.log('\n' + '='.repeat(80));
  console.log('BẢNG TỔNG HỢP KẾT QUẢ KIỂM THỬ BƯỚC A');
  console.log('='.repeat(80));
  console.table(testRuns.map(r => ({
    'Ca Kiểm Thử': r.name,
    'Lệnh / Tool': r.tool,
    'Trạng Thái': r.status,
    'Thời Gian': `${r.durationMs} ms`,
    'RAM': r.ram,
    'Tóm Tắt Kết Quả': r.resultSummary
  })));
}

runStepATests().catch(err => {
  console.error('Lỗi kiểm thử Bước A:', err);
  process.exit(1);
});

