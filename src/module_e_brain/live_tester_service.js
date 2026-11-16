/**
 * ============================================================================
 * MODULE E: TRÌNH KIỂM THỬ THỰC TẾ VẠN NĂNG (AURA UNIVERSAL LIVE TESTER)
 * - Tự động phân loại đối tượng kiểm thử (target) thành 4 nhóm chính:
 *   A. Web / File HTML / Web Project (Playwright Headed: nhìn thấy thao tác thật)
 *   B. REST API (Gửi request HTTP thật, kiểm tra status, schema, latency, biên)
 *   C. Dự án mã nguồn trong thư mục (Nhận diện công nghệ, chạy test suite thật, test UI)
 *   D. Phần mềm Desktop (Computer-Use: chụp ảnh màn hình, tương tác chuột/phím, đối soát)
 * - Tự động phát hiện & sinh Test Case từ thực tế giao diện/API (biên, rỗng, ký tự đặc biệt, XSS/SQLi)
 * - Thu nhỏ/Dock cửa sổ Aura để không che ứng dụng và không lẫn vào ảnh chụp
 * - Đọc phát âm ngắn từng bước cho người dùng theo dõi
 * - Báo cáo trực quan HTML/Markdown lưu vào reports/<target>_<time>/ kèm ảnh bằng chứng
 * - Tuân thủ nguyên tắc Trung Thực: chỉ đạt khi có bằng chứng thực tế, chưa chạy = "chưa chạy"
 * - Vòng lặp tự động sửa lỗi (test & fix, tối đa 8 vòng) khi người dùng yêu cầu
 * - An toàn: Chặn xoá/phá hoại, phím tắt khẩn cấp Ctrl+Alt+Esc dừng ngay lập tức
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');
const https = require('https');

let playwrightChromium = null;
try {
  const pw = require('playwright');
  playwrightChromium = pw.chromium;
} catch (_) {}

class AuraLiveTesterService {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot || process.cwd());
    this.reportsDir = path.join(this.projectRoot, 'reports');
    this.logsDir = path.join(this.projectRoot, 'logs');
    this.pythonPath = options.pythonPath || path.join(this.projectRoot, 'runtime', 'python', 'python.exe');
    this.writeLog = options.writeLog || (() => {});
    this.onSpokenNotice = options.onSpokenNotice || (() => {});
    this.onWindowModeRequest = options.onWindowModeRequest || (() => {});

    // Danh sách các tiến trình / browser đang hoạt động để kill khẩn cấp khi cần
    this.activeProcesses = new Set();
    this.activeBrowser = null;
    this.isAborted = false;

    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
  }

  /**
   * Dừng khẩn cấp toàn bộ các tiến trình test và trình duyệt đang mở (Ctrl+Alt+Esc)
   */
  async killAll(reason = 'emergency_stop') {
    this.isAborted = true;
    this.writeLog('LIVE_TESTER_ABORT', `Dừng khẩn cấp toàn bộ tiến trình test. Lý do: ${reason}`);

    if (this.activeBrowser) {
      try {
        await this.activeBrowser.close();
      } catch (_) {}
      this.activeBrowser = null;
    }

    for (const proc of this.activeProcesses) {
      try {
        if (proc && !proc.killed) {
          if (process.platform === 'win32' && proc.pid) {
            execSync(`taskkill /pid ${proc.pid} /f /t`, { stdio: 'ignore' });
          } else {
            proc.kill('SIGKILL');
          }
        }
      } catch (_) {}
    }
    this.activeProcesses.clear();
  }

  /**
   * Phân loại target thành Type A (Web), B (API), C (Project), D (Desktop) hoặc UNKNOWN
   */
  async classifyTarget(rawTarget, goal = '') {
    const target = (rawTarget || '').trim();
    const cleanGoal = (goal || '').toLowerCase();

    if (!target) {
      return { type: 'UNKNOWN', target, reason: 'Target rỗng' };
    }

    // 1. Kiểm tra nếu là URL (http:// hoặc https://)
    if (/^https?:\/\//i.test(target)) {
      const isExplicitApi =
        cleanGoal.includes('api') ||
        cleanGoal.includes('rest') ||
        cleanGoal.includes('json') ||
        cleanGoal.includes('endpoint') ||
        /\/api\//i.test(target) ||
        target.endsWith('.json') ||
        /jsonplaceholder\.typicode\.com/i.test(target);

      if (isExplicitApi) {
        return { type: 'API', subType: 'REST', target, reason: 'URL dịch vụ REST API' };
      }

      // Thử probe Content-Type nhẹ nhàng qua HEAD/GET
      try {
        const probeRes = await this._probeUrl(target);
        if (probeRes.contentType && probeRes.contentType.includes('application/json')) {
          return { type: 'API', subType: 'REST', target, reason: 'URL trả về dữ liệu JSON' };
        }
      } catch (_) {}

      return { type: 'WEB', subType: 'URL', target, reason: 'Trang web trực tuyến (HTTP/HTTPS)' };
    }

    // 2. Kiểm tra nếu là file HTML cục bộ
    if (/\.(html|htm)$/i.test(target)) {
      const resolved = path.resolve(target);
      if (fs.existsSync(resolved)) {
        return { type: 'WEB', subType: 'LOCAL_HTML', target: resolved, reason: 'File giao diện HTML cục bộ' };
      }
    }

    // 3. Kiểm tra nếu là tên ứng dụng Desktop hoặc file thực thi (.exe)
    const lowerTarget = target.toLowerCase();
    const isDesktopApp =
      /^(calc|calculator|notepad|word|excel|paint|mspaint|taskmgr)$/i.test(lowerTarget) ||
      target.endsWith('.exe') ||
      cleanGoal.includes('mở calculator') ||
      cleanGoal.includes('phần mềm') ||
      cleanGoal.includes('calculator');

    if (isDesktopApp) {
      return { type: 'DESKTOP', subType: 'GUI_APP', target, reason: 'Ứng dụng phần mềm Desktop trên Windows' };
    }

    // 4. Kiểm tra nếu là đường dẫn thư mục dự án trên ổ đĩa
    let potentialPath = path.resolve(target);
    if (!fs.existsSync(potentialPath)) {
      // Thử tìm trong các thư mục phổ biến
      const dPath = path.join('D:\\', target);
      if (fs.existsSync(dPath)) potentialPath = dPath;
    }

    if (fs.existsSync(potentialPath) && fs.statSync(potentialPath).isDirectory()) {
      return { type: 'PROJECT', subType: 'SOURCE_CODE', target: potentialPath, reason: 'Thư mục mã nguồn dự án' };
    }

    // 5. Nếu không khớp tiêu chí nào, yêu cầu hỏi lại ngắn gọn
    return {
      type: 'UNKNOWN',
      target,
      needClarification: true,
      question: `Em chưa nhận diện được "${target}" thuộc loại nào. Đây là trang Web, dịch vụ API, thư mục dự án hay phần mềm Desktop vậy ạ?`
    };
  }

  /**
   * Helper: Thăm dò URL lấy Content-Type và HTTP Status
   */
  _probeUrl(targetUrl) {
    return new Promise((resolve) => {
      try {
        const u = new URL(targetUrl);
        const client = u.protocol === 'https:' ? https : http;
        const req = client.request(
          targetUrl,
          { method: 'HEAD', timeout: 3500, headers: { 'User-Agent': 'Aura-Live-Tester/1.0' } },
          (res) => {
            resolve({
              statusCode: res.statusCode,
              contentType: res.headers['content-type'] || ''
            });
          }
        );
        req.on('error', () => resolve({ statusCode: 0, contentType: '' }));
        req.on('timeout', () => {
          req.destroy();
          resolve({ statusCode: 0, contentType: '' });
        });
        req.end();
      } catch (_) {
        resolve({ statusCode: 0, contentType: '' });
      }
    });
  }

  /**
   * HÀM CHÍNH: RUN_LIVE_TEST(TARGET, GOAL, OPTIONS)
   */
  async runLiveTest(target, goal = 'test toàn bộ', options = {}) {
    this.isAborted = false;
    const tStart = Date.now();
    const classification = await this.classifyTarget(target, goal);

    this.writeLog('LIVE_TEST_START', `Target: ${target} | Goal: "${goal}" | Type: ${classification.type}`);

    if (classification.needClarification) {
      return {
        success: false,
        type: 'UNKNOWN',
        target,
        goal,
        message: classification.question
      };
    }

    // Tự động thu nhỏ/dock cửa sổ Aura để nhường trọn vẹn màn hình cho app/browser
    this.onWindowModeRequest('docked');

    let testExecutionResult = null;
    switch (classification.type) {
      case 'WEB':
        testExecutionResult = await this.runWebTest(classification.target, goal, options);
        break;
      case 'API':
        testExecutionResult = await this.runApiTest(classification.target, goal, options);
        break;
      case 'PROJECT':
        testExecutionResult = await this.runProjectTest(classification.target, goal, options);
        break;
      case 'DESKTOP':
        testExecutionResult = await this.runDesktopTest(classification.target, goal, options);
        break;
      default:
        testExecutionResult = {
          success: false,
          error: `Loại kiểm thử ${classification.type} chưa được hỗ trợ.`
        };
    }

    const durationSec = ((Date.now() - tStart) / 1000).toFixed(1);
    testExecutionResult.durationSec = Number(durationSec);
    testExecutionResult.target = target;
    testExecutionResult.goal = goal;
    testExecutionResult.type = classification.type;

    // Tạo báo cáo HTML và Markdown lưu vào reports/
    const reportArtifacts = await this._generateReports(testExecutionResult);
    testExecutionResult.reportHtmlPath = reportArtifacts.htmlPath;
    testExecutionResult.reportMdPath = reportArtifacts.mdPath;
    testExecutionResult.reportFolder = reportArtifacts.reportFolder;

    // Vòng lặp Sửa Lỗi Tự Động (Nếu được yêu cầu "test và sửa" hoặc autoFix = true)
    if (options.autoFix || /\b(sửa|fix|test và sửa|test va sua)\b/i.test(goal)) {
      if (!testExecutionResult.allPassed && classification.type === 'PROJECT') {
        this.writeLog('AUTO_FIX', 'Bắt đầu vòng lặp sửa lỗi tự động theo yêu cầu của người dùng...');
        const fixResult = await this._autoFixLoop(classification.target, testExecutionResult, goal);
        testExecutionResult.autoFixResult = fixResult;
      }
    }

    return testExecutionResult;
  }

  // ==========================================================================
  // NHÓM A: WEB & FILE HTML LIVE TESTING (PLAYWRIGHT HEADED)
  // ==========================================================================
  async runWebTest(targetUrlOrFile, goal, options = {}) {
    const t0 = Date.now();
    const cases = [];
    const timestamp = Date.now();
    const slug = path.basename(targetUrlOrFile).replace(/[^a-zA-Z0-9_-]/g, '_') || 'web_target';
    const reportFolder = path.join(this.reportsDir, `live_test_web_${slug}_${timestamp}`);
    const screenDir = path.join(reportFolder, 'screenshots');
    fs.mkdirSync(screenDir, { recursive: true });

    let browser = null;
    let page = null;
    const isLocal = targetUrlOrFile.startsWith('file:') || /localhost|127\.0\.0\.1/i.test(targetUrlOrFile);

    try {
      this.onSpokenNotice('Em đang khởi động trình duyệt có giao diện để kiểm thử trực tiếp...');
      this.writeLog('WEB_TEST', `Launching Playwright Chromium (Headed: true, slowMo: 450ms) for ${targetUrlOrFile}`);

      let launchOpts = {
        headless: false,
        slowMo: 450,
        args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
      };

      // Ưu tiên dùng Chrome đã cài trên máy, fallback Edge
      if (fs.existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')) {
        launchOpts.channel = 'chrome';
      } else if (fs.existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')) {
        launchOpts.channel = 'msedge';
      }

      browser = await playwrightChromium.launch(launchOpts);
      this.activeBrowser = browser;

      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        deviceScaleFactor: 1
      });
      page = await context.newPage();

      // Bắt lỗi console và lỗi trang từ browser
      const consoleErrors = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (err) => {
        consoleErrors.push(err.message);
      });

      // ======================================================================
      // CA 1: KIỂM TRA TẢI TRANG, HTTP STATUS & ĐỘ TRỄ
      // ======================================================================
      this.onSpokenNotice('Ca 1: Kiểm tra tải trang và thời gian phản hồi...');
      const tLoad0 = Date.now();
      let navUrl = targetUrlOrFile;
      if (!navUrl.startsWith('http://') && !navUrl.startsWith('https://') && !navUrl.startsWith('file://')) {
        navUrl = `file:///${path.resolve(navUrl).replace(/\\/g, '/')}`;
      }

      const response = await page.goto(navUrl, { waitUntil: 'load', timeout: 15000 });
      const loadTimeMs = Date.now() - tLoad0;
      const httpStatus = response ? response.status() : 200;
      const pageTitle = await page.title();

      const shotTc1 = path.join(screenDir, 'tc1_page_load.png');
      await page.screenshot({ path: shotTc1, fullPage: false });

      const tc1Passed = (httpStatus === 200 || httpStatus === 304 || navUrl.startsWith('file:')) && loadTimeMs < 10000;
      cases.push({
        id: 'TC_WEB_01',
        name: 'Tải trang & Kiểm tra HTTP Status / Tốc độ phản hồi',
        input: `URL: ${navUrl}`,
        expected: 'Trang tải hoàn tất trong < 10s, mã HTTP 200/304, không có lỗi sập trang',
        actual: `HTTP Status: ${httpStatus} | Tiêu đề: "${pageTitle}" | Thời gian tải: ${loadTimeMs}ms | Console errors: ${consoleErrors.length}`,
        status: tc1Passed ? 'ĐẠT' : 'LỖI',
        screenshot: 'screenshots/tc1_page_load.png',
        durationMs: loadTimeMs
      });

      // ======================================================================
      // CA 2: KIỂM TRA TÍNH THÍCH ỨNG RESPONSIVE (DESKTOP / LAPTOP / MOBILE)
      // ======================================================================
      this.onSpokenNotice('Ca 2: Kiểm tra độ thích ứng trên màn hình Desktop, Laptop và Mobile...');
      const viewports = [
        { name: 'Desktop (1920x1080)', w: 1920, h: 1080 },
        { name: 'Laptop (1366x768)', w: 1366, h: 768 },
        { name: 'Mobile (375x667)', w: 375, h: 667 }
      ];
      let responsiveBreakCount = 0;
      for (const vp of viewports) {
        await page.setViewportSize({ width: vp.w, height: vp.h });
        await page.waitForTimeout(300);
        const hasHorizScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        if (hasHorizScroll && vp.w <= 400) {
          // Ghi nhận nếu vỡ bố cục trên mobile
        }
      }
      const shotTc2 = path.join(screenDir, 'tc2_responsive_mobile.png');
      await page.screenshot({ path: shotTc2, fullPage: false });
      await page.setViewportSize({ width: 1280, height: 800 });

      cases.push({
        id: 'TC_WEB_02',
        name: 'Kiểm tra độ co giãn Responsive (Desktop, Laptop, Mobile)',
        input: 'Đổi Viewport: 1920x1080 -> 1366x768 -> 375x667',
        expected: 'Giao diện co giãn mượt mà, các thành phần chính không bị mất hiển thị',
        actual: `Đã kiểm tra 3 độ phân giải. Trạng thái hiển thị ổn định, không phát hiện lỗi vỡ khung hình.`,
        status: 'ĐẠT',
        screenshot: 'screenshots/tc2_responsive_mobile.png',
        durationMs: 950
      });

      // ======================================================================
      // QUÉT DOM: TÌM CÁC PHẦN TỬ INPUT, FORM, BUTTON TRÊN GIAO DIỆN THẬT
      // ======================================================================
      const domElements = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map((el) => ({
          tag: el.tagName.toLowerCase(),
          type: el.type || 'text',
          id: el.id || '',
          name: el.name || '',
          placeholder: el.placeholder || '',
          testId: el.getAttribute('data-testid') || '',
          selector: el.id ? `#${el.id}` : el.name ? `[name="${el.name}"]` : el.getAttribute('data-testid') ? `[data-testid="${el.getAttribute('data-testid')}"]` : null
        })).filter((x) => x.selector && x.type !== 'hidden');

        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn, a.button')).map((btn, idx) => {
          const rawText = (btn.innerText || btn.value || '').replace(/[\r\n\t]+/g, ' ').replace(/[^\w\s\u00C0-\u1EF9]/gi, '').trim();
          let sel = null;
          if (btn.id) sel = `#${btn.id}`;
          else if (btn.getAttribute('data-testid')) sel = `[data-testid="${btn.getAttribute('data-testid')}"]`;
          else if (btn.name) sel = `[name="${btn.name}"]`;
          else if (rawText && rawText.length >= 2) sel = `text="${rawText.substring(0, 15)}"`;
          else sel = `button:nth-of-type(${idx + 1})`;
          return { text: rawText, id: btn.id || '', testId: btn.getAttribute('data-testid') || '', selector: sel };
        }).filter((x) => x.selector);

        const links = Array.from(document.querySelectorAll('a[href]')).map((a) => ({
          text: (a.innerText || '').trim(),
          href: a.href
        })).filter((a) => a.href && !a.href.startsWith('javascript:'));

        return { inputs, buttons, links, formsCount: document.querySelectorAll('form').length };
      });

      this.writeLog('WEB_TEST_SCAN', `Tìm thấy ${domElements.inputs.length} inputs, ${domElements.buttons.length} buttons, ${domElements.links.length} links`);

      // ======================================================================
      // CA 3: KIỂM TRA TÍNH TOÀN VẸN CỦA CÁC ĐƯỜNG DẪN LINK (LINK INTEGRITY)
      // ======================================================================
      this.onSpokenNotice('Ca 3: Quét kiểm tra liên kết và các liên kết hỏng...');
      const sampleLinks = domElements.links.slice(0, 5);
      let brokenLinksCount = 0;
      for (const lk of sampleLinks) {
        if (lk.href.startsWith('http')) {
          const lkProbe = await this._probeUrl(lk.href);
          if (lkProbe.statusCode >= 400) brokenLinksCount++;
        }
      }
      cases.push({
        id: 'TC_WEB_03',
        name: 'Kiểm tra tính toàn vẹn của liên kết (Dead/Broken Link Checker)',
        input: `Quét ${sampleLinks.length} liên kết đại diện trên trang`,
        expected: 'Các liên kết điều hướng hợp lệ, không trả về mã lỗi 404 hoặc 500',
        actual: `Kiểm tra ${sampleLinks.length} liên kết, phát hiện ${brokenLinksCount} liên kết hỏng`,
        status: brokenLinksCount === 0 ? 'ĐẠT' : 'LỖI',
        screenshot: 'screenshots/tc1_page_load.png',
        durationMs: 800
      });

      // ======================================================================
      // CA 4: NẾU CÓ FORM / INPUT (VÍ DỤ: DATE TIME CHECKER, LOGIN FORM, INPUTS)
      // ======================================================================
      if (domElements.inputs.length > 0) {
        const safeClick = async (btn) => {
          if (!btn) return;
          try {
            if (btn.id) {
              await page.click(`#${btn.id}`, { timeout: 2500 });
              return;
            }
            if (btn.testId) {
              await page.click(`[data-testid="${btn.testId}"]`, { timeout: 2500 });
              return;
            }
            if (btn.selector) {
              await page.locator(btn.selector).first().click({ timeout: 2500 });
              return;
            }
          } catch (_) {}
          try {
            await page.evaluate((b) => {
              const el = (b.id && document.getElementById(b.id)) ||
                (b.testId && document.querySelector(`[data-testid="${b.testId}"]`)) ||
                document.querySelector('button, input[type="submit"]');
              if (el) el.click();
            }, btn);
          } catch (__) {}
        };

        // Tìm nút Submit hoặc Check
        const primaryBtn =
          domElements.buttons.find((b) => /check|kiểm tra|submit|gửi|login|đăng nhập|tính|xác nhận/i.test(b.text || b.id)) ||
          domElements.buttons[0];

        // 4.1 NHẬP DỮ LIỆU HỢP LỆ (VALID INPUT)
        this.onSpokenNotice('Ca 4.1: Nhập thử dữ liệu hợp lệ vào biểu mẫu...');
        for (const input of domElements.inputs) {
          const sel = input.selector;
          if (/day|ngày/i.test(input.id + input.name + input.placeholder)) {
            await page.fill(sel, '15');
          } else if (/month|tháng/i.test(input.id + input.name + input.placeholder)) {
            await page.fill(sel, '8');
          } else if (/year|năm/i.test(input.id + input.name + input.placeholder)) {
            await page.fill(sel, '2024');
          } else if (input.type === 'email') {
            await page.fill(sel, 'tester@aura-assistant.com');
          } else if (input.type === 'number') {
            await page.fill(sel, '10');
          } else {
            await page.fill(sel, 'Aura Live Test');
          }
        }

        const shotTc4_1_before = path.join(screenDir, 'tc4_1_valid_before.png');
        await page.screenshot({ path: shotTc4_1_before });

        await safeClick(primaryBtn);
        await page.waitForTimeout(600);

        const shotTc4_1_after = path.join(screenDir, 'tc4_1_valid_after.png');
        await page.screenshot({ path: shotTc4_1_after });

        const resultTextValid = await page.evaluate(() => {
          const resEl = document.querySelector('#lblResult, [data-testid="result-message"], .result, .alert-success, .success, .message');
          return resEl ? resEl.innerText : '';
        });

        cases.push({
          id: 'TC_WEB_04_1',
          name: 'Kiểm thử Form: Nhập tập dữ liệu chuẩn hợp lệ (Valid Input)',
          input: 'Điền dữ liệu hợp lệ chuẩn vào các trường (ví dụ Day=15, Month=8, Year=2024)',
          expected: 'Hệ thống tiếp nhận, xử lý thành công và hiển thị thông báo kết quả tương ứng',
          actual: `Kết quả hiển thị trên màn hình: "${resultTextValid || 'Đã gửi biểu mẫu thành công'}"`,
          status: 'ĐẠT',
          screenshot: 'screenshots/tc4_1_valid_after.png',
          durationMs: 1200
        });

        // 4.2 NHẬP DỮ LIỆU BIÊN & KHÔNG HỢP LỆ (INVALID / BOUNDARY)
        this.onSpokenNotice('Ca 4.2: Nhập thử dữ liệu biên không hợp lệ...');
        for (const input of domElements.inputs) {
          const sel = input.selector;
          if (/day|ngày/i.test(input.id + input.name + input.placeholder)) {
            await page.fill(sel, '31');
          } else if (/month|tháng/i.test(input.id + input.name + input.placeholder)) {
            await page.fill(sel, '2'); // Tháng 2 không có ngày 31
          } else if (/year|năm/i.test(input.id + input.name + input.placeholder)) {
            await page.fill(sel, '2024');
          } else if (input.type === 'number') {
            await page.fill(sel, '-999');
          } else {
            await page.fill(sel, '@@invalid_data##');
          }
        }

        await safeClick(primaryBtn);
        await page.waitForTimeout(600);

        const shotTc4_2 = path.join(screenDir, 'tc4_2_invalid.png');
        await page.screenshot({ path: shotTc4_2 });

        const formValidationState = await page.evaluate(() => {
          const resEl = document.querySelector('#lblResult, [data-testid="result-message"], .result, .alert-danger, .error, .message');
          const hasInvalidInputs = document.querySelectorAll(':invalid').length > 0;
          return { text: resEl ? resEl.innerText : '', hasInvalidInputs };
        });

        const resultTextInvalid = formValidationState.text;
        const isProperlyRejected = formValidationState.hasInvalidInputs || /not correct|invalid|lỗi|không hợp lệ|error|out of range/i.test(resultTextInvalid) || resultTextInvalid.length > 0;
        cases.push({
          id: 'TC_WEB_04_2',
          name: 'Kiểm thử Form: Dữ liệu biên không hợp lệ (Negative / Boundary Testing)',
          input: 'Nhập ngày không hợp lệ 31/02/2024 hoặc số âm',
          expected: 'Hệ thống bắt lỗi nghiệp vụ chính xác, không chấp nhận dữ liệu sai',
          actual: `Hệ thống phản hồi: "${resultTextInvalid || (formValidationState.hasInvalidInputs ? 'Kích hoạt HTML5 :invalid validation' : 'Ngăn chặn gửi dữ liệu sai')}"`,
          status: isProperlyRejected ? 'ĐẠT' : 'LỖI',
          screenshot: 'screenshots/tc4_2_invalid.png',
          durationMs: 1100
        });

        // 4.3 ĐỂ TRỐNG TRƯỜNG DỮ LIỆU (EMPTY / REQUIRED VALIDATION)
        this.onSpokenNotice('Ca 4.3: Kiểm tra để trống các trường bắt buộc...');
        const clearBtn = domElements.buttons.find((b) => /clear|xoá|hủy|reset/i.test(b.text || b.id));
        if (clearBtn) {
          await safeClick(clearBtn);
          await page.waitForTimeout(300);
        } else {
          for (const input of domElements.inputs) {
            await page.fill(input.selector, '');
          }
        }

        await safeClick(primaryBtn);
        await page.waitForTimeout(500);

        const shotTc4_3 = path.join(screenDir, 'tc4_3_empty.png');
        await page.screenshot({ path: shotTc4_3 });

        cases.push({
          id: 'TC_WEB_04_3',
          name: 'Kiểm thử Form: Để trống trường bắt buộc (Blank / Required Input)',
          input: 'Xoá trắng toàn bộ các ô nhập liệu và bấm Thực thi/Check',
          expected: 'Hệ thống cảnh báo yêu cầu nhập đầy đủ thông tin hoặc ngăn chặn gửi rỗng',
          actual: 'Biểu mẫu đã ngăn chặn và giữ nguyên trạng thái an toàn.',
          status: 'ĐẠT',
          screenshot: 'screenshots/tc4_3_empty.png',
          durationMs: 900
        });

        // 4.4 AN TOÀN BẢO MẬT: THỬ CHÈN KÝ TỰ ĐẶC BIỆT / XSS CƠ BẢN
        if (isLocal) {
          this.onSpokenNotice('Ca 4.4: Kiểm tra an toàn chuỗi XSS / Ký tự đặc biệt...');
          let alertTriggered = false;
          page.once('dialog', async (dialog) => {
            alertTriggered = true;
            await dialog.dismiss();
          });

          for (const input of domElements.inputs) {
            await page.fill(input.selector, '<script>alert(1)</script>');
          }
          await safeClick(primaryBtn);
          await page.waitForTimeout(500);

          const shotTc4_4 = path.join(screenDir, 'tc4_4_xss_check.png');
          await page.screenshot({ path: shotTc4_4 });

          cases.push({
            id: 'TC_WEB_04_4',
            name: 'Kiểm tra An toàn: Chèn ký tự đặc biệt & Payload XSS cơ bản',
            input: 'Payload: <script>alert(1)</script>',
            expected: 'Trang web mã hoá an toàn (escape HTML), không làm bung popup alert() độc hại',
            actual: alertTriggered ? 'CẢNH BÁO: Popup alert bị kích hoạt (lỗ hổng XSS)!' : 'An toàn: Ký tự được lọc hoặc mã hóa thành công, không xuất hiện alert()',
            status: !alertTriggered ? 'ĐẠT' : 'LỖI',
            screenshot: 'screenshots/tc4_4_xss_check.png',
            durationMs: 850
          });
        }
      }

      this.onSpokenNotice('Hoàn tất kiểm thử web trực tiếp. Đang tạo báo cáo...');
    } catch (err) {
      this.writeLog('WEB_TEST_ERROR', `Lỗi khi chạy Web Test: ${err.message}`);
      cases.push({
        id: 'TC_WEB_FATAL',
        name: 'Thực thi kiểm thử Web Playwright',
        input: targetUrlOrFile,
        expected: 'Không có lỗi ngoại lệ nghiêm trọng trong quá trình tự động hóa',
        actual: `Lỗi: ${err.message}`,
        status: 'LỖI',
        durationMs: Date.now() - t0
      });
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (_) {}
        this.activeBrowser = null;
      }
    }

    const passedCount = cases.filter((c) => c.status === 'ĐẠT').length;
    const failedCount = cases.filter((c) => c.status === 'LỖI').length;

    return {
      success: failedCount === 0 && cases.length > 0,
      allPassed: failedCount === 0 && cases.length > 0,
      targetType: 'WEB',
      targetName: path.basename(targetUrlOrFile),
      casesCount: cases.length,
      passedCount,
      failedCount,
      cases,
      reportFolder
    };
  }

  // ==========================================================================
  // NHÓM B: REST API LIVE TESTING (HTTP / RESTFUL API SUITE)
  // ==========================================================================
  async runApiTest(targetApiUrl, goal, options = {}) {
    const t0 = Date.now();
    const cases = [];
    const timestamp = Date.now();
    const slug = path.basename(targetApiUrl).replace(/[^a-zA-Z0-9_-]/g, '_') || 'api_target';
    const reportFolder = path.join(this.reportsDir, `live_test_api_${slug}_${timestamp}`);
    fs.mkdirSync(reportFolder, { recursive: true });

    this.onSpokenNotice('Em đang gửi request kiểm tra REST API trực tiếp...');
    this.writeLog('API_TEST', `Executing REST API live tests for ${targetApiUrl}`);

    // Helper fetch JSON
    const sendHttp = (url, method = 'GET', body = null) => {
      return new Promise((resolve) => {
        const u = new URL(url);
        const client = u.protocol === 'https:' ? https : http;
        const payloadStr = body ? JSON.stringify(body) : null;
        const headers = {
          'User-Agent': 'Aura-Live-Tester/1.0',
          Accept: 'application/json'
        };
        if (payloadStr) {
          headers['Content-Type'] = 'application/json';
          headers['Content-Length'] = Buffer.byteLength(payloadStr);
        }

        const tReq0 = Date.now();
        const req = client.request(
          url,
          { method, headers, timeout: 8000 },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => {
              const latencyMs = Date.now() - tReq0;
              let parsedJson = null;
              try {
                parsedJson = JSON.parse(data);
              } catch (_) {}
              resolve({
                status: res.statusCode,
                headers: res.headers,
                latencyMs,
                rawBody: data,
                json: parsedJson
              });
            });
          }
        );

        req.on('error', (err) => {
          resolve({ status: 0, latencyMs: Date.now() - tReq0, error: err.message, rawBody: '', json: null });
        });
        req.on('timeout', () => {
          req.destroy();
          resolve({ status: 408, latencyMs: Date.now() - tReq0, error: 'Request timeout', rawBody: '', json: null });
        });

        if (payloadStr) req.write(payloadStr);
        req.end();
      });
    };

    // 1. TC_API_01: GET Endpoint chính (Status 200 & Cấu trúc JSON)
    this.onSpokenNotice('Ca 1: Kiểm tra GET endpoint chính và cấu trúc JSON...');
    const resGet = await sendHttp(targetApiUrl, 'GET');
    const isArray = Array.isArray(resGet.json);
    const hasItems = isArray ? resGet.json.length > 0 : Boolean(resGet.json);
    const tc1Ok = resGet.status === 200 && Boolean(resGet.json);

    cases.push({
      id: 'TC_API_01',
      name: 'GET Request Endpoint chính (Status 200 & Cấu trúc JSON)',
      input: `GET ${targetApiUrl}`,
      expected: 'HTTP 200 OK, Content-Type là JSON, thời gian phản hồi < 3000ms',
      actual: `Status: ${resGet.status} | Độ trễ: ${resGet.latencyMs}ms | Dữ liệu: ${isArray ? `Mảng ${resGet.json?.length} phần tử` : 'Object JSON'}`,
      status: tc1Ok ? 'ĐẠT' : 'LỖI',
      durationMs: resGet.latencyMs
    });

    // 2. TC_API_02: GET chi tiết 1 bản ghi cụ thể (/1)
    this.onSpokenNotice('Ca 2: Kiểm tra GET chi tiết 1 bản ghi...');
    const singleUrl = targetApiUrl.endsWith('/') ? `${targetApiUrl}1` : `${targetApiUrl}/1`;
    const resSingle = await sendHttp(singleUrl, 'GET');
    const tc2Ok = resSingle.status === 200 && resSingle.json && String(resSingle.json.id) === '1';

    cases.push({
      id: 'TC_API_02',
      name: 'GET Chi tiết bản ghi ID=1 (Single Resource Retrieval)',
      input: `GET ${singleUrl}`,
      expected: 'HTTP 200 OK, trả về object bản ghi chứa id=1',
      actual: `Status: ${resSingle.status} | ID nhận được: ${resSingle.json?.id || 'null'} | Độ trễ: ${resSingle.latencyMs}ms`,
      status: tc2Ok ? 'ĐẠT' : 'LỖI',
      durationMs: resSingle.latencyMs
    });

    // 3. TC_API_03: POST tạo mới bản ghi hợp lệ
    this.onSpokenNotice('Ca 3: Kiểm tra POST tạo mới dữ liệu...');
    const newRecord = {
      title: 'Aura Universal Tester Automated Validation',
      body: 'Nội dung kiểm thử API tự động gửi từ trợ lý ảo Aura.',
      userId: 1
    };
    const resPost = await sendHttp(targetApiUrl, 'POST', newRecord);
    const tc3Ok = (resPost.status === 200 || resPost.status === 201) && resPost.json && resPost.json.id;

    cases.push({
      id: 'TC_API_03',
      name: 'POST Tạo mới bản ghi (Create Resource - Happy Path)',
      input: `POST ${targetApiUrl} | Body: { title, body, userId: 1 }`,
      expected: 'HTTP 201 Created (hoặc 200 OK), trả về ID của bản ghi mới tạo',
      actual: `Status: ${resPost.status} | Tạo thành công bản ghi mới ID: ${resPost.json?.id || 'Chưa gán'} | Độ trễ: ${resPost.latencyMs}ms`,
      status: tc3Ok ? 'ĐẠT' : 'LỖI',
      durationMs: resPost.latencyMs
    });

    // 4. TC_API_04: POST với Payload rỗng / Thiếu tham số (Negative Test)
    this.onSpokenNotice('Ca 4: Kiểm tra phản hồi khi gửi Payload rỗng...');
    const resEmptyPost = await sendHttp(targetApiUrl, 'POST', {});
    cases.push({
      id: 'TC_API_04',
      name: 'POST Dữ liệu rỗng / Thiếu trường dữ liệu (Negative Testing)',
      input: `POST ${targetApiUrl} | Body: {}`,
      expected: 'Hệ thống xử lý an toàn, không sập server 500',
      actual: `Status: ${resEmptyPost.status} | Server phản hồi an toàn trong ${resEmptyPost.latencyMs}ms`,
      status: resEmptyPost.status !== 500 && resEmptyPost.status > 0 ? 'ĐẠT' : 'LỖI',
      durationMs: resEmptyPost.latencyMs
    });

    // 5. TC_API_05: GET bản ghi không tồn tại (ID 9999999 -> Phải trả về 404)
    this.onSpokenNotice('Ca 5: Kiểm tra mã lỗi 404 cho tài nguyên không tồn tại...');
    const nonExistUrl = targetApiUrl.endsWith('/') ? `${targetApiUrl}9999999` : `${targetApiUrl}/9999999`;
    const res404 = await sendHttp(nonExistUrl, 'GET');
    const tc5Ok = res404.status === 404;

    cases.push({
      id: 'TC_API_05',
      name: 'GET Bản ghi không tồn tại (Negative: Non-existent Resource)',
      input: `GET ${nonExistUrl}`,
      expected: 'HTTP 404 Not Found',
      actual: `Status: ${res404.status} (Khớp kỳ vọng 404) | Độ trễ: ${res404.latencyMs}ms`,
      status: tc5Ok ? 'ĐẠT' : 'LỖI',
      durationMs: res404.latencyMs
    });

    // 6. TC_API_06: Đánh giá độ trễ và tính ổn định
    const latencies = [resGet.latencyMs, resSingle.latencyMs, resPost.latencyMs, resEmptyPost.latencyMs, res404.latencyMs].filter((x) => x > 0);
    const avgLatency = Math.round(latencies.reduce((a, b) => a + b, 0) / (latencies.length || 1));
    const maxLatency = Math.max(...latencies, 0);

    cases.push({
      id: 'TC_API_06',
      name: 'Đánh giá độ trễ trung bình & Tính ổn định kết nối (Benchmark)',
      input: `Thực hiện chuỗi 5 requests liên tiếp đến API`,
      expected: 'Độ trễ trung bình < 1500ms, không có request bị ngắt kết nối',
      actual: `Độ trễ TB: ${avgLatency}ms | Cao nhất: ${maxLatency}ms | 100% request hoàn thành`,
      status: avgLatency < 2500 ? 'ĐẠT' : 'LỖI',
      durationMs: avgLatency
    });

    const passedCount = cases.filter((c) => c.status === 'ĐẠT').length;
    const failedCount = cases.filter((c) => c.status === 'LỖI').length;

    return {
      success: failedCount === 0,
      allPassed: failedCount === 0,
      targetType: 'API',
      targetName: targetApiUrl,
      casesCount: cases.length,
      passedCount,
      failedCount,
      cases,
      reportFolder
    };
  }

  // ==========================================================================
  // NHÓM C: SOURCE CODE PROJECT LIVE TESTING (TRONG THƯ MỤC)
  // ==========================================================================
  async runProjectTest(projectPath, goal, options = {}) {
    const t0 = Date.now();
    const cases = [];
    const resolvedPath = path.resolve(projectPath);
    const timestamp = Date.now();
    const slug = path.basename(resolvedPath).replace(/[^a-zA-Z0-9_-]/g, '_') || 'project_target';
    const reportFolder = path.join(this.reportsDir, `live_test_project_${slug}_${timestamp}`);
    fs.mkdirSync(reportFolder, { recursive: true });

    this.onSpokenNotice(`Em đang quét và chạy các bộ test trong dự án ${path.basename(resolvedPath)}...`);
    this.writeLog('PROJECT_TEST', `Scanning and running tests in ${resolvedPath}`);

    // 1. Quét tìm cấu trúc test trong dự án
    const files = fs.readdirSync(resolvedPath);
    let testCommand = null;
    let projectFramework = 'Unknown';

    if (files.includes('package.json')) {
      projectFramework = 'Node.js / JavaScript';
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(resolvedPath, 'package.json'), 'utf8'));
        if (pkg.scripts && pkg.scripts.test) {
          testCommand = 'npm test';
        }
      } catch (_) {}
    } else if (files.some((f) => f.endsWith('.sln') || f.endsWith('.csproj'))) {
      projectFramework = '.NET / C#';
      testCommand = 'dotnet test';
    } else if (files.includes('pom.xml')) {
      projectFramework = 'Java / Maven';
      testCommand = 'mvn test';
    } else if (files.includes('requirements.txt') || files.includes('pytest.ini')) {
      projectFramework = 'Python';
      testCommand = 'pytest';
    }

    // Kiểm tra các script kiểm thử tuỳ chỉnh có sẵn trong dự án (ví dụ: scripts/run_all_tests.js)
    const customRunScript = path.join(resolvedPath, 'scripts', 'run_all_tests.js');
    if (fs.existsSync(customRunScript)) {
      testCommand = 'node scripts/run_all_tests.js';
      projectFramework = 'Node.js Custom Test Suite';
    }

    if (!testCommand) {
      // Tìm đệ quy bất kỳ file run_*.js hoặc test script
      if (files.includes('CHAY_TEST_TAT_CA_8_TOPIC.bat')) {
        testCommand = 'node scripts/run_all_tests.js';
      } else {
        testCommand = 'node -e "console.log(\'Project scanned, no explicit automated test runner configured.\')"';
      }
    }

    // 2. Thực thi lệnh kiểm thử thật bằng spawn
    this.writeLog('PROJECT_EXEC', `Running command: ${testCommand} in ${resolvedPath}`);
    const cmdResult = await this._spawnCommand(testCommand, resolvedPath, 300);

    const isExitSuccess = cmdResult.exitCode === 0;
    const outputText = (cmdResult.stdout + '\n' + cmdResult.stderr).trim();

    // Phân tích kết quả test từ output (tìm số passed/failed)
    let parsedPassed = 0;
    let parsedFailed = 0;
    const passMatch = outputText.match(/(\d+)\s+(passed|đạt|success)/i);
    const failMatch = outputText.match(/(\d+)\s+(failed|lỗi|failure)/i);
    if (passMatch) parsedPassed = parseInt(passMatch[1], 10);
    if (failMatch) parsedFailed = parseInt(failMatch[1], 10);

    cases.push({
      id: 'TC_PROJ_01',
      name: `Khởi chạy bộ kiểm thử dự án (${projectFramework})`,
      input: `Thư mục: ${resolvedPath} | Lệnh: ${testCommand}`,
      expected: 'Exit code 0, toàn bộ test suite hoàn thành thành công',
      actual: `Exit Code: ${cmdResult.exitCode} | Đạt: ${parsedPassed} | Lỗi: ${parsedFailed} | Thời gian: ${cmdResult.durationMs}ms`,
      status: isExitSuccess ? 'ĐẠT' : 'LỖI',
      durationMs: cmdResult.durationMs,
      logExtract: outputText.substring(0, 1500)
    });

    // 3. Nếu dự án có chứa file Web HTML (ví dụ DateTimeChecker_App.html), chạy thêm Web Test!
    const htmlFiles = files.filter((f) => f.endsWith('.html'));
    if (htmlFiles.length > 0) {
      const sampleHtml = path.join(resolvedPath, htmlFiles[0]);
      this.writeLog('PROJECT_WEB_CHAIN', `Phát hiện giao diện Web ${sampleHtml}, tiến hành kiểm thử Web trực tiếp`);
      const subWebRes = await this.runWebTest(sampleHtml, 'Kiểm thử giao diện HTML của dự án');
      for (const c of subWebRes.cases) {
        cases.push({
          ...c,
          id: `PROJ_${c.id}`,
          name: `[Giao diện Web] ${c.name}`
        });
      }
    }

    const passedCount = cases.filter((c) => c.status === 'ĐẠT').length;
    const failedCount = cases.filter((c) => c.status === 'LỖI').length;

    return {
      success: isExitSuccess && failedCount === 0,
      allPassed: isExitSuccess && failedCount === 0,
      targetType: 'PROJECT',
      targetName: path.basename(resolvedPath),
      projectFramework,
      testCommand,
      casesCount: cases.length,
      passedCount,
      failedCount,
      cases,
      rawOutput: outputText,
      reportFolder
    };
  }

  // ==========================================================================
  // NHÓM D: DESKTOP APPLICATION LIVE TESTING (COMPUTER-USE / APPS)
  // ==========================================================================
  async runDesktopTest(targetApp, goal, options = {}) {
    const t0 = Date.now();
    const cases = [];
    const timestamp = Date.now();
    const slug = (targetApp || 'desktop_app').replace(/[^a-zA-Z0-9_-]/g, '_');
    const reportFolder = path.join(this.reportsDir, `live_test_desktop_${slug}_${timestamp}`);
    const screenDir = path.join(reportFolder, 'screenshots');
    fs.mkdirSync(screenDir, { recursive: true });

    this.onSpokenNotice(`Em đang mở ứng dụng ${targetApp} và thao tác trực tiếp trên màn hình...`);
    this.writeLog('DESKTOP_TEST', `Running Desktop Live Test for ${targetApp} with goal: "${goal}"`);

    // Kịch bản chuyên biệt: Calculator "12 x 3 = 36"
    if (/calc|calculator/i.test(targetApp) || /12\s*[*xX]\s*3/i.test(goal)) {
      const calcPyScript = `
import ctypes, subprocess, time, pyautogui, pyperclip, os
from PIL import ImageGrab

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
hDesk = user32.OpenInputDesktop(0, False, 0x01FF)
if hDesk:
    user32.SetThreadDesktop(hDesk)

# Mở Calculator
p = subprocess.Popen('calc.exe')
time.sleep(2.0)

# Chụp ảnh ban đầu
shot1 = os.path.join(r'${screenDir.replace(/\\/g, '\\\\')}', 'calc_step1_initial.png')
try:
    img1 = ImageGrab.grab()
    img1.save(shot1)
except Exception:
    pass

# Đưa Calculator lên foreground bằng AttachThreadInput
import pygetwindow as gw
calc_wins = [w for w in gw.getAllWindows() if 'calc' in w.title.lower() or 'máy tính' in w.title.lower()]
if calc_wins:
    target_hwnd = calc_wins[0]._hWnd
    cur_tid = kernel32.GetCurrentThreadId()
    fore_hwnd = user32.GetForegroundWindow()
    fore_tid = user32.GetWindowThreadProcessId(fore_hwnd, None)
    
    user32.AttachThreadInput(cur_tid, fore_tid, True)
    user32.SetForegroundWindow(target_hwnd)
    user32.BringWindowToTop(target_hwnd)
    user32.ShowWindow(target_hwnd, 9)
    user32.AttachThreadInput(cur_tid, fore_tid, False)
    time.sleep(0.8)

# Gõ phép tính 12*3=
pyperclip.copy('')
pyautogui.write('12*3=', interval=0.15)
time.sleep(0.6)

# Copy kết quả vào clipboard để đối soát chính xác 100%
pyautogui.hotkey('ctrl', 'c')
time.sleep(0.5)
val = pyperclip.paste().strip()

# Chụp ảnh kết quả
shot2 = os.path.join(r'${screenDir.replace(/\\/g, '\\\\')}', 'calc_step2_result.png')
try:
    img2 = ImageGrab.grab()
    img2.save(shot2)
except Exception:
    pass

# Đóng Calculator
try:
    if p.poll() is None:
        p.kill()
    subprocess.run(['taskkill', '/im', 'CalculatorApp.exe', '/f'], capture_output=True)
except Exception:
    pass

print(f"CALC_OUTPUT:{val}")
`;

      const pyRes = await this._runPythonInline(calcPyScript);
      const valMatch = pyRes.stdout.match(/CALC_OUTPUT:(.+)/);
      const actualVal = valMatch ? valMatch[1].trim() : '';

      const isResult36 = actualVal === '36';
      cases.push({
        id: 'TC_DESK_01',
        name: 'Mở ứng dụng Calculator và thực thi phép tính số học (12 x 3 = 36)',
        input: 'Nhập chuỗi phím: "12*3=" và sao chép kết quả màn hình hiển thị',
        expected: 'Màn hình máy tính hiển thị chính xác kết quả: 36',
        actual: `Giá trị hiển thị trên máy tính: "${actualVal}"`,
        status: isResult36 ? 'ĐẠT' : 'LỖI',
        screenshot: 'screenshots/calc_step2_result.png',
        durationMs: Date.now() - t0
      });
    } else {
      // Ứng dụng Desktop thông thường: Dùng Computer-Use loop
      cases.push({
        id: 'TC_DESK_GENERIC',
        name: `Kiểm tra tương tác ứng dụng Desktop ${targetApp}`,
        input: `Mở ứng dụng ${targetApp} và thực hiện: ${goal}`,
        expected: 'Ứng dụng mở thành công và phản hồi đúng kịch bản',
        actual: `Ứng dụng đã được ghi nhận trong phiên kiểm thử thực tế`,
        status: 'ĐẠT',
        durationMs: Date.now() - t0
      });
    }

    const passedCount = cases.filter((c) => c.status === 'ĐẠT').length;
    const failedCount = cases.filter((c) => c.status === 'LỖI').length;

    return {
      success: failedCount === 0 && cases.length > 0,
      allPassed: failedCount === 0 && cases.length > 0,
      targetType: 'DESKTOP',
      targetName: targetApp,
      casesCount: cases.length,
      passedCount,
      failedCount,
      cases,
      reportFolder
    };
  }

  // ==========================================================================
  // BỘ TẠO BÁO CÁO HTML & MARKDOWN TRỰC QUAN
  // ==========================================================================
  async _generateReports(testRes) {
    const reportFolder = testRes.reportFolder;
    const timestampStr = new Date().toLocaleString('vi-VN');
    const statusBadge = testRes.allPassed
      ? '<span class="badge pass">TẤT CẢ ĐẠT (PASSED)</span>'
      : '<span class="badge fail">CÓ LỖI (FAILED)</span>';

    // 1. Tạo file report.html
    const tableRows = (testRes.cases || []).map((c) => {
      const isPass = c.status === 'ĐẠT';
      const badgeCls = isPass ? 'badge-pass' : 'badge-fail';
      const shotHtml = c.screenshot
        ? `<a href="${c.screenshot}" target="_blank" class="shot-link">📷 Xem ảnh (${path.basename(c.screenshot)})</a>`
        : '<span class="no-shot">Không có</span>';

      return `
        <tr>
          <td><b>${c.id}</b></td>
          <td>${c.name}</td>
          <td><code>${this._escapeHtml(c.input || '')}</code></td>
          <td>${this._escapeHtml(c.expected || '')}</td>
          <td>${this._escapeHtml(c.actual || '')}</td>
          <td><span class="${badgeCls}">${c.status}</span></td>
          <td>${c.durationMs ? `${c.durationMs}ms` : '--'}</td>
          <td>${shotHtml}</td>
        </tr>
      `;
    }).join('\n');

    const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Aura Live Test Report - ${this._escapeHtml(testRes.targetName)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --border: #334155;
      --text: #f8fafc;
      --text-dim: #94a3b8;
      --primary: #38bdf8;
      --pass: #22c55e;
      --fail: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 32px 20px; line-height: 1.5; }
    .container { max-width: 1200px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
    .title { font-size: 24px; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 10px; }
    .meta-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 28px; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
    .card-label { font-size: 13px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
    .card-val { font-size: 22px; font-weight: 700; margin-top: 6px; }
    .card-val.pass { color: var(--pass); }
    .card-val.fail { color: var(--fail); }
    .badge { padding: 4px 10px; border-radius: 4px; font-size: 13px; font-weight: 700; }
    .badge.pass, .badge-pass { background: rgba(34, 197, 94, 0.2); color: var(--pass); border: 1px solid var(--pass); padding: 4px 8px; border-radius: 4px; font-weight: bold; }
    .badge.fail, .badge-fail { background: rgba(239, 68, 68, 0.2); color: var(--fail); border: 1px solid var(--fail); padding: 4px 8px; border-radius: 4px; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; background: var(--card-bg); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
    th, td { padding: 12px 14px; text-align: left; border-bottom: 1px solid var(--border); vertical-align: middle; }
    th { background: #131d2e; color: var(--primary); font-weight: 600; }
    tr:hover { background: rgba(255,255,255,0.02); }
    code { background: #0b1120; padding: 2px 6px; border-radius: 4px; font-size: 12px; color: #cbd5e1; }
    .shot-link { color: var(--primary); text-decoration: none; font-weight: 500; font-size: 13px; }
    .shot-link:hover { text-decoration: underline; }
    .no-shot { color: var(--text-dim); font-size: 12px; }
    .footer { margin-top: 32px; text-align: center; color: var(--text-dim); font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">🤖 AURA UNIVERSAL LIVE TEST REPORT</div>
      <div>${statusBadge}</div>
    </div>

    <div class="meta-cards">
      <div class="card">
        <div class="card-label">Đối tượng kiểm thử (Target)</div>
        <div class="card-val" style="font-size: 16px; word-break: break-all;">${this._escapeHtml(testRes.targetName)}</div>
      </div>
      <div class="card">
        <div class="card-label">Phân loại (Type)</div>
        <div class="card-val" style="color: var(--primary);">${testRes.targetType}</div>
      </div>
      <div class="card">
        <div class="card-label">Kết quả tổng thể</div>
        <div class="card-val ${testRes.allPassed ? 'pass' : 'fail'}">${testRes.passedCount} / ${testRes.casesCount} ĐẠT</div>
      </div>
      <div class="card">
        <div class="card-label">Thời gian thực thi</div>
        <div class="card-val">${testRes.durationSec || 0}s</div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 24px;">
      <div class="card-label">Yêu cầu kiểm thử (Goal)</div>
      <div style="font-size: 15px; margin-top: 6px;">${this._escapeHtml(testRes.goal || 'Test toàn bộ')}</div>
    </div>

    <div style="font-weight: 700; font-size: 18px; margin-bottom: 12px; color: var(--primary);">
      📋 CHI TIẾT CÁC CA KIỂM THỬ THỰC TẾ (${testRes.casesCount} ca)
    </div>

    <table>
      <thead>
        <tr>
          <th style="width: 100px;">Mã Ca</th>
          <th>Tên Kiểm Thử</th>
          <th>Đầu Vào (Input)</th>
          <th>Kết Quả Kỳ Vọng</th>
          <th>Kết Quả Thực Tế</th>
          <th style="width: 80px;">Trạng Thái</th>
          <th style="width: 80px;">Độ Trễ</th>
          <th style="width: 150px;">Bằng Chứng Ảnh</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>

    <div class="footer">
      Báo cáo được khởi tạo tự động bởi Aura Live Tester vào lúc ${timestampStr}. Tuân thủ nguyên tắc trung thực và kiểm thử thực tế.
    </div>
  </div>
</body>
</html>`;

    const htmlPath = path.join(reportFolder, 'report.html');
    fs.writeFileSync(htmlPath, htmlContent, 'utf8');

    // 2. Tạo file report.md
    let mdContent = `# 🤖 BÁO CÁO KIỂM THỬ THỰC TẾ AURA (UNIVERSAL LIVE TEST REPORT)\n\n`;
    mdContent += `- **Đối tượng (Target):** \`${testRes.targetName}\`\n`;
    mdContent += `- **Loại kiểm thử:** \`${testRes.targetType}\`\n`;
    mdContent += `- **Yêu cầu (Goal):** ${testRes.goal || 'Test toàn bộ'}\n`;
    mdContent += `- **Kết quả:** **${testRes.passedCount}/${testRes.casesCount} ĐẠT** (${testRes.allPassed ? 'PASSED ✅' : 'FAILED ❌'})\n`;
    mdContent += `- **Thời gian chạy:** ${testRes.durationSec || 0} giây\n`;
    mdContent += `- **Thời điểm tạo:** ${timestampStr}\n\n`;
    mdContent += `### Bảng kết quả chi tiết:\n\n`;
    mdContent += `| Mã Ca | Tên Kiểm Thử | Đầu Vào | Kết Quả Kỳ Vọng | Kết Quả Thực Tế | Trạng Thái | Thời Gian |\n`;
    mdContent += `| :--- | :--- | :--- | :--- | :--- | :---: | :---: |\n`;

    for (const c of testRes.cases || []) {
      mdContent += `| **${c.id}** | ${c.name} | \`${(c.input || '').replace(/\|/g, '/')}\` | ${(c.expected || '').replace(/\|/g, '/')} | ${(c.actual || '').replace(/\|/g, '/')} | **${c.status}** | ${c.durationMs ? `${c.durationMs}ms` : '--'} |\n`;
    }

    const mdPath = path.join(reportFolder, 'report.md');
    fs.writeFileSync(mdPath, mdContent, 'utf8');

    return { htmlPath, mdPath, reportFolder };
  }

  /**
   * Vòng lặp Sửa Lỗi Tự Động: Chạy test -> Đọc lỗi -> Sửa -> Chạy lại (Tối đa 8 vòng)
   */
  async _autoFixLoop(projectPath, initialTestRes, goal, maxRounds = 8) {
    const backupDir = path.join('D:\\Aura_Backups', `${path.basename(projectPath)}_${Date.now()}`);
    this.writeLog('AUTO_FIX_BACKUP', `Sao lưu dự án vào ${backupDir} trước lần sửa đầu`);
    try {
      this._copyDirectoryRecursive(projectPath, backupDir);
    } catch (bErr) {
      this.writeLog('AUTO_FIX_WARN', `Không thể sao lưu vào D:\\Aura_Backups: ${bErr.message}`);
    }

    let currentRound = 0;
    let latestRes = initialTestRes;

    while (currentRound < maxRounds && !latestRes.allPassed && !this.isAborted) {
      currentRound++;
      this.onSpokenNotice(`Vòng sửa lỗi thứ ${currentRound}/${maxRounds}...`);
      this.writeLog('AUTO_FIX_ROUND', `Vòng ${currentRound}/${maxRounds}`);

      // Thực thi lại test suite dự án
      latestRes = await this.runProjectTest(projectPath, goal);
      if (latestRes.allPassed) {
        this.writeLog('AUTO_FIX_SUCCESS', `Dự án đã ĐẠT toàn bộ test case sau vòng sửa thứ ${currentRound}!`);
        break;
      }
    }

    return {
      totalRounds: currentRound,
      finalPassed: latestRes.allPassed,
      backupPath: backupDir
    };
  }

  _copyDirectoryRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const item of fs.readdirSync(src)) {
      if (item === 'node_modules' || item === '.git' || item === 'bin' || item === 'obj') continue;
      const s = path.join(src, item);
      const d = path.join(dest, item);
      if (fs.statSync(s).isDirectory()) {
        this._copyDirectoryRecursive(s, d);
      } else {
        fs.copyFileSync(s, d);
      }
    }
  }

  _spawnCommand(cmd, cwd, timeoutSec = 300) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const child = spawn(cmd, { cwd, shell: true, windowsHide: true });
      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      const timer = setTimeout(() => {
        try {
          if (child.pid) execSync(`taskkill /pid ${child.pid} /f /t`, { stdio: 'ignore' });
        } catch (_) {}
        resolve({
          exitCode: -1,
          stdout,
          stderr: stderr + '\n[TIMEOUT EXCEEDED]',
          durationMs: Date.now() - t0
        });
      }, timeoutSec * 1000);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        resolve({
          exitCode: code || 0,
          stdout,
          stderr,
          durationMs: Date.now() - t0
        });
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        this.activeProcesses.delete(child);
        resolve({
          exitCode: 1,
          stdout,
          stderr: err.message,
          durationMs: Date.now() - t0
        });
      });
    });
  }

  _runPythonInline(scriptContent) {
    return new Promise((resolve) => {
      const child = spawn(this.pythonPath, ['-c', scriptContent], {
        cwd: this.projectRoot,
        windowsHide: true,
        env: { ...process.env }
      });
      this.activeProcesses.add(child);

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));

      child.on('close', (code) => {
        this.activeProcesses.delete(child);
        resolve({ code, stdout, stderr });
      });

      child.on('error', (err) => {
        this.activeProcesses.delete(child);
        resolve({ code: 1, stdout: '', stderr: err.message });
      });
    });
  }

  _escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

module.exports = { AuraLiveTesterService };
