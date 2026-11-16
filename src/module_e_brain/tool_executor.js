/**
 * ============================================================================
 * MODULE E: TRÌNH THỰC THI CÔNG CỤ (TOOL EXECUTOR & SAFETY CONTROLLER)
 * - Chạy trong Electron Main Process (Node.js) với toàn quyền hệ thống được kiểm soát
 * - Kiểm tra Whitelist từ allowed_apps.json & allowed_folders.json
 * - Chống injection: không cho ký tự điều khiển shell, chặn path traversal (../)
 * - Ghi audit log chi tiết mọi thao tác (thời gian, tên tool, tham số, kết quả, xác nhận)
 * ============================================================================
 */
let electronShell = null;
let electronClipboard = null;
try {
  const el = require('electron');
  if (el && typeof el === 'object') {
    electronShell = el.shell;
    electronClipboard = el.clipboard;
  }
} catch (_) {}
const { spawn, execFile, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const os = require('os');
const { AuraLiveTesterService } = require('./live_tester_service');

class AuraToolExecutor {
  constructor(projectRoot, writeLogFn, onReminderTriggerFn) {
    const root = (typeof projectRoot === 'object' && projectRoot && projectRoot.projectRoot) ? projectRoot.projectRoot : (projectRoot || process.cwd());
    this.projectRoot = path.resolve(root);
    const defaultLogFn = (type, msg) => {
      try {
        const logDir = path.join(this.projectRoot, 'logs');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const now = new Date();
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        const ts = `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}]`;
        const cleanMsg = typeof msg === 'string' ? msg.replace(/(?:key|secret|token|password)[=:]\s*["']?([^"',\s]+)/gi, '$1=***REDACTED***') : msg;
        fs.appendFileSync(path.join(logDir, 'aura_actions.log'), `${ts} [${type}] ${cleanMsg}\n`, 'utf8');
      } catch (_) {}
    };
    this.writeLog = writeLogFn || defaultLogFn;
    this.onReminderTrigger = onReminderTriggerFn || (() => {});
    this.recentToolLogs = [];
    this.activeReminders = new Map();
    this.reminderCounter = 0;
    this.computerUseService = null;
    this.isTestRunning = false;
    this.currentTestProcess = null;
    this.approvedInstallProjects = new Set();
    this.sessionBackedUpProjects = new Map();
    this.liveTesterService = new AuraLiveTesterService({
      projectRoot: this.projectRoot,
      writeLog: this.writeLog,
      onSpokenNotice: (notice) => {
        if (this.computerUseService && typeof this.computerUseService.onSpokenNotice === 'function') {
          this.computerUseService.onSpokenNotice(notice);
        }
      }
    });
    this._loadApprovedInstallProjects();
  }

  _loadApprovedInstallProjects() {
    try {
      const cachePath = path.join(this.projectRoot, 'projects_cache.json');
      if (fs.existsSync(cachePath)) {
        const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        for (const [pKey, pVal] of Object.entries(cache)) {
          if (pVal && pVal.installApproved === true) {
            this.approvedInstallProjects.add(path.resolve(pKey).toLowerCase());
          }
        }
      }
    } catch (_) {}
  }

  setComputerUseService(service) {
    this.computerUseService = service;
  }

  _recordAudit(entry) {
    const record = {
      id: `tool_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.recentToolLogs.unshift(record);
    if (this.recentToolLogs.length > 60) {
      this.recentToolLogs.pop();
    }
    const confirmedStr = record.confirmed === true ? 'YES' : record.confirmed === false ? 'REJECTED' : 'NOT_REQUIRED';
    this.writeLog(
      'TOOL_EXEC',
      `Tool=${record.tool} | Confirmed=${confirmedStr} | Success=${record.success} | Args=${JSON.stringify(record.args || {})} | Result=${JSON.stringify(record.result || {})}`
    );
    return record;
  }

  getRecentLogs(limit = 25) {
    return this.recentToolLogs.slice(0, limit);
  }

  _stripVietnameseDiacritics(str) {
    if (!str) return '';
    return String(str)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .toLowerCase();
  }

  _normalizePath(rawPath) {
    if (!rawPath || typeof rawPath !== 'string') return '';
    let clean = rawPath.trim().normalize('NFC').replace(/\//g, '\\');
    if (/^[a-zA-Z]:$/.test(clean)) {
      clean += '\\';
    }
    let resolved = path.isAbsolute(clean) ? path.resolve(clean) : path.resolve(this.projectRoot, clean);
    if (/^[a-zA-Z]:\\?$/i.test(resolved)) {
      return resolved.slice(0, 2).toUpperCase() + '\\';
    }
    if (resolved.endsWith('\\') && resolved.length > 3) {
      resolved = resolved.slice(0, -1);
    }
    return resolved;
  }

  getAllowedApps() {
    const p = path.join(this.projectRoot, 'allowed_apps.json');
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  getAllowedFolders() {
    const p = path.join(this.projectRoot, 'allowed_folders.json');
    if (!fs.existsSync(p)) return [this._normalizePath(this.projectRoot)];
    try {
      const stat = fs.statSync(p);
      if (this._allowedFoldersCache && this._allowedFoldersMtime === stat.mtimeMs) {
        return this._allowedFoldersCache;
      }
      const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
      const arr = JSON.parse(raw);
      const normalized = Array.isArray(arr)
        ? arr.map((x) => (x === '*' ? '*' : this._normalizePath(x))).filter(Boolean)
        : [this._normalizePath(this.projectRoot)];
      this._allowedFoldersCache = normalized;
      this._allowedFoldersMtime = stat.mtimeMs;
      this._allowedFoldersLoadedAt = new Date().toISOString();
      return normalized;
    } catch (err) {
      if (this.writeLog) this.writeLog('ALLOWED_FOLDERS_ERR', `Lỗi nạp allowed_folders.json: ${err.message}`);
      return [this._normalizePath(this.projectRoot)];
    }
  }

  getPreferences() {
    const p = path.join(this.projectRoot, 'preferences.json');
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  savePreferences(data) {
    const p = path.join(this.projectRoot, 'preferences.json');
    try {
      fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
      return true;
    } catch (_) {
      return false;
    }
  }

  _isPathInsideAllowed(targetPath) {
    if (!targetPath) return false;
    const allowed = this.getAllowedFolders();
    if (allowed.includes('*')) return true;
    const normTarget = this._normalizePath(targetPath).toLowerCase();
    return allowed.some((folder) => {
      if (folder === '*') return true;
      const normAllowed = this._normalizePath(folder).toLowerCase();
      if (normTarget === normAllowed) return true;
      if (normAllowed.endsWith('\\')) {
        return normTarget.startsWith(normAllowed);
      } else {
        return normTarget.startsWith(normAllowed + '\\');
      }
    });
  }

  _resolveEnvVars(str) {
    if (!str) return '';
    return str.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
  }

  _resolveSearchFolder(folder) {
    if (!folder) return this.projectRoot;
    let clean = String(folder).trim().normalize('NFC');
    const cleanLower = clean.toLowerCase();

    // 1. Bí danh dự án Aura
    const auraAliases = [
      'aura',
      'thư mục aura',
      'thu muc aura',
      'thư mục dự án',
      'dự án aura',
      'project',
      'project root',
      'dự án',
      'aura assistant',
      'thư mục aura assistant',
      '.',
      './'
    ];
    if (auraAliases.includes(cleanLower)) {
      return this.projectRoot;
    }

    // 2. Bí danh ổ D (ổ D, o d, d:, d:\, d)
    const dDriveAliases = ['ổ d', 'o d', 'ổ đ', 'o đ', 'd:', 'd:\\', 'd:/', 'd'];
    if (dDriveAliases.includes(cleanLower)) {
      return 'D:\\';
    }

    // 3. Khớp ổ đĩa tổng quát: "ổ c", "c:", "c:\", "ổ e", v.v.
    const driveMatch = clean.match(/^(?:ổ\s*)?([a-zA-Z])(?::|\\|\/)?$/i);
    if (driveMatch) {
      return driveMatch[1].toUpperCase() + ':\\';
    }

    // 3b. Nhận diện cụm từ tự nhiên: "thư mục ảnh trong ổ D", "ảnh ổ D", "thư mục ảnh ổ D"
    const folderDriveMatch1 = clean.match(/^(?:thư\s*mục|thu\s*muc|folder)?\s*(.+?)\s*(?:trong|ở|tai|tại)?\s*ổ\s*([a-zA-Z])(?::|\\|\/)?$/i);
    if (folderDriveMatch1) {
      const driveLetter = folderDriveMatch1[2].toUpperCase() + ':\\';
      let subName = folderDriveMatch1[1].trim().replace(/^(?:thư\s*mục|thu\s*muc|folder)\s+/i, '');
      const candidatePath = path.join(driveLetter, subName);
      if (fs.existsSync(candidatePath)) {
        return this._normalizePath(candidatePath);
      }
    }

    // 3c. Nhận diện cụm từ: "ổ D thư mục ảnh"
    const folderDriveMatch2 = clean.match(/^ổ\s*([a-zA-Z])(?::|\\|\/)?\s*(?:thư\s*mục|thu\s*muc|folder)?\s*(.+)$/i);
    if (folderDriveMatch2) {
      const driveLetter = folderDriveMatch2[1].toUpperCase() + ':\\';
      const subName = folderDriveMatch2[2].trim();
      const candidatePath = path.join(driveLetter, subName);
      if (fs.existsSync(candidatePath)) {
        return this._normalizePath(candidatePath);
      }
    }

    // 4. Giải nén biến môi trường (ví dụ %USERPROFILE%)
    const expanded = this._resolveEnvVars(clean);

    // 5. Nếu là đường dẫn hợp lệ hoặc tồn tại trực tiếp
    const normalized = this._normalizePath(expanded);
    if (normalized && (fs.existsSync(normalized) || /^[a-zA-Z]:\\$/i.test(normalized))) {
      return normalized;
    }

    // 6. Tìm theo tên thư mục trong danh sách allowed (chỉ so khớp khi base không rỗng)
    const allowed = this.getAllowedFolders();
    for (const f of allowed) {
      const base = path.basename(f).toLowerCase();
      if (!base) continue; // Bỏ qua ổ đĩa gốc như "D:\" vì basename là rỗng
      if (base === cleanLower || cleanLower === `thư mục ${base}` || cleanLower.includes(base)) {
        return f;
      }
    }

    return normalized || path.resolve(this.projectRoot, expanded);
  }

  // ==========================================================================
  // TOOL 1: open_app(name)
  // ==========================================================================
  async executeOpenApp(name) {
    const cleanName = String(name || '').toLowerCase().trim();
    if (!cleanName) {
      return { success: false, error: 'Tên ứng dụng không được để trống.' };
    }

    const apps = this.getAllowedApps();
    let matchedKey = null;
    let matchedConfig = null;

    for (const [key, cfg] of Object.entries(apps)) {
      if (key.toLowerCase() === cleanName) {
        matchedKey = key;
        matchedConfig = cfg;
        break;
      }
      const aliases = cfg.aliases || [];
      if (aliases.some((a) => String(a).toLowerCase() === cleanName || cleanName.includes(String(a).toLowerCase()))) {
        matchedKey = key;
        matchedConfig = cfg;
        break;
      }
    }

    if (!matchedConfig) {
      const allowedList = Object.keys(apps).join(', ');
      return {
        success: false,
        error: `Ứng dụng "${name}" không nằm trong danh sách cho phép (allowed_apps.json). Các ứng dụng đang hỗ trợ: ${allowedList}. Bạn có thể thêm vào file allowed_apps.json.`
      };
    }

    let targetExe = null;
    const searchPaths = matchedConfig.searchPaths || [];

    for (const sp of searchPaths) {
      const expanded = this._resolveEnvVars(sp);
      if (fs.existsSync(expanded)) {
        targetExe = expanded;
        break;
      }
    }

    // Nếu là Chrome, kiểm tra kỹ các đường dẫn phổ biến
    if (!targetExe && (matchedKey === 'chrome' || cleanName.includes('chrome'))) {
      const commonChrome = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe')
      ];
      for (const cp of commonChrome) {
        if (fs.existsSync(cp)) {
          targetExe = cp;
          break;
        }
      }
      if (!targetExe) {
        return {
          success: false,
          error: 'Không tìm thấy Google Chrome tại các đường dẫn cài đặt thông thường trên Windows (C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe,...).'
        };
      }
    }

    // Nếu chưa thấy file cụ thể nhưng có executable ngắn (như notepad.exe, calc.exe, explorer.exe)
    if (!targetExe && matchedConfig.executable) {
      targetExe = matchedConfig.executable;
    }

    if (!targetExe) {
      return {
        success: false,
        error: `Không tìm thấy file thực thi của ứng dụng ${matchedConfig.name} trên máy tính.`
      };
    }

    try {
      const proc = spawn(targetExe, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false
      });
      proc.unref();

      return {
        success: true,
        app: matchedConfig.name,
        path: targetExe,
        message: `Đã mở ứng dụng ${matchedConfig.name} thành công.`
      };
    } catch (err) {
      return {
        success: false,
        error: `Lỗi khi khởi chạy ${matchedConfig.name}: ${err.message}`
      };
    }
  }

  // ==========================================================================
  // TOOL 2: close_app(name) (LUÔN hỏi xác nhận trước)
  // ==========================================================================
  async executeCloseApp(name) {
    const cleanName = String(name || '').toLowerCase().trim();
    const apps = this.getAllowedApps();
    let matchedConfig = null;

    for (const [key, cfg] of Object.entries(apps)) {
      if (key.toLowerCase() === cleanName) {
        matchedConfig = cfg;
        break;
      }
      const aliases = cfg.aliases || [];
      if (aliases.some((a) => String(a).toLowerCase() === cleanName || cleanName.includes(String(a).toLowerCase()))) {
        matchedConfig = cfg;
        break;
      }
    }

    if (!matchedConfig) {
      return {
        success: false,
        error: `Ứng dụng "${name}" không nằm trong danh sách cho phép đóng (allowed_apps.json).`
      };
    }

    const killTargets = matchedConfig.killNames || [matchedConfig.processName];
    let closedCount = 0;

    for (const kn of killTargets) {
      try {
        execSync(`taskkill /IM "${kn}" /F`, { stdio: 'ignore', timeout: 4000 });
        closedCount++;
      } catch (_) {
        // Có thể process không đang chạy
      }
    }

    if (closedCount > 0) {
      return {
        success: true,
        app: matchedConfig.name,
        message: `Đã đóng ứng dụng ${matchedConfig.name} thành công.`
      };
    } else {
      return {
        success: true,
        app: matchedConfig.name,
        message: `Đã kiểm tra và gửi yêu cầu đóng ${matchedConfig.name}. Ứng dụng hiện không có tiến trình nào đang chạy.`
      };
    }
  }

  // ==========================================================================
  // TOOL 3: open_url(url)
  // ==========================================================================
  async executeOpenUrl(rawUrl) {
    let urlStr = String(rawUrl || '').trim();
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
      urlStr = 'https://' + urlStr;
    }

    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, error: 'Chỉ chấp nhận liên kết web bắt đầu bằng http:// hoặc https://' };
      }
      if (electronShell && typeof electronShell.openExternal === 'function') {
        await electronShell.openExternal(urlStr);
      } else {
        execFile('cmd.exe', ['/c', 'start', '""', urlStr]);
      }
      return {
        success: true,
        url: urlStr,
        domain: parsed.hostname,
        message: `Đã mở trang web ${parsed.hostname} trên trình duyệt.`
      };
    } catch (err) {
      return { success: false, error: `Địa chỉ URL không hợp lệ: ${err.message}` };
    }
  }

  // ==========================================================================
  // TOOL 4: open_youtube_search(query)
  // ==========================================================================
  async executeYoutubeSearch(query) {
    const q = String(query || '').trim();
    if (!q) {
      return { success: false, error: 'Từ khoá tìm kiếm không được để trống.' };
    }
    const targetUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
    try {
      if (this.computerUseService && typeof this.computerUseService.ensureYoutubeSearchOpen === 'function') {
        await this.computerUseService.ensureYoutubeSearchOpen(q);
      } else if (electronShell && typeof electronShell.openExternal === 'function') {
        await electronShell.openExternal(targetUrl);
      } else {
        execFile('cmd.exe', ['/c', 'start', '""', targetUrl]);
      }
      return {
        success: true,
        query: q,
        url: targetUrl,
        message: `Đã mở tìm kiếm YouTube cho từ khoá: "${q}".`
      };
    } catch (err) {
      return { success: false, error: `Không thể mở YouTube: ${err.message}` };
    }
  }

  // ==========================================================================
  // HELPER: _fetchYoutubeVideoInfo(query)
  // Ưu tiên YouTube Data API v3 (nếu có key trong .env: YOUTUBE_API_KEY)
  // Nếu không có key -> Lấy videoId đầu tiên từ ytInitialData, bỏ qua Ads, Shorts, Live, Playlist
  // ==========================================================================
  async _fetchYoutubeVideoInfo(query) {
    const q = String(query || '').trim();
    if (!q) return null;

    // 1. Ưu tiên YouTube Data API v3 nếu có YOUTUBE_API_KEY
    const apiKey = (process.env.YOUTUBE_API_KEY || '').trim();
    if (apiKey) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&type=video&q=${encodeURIComponent(q)}&key=${apiKey}`;
        const data = await new Promise((resolve, reject) => {
          https.get(apiUrl, { timeout: 8000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch (e) {
                reject(e);
              }
            });
          }).on('error', reject);
        });

        if (data && Array.isArray(data.items) && data.items.length > 0) {
          const item = data.items[0];
          if (item && item.id && item.id.videoId) {
            return {
              videoId: item.id.videoId,
              title: item.snippet?.title || q,
              source: 'youtube_data_api_v3'
            };
          }
        }
      } catch (err) {
        this.writeLog('YT_API_WARN', `Gọi YouTube Data API v3 thất bại: ${err.message}. Chuyển sang tìm kiếm web trực tiếp.`);
      }
    }

    // 2. Không có key hoặc API lỗi: Cào dữ liệu từ trang tìm kiếm YouTube (ytInitialData)
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
      };

      const html = await new Promise((resolve, reject) => {
        const req = https.get(searchUrl, { headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy(new Error('Timeout kết nối tìm kiếm YouTube'));
        });
      });

      const match = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
      if (match) {
        const json = JSON.parse(match[1]);
        const contents = json?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents;
        if (Array.isArray(contents)) {
          for (const c of contents) {
            const items = c?.itemSectionRenderer?.contents;
            if (!Array.isArray(items)) continue;
            for (const item of items) {
              const vr = item.videoRenderer;
              if (!vr || !vr.videoId) continue;

              // Bỏ qua livestream (có badge hoặc thumbnailOverlay kiểu LIVE)
              const badges = (vr.badges || []).map(b => b?.metadataBadgeRenderer?.label || '').join(' ').toLowerCase();
              const overlays = JSON.stringify(vr.thumbnailOverlays || {}).toLowerCase();
              const isLive = badges.includes('live') || badges.includes('trực tiếp') || overlays.includes('style_live');
              if (isLive) continue;

              // Bỏ qua shorts nếu có đánh dấu hoặc link shorts
              const navEndpoint = JSON.stringify(vr.navigationEndpoint || {}).toLowerCase();
              if (navEndpoint.includes('/shorts/')) continue;

              const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || q;
              const lengthText = vr.lengthText?.simpleText || vr.lengthText?.runs?.map(r => r.text).join('') || '';

              return {
                videoId: vr.videoId,
                title,
                lengthText,
                source: 'youtube_web_search'
              };
            }
          }
        }
      }
    } catch (err) {
      this.writeLog('YT_SCRAPE_WARN', `Cào kết quả tìm kiếm YouTube thất bại: ${err.message}`);
    }

    return null;
  }

  // ==========================================================================
  // TOOL 4b: open_youtube_video(query)
  // Tìm video phù hợp nhất rồi mở thẳng https://www.youtube.com/watch?v=<id>
  // Không dùng chụp màn hình hay bấm chuột
  // ==========================================================================
  async executeYoutubeVideo(query) {
    const q = String(query || '').trim();
    if (!q) {
      return { success: false, error: 'Tên video hoặc từ khoá không được để trống.' };
    }

    this.writeLog('YT_VIDEO_LOOKUP', `Đang tìm video YouTube phù hợp nhất cho: "${q}"`);
    const t0 = Date.now();
    const info = await this._fetchYoutubeVideoInfo(q);
    const lookupDuration = Date.now() - t0;

    if (info && info.videoId) {
      const targetUrl = `https://www.youtube.com/watch?v=${info.videoId}`;
      this.writeLog('YT_VIDEO_FOUND', `Tìm thấy video sau ${lookupDuration}ms [${info.source}]: "${info.title}" (${targetUrl})`);

      try {
        let browserOpened = false;
        if (this.computerUseService && typeof this.computerUseService.ensureBrowserUrlOpen === 'function') {
          browserOpened = await this.computerUseService.ensureBrowserUrlOpen(targetUrl);
        }
        if (!browserOpened) {
          if (electronShell && typeof electronShell.openExternal === 'function') {
            await electronShell.openExternal(targetUrl);
            browserOpened = true;
          } else {
            execFile('cmd.exe', ['/c', 'start', '""', targetUrl]);
            browserOpened = true;
          }
        }

        return {
          success: true,
          opened: true,
          videoId: info.videoId,
          title: info.title,
          url: targetUrl,
          lookupDurationMs: lookupDuration,
          source: info.source,
          message: `Đã mở video "${info.title}" trên YouTube.`
        };
      } catch (err) {
        this.writeLog('YT_VIDEO_OPEN_ERR', `Lỗi mở URL trình duyệt: ${err.message}`);
        return { success: false, error: `Không thể mở trình duyệt: ${err.message}` };
      }
    } else {
      // Nếu không tìm được video cụ thể, quay về mở trang tìm kiếm và báo thật
      this.writeLog('YT_VIDEO_FALLBACK', `Không tìm thấy video trực tiếp sau ${lookupDuration}ms, chuyển về mở trang tìm kiếm cho "${q}".`);
      const searchRes = await this.executeYoutubeSearch(q);
      return {
        success: true,
        fallbackSearch: true,
        query: q,
        url: searchRes.url,
        message: `Không tìm được video cụ thể cho "${q}", em đã mở trang kết quả tìm kiếm YouTube.`
      };
    }
  }

  // ==========================================================================
  // TOOL 4c: open_live_stream(topic)
  // Mở ĐÚNG buổi livestream đang phát trực tiếp của giải đấu/đội tuyển từ live_channels.json
  // Xác minh có nhãn LIVE thật sự, nếu không có thì hỏi mở bản phát lại
  // ==========================================================================
  _loadLiveChannelsConfig() {
    const filePath = path.join(this.projectRoot, 'live_channels.json');
    if (!fs.existsSync(filePath)) {
      this.writeLog('LIVE_CONFIG_WARN', `Không tìm thấy file ${filePath}`);
      return [];
    }
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content);
      return Array.isArray(parsed?.channels) ? parsed.channels : [];
    } catch (err) {
      this.writeLog('LIVE_CONFIG_ERR', `Lỗi đọc live_channels.json: ${err.message}`);
      return [];
    }
  }

  _removeDiacritics(str) {
    return (str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D');
  }

  _matchLiveChannels(topic, channels) {
    const raw = String(topic || '').trim().toLowerCase();
    const rawNoAccent = this._removeDiacritics(raw);
    const channelsWithAddress = (channels || []).filter(c => c.channelId || c.channelUrl);

    const isEnglishRequested = raw.includes('tiếng anh') || raw.includes('english') || raw.includes('global') || raw.includes('eng');
    const isGeneralLol = raw.includes('liên minh huyền thoại') || raw.includes('lmht') || raw.includes('lol') || raw.includes('league of legends');

    const matched = [];

    for (const ch of channelsWithAddress) {
      let score = 0;
      const tourLower = (ch.tournament || '').toLowerCase();

      // Khớp theo tên giải
      if (raw.includes(tourLower) || rawNoAccent.includes(this._removeDiacritics(tourLower))) {
        score += 40;
      }

      // Khớp theo từ khóa
      for (const kw of (ch.keywords || [])) {
        const kwLower = kw.toLowerCase();
        const kwNoAccent = this._removeDiacritics(kwLower);

        if (raw === kwLower || rawNoAccent === kwNoAccent) {
          score += 50;
          break;
        } else if (raw.includes(kwLower) || rawNoAccent.includes(kwNoAccent)) {
          score += 25;
        }
      }

      // Nếu yêu cầu chung chung về LMHT
      if (isGeneralLol && score === 0) {
        score += 15;
      }

      if (score > 0) {
        let langScore = 0;
        if (isEnglishRequested) {
          if (ch.language === 'en') langScore = 20;
        } else {
          if (ch.language === 'vi') langScore = 20;
        }

        matched.push({
          channel: ch,
          score: score + langScore + (ch.priority || 0)
        });
      }
    }

    matched.sort((a, b) => b.score - a.score);
    return matched.map(m => m.channel);
  }

  async _checkChannelLive(channel) {
    const apiKey = (process.env.YOUTUBE_API_KEY || '').trim();

    // 1. Ưu tiên YouTube Data API v3 nếu có key và channelId
    if (apiKey && channel.channelId) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channel.channelId)}&eventType=live&type=video&key=${apiKey}`;
        const data = await new Promise((resolve, reject) => {
          https.get(apiUrl, { timeout: 8000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        if (data && Array.isArray(data.items) && data.items.length > 0) {
          const item = data.items[0];
          if (item?.id?.videoId) {
            return {
              isLive: true,
              videoId: item.id.videoId,
              title: item.snippet?.title || `${channel.name} Trực tiếp`,
              url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
              source: 'youtube_data_api_v3'
            };
          }
        }
      } catch (err) {
        this.writeLog('LIVE_API_WARN', `Gọi YouTube Data API v3 cho kênh ${channel.name} thất bại: ${err.message}. Kiểm tra trực tiếp qua trang /live.`);
      }
    }

    // 2. Không có key hoặc API không có live: Kiểm tra trang /live của kênh
    try {
      const liveUrl = channel.channelUrl ? `${channel.channelUrl}/live` : `https://www.youtube.com/channel/${channel.channelId}/live`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
      };

      const html = await new Promise((resolve, reject) => {
        const req = https.get(liveUrl, { headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Timeout kết nối trang /live')));
      });

      const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
      const canonical = canonicalMatch ? canonicalMatch[1] : '';
      const isWatchUrl = canonical.includes('youtube.com/watch?v=');

      // Các dấu hiệu phát trực tiếp thật sự
      const hasLiveBadge = html.includes('"style":"LIVE"') || html.includes('"label":"LIVE"') || html.includes('"text":"LIVE"') || html.includes(' đang xem') || html.includes(' watching');
      const isLiveStream = html.includes('"isLive":true') || html.includes('"isLiveStream":true');
      const isUpcoming = html.includes('"upcomingEventData"') || html.includes('"isUpcoming":true');

      const isLiveNow = (isWatchUrl && (hasLiveBadge || isLiveStream)) && !isUpcoming;

      if (isLiveNow) {
        const vIdMatch = canonical.match(/watch\?v=([a-zA-Z0-9_-]{11})/) || html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        const videoId = vIdMatch ? vIdMatch[1] : null;
        const metaTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
        const title = metaTitleMatch ? metaTitleMatch[1].replace(' - YouTube', '').trim() : `${channel.name} Trực tiếp`;

        if (videoId) {
          return {
            isLive: true,
            videoId,
            title,
            url: `https://www.youtube.com/watch?v=${videoId}`,
            source: 'channel_live_endpoint'
          };
        }
      }
    } catch (err) {
      this.writeLog('LIVE_SCRAPE_WARN', `Kiểm tra trang /live của kênh ${channel.name} thất bại: ${err.message}`);
    }

    return { isLive: false };
  }

  async _getLatestChannelReplay(channel) {
    const apiKey = (process.env.YOUTUBE_API_KEY || '').trim();

    // 1. Ưu tiên YouTube Data API v3 nếu có key
    if (apiKey && channel.channelId) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${encodeURIComponent(channel.channelId)}&order=date&type=video&maxResults=1&key=${apiKey}`;
        const data = await new Promise((resolve, reject) => {
          https.get(apiUrl, { timeout: 8000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
              try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
          }).on('error', reject);
        });

        if (data && Array.isArray(data.items) && data.items.length > 0) {
          const item = data.items[0];
          if (item?.id?.videoId) {
            return {
              videoId: item.id.videoId,
              title: item.snippet?.title || '',
              url: `https://www.youtube.com/watch?v=${item.id.videoId}`
            };
          }
        }
      } catch (_) {}
    }

    // 2. Cào từ trang /videos của kênh
    try {
      const videosUrl = channel.channelUrl ? `${channel.channelUrl}/videos` : `https://www.youtube.com/channel/${channel.channelId}/videos`;
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
      };

      const html = await new Promise((resolve, reject) => {
        const req = https.get(videosUrl, { headers, timeout: 10000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve(data));
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Timeout kết nối /videos')));
      });

      const m = html.match(/var ytInitialData = ({.*?});<\/script>/s) || html.match(/ytInitialData\s*=\s*({.+?});/);
      if (m) {
        const data = JSON.parse(m[1]);
        const tab = (data?.contents?.twoColumnBrowseResultsRenderer?.tabs || []).find(t => t.tabRenderer?.selected);
        const contents = tab?.tabRenderer?.content?.richGridRenderer?.contents || [];

        for (const item of contents) {
          const lockup = item.richItemRenderer?.content?.lockupViewModel;
          if (lockup) {
            const title = lockup.metadata?.lockupMetadataViewModel?.title?.content || '';
            const jsonStr = JSON.stringify(lockup);
            const vIdMatch = jsonStr.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
            if (vIdMatch) {
              return {
                videoId: vIdMatch[1],
                title,
                url: `https://www.youtube.com/watch?v=${vIdMatch[1]}`
              };
            }
          }

          const vr = item.richItemRenderer?.content?.videoRenderer;
          if (vr && vr.videoId) {
            const title = vr.title?.runs?.map(r => r.text).join('') || vr.title?.simpleText || '';
            return {
              videoId: vr.videoId,
              title,
              url: `https://www.youtube.com/watch?v=${vr.videoId}`
            };
          }
        }
      }
    } catch (_) {}

    return null;
  }

  async executeLiveStream(topic) {
    const rawTopic = String(topic || '').trim();
    if (!rawTopic) {
      return { success: false, error: 'Chủ đề hoặc tên giải đấu không được để trống.' };
    }

    this.writeLog('LIVE_STREAM_LOOKUP', `Đang tìm buổi livestream trực tiếp chính thức cho: "${rawTopic}"`);
    const t0 = Date.now();

    const channels = this._loadLiveChannelsConfig();
    const candidates = this._matchLiveChannels(rawTopic, channels);

    if (candidates.length === 0) {
      this.writeLog('LIVE_STREAM_NO_CHANNEL', `Không khớp được kênh chính thức nào cho "${rawTopic}".`);
      return {
        success: true,
        isLive: false,
        topic: rawTopic,
        message: `Hiện tại em chưa có cấu hình kênh chính thức cho "${rawTopic}" trong live_channels.json. Anh có thể thêm channelId vào file cấu hình theo hướng dẫn ạ.`
      };
    }

    this.writeLog('LIVE_STREAM_CANDIDATES', `Khớp được ${candidates.length} kênh ứng viên: ${candidates.map(c => `${c.name} (${c.language})`).join(', ')}`);

    // Kiểm tra trạng thái LIVE lần lượt theo độ ưu tiên
    const liveResults = [];
    for (const ch of candidates) {
      this.writeLog('LIVE_STREAM_PROBE', `Đang kiểm tra trạng thái LIVE trên kênh: ${ch.name}...`);
      const status = await this._checkChannelLive(ch);
      if (status.isLive) {
        liveResults.push({ channel: ch, info: status });
      }
    }

    const elapsed = Date.now() - t0;

    // 1. NẾU CÓ KÊNH ĐANG PHÁT TRỰC TIẾP
    if (liveResults.length > 0) {
      // Ưu tiên kênh tiếng Việt trước rồi tới tiếng Anh (hoặc theo độ ưu tiên của bộ match)
      const selected = liveResults[0];
      const targetUrl = selected.info.url;

      this.writeLog('LIVE_STREAM_FOUND', `Tìm thấy livestream [${selected.info.source}] sau ${elapsed}ms: "${selected.info.title}" trên kênh "${selected.channel.name}" (${targetUrl})`);

      try {
        let browserOpened = false;
        if (this.computerUseService && typeof this.computerUseService.ensureBrowserUrlOpen === 'function') {
          browserOpened = await this.computerUseService.ensureBrowserUrlOpen(targetUrl);
        }
        if (!browserOpened) {
          if (electronShell && typeof electronShell.openExternal === 'function') {
            await electronShell.openExternal(targetUrl);
            browserOpened = true;
          } else {
            execFile('cmd.exe', ['/c', 'start', '""', targetUrl]);
            browserOpened = true;
          }
        }

        this.writeLog('LIVE_STREAM_VERIFIED', `Xác minh thành công: "${selected.info.title}" trên kênh "${selected.channel.name}" đang phát trực tiếp (LIVE).`);

        let noteMsg = `Dạ, em đang mở trực tiếp "${selected.info.title}" trên kênh chính thức ${selected.channel.name} cho anh ạ.`;
        if (liveResults.length > 1) {
          const others = liveResults.slice(1).map(r => r.channel.name).join(', ');
          noteMsg += ` Kênh ${others} cũng đang phát nếu anh muốn chuyển.`;
        }

        return {
          success: true,
          isLive: true,
          channelName: selected.channel.name,
          tournament: selected.channel.tournament,
          videoId: selected.info.videoId,
          title: selected.info.title,
          url: targetUrl,
          source: selected.info.source,
          totalLiveFound: liveResults.length,
          lookupDurationMs: elapsed,
          message: noteMsg
        };
      } catch (err) {
        this.writeLog('LIVE_STREAM_OPEN_ERR', `Lỗi mở URL livestream: ${err.message}`);
        return { success: false, error: `Không thể mở trình duyệt: ${err.message}` };
      }
    }

    // 2. NẾU KHÔNG CÓ KÊNH NÀO ĐANG PHÁT TRỰC TIẾP
    const topChannel = candidates[0];
    this.writeLog('LIVE_STREAM_NOT_LIVE', `Không có buổi livestream nào đang phát cho "${rawTopic}" sau ${elapsed}ms. Đang tìm bản phát lại mới nhất của "${topChannel.name}"...`);

    const latestReplay = await this._getLatestChannelReplay(topChannel);
    this.writeLog('LIVE_STREAM_REPLAY_FOUND', `Bản phát lại mới nhất của ${topChannel.name}: "${latestReplay?.title || 'Không rõ'}"`);

    const replayTitle = latestReplay?.title ? `"${latestReplay.title}"` : 'các video gần nhất';
    const message = `Dạ, hiện tại giải ${topChannel.tournament || rawTopic} không có buổi livestream nào đang phát trực tiếp. Bản phát lại mới nhất trên kênh chính thức ${topChannel.name} là ${replayTitle}. Anh có muốn em mở bản phát lại này không ạ?`;

    return {
      success: true,
      isLive: false,
      topic: rawTopic,
      channelName: topChannel.name,
      tournament: topChannel.tournament,
      matchedChannels: candidates.map(c => c.name),
      latestReplay: latestReplay,
      lookupDurationMs: elapsed,
      message
    };
  }

  // ==========================================================================
  // TOOL 4c: list_directory(path)
  // Liệt kê chi tiết file và thư mục con trong một thư mục được cấp phép
  // Không nuốt lỗi, báo rõ mã lỗi: OUTSIDE_ALLOWED_FOLDERS, NOT_FOUND, PERMISSION_DENIED, EMPTY_DIRECTORY
  // ==========================================================================
  async executeListDirectory(dirPath) {
    const rawPath = String(dirPath || '').trim();
    if (!rawPath) {
      return {
        success: false,
        errorCode: 'INVALID_PATH',
        message: 'Đường dẫn thư mục không được để trống.',
        path: '',
        totalCount: 0,
        items: []
      };
    }

    const resolved = this._resolveSearchFolder(rawPath);
    const normalized = this._normalizePath(resolved);

    // 1. Kiểm tra quyền truy cập (allowed_folders.json)
    if (!this._isPathInsideAllowed(normalized)) {
      return {
        success: false,
        errorCode: 'OUTSIDE_ALLOWED_FOLDERS',
        message: `Thư mục "${normalized}" nằm ngoài danh sách được cấp phép (allowed_folders.json).`,
        path: normalized,
        totalCount: 0,
        items: []
      };
    }

    // 2. Kiểm tra tồn tại trên đĩa
    if (!fs.existsSync(normalized)) {
      return {
        success: false,
        errorCode: 'NOT_FOUND',
        message: `Thư mục không tồn tại: "${normalized}".`,
        path: normalized,
        totalCount: 0,
        items: []
      };
    }

    // 3. Kiểm tra xem có phải là thư mục không
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isDirectory()) {
        return {
          success: false,
          errorCode: 'NOT_A_DIRECTORY',
          message: `Đường dẫn "${normalized}" là một tệp tin, không phải là thư mục.`,
          path: normalized,
          totalCount: 0,
          items: []
        };
      }
    } catch (err) {
      const code = err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : 'STAT_ERROR';
      return {
        success: false,
        errorCode: code,
        message: `Không thể đọc thông tin thư mục: ${err.message}`,
        path: normalized,
        totalCount: 0,
        items: []
      };
    }

    // 4. Đọc danh sách các mục
    try {
      const dirents = fs.readdirSync(normalized, { withFileTypes: true });

      const items = [];
      for (const d of dirents) {
        const itemPath = path.join(normalized, d.name);
        let size = 0;
        const isDir = d.isDirectory();
        if (!isDir) {
          try {
            size = fs.statSync(itemPath).size;
          } catch (_) {}
        }
        items.push({
          name: d.name,
          isDirectory: isDir,
          sizeBytes: size,
          extension: isDir ? '' : path.extname(d.name).toLowerCase()
        });
      }

      // Sắp xếp: Thư mục lên trước, sau đó tới file (theo thứ tự alphabet)
      items.sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name, 'vi', { sensitivity: 'base' });
      });

      if (items.length === 0) {
        return {
          success: true,
          errorCode: 'EMPTY_DIRECTORY',
          message: `Thư mục "${normalized}" hiện tại đang rỗng (không chứa file hoặc thư mục con nào).`,
          path: normalized,
          totalCount: 0,
          items: []
        };
      }

      const filesCount = items.filter((x) => !x.isDirectory).length;
      const dirsCount = items.filter((x) => x.isDirectory).length;

      return {
        success: true,
        errorCode: null,
        message: `Đã đọc thành công thư mục "${normalized}": gồm ${dirsCount} thư mục và ${filesCount} file.`,
        path: normalized,
        totalCount: items.length,
        directoriesCount: dirsCount,
        filesCount: filesCount,
        items: items
      };
    } catch (err) {
      const code = err.code === 'EACCES' || err.code === 'EPERM' ? 'PERMISSION_DENIED' : err.code || 'READ_ERROR';
      return {
        success: false,
        errorCode: code,
        message: `Lỗi đọc thư mục "${normalized}": ${err.message}`,
        path: normalized,
        totalCount: 0,
        items: []
      };
    }
  }

  // ==========================================================================
  // TOOL 4d: open_folder(path)
  // Mở File Explorer tại đúng thư mục bằng spawn("explorer.exe", [path])
  // Truyền path là tham số riêng, không ghép chuỗi shell để bảo vệ dấu cách và tiếng Việt
  // Kiểm tra fs.existsSync(path) và là thư mục trước khi mở
  // Chỉ cho mở thư mục nằm trong allowed_folders.json, ngoài danh sách thì hỏi xác nhận
  // ==========================================================================
  async executeOpenFolder(dirPath, confirmed = null) {
    const rawPath = String(dirPath || '').trim();
    if (!rawPath) {
      return {
        success: false,
        errorCode: 'EMPTY_PATH',
        error: 'Đường dẫn thư mục không được để trống.',
        path: ''
      };
    }

    const resolved = this._resolveSearchFolder(rawPath);
    const normalized = this._normalizePath(resolved);

    // 1. Kiểm tra quyền truy cập whitelist (allowed_folders.json)
    const isAllowed = this._isPathInsideAllowed(normalized);
    if (!isAllowed && confirmed !== true) {
      return {
        success: false,
        requiresConfirmation: true,
        errorCode: 'OUTSIDE_ALLOWED_FOLDERS',
        error: `Thư mục "${normalized}" nằm ngoài danh sách được cấp phép (allowed_folders.json). Cần bạn xác nhận trước khi mở.`,
        path: normalized
      };
    }

    // 2. Kiểm tra tồn tại trên đĩa
    if (!fs.existsSync(normalized)) {
      return {
        success: false,
        errorCode: 'NOT_FOUND',
        error: `Thư mục không tồn tại: "${normalized}".`,
        path: normalized
      };
    }

    // 3. Kiểm tra phải là thư mục (không phải là file)
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isDirectory()) {
        return {
          success: false,
          errorCode: 'NOT_A_DIRECTORY',
          error: `Đường dẫn "${normalized}" là file chứ không phải thư mục. Vui lòng dùng open_file.`,
          path: normalized
        };
      }
    } catch (statErr) {
      return {
        success: false,
        errorCode: 'STAT_ERROR',
        error: `Không thể đọc thông tin thư mục: ${statErr.message}`,
        path: normalized
      };
    }

    // 4. Mở File Explorer bằng spawn('explorer.exe', [normalized])
    // Truyền normalized là một tham số riêng trong mảng args, KHÔNG ghép chuỗi lệnh shell
    try {
      const child = spawn('explorer.exe', [normalized], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();

      if (this.writeLog) {
        this.writeLog('FOLDER_OPENED', `Đã mở File Explorer tại thư mục: "${normalized}" (PID=${child.pid})`);
      }

      return {
        success: true,
        errorCode: null,
        path: normalized,
        pid: child.pid,
        message: `Đã mở File Explorer tại thư mục: ${normalized}`
      };
    } catch (spawnErr) {
      if (this.writeLog) {
        this.writeLog('FOLDER_OPEN_ERR', `Lỗi khi mở File Explorer tại "${normalized}": ${spawnErr.message}`);
      }
      return {
        success: false,
        errorCode: 'SPAWN_ERROR',
        error: `Không thể khởi chạy File Explorer: ${spawnErr.message}`,
        path: normalized
      };
    }
  }

  // ==========================================================================
  // TOOL 4e: open_file(path)
  // Mở file cụ thể trong thư mục cho phép bằng ứng dụng mặc định của Windows
  // ==========================================================================
  async executeOpenFile(filePath, confirmed = null) {
    const rawPath = String(filePath || '').trim();
    if (!rawPath) {
      return {
        success: false,
        errorCode: 'EMPTY_PATH',
        error: 'Đường dẫn file không được để trống.',
        path: ''
      };
    }

    const resolved = this._resolveSearchFolder(rawPath);
    const normalized = this._normalizePath(resolved);

    // 1. Kiểm tra quyền truy cập whitelist (allowed_folders.json)
    const isAllowed = this._isPathInsideAllowed(normalized);
    if (!isAllowed && confirmed !== true) {
      return {
        success: false,
        requiresConfirmation: true,
        errorCode: 'OUTSIDE_ALLOWED_FOLDERS',
        error: `File "${normalized}" nằm ngoài danh sách thư mục được cấp phép (allowed_folders.json). Cần bạn xác nhận trước khi mở.`,
        path: normalized
      };
    }

    // 2. Kiểm tra tồn tại trên đĩa
    if (!fs.existsSync(normalized)) {
      return {
        success: false,
        errorCode: 'NOT_FOUND',
        error: `File không tồn tại: "${normalized}".`,
        path: normalized
      };
    }

    // 3. Kiểm tra phải là file (không phải là thư mục)
    try {
      const stat = fs.statSync(normalized);
      if (stat.isDirectory()) {
        return {
          success: false,
          errorCode: 'IS_A_DIRECTORY',
          error: `Đường dẫn "${normalized}" là thư mục chứ không phải file. Vui lòng dùng open_folder.`,
          path: normalized
        };
      }
    } catch (statErr) {
      return {
        success: false,
        errorCode: 'STAT_ERROR',
        error: `Không thể đọc thông tin file: ${statErr.message}`,
        path: normalized
      };
    }

    // 4. Mở file bằng ứng dụng mặc định
    try {
      if (electronShell && typeof electronShell.openPath === 'function') {
        const errMsg = await electronShell.openPath(normalized);
        if (errMsg) {
          throw new Error(errMsg);
        }
      } else {
        const child = spawn('explorer.exe', [normalized], {
          detached: true,
          stdio: 'ignore'
        });
        child.unref();
      }

      if (this.writeLog) {
        this.writeLog('FILE_OPENED', `Đã mở file bằng ứng dụng mặc định: "${normalized}"`);
      }

      return {
        success: true,
        errorCode: null,
        path: normalized,
        message: `Đã mở file thành công: ${normalized}`
      };
    } catch (err) {
      if (this.writeLog) {
        this.writeLog('FILE_OPEN_ERR', `Lỗi khi mở file "${normalized}": ${err.message}`);
      }
      return {
        success: false,
        errorCode: 'OPEN_ERROR',
        error: `Không thể mở file: ${err.message}`,
        path: normalized
      };
    }
  }

  // ==========================================================================
  // TOOL 5: file_search(query, folder, type)
  // Tìm kiếm file hoặc thư mục đệ quy tối thiểu 5 cấp
  // Không phân biệt hoa thường, so khớp không dấu tiếng Việt
  // Bỏ qua $RECYCLE.BIN, System Volume Information, node_modules
  // ==========================================================================
  async executeFileSearch(query, folder, type = 'any') {
    const rawQuery = String(query || '').trim();
    const cleanType = String(type || 'any').toLowerCase().trim(); // 'file' | 'folder' | 'any'

    // Nếu query rỗng hoặc '*' hoặc 'all' thì hiểu là tìm tất cả
    const isMatchAll = !rawQuery || rawQuery === '*' || rawQuery.toLowerCase() === 'all';
    const qLower = rawQuery.toLowerCase();
    const qStripped = this._stripVietnameseDiacritics(rawQuery);

    let searchRoots = [];
    let searchFolderDisplay = '';

    if (!folder || folder === 'all' || folder === 'allowed') {
      const allowed = this.getAllowedFolders().filter((f) => f !== '*' && fs.existsSync(f));
      const rootsOnly = allowed.filter(f => /^[a-zA-Z]:\\?$/i.test(f));
      searchRoots = rootsOnly.length > 0 ? rootsOnly : (allowed.length > 0 ? allowed : [this.projectRoot]);
      searchFolderDisplay = searchRoots.join(', ');
    } else {
      const searchFolder = this._resolveSearchFolder(folder);
      const normalizedFolder = this._normalizePath(searchFolder);

      if (!this._isPathInsideAllowed(normalizedFolder)) {
        return {
          success: false,
          errorCode: 'OUTSIDE_ALLOWED_FOLDERS',
          message: `Thư mục "${normalizedFolder}" nằm ngoài danh sách được cấp phép (allowed_folders.json).`,
          query: rawQuery,
          searchFolder: normalizedFolder,
          count: 0,
          files: []
        };
      }

      if (!fs.existsSync(normalizedFolder)) {
        return {
          success: false,
          errorCode: 'NOT_FOUND',
          message: `Thư mục tìm kiếm không tồn tại: "${normalizedFolder}".`,
          query: rawQuery,
          searchFolder: normalizedFolder,
          count: 0,
          files: []
        };
      }

      searchRoots = [normalizedFolder];
      searchFolderDisplay = normalizedFolder;
    }

    const results = [];
    const maxResults = 50;
    const maxScanned = 15000;
    let scanned = 0;
    const maxDepth = 5; // Tối thiểu 5 cấp đệ quy

    const ignoredDirs = new Set([
      '$recycle.bin',
      'system volume information',
      'node_modules',
      '.git',
      '.vs',
      '.idea',
      '__macosx',
      'steamlibrary',
      'riot games',
      'windows',
      'wuthering waves',
      'program files',
      'program files (x86)',
      'programdata',
      'appdata',
      'mssql10_50.sqlexpress'
    ]);

    // Sử dụng Breadth-First Search (BFS) để tìm theo từng tầng (tầng 0, tầng 1, tầng 2...)
    // Đảm bảo tìm thấy các thư mục/file ở các cấp trên trước, không bị kẹt sâu trong các thư mục lớn
    const queue = searchRoots.map((dir) => ({ dir, depth: 0 }));
    const visitedPaths = new Set();

    while (queue.length > 0 && results.length < maxResults && scanned < maxScanned) {
      const current = queue.shift();
      const normCur = this._normalizePath(current.dir).toLowerCase();
      if (visitedPaths.has(normCur)) continue;
      visitedPaths.add(normCur);

      if (current.depth > maxDepth) continue;

      let entries = [];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch (_) {
        continue;
      }

      for (const entry of entries) {
        scanned++;
        if (scanned >= maxScanned) break;
        const entryNameLower = entry.name.toLowerCase();

        // Bỏ qua các thư mục hệ thống / rác
        if (entry.isDirectory() && ignoredDirs.has(entryNameLower)) continue;

        const isDir = entry.isDirectory();
        const fullPath = path.join(current.dir, entry.name);

        // Kiểm tra loại (type filter: 'file' | 'folder' | 'any')
        let typeMatches = true;
        if (cleanType === 'file' && isDir) typeMatches = false;
        if (cleanType === 'folder' && !isDir) typeMatches = false;

        // So khớp tên: wildcard, khớp thường hoặc khớp không dấu
        let nameMatches = false;
        if (isMatchAll) {
          nameMatches = true;
        } else {
          const nameStripped = this._stripVietnameseDiacritics(entry.name);
          nameMatches = entryNameLower.includes(qLower) || nameStripped.includes(qStripped);
        }

        if (typeMatches && nameMatches) {
          let size = 0;
          if (!isDir) {
            try { size = fs.statSync(fullPath).size; } catch (_) {}
          }
          results.push({
            name: entry.name,
            path: fullPath,
            isDirectory: isDir,
            sizeBytes: size
          });
          if (results.length >= maxResults) break;
        }

        // Đưa thư mục con vào hàng đợi cho các tầng tiếp theo
        if (isDir && current.depth < maxDepth && !ignoredDirs.has(entryNameLower)) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
      }
    }

    if (results.length === 0) {
      return {
        success: true,
        errorCode: 'EMPTY_DIRECTORY',
        query: rawQuery,
        searchFolder: searchFolderDisplay,
        count: 0,
        files: [],
        message: isMatchAll
          ? `Thư mục "${searchFolderDisplay}" không chứa mục nào phù hợp.`
          : `Không tìm thấy file hay thư mục nào khớp với "${rawQuery}" trong "${searchFolderDisplay}".`
      };
    }

    return {
      success: true,
      errorCode: null,
      query: rawQuery,
      searchFolder: searchFolderDisplay,
      count: results.length,
      files: results,
      message: `Đã tìm thấy ${results.length} mục phù hợp với "${rawQuery || '*'}" trong "${searchFolderDisplay}".`
    };
  }

  // ==========================================================================
  // TOOL 6: read_file(filePath)
  // ==========================================================================
  async executeReadFile(filePath) {
    const p = String(filePath || '').trim();
    if (!p) {
      return { success: false, error: 'Đường dẫn file không được để trống.' };
    }

    // Chặn đường dẫn cố tình thoát ra ngoài (..)
    const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.projectRoot, p);

    // Chặn cứng đọc file .env và khoá bí mật
    if (path.basename(resolved).toLowerCase() === '.env' || resolved.toLowerCase().endsWith('.env')) {
      return { success: false, error: 'Chặn cứng: Không được phép đọc nội dung file .env và các khóa bí mật.' };
    }

    // Kiểm tra nằm trong allowed_folders HOẶC nằm trong dự án đã quét
    let isAllowed = this._isPathInsideAllowed(resolved);
    if (!isAllowed) {
      try {
        const cachePath = path.join(this.projectRoot, 'projects_cache.json');
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const rLower = resolved.toLowerCase();
          for (const projKey of Object.keys(cache)) {
            if (rLower.startsWith(path.resolve(projKey).toLowerCase())) {
              isAllowed = true;
              break;
            }
          }
        }
      } catch (_) {}
    }

    if (!isAllowed) {
      return {
        success: false,
        error: `Đường dẫn "${resolved}" nằm ngoài các thư mục được cấp phép (allowed_folders.json) và ngoài dự án.`
      };
    }

    if (!fs.existsSync(resolved)) {
      return { success: false, error: `File không tồn tại: ${resolved}` };
    }

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return { success: false, error: `Đường dẫn không phải là file: ${resolved}` };
    }

    const MAX_BYTES = 200 * 1024; // 200KB
    if (stat.size > MAX_BYTES) {
      return {
        success: false,
        error: `File dung lượng ${Math.round(stat.size / 1024)}KB vượt quá giới hạn cho phép đọc (200KB).`
      };
    }

    try {
      const content = fs.readFileSync(resolved, 'utf8');
      return {
        success: true,
        path: resolved,
        sizeBytes: stat.size,
        content: content.substring(0, 15000), // An toàn cho LLM context
        message: `Đã đọc file ${path.basename(resolved)} (${stat.size} bytes).`
      };
    } catch (err) {
      return { success: false, error: `Lỗi đọc file: ${err.message}` };
    }
  }

  // ==========================================================================
  // TOOL 7: clipboard_read()
  // ==========================================================================
  async executeClipboardRead() {
    try {
      let text = '';
      if (electronClipboard && typeof electronClipboard.readText === 'function') {
        text = electronClipboard.readText();
      } else if (this.computerUseService && typeof this.computerUseService.getClipboardText === 'function') {
        const res = await this.computerUseService.getClipboardText();
        text = (res && res.text) || '';
      } else {
        text = execSync('powershell.exe -NoProfile -Command "Get-Clipboard"', { encoding: 'utf8', timeout: 4000 }).trim();
      }
      return {
        success: true,
        length: text.length,
        text: text ? text.substring(0, 2000) : '',
        message: text ? `Đã đọc ${text.length} ký tự từ clipboard.` : 'Bộ nhớ đệm (clipboard) hiện đang trống.'
      };
    } catch (err) {
      return { success: false, error: `Không thể đọc clipboard: ${err.message}` };
    }
  }

  // ==========================================================================
  // TOOL 8: clipboard_write(text)
  // ==========================================================================
  async executeClipboardWrite(text) {
    const s = String(text || '');
    try {
      if (electronClipboard && typeof electronClipboard.writeText === 'function') {
        electronClipboard.writeText(s);
      } else {
        const escaped = s.replace(/"/g, '`"');
        execSync(`powershell.exe -NoProfile -Command "Set-Clipboard -Value \\"${escaped}\\""`, { stdio: 'ignore', timeout: 4000 });
      }
      return {
        success: true,
        length: s.length,
        preview: s.substring(0, 80),
        message: `Đã sao chép nội dung vào bộ nhớ đệm (clipboard) thành công.`
      };
    } catch (err) {
      return { success: false, error: `Không thể ghi vào clipboard: ${err.message}` };
    }
  }

  // ==========================================================================
  // TOOL 9: set_reminder(minutes, message)
  // ==========================================================================
  async executeSetReminder(minutes, message) {
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) {
      return { success: false, error: 'Số phút hẹn giờ phải là số dương lớn hơn 0.' };
    }
    const msg = String(message || 'Đến giờ rồi!').trim();
    const id = `rem_${Date.now()}_${++this.reminderCounter}`;
    const delayMs = Math.round(mins * 60 * 1000);
    const triggerAt = new Date(Date.now() + delayMs).toLocaleTimeString('vi-VN');

    const timer = setTimeout(() => {
      this.activeReminders.delete(id);
      this.writeLog('REMINDER_TRIGGER', `ID=${id} | Message="${msg}"`);
      this.onReminderTrigger({ id, minutes: mins, message: msg, triggerAt });
    }, delayMs);

    this.activeReminders.set(id, { id, timer, minutes: mins, message: msg, triggerAt });

    return {
      success: true,
      reminderId: id,
      minutes: mins,
      message: msg,
      triggerAt,
      systemMessage: `Đã đặt lời nhắc: "${msg}" sau ${mins} phút (lúc ${triggerAt}).`
    };
  }

  // ==========================================================================
  // TOOL 10: get_preferences() & save_preference(key, value)
  // ==========================================================================
  async executeGetPreferences() {
    const prefs = this.getPreferences();
    return {
      success: true,
      preferences: prefs,
      message: 'Đã đọc danh sách sở thích người dùng từ preferences.json.'
    };
  }

  async executeSavePreference(key, value) {
    const k = String(key || '').trim();
    const v = String(value || '').trim();
    if (!k) {
      return { success: false, error: 'Tên thuộc tính sở thích không được để trống.' };
    }

    const prefs = this.getPreferences();
    prefs[k] = v;
    const ok = this.savePreferences(prefs);

    if (ok) {
      return {
        success: true,
        key: k,
        value: v,
        preferences: prefs,
        message: `Đã lưu sở thích "${k}" = "${v}" vào preferences.json.`
      };
    } else {
      return { success: false, error: 'Không thể ghi vào file preferences.json.' };
    }
  }

  // ==========================================================================
  // TOOL 11: KIỂM THỬ AN TOÀN ĐỒ ÁN SWT301 (list_test_topics, run_test, get_latest_test_report)
  // ==========================================================================

  /**
   * Dừng khẩn cấp tiến trình test đang chạy (gọi khi bấm Ctrl+Alt+Esc)
   */
  killCurrentTestProcess(reason = 'emergency_stop') {
    if (this.liveTesterService) {
      this.liveTesterService.killAll(reason);
    }
    if (this.currentTestProcess && this.currentTestProcess.pid) {
      const pid = this.currentTestProcess.pid;
      this.writeLog('TEST_EMERGENCY_KILL', `Stopping test process PID ${pid} (reason=${reason})`);
      try {
        execSync(`taskkill /pid ${pid} /T /F 2>nul`);
      } catch (_) {
        try {
          this.currentTestProcess.kill('SIGKILL');
        } catch (__) {}
      }
      this.isTestRunning = false;
      this.currentTestProcess = null;
      return true;
    }
    return false;
  }

  /**
   * Liệt kê các bài test / topic SWT301 được định nghĩa trong test_topics.json
   */
  async executeListTestTopics() {
    const configPath = path.join(this.projectRoot, 'test_topics.json');
    if (!fs.existsSync(configPath)) {
      return {
        success: false,
        error: 'Chưa tìm thấy file cấu hình test_topics.json trong thư mục gốc dự án.'
      };
    }
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      const topics = JSON.parse(content);
      const summaryList = topics.map((t) => ({
        id: t.id,
        name: t.name,
        cwd: t.cwd,
        command: `${t.command} ${(t.args || []).join(' ')}`,
        timeoutSec: t.timeoutSec || 30,
        description: t.description,
        keywords: t.keywords
      }));
      return {
        success: true,
        totalTopics: summaryList.length,
        topics: summaryList,
        message: `Đã tải thành công ${summaryList.length} bài test môn SWT301 từ cấu hình.`
      };
    } catch (err) {
      return {
        success: false,
        error: `Lỗi đọc file cấu hình test_topics.json: ${err.message}`
      };
    }
  }

  /**
   * Chạy bài test SWT301 với cơ chế an toàn tuyệt đối:
   * 1. Bắt buộc có xác nhận (confirmed === true)
   * 2. Khoá tuần tự (không chạy song song)
   * 3. Kiểm tra RAM (< 90%)
   * 4. Lệnh và tham số cố định từ test_topics.json (spawn với mảng args, không dùng shell string)
   * 5. Timeout tự huỷ và ghi log báo cáo vào reports/
   */
  async executeRunTest(topicQuery, confirmed = null) {
    if (confirmed !== true) {
      return {
        success: false,
        needsConfirmation: true,
        error: 'Thao tác chạy bài test bị từ chối do chưa có sự đồng ý của người dùng.'
      };
    }

    if (this.isTestRunning) {
      return {
        success: false,
        error: 'Đang có một tiến trình kiểm thử khác đang chạy. Hệ thống chỉ cho phép chạy tuần tự để đảm bảo tài nguyên.'
      };
    }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedRatio = (totalMem - freeMem) / totalMem;
    const usedPercent = (usedRatio * 100).toFixed(1);
    if (usedRatio >= 0.90) {
      return {
        success: false,
        error: `Hệ thống từ chối chạy bài test do mức sử dụng RAM quá cao: ${usedPercent}% (ngưỡng an toàn tối đa: 90%).`
      };
    }

    const configPath = path.join(this.projectRoot, 'test_topics.json');
    if (!fs.existsSync(configPath)) {
      return {
        success: false,
        error: 'Chưa tìm thấy file cấu hình test_topics.json.'
      };
    }

    let topics = [];
    try {
      topics = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {
      return {
        success: false,
        error: `Không thể đọc test_topics.json: ${e.message}`
      };
    }

    const q = String(topicQuery || '').toLowerCase().trim();
    let target = topics.find((t) => t.id && t.id.toLowerCase() === q);
    if (!target) {
      target = topics.find((t) => (t.name && t.name.toLowerCase().includes(q)) || (t.id && t.id.toLowerCase().includes(q)));
    }
    if (!target) {
      target = topics.find((t) => Array.isArray(t.keywords) && t.keywords.some((k) => {
        const kl = k.toLowerCase();
        return q.includes(kl) || kl.includes(q);
      }));
    }

    if (!target) {
      return {
        success: false,
        error: `Không tìm thấy topic test phù hợp với "${topicQuery}". Vui lòng dùng lệnh list_test_topics để kiểm tra danh sách bài test có sẵn.`
      };
    }

    const cmdLower = (target.command || '').toLowerCase();
    const argsJoined = (target.args || []).join(' ').toLowerCase();
    if (argsJoined.includes('install') && !cmdLower.includes('dotnet')) {
      return {
        success: false,
        error: 'Lệnh chứa tham số cài đặt gói thư viện (install) chưa được cấp phép phê duyệt riêng.'
      };
    }

    if (!fs.existsSync(target.cwd)) {
      return {
        success: false,
        error: `Thư mục làm việc của topic không tồn tại trên máy: ${target.cwd}`
      };
    }

    this.isTestRunning = true;
    const t0 = Date.now();
    let stdoutData = '';
    let stderrData = '';
    let timedOut = false;
    let proc = null;

    try {
      const timeoutMs = (target.timeoutSec || 60) * 1000;

      const res = await new Promise((resolve) => {
        let timer = null;
        try {
          proc = spawn(target.command, target.args || [], {
            cwd: target.cwd,
            windowsHide: true,
            env: { ...process.env, NODE_ENV: 'test', CI: 'true' }
          });
          this.currentTestProcess = proc;
        } catch (spawnErr) {
          this.isTestRunning = false;
          this.currentTestProcess = null;
          return resolve({
            exitCode: -1,
            spawnError: spawnErr.message
          });
        }

        timer = setTimeout(() => {
          timedOut = true;
          this.writeLog('TEST_TIMEOUT', `Test "${target.id}" vượt quá thời gian cho phép ${target.timeoutSec}s -> Force kill.`);
          if (proc && proc.pid) {
            try {
              execSync(`taskkill /pid ${proc.pid} /T /F 2>nul`);
            } catch (_) {
              try {
                proc.kill('SIGKILL');
              } catch (__) {}
            }
          }
        }, timeoutMs);

        proc.stdout.on('data', (d) => {
          stdoutData += d.toString('utf8');
        });

        proc.stderr.on('data', (d) => {
          stderrData += d.toString('utf8');
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          this.isTestRunning = false;
          this.currentTestProcess = null;
          resolve({ exitCode: code });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          this.isTestRunning = false;
          this.currentTestProcess = null;
          resolve({ exitCode: -1, spawnError: err.message });
        });
      });

      const durationMs = Date.now() - t0;
      if (res.spawnError) {
        return {
          success: false,
          topicId: target.id,
          topicName: target.name,
          error: `Không thể khởi chạy lệnh: ${res.spawnError}`
        };
      }

      if (timedOut) {
        return {
          success: false,
          topicId: target.id,
          topicName: target.name,
          durationMs,
          error: `Bài test bị dừng do vượt quá thời gian tối đa ${target.timeoutSec} giây.`
        };
      }

      const parsed = this._parseTestResult(target.id, stdoutData, stderrData, res.exitCode);

      const reportsDir = path.join(this.projectRoot, 'reports');
      if (!fs.existsSync(reportsDir)) {
        try {
          fs.mkdirSync(reportsDir, { recursive: true });
        } catch (_) {}
      }

      const reportFileName = `report_${target.id}_${Date.now()}.json`;
      const reportFilePath = path.join(reportsDir, reportFileName);

      const reportData = {
        topicId: target.id,
        topicName: target.name,
        timestamp: new Date().toISOString(),
        success: parsed.success,
        exitCode: res.exitCode,
        durationMs,
        passed: parsed.passed,
        failed: parsed.failed,
        total: parsed.total,
        failingTests: parsed.failingTests,
        command: `${target.command} ${(target.args || []).join(' ')}`,
        cwd: target.cwd,
        ramUsage: {
          totalMb: Math.round(totalMem / (1024 * 1024)),
          freeMb: Math.round(freeMem / (1024 * 1024)),
          usedPercent: `${usedPercent}%`
        },
        stdoutSnippet: stdoutData.slice(-3000),
        stderrSnippet: stderrData.slice(-1000)
      };

      try {
        fs.writeFileSync(reportFilePath, JSON.stringify(reportData, null, 2), 'utf8');
      } catch (writeErr) {
        this.writeLog('REPORT_WRITE_ERROR', `Không thể lưu file báo cáo: ${writeErr.message}`);
      }

      return {
        success: parsed.success,
        topicId: target.id,
        topicName: target.name,
        exitCode: res.exitCode,
        passed: parsed.passed,
        failed: parsed.failed,
        total: parsed.total,
        failingTests: parsed.failingTests,
        durationMs,
        usedRamPercent: `${usedPercent}%`,
        reportFile: reportFileName,
        message: parsed.success
          ? `Bài test "${target.name}" đã CHẠY THÀNH CÔNG: ${parsed.passed}/${parsed.total} test case ĐẠT trong ${durationMs}ms.`
          : `Bài test "${target.name}" THẤT BẠI: Có ${parsed.failed} test case LỖI (Thất bại: ${parsed.failingTests.join(', ') || 'Xem log'}).`
      };
    } finally {
      this.isTestRunning = false;
      this.currentTestProcess = null;
    }
  }

  _parseTestResult(topicId, stdout, stderr, exitCode) {
    let passed = 0;
    let failed = 0;
    let total = 0;
    const failingTests = [];

    const fullOutput = stdout + '\n' + stderr;

    // Trường hợp 1: .NET NUnit (lab3)
    const dotnetMatch = fullOutput.match(/(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i);
    if (dotnetMatch) {
      failed = parseInt(dotnetMatch[1], 10);
      passed = parseInt(dotnetMatch[2], 10);
      total = parseInt(dotnetMatch[4], 10);
      if (failed > 0) {
        const failLines = fullOutput.split('\n').filter((l) => l.includes('Failed') && l.includes('[') && l.includes(']'));
        for (const fl of failLines) {
          failingTests.push(fl.trim());
        }
      }
      return {
        success: exitCode === 0 && failed === 0,
        passed,
        failed,
        total,
        failingTests
      };
    }

    // Trường hợp 2: All topics runner (scripts/run_all_tests.js)
    const allTopicsMatch = fullOutput.match(/Thành công:\s*(\d+)\s*\/\s*(\d+)[\s\S]*?Thất bại:\s*(\d+)\s*\/\s*(\d+)/i);
    if (allTopicsMatch) {
      passed = parseInt(allTopicsMatch[1], 10);
      total = parseInt(allTopicsMatch[2], 10);
      failed = parseInt(allTopicsMatch[3], 10);
      return {
        success: exitCode === 0 && failed === 0,
        passed,
        failed,
        total,
        failingTests
      };
    }

    // Trường hợp 3: Tổng kết chuẩn Node.js test cases
    const summaryMatch = fullOutput.match(/TỔNG KẾT:\s*(\d+)\s*ĐẠT,\s*(\d+)\s*LỖI/i);
    if (summaryMatch) {
      passed = parseInt(summaryMatch[1], 10);
      failed = parseInt(summaryMatch[2], 10);
      total = passed + failed;
    } else {
      const ratioMatch = fullOutput.match(/Đạt\s+(\d+)\/(\d+)/i);
      if (ratioMatch) {
        passed = parseInt(ratioMatch[1], 10);
        total = parseInt(ratioMatch[2], 10);
        failed = Math.max(0, total - passed);
      }
    }

    // Trích xuất các test case lỗi nếu có
    const failMatches = [...fullOutput.matchAll(/\[(?:FAIL|LỖI)[^\]]*\]\s*([^:\r\n]+)/gi)];
    for (const m of failMatches) {
      if (m[1] && !failingTests.includes(m[1].trim())) {
        failingTests.push(m[1].trim());
      }
    }
    const starMatches = [...fullOutput.matchAll(/\*\s*(TC_[^\s:\r\n]+)/gi)];
    for (const sm of starMatches) {
      if (sm[1] && !failingTests.includes(sm[1].trim())) {
        failingTests.push(sm[1].trim());
      }
    }

    if (exitCode !== 0 && failed === 0) {
      failed = failingTests.length || 1;
      if (total < failed) total = failed;
    }

    if (exitCode === 0 && total === 0) {
      if (fullOutput.includes('THÀNH CÔNG') || fullOutput.includes('HOÀN TẤT') || fullOutput.includes('✓')) {
        passed = 1;
        total = 1;
      }
    }

    const success = (exitCode === 0 && failed === 0);
    return {
      success,
      passed,
      failed,
      total,
      failingTests
    };
  }

  /**
   * Đọc lại file báo cáo kiểm thử gần nhất từ thư mục reports/
   */
  async executeGetLatestTestReport(topicQuery) {
    const reportsDir = path.join(this.projectRoot, 'reports');
    if (!fs.existsSync(reportsDir)) {
      return {
        success: false,
        error: 'Thư mục reports/ chưa có báo cáo kiểm thử nào.'
      };
    }

    try {
      const files = fs.readdirSync(reportsDir).filter((f) => f.startsWith('report_') && f.endsWith('.json'));
      if (files.length === 0) {
        return {
          success: false,
          error: 'Chưa có file báo cáo kiểm thử (.json) nào trong thư mục reports/.'
        };
      }

      const stats = files.map((f) => {
        const full = path.join(reportsDir, f);
        return {
          file: f,
          full,
          mtime: fs.statSync(full).mtimeMs
        };
      }).sort((a, b) => b.mtime - a.mtime);

      let targetFile = stats[0];
      if (topicQuery) {
        const q = String(topicQuery).toLowerCase().trim();
        const matched = stats.find((s) => s.file.toLowerCase().includes(q));
        if (matched) {
          targetFile = matched;
        }
      }

      const content = JSON.parse(fs.readFileSync(targetFile.full, 'utf8'));
      return {
        success: true,
        reportFile: targetFile.file,
        report: content,
        message: `Đã đọc thành công báo cáo kiểm thử gần nhất: ${targetFile.file}`
      };
    } catch (err) {
      return {
        success: false,
        error: `Lỗi đọc báo cáo kiểm thử: ${err.message}`
      };
    }
  }

  // ==========================================================================
  // TOOL 12: TÌM & HIỂU DỰ ÁN (BƯỚC A: find_project, scan_project)
  // ==========================================================================

  /**
   * BƯỚC A.1: Tìm kiếm thư mục dự án theo tên hoặc đường dẫn
   * Bỏ qua thư mục hệ thống: Windows, Program Files, node_modules, $RECYCLE.BIN...
   */
  async executeFindProject(query) {
    const rawQuery = String(query || '').trim();
    if (!rawQuery) {
      return { success: false, error: 'Tên hoặc đường dẫn dự án không được để trống.' };
    }

    const t0 = Date.now();
    // 1. Kiểm tra nếu query là một đường dẫn trực tiếp đã tồn tại
    try {
      const resolved = path.resolve(rawQuery);
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isDirectory()) {
          const directMatch = {
            name: path.basename(resolved),
            path: resolved,
            isDirectPath: true
          };
          this.writeLog('PROJECT_FIND', `Direct path matched: ${resolved}`);
          return {
            success: true,
            count: 1,
            projectPath: resolved,
            matches: [directMatch],
            durationMs: Date.now() - t0,
            message: `Đã xác định thư mục dự án: ${resolved}`
          };
        }
      }
    } catch (_) {}

    // 2. Tìm kiếm dự án theo tên trên các phân vùng đĩa & thư mục làm việc chính
    const qLower = rawQuery.toLowerCase();
    const qStripped = this._stripVietnameseDiacritics(rawQuery);

    const IGNORED_FOLDERS = new Set([
      '$recycle.bin',
      'system volume information',
      'windows',
      'program files',
      'program files (x86)',
      'programdata',
      'appdata',
      'node_modules',
      '.git',
      '.vs',
      '.idea',
      '.vscode',
      'recovery',
      'perflogs',
      'msocache',
      'temp',
      'tmp'
    ]);

    const searchRoots = [];
    if (fs.existsSync('D:\\')) searchRoots.push('D:\\');
    const userProfile = process.env.USERPROFILE || 'C:\\Users\\ADMIN';
    if (fs.existsSync(userProfile)) {
      searchRoots.push(path.join(userProfile, 'Projects'));
      searchRoots.push(path.join(userProfile, 'source'));
      searchRoots.push(path.join(userProfile, 'Desktop'));
      searchRoots.push(path.join(userProfile, 'Documents'));
      searchRoots.push(path.join(userProfile, '.gemini'));
    }

    const PROJECT_MARKERS = [
      'package.json',
      'pom.xml',
      'requirements.txt',
      'Cargo.toml',
      'go.mod',
      'build.gradle',
      'CMakeLists.txt',
      'playwright.config.js',
      'playwright.config.ts',
      'scripts',
      'sample_code'
    ];

    const matches = [];
    const visited = new Set();

    const scanDir = (dir, depth = 0, maxDepth = 3) => {
      if (depth > maxDepth) return;
      if (visited.has(dir.toLowerCase())) return;
      visited.add(dir.toLowerCase());

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }

      const dirBase = path.basename(dir).toLowerCase();
      const dirBaseStripped = this._stripVietnameseDiacritics(path.basename(dir));

      const isNameMatch =
        dirBase === qLower ||
        dirBase.includes(qLower) ||
        qLower.includes(dirBase) ||
        dirBaseStripped.includes(qStripped) ||
        qStripped.includes(dirBaseStripped);

      const hasMarker = entries.some(
        (e) => PROJECT_MARKERS.includes(e.name) || e.name.endsWith('.sln') || e.name.endsWith('.csproj')
      );

      if (isNameMatch) {
        matches.push({
          name: path.basename(dir),
          path: dir,
          hasMarker,
          depth
        });
        if (hasMarker && depth > 0) return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const entryName = entry.name.toLowerCase();
        if (IGNORED_FOLDERS.has(entryName) || entryName.startsWith('.')) continue;

        const subPath = path.join(dir, entry.name);
        scanDir(subPath, depth + 1, maxDepth);
      }
    };

    for (const root of searchRoots) {
      if (fs.existsSync(root)) {
        scanDir(root, 0, 3);
      }
    }

    matches.sort((a, b) => {
      const aExact = a.name.toLowerCase() === qLower ? 1 : 0;
      const bExact = b.name.toLowerCase() === qLower ? 1 : 0;
      if (aExact !== bExact) return bExact - aExact;
      if (a.hasMarker !== b.hasMarker) return (b.hasMarker ? 1 : 0) - (a.hasMarker ? 1 : 0);
      return a.depth - b.depth;
    });

    const uniqueMatches = [];
    const seenPaths = new Set();
    for (const m of matches) {
      const norm = path.resolve(m.path).toLowerCase();
      if (!seenPaths.has(norm)) {
        seenPaths.add(norm);
        uniqueMatches.push({ name: m.name, path: path.resolve(m.path), hasMarker: m.hasMarker });
      }
    }

    const durationMs = Date.now() - t0;
    this.writeLog('PROJECT_FIND', `Query="${rawQuery}" -> Found ${uniqueMatches.length} matches in ${durationMs}ms`);

    if (uniqueMatches.length === 1) {
      return {
        success: true,
        count: 1,
        projectPath: uniqueMatches[0].path,
        matches: uniqueMatches,
        durationMs,
        message: `Đã tìm thấy dự án: ${uniqueMatches[0].path}`
      };
    } else if (uniqueMatches.length > 1) {
      return {
        success: true,
        count: uniqueMatches.length,
        projectPath: uniqueMatches[0].path,
        matches: uniqueMatches,
        durationMs,
        message: `Tìm thấy ${uniqueMatches.length} thư mục dự án phù hợp với "${rawQuery}". Dự án khớp nhất: ${uniqueMatches[0].path}`
      };
    } else {
      return {
        success: false,
        count: 0,
        matches: [],
        durationMs,
        message: `Không tìm thấy thư mục dự án nào khớp với từ khóa "${rawQuery}".`
      };
    }
  }

  /**
   * BƯỚC A.2: Nhận diện loại dự án và tự đoán lệnh test/build/run
   * Phân tích package.json, pom.xml, requirements.txt, .csproj, scripts...
   * Tự động lưu cache vào projects_cache.json
   */
  async executeScanProject(rawPath) {
    const t0 = Date.now();
    if (!rawPath) {
      return { success: false, error: 'Đường dẫn dự án không được để trống.' };
    }

    const projectPath = path.resolve(rawPath);
    if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
      return { success: false, error: `Thư mục dự án không tồn tại: ${projectPath}` };
    }

    let entries = [];
    try {
      entries = fs.readdirSync(projectPath, { withFileTypes: true });
    } catch (err) {
      return { success: false, error: `Không thể đọc thư mục dự án: ${err.message}` };
    }

    const fileNames = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
    const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    let projectType = 'Generic / Script Project';
    let language = 'Unknown';
    let packageManager = 'none';
    let projectName = path.basename(projectPath);
    const detectedFiles = [];
    const commands = {
      test: null,
      build: null,
      run: null
    };

    // 1. Kiểm tra Node.js / TypeScript (package.json)
    if (fileNames.includes('package.json')) {
      detectedFiles.push('package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
        if (pkg.name) projectName = pkg.name;
        const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

        if (allDeps['electron'] || (pkg.main && pkg.main.includes('electron'))) {
          projectType = 'Node.js / Electron Desktop Application';
        } else if (allDeps['react'] || allDeps['next']) {
          projectType = 'React / Next.js Web Application';
        } else if (allDeps['vue'] || allDeps['nuxt']) {
          projectType = 'Vue / Nuxt Web Application';
        } else if (allDeps['express'] || allDeps['nestjs'] || allDeps['fastify']) {
          projectType = 'Node.js Backend Server';
        } else {
          projectType = 'Node.js Application';
        }

        language = fileNames.includes('tsconfig.json') ? 'TypeScript' : 'JavaScript';
        packageManager = fileNames.includes('pnpm-lock.yaml')
          ? 'pnpm'
          : fileNames.includes('yarn.lock')
          ? 'yarn'
          : 'npm';

        const scripts = pkg.scripts || {};
        if (scripts.test) {
          commands.test = {
            command: packageManager,
            args: ['test'],
            fullCmd: `${packageManager} test`,
            description: `Chạy lệnh test script từ package.json ("${scripts.test}")`
          };
        } else {
          const testScriptKey = Object.keys(scripts).find((k) => k.startsWith('test'));
          if (testScriptKey) {
            commands.test = {
              command: packageManager,
              args: ['run', testScriptKey],
              fullCmd: `${packageManager} run ${testScriptKey}`,
              description: `Chạy script ${testScriptKey} từ package.json`
            };
          }
        }

        if (scripts.build) {
          commands.build = {
            command: packageManager,
            args: ['run', 'build'],
            fullCmd: `${packageManager} run build`,
            description: `Chạy lệnh build từ package.json ("${scripts.build}")`
          };
        }

        if (scripts.start) {
          commands.run = {
            command: packageManager,
            args: ['start'],
            fullCmd: `${packageManager} start`,
            description: `Khởi chạy ứng dụng từ package.json ("${scripts.start}")`
          };
        } else if (scripts.dev) {
          commands.run = {
            command: packageManager,
            args: ['run', 'dev'],
            fullCmd: `${packageManager} run dev`,
            description: `Khởi chạy chế độ phát triển ("${scripts.dev}")`
          };
        }
      } catch (pkgErr) {
        detectedFiles.push(`package.json (parse error: ${pkgErr.message})`);
      }
    }

    // 2. Kiểm tra bộ kiểm thử Node.js tuỳ chỉnh (Multi-Topic Test Suite / SWT301)
    if (dirNames.includes('scripts') || dirNames.some((d) => d.toLowerCase().startsWith('topic_'))) {
      const scriptsDir = path.join(projectPath, 'scripts');
      let scriptFiles = [];
      if (fs.existsSync(scriptsDir)) {
        try {
          scriptFiles = fs.readdirSync(scriptsDir);
        } catch (_) {}
      }

      if (scriptFiles.includes('run_all_tests.js') || fileNames.some((f) => f.includes('CHAY_TEST_') || f.includes('run_all'))) {
        projectType = 'Node.js Test Suite (SWT301 Multi-Topic Testing)';
        language = 'JavaScript';
        packageManager = 'node';

        if (scriptFiles.includes('run_all_tests.js')) {
          detectedFiles.push('scripts/run_all_tests.js');
          commands.test = {
            command: 'node',
            args: ['scripts/run_all_tests.js'],
            fullCmd: 'node scripts/run_all_tests.js',
            description: 'Chạy toàn bộ 8 Topic kiểm thử SWT301 qua bộ runner tự động'
          };
        }
        const batRunner = fileNames.find(
          (f) => f.toLowerCase().endsWith('.bat') && f.toLowerCase().includes('chay_test')
        );
        if (batRunner) {
          detectedFiles.push(batRunner);
          if (!commands.test) {
            commands.test = {
              command: 'cmd.exe',
              args: ['/c', batRunner],
              fullCmd: batRunner,
              description: `Chạy kiểm thử thông qua file kịch bản batch ${batRunner}`
            };
          }
        }
      }
    }

    // 3. Kiểm tra .NET / C# (*.sln, *.csproj)
    const slnFile = fileNames.find((f) => f.endsWith('.sln'));
    const csprojFile = fileNames.find((f) => f.endsWith('.csproj'));
    if (slnFile || csprojFile) {
      if (slnFile) detectedFiles.push(slnFile);
      if (csprojFile) detectedFiles.push(csprojFile);
      projectType = '.NET C# Application';
      language = 'C#';
      packageManager = 'dotnet';
      commands.test = {
        command: 'dotnet',
        args: ['test', '--no-restore', '--nologo'],
        fullCmd: 'dotnet test --no-restore --nologo',
        description: 'Chạy các test cases NUnit / xUnit / MSTest qua .NET CLI'
      };
      commands.build = {
        command: 'dotnet',
        args: ['build', '--no-restore'],
        fullCmd: 'dotnet build --no-restore',
        description: 'Biên dịch mã nguồn dự án .NET'
      };
      commands.run = {
        command: 'dotnet',
        args: ['run'],
        fullCmd: 'dotnet run',
        description: 'Khởi chạy dự án .NET'
      };
    }

    // 4. Kiểm tra Python
    if (fileNames.includes('requirements.txt') || fileNames.includes('pyproject.toml') || fileNames.includes('setup.py')) {
      if (fileNames.includes('requirements.txt')) detectedFiles.push('requirements.txt');
      if (fileNames.includes('pyproject.toml')) detectedFiles.push('pyproject.toml');
      if (fileNames.includes('setup.py')) detectedFiles.push('setup.py');
      projectType = 'Python Application';
      language = 'Python';
      packageManager = 'pip';
      commands.test = {
        command: 'pytest',
        args: [],
        fullCmd: 'pytest',
        description: 'Chạy bộ kiểm thử tự động với PyTest'
      };
      if (fileNames.includes('main.py')) {
        detectedFiles.push('main.py');
        commands.run = {
          command: 'python',
          args: ['main.py'],
          fullCmd: 'python main.py',
          description: 'Chạy file thực thi chính main.py'
        };
      }
    }

    // 5. Kiểm tra Java (Maven / Gradle)
    if (fileNames.includes('pom.xml')) {
      detectedFiles.push('pom.xml');
      projectType = 'Java (Maven) Application';
      language = 'Java';
      packageManager = 'mvn';
      commands.test = {
        command: 'mvn',
        args: ['test'],
        fullCmd: 'mvn test',
        description: 'Chạy bộ kiểm thử JUnit qua Maven'
      };
      commands.build = {
        command: 'mvn',
        args: ['clean', 'package'],
        fullCmd: 'mvn clean package',
        description: 'Đóng gói sản phẩm JAR/WAR với Maven'
      };
    } else if (fileNames.includes('build.gradle') || fileNames.includes('build.gradle.kts')) {
      const gradlew = fileNames.includes('gradlew.bat') ? 'gradlew.bat' : 'gradle';
      detectedFiles.push('build.gradle');
      projectType = 'Java (Gradle) Application';
      language = 'Java / Kotlin';
      packageManager = 'gradle';
      commands.test = {
        command: gradlew,
        args: ['test'],
        fullCmd: `${gradlew} test`,
        description: 'Chạy kiểm thử với Gradle'
      };
    }

    // 6. Kiểm tra Playwright E2E riêng biệt
    const pwConfig = fileNames.find((f) => f.startsWith('playwright.config'));
    if (pwConfig) {
      detectedFiles.push(pwConfig);
      if (!commands.test) {
        commands.test = {
          command: 'npx',
          args: ['playwright', 'test'],
          fullCmd: 'npx playwright test',
          description: 'Chạy bộ kiểm thử Playwright Web E2E'
        };
      }
    }

    const hasGit = fs.existsSync(path.join(projectPath, '.git'));
    const scanResult = {
      projectPath,
      name: projectName,
      type: projectType,
      language,
      packageManager,
      detectedFiles,
      commands,
      hasGit,
      lastScanned: new Date().toISOString()
    };

    // 7. Cập nhật vào projects_cache.json
    const cachePath = path.join(this.projectRoot, 'projects_cache.json');
    let cache = {};
    if (fs.existsSync(cachePath)) {
      try {
        cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      } catch (_) {
        cache = {};
      }
    }

    cache[projectPath] = scanResult;

    try {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
    } catch (saveErr) {
      this.writeLog('CACHE_WRITE_ERROR', `Không thể ghi file projects_cache.json: ${saveErr.message}`);
    }

    const durationMs = Date.now() - t0;
    this.writeLog(
      'PROJECT_SCAN',
      `Scanned ${projectPath} in ${durationMs}ms: Type="${projectType}", PM="${packageManager}", Test="${commands.test?.fullCmd || 'None'}"`
    );

    return {
      success: true,
      profile: scanResult,
      cacheFile: 'projects_cache.json',
      durationMs,
      message: `Đã nhận diện thành công dự án "${projectName}": Loại ${projectType}, Ngôn ngữ ${language}. Lệnh test tự đoán: ${commands.test?.fullCmd || 'Chưa xác định'}.`
    };
  }

  /**
   * BƯỚC B: Chạy lệnh test/build/run trong thư mục dự án
   * - Thực thi bằng spawn, timeout mặc định 300s (5 phút)
   * - Hỗ trợ cài đặt gói (npm install, pip install...) với xác nhận 1 lần duy nhất cho mỗi dự án
   * - Chặn cứng: format ổ đĩa, git push, sửa registry, can thiệp file hệ thống, đọc .env
   * - Đọc kết quả thực tế (exit code, số đạt/lỗi, test lỗi)
   * - Lưu báo cáo vào reports/ và cập nhật projects_cache.json
   * - Chỉ nói "đạt" khi exitCode === 0
   */
  async executeRunInProject(rawPath, command, timeoutSec = 300, confirmed = null) {
    const t0 = Date.now();
    const rawCmd = String(command || '').trim();
    if (!rawCmd) {
      return { success: false, error: 'Lệnh thực thi không được để trống.' };
    }

    // 1. Xác định thư mục dự án
    let targetPath = rawPath ? path.resolve(rawPath) : null;
    if (!targetPath || !fs.existsSync(targetPath)) {
      const cachePath = path.join(this.projectRoot, 'projects_cache.json');
      if (fs.existsSync(cachePath)) {
        try {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const keys = Object.keys(cache);
          if (keys.length > 0) {
            if (rawPath) {
              const matched = keys.find(
                (k) =>
                  k.toLowerCase().includes(rawPath.toLowerCase()) ||
                  (cache[k].name && cache[k].name.toLowerCase().includes(rawPath.toLowerCase()))
              );
              if (matched) targetPath = matched;
            } else {
              targetPath = keys[keys.length - 1];
            }
          }
        } catch (_) {}
      }
    }

    if (!targetPath || !fs.existsSync(targetPath)) {
      targetPath = this.projectRoot;
    }

    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      return { success: false, error: `Thư mục dự án không tồn tại: ${targetPath}` };
    }

    const normProjectPath = path.resolve(targetPath).toLowerCase();
    const cmdLower = rawCmd.toLowerCase();

    // 2. Chặn cứng các thao tác nguy hiểm (Hard-blocks)
    if (
      cmdLower.includes('format ') ||
      cmdLower.includes('git push') ||
      cmdLower.includes('reg add') ||
      cmdLower.includes('reg delete') ||
      cmdLower.includes('regedit') ||
      cmdLower.includes('del /s /q c:\\windows') ||
      cmdLower.includes('rm -rf /') ||
      cmdLower.includes('rm -rf c:') ||
      cmdLower.includes('.env')
    ) {
      return {
        success: false,
        error:
          'Lệnh bị chặn cứng vì vi phạm nguyên tắc an toàn: Không được format ổ đĩa, git push, sửa registry, can thiệp file hệ thống hoặc đọc mã khóa .env.'
      };
    }

    // 3. Kiểm tra lệnh cài đặt thư viện (npm install, pip install...) -> Cần xác nhận 1 lần duy nhất cho mỗi dự án
    const isInstallCmd =
      /\b(npm\s+(i|install|add)|yarn\s+add|pnpm\s+(add|i|install)|pip\s+install|dotnet\s+restore)\b/i.test(cmdLower);

    if (isInstallCmd) {
      const isApproved = this.approvedInstallProjects.has(normProjectPath);
      if (!isApproved) {
        if (confirmed !== true) {
          return {
            success: false,
            needsConfirmation: true,
            reason: 'install_dependencies_confirmation',
            error: `Cần xác nhận từ người dùng để cài đặt thư viện cho dự án "${path.basename(targetPath)}" (chỉ hỏi 1 lần duy nhất cho mỗi dự án).`
          };
        } else {
          this.approvedInstallProjects.add(normProjectPath);
          const cachePath = path.join(this.projectRoot, 'projects_cache.json');
          if (fs.existsSync(cachePath)) {
            try {
              const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
              if (cache[targetPath]) {
                cache[targetPath].installApproved = true;
              } else {
                cache[targetPath] = { projectPath: targetPath, installApproved: true };
              }
              fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
            } catch (_) {}
          }
          this.writeLog('PROJECT_INSTALL_APPROVED', `Approved package installation for project: ${targetPath}`);
        }
      }
    }

    // 4. Kiểm tra khoá tuần tự & RAM Guard (< 90%)
    if (this.isTestRunning) {
      return {
        success: false,
        error:
          'Đang có một tiến trình kiểm thử hoặc chạy lệnh khác. Hệ thống chỉ cho phép chạy tuần tự để đảm bảo tài nguyên.'
      };
    }

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedRatio = (totalMem - freeMem) / totalMem;
    const usedPercent = (usedRatio * 100).toFixed(1);
    if (usedRatio >= 0.90) {
      return {
        success: false,
        error: `Từ chối chạy lệnh: Mức sử dụng RAM hệ thống quá cao (${usedPercent}% >= 90%). Vui lòng giải phóng bớt bộ nhớ.`
      };
    }

    // 5. Chuẩn bị chạy tiến trình spawn
    this.isTestRunning = true;
    let stdoutData = '';
    let stderrData = '';
    let timedOut = false;
    let proc = null;
    const timeoutDuration = (timeoutSec || 300) * 1000;

    try {
      const parts = rawCmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [rawCmd];
      const mainExe = parts[0].replace(/^"|"$/g, '');
      const rawArgs = parts.slice(1).map((a) => a.replace(/^"|"$/g, ''));

      let spawnExe = mainExe;
      let spawnArgs = rawArgs;

      if (process.platform === 'win32') {
        const winBatchKeywords = ['npm', 'npx', 'yarn', 'pnpm'];
        if (
          winBatchKeywords.includes(mainExe.toLowerCase()) ||
          mainExe.toLowerCase().endsWith('.bat') ||
          mainExe.toLowerCase().endsWith('.cmd')
        ) {
          spawnExe = 'cmd.exe';
          spawnArgs = ['/d', '/s', '/c', rawCmd];
        }
      }

      const res = await new Promise((resolve) => {
        let timer = null;
        try {
          proc = spawn(spawnExe, spawnArgs, {
            cwd: targetPath,
            windowsHide: true,
            env: { ...process.env, NODE_ENV: 'test', CI: 'true' }
          });
          this.currentTestProcess = proc;
        } catch (spawnErr) {
          this.isTestRunning = false;
          this.currentTestProcess = null;
          return resolve({ exitCode: -1, spawnError: spawnErr.message });
        }

        timer = setTimeout(() => {
          timedOut = true;
          this.writeLog(
            'PROJECT_CMD_TIMEOUT',
            `Command "${rawCmd}" in ${targetPath} timed out after ${timeoutSec}s -> Force kill.`
          );
          if (proc && proc.pid) {
            try {
              execSync(`taskkill /pid ${proc.pid} /T /F 2>nul`);
            } catch (_) {
              try {
                proc.kill('SIGKILL');
              } catch (__) {}
            }
          }
        }, timeoutDuration);

        proc.stdout.on('data', (d) => {
          stdoutData += d.toString('utf8');
        });

        proc.stderr.on('data', (d) => {
          stderrData += d.toString('utf8');
        });

        proc.on('close', (code) => {
          clearTimeout(timer);
          this.isTestRunning = false;
          this.currentTestProcess = null;
          resolve({ exitCode: code });
        });

        proc.on('error', (err) => {
          clearTimeout(timer);
          this.isTestRunning = false;
          this.currentTestProcess = null;
          resolve({ exitCode: -1, spawnError: err.message });
        });
      });

      const durationMs = Date.now() - t0;
      if (res.spawnError) {
        return {
          success: false,
          projectPath: targetPath,
          command: rawCmd,
          error: `Không thể khởi chạy lệnh: ${res.spawnError}`
        };
      }

      if (timedOut) {
        return {
          success: false,
          projectPath: targetPath,
          command: rawCmd,
          durationMs,
          timedOut: true,
          error: `Lệnh bị dừng do vượt quá thời gian tối đa ${timeoutSec} giây (5 phút).`
        };
      }

      // 6. Phân tích kết quả thực tế
      const parsed = this._parseTestResult(path.basename(targetPath), stdoutData, stderrData, res.exitCode);
      const isSuccess = res.exitCode === 0 && parsed.failed === 0;

      // 7. Lưu báo cáo vào reports/
      const reportsDir = path.join(this.projectRoot, 'reports');
      if (!fs.existsSync(reportsDir)) {
        try {
          fs.mkdirSync(reportsDir, { recursive: true });
        } catch (_) {}
      }

      const safeProjName = path.basename(targetPath).replace(/[^a-zA-Z0-9_\-]/g, '_');
      const reportFileName = `report_run_${safeProjName}_${Date.now()}.json`;
      const reportFilePath = path.join(reportsDir, reportFileName);

      const reportData = {
        projectPath: targetPath,
        projectName: path.basename(targetPath),
        timestamp: new Date().toISOString(),
        command: rawCmd,
        exitCode: res.exitCode,
        success: isSuccess,
        durationMs,
        passed: parsed.passed,
        failed: parsed.failed,
        total: parsed.total,
        failingTests: parsed.failingTests,
        ramUsage: {
          totalMb: Math.round(totalMem / (1024 * 1024)),
          freeMb: Math.round(freeMem / (1024 * 1024)),
          usedPercent: `${usedPercent}%`
        },
        stdoutSnippet: stdoutData.slice(-3000),
        stderrSnippet: stderrData.slice(-1000)
      };

      try {
        fs.writeFileSync(reportFilePath, JSON.stringify(reportData, null, 2), 'utf8');
      } catch (writeErr) {
        this.writeLog('REPORT_WRITE_ERROR', `Không thể lưu file báo cáo: ${writeErr.message}`);
      }

      // 8. Cập nhật vào projects_cache.json
      const cachePath = path.join(this.projectRoot, 'projects_cache.json');
      if (fs.existsSync(cachePath)) {
        try {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          if (cache[targetPath]) {
            cache[targetPath].lastRun = {
              command: rawCmd,
              exitCode: res.exitCode,
              success: isSuccess,
              passed: parsed.passed,
              failed: parsed.failed,
              total: parsed.total,
              failingTests: parsed.failingTests,
              durationMs,
              reportFile: reportFileName,
              timestamp: new Date().toISOString()
            };
            fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
          }
        } catch (_) {}
      }

      this.writeLog(
        'PROJECT_RUN',
        `Path="${targetPath}" | Cmd="${rawCmd}" | ExitCode=${res.exitCode} | Success=${isSuccess} | Pass=${parsed.passed}/${parsed.total} | Dur=${durationMs}ms`
      );

      return {
        success: isSuccess,
        projectPath: targetPath,
        projectName: path.basename(targetPath),
        command: rawCmd,
        exitCode: res.exitCode,
        passed: parsed.passed,
        failed: parsed.failed,
        total: parsed.total,
        failingTests: parsed.failingTests,
        durationMs,
        usedRamPercent: `${usedPercent}%`,
        reportFile: reportFileName,
        message: isSuccess
          ? `Lệnh "${rawCmd}" trong dự án "${path.basename(targetPath)}" đã CHẠY ĐẠT (Exit code: 0, ${parsed.passed}/${parsed.total} test đạt trong ${durationMs}ms).`
          : `Lệnh "${rawCmd}" trong dự án "${path.basename(targetPath)}" KHÔNG ĐẠT (Exit code: ${res.exitCode}, có ${parsed.failed} ca lỗi. Thất bại: ${parsed.failingTests.join(', ') || 'Xem chi tiết trong log'}).`
      };
    } finally {
      this.isTestRunning = false;
      this.currentTestProcess = null;
    }
  }

  // ==========================================================================
  // TOOL 14: SỬA CODE VÀ VÒNG LẶP TEST-FIX (BƯỚC C)
  // ==========================================================================

  _findProjectRootForFile(filePath) {
    let currentDir = path.dirname(path.resolve(filePath));
    const rootDrive = path.parse(currentDir).root;
    while (currentDir && currentDir !== rootDrive) {
      if (
        fs.existsSync(path.join(currentDir, 'package.json')) ||
        fs.existsSync(path.join(currentDir, 'pom.xml')) ||
        fs.existsSync(path.join(currentDir, 'requirements.txt')) ||
        fs.existsSync(path.join(currentDir, '.git')) ||
        fs.existsSync(path.join(currentDir, 'scripts'))
      ) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    return path.dirname(path.resolve(filePath));
  }

  _ensureBackupOrBranch(projectPath) {
    const resolved = path.resolve(projectPath);
    const norm = resolved.toLowerCase();
    if (this.sessionBackedUpProjects.has(norm)) {
      return this.sessionBackedUpProjects.get(norm);
    }

    const now = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const timeStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const projName = path.basename(resolved).replace(/[^a-zA-Z0-9_\-]/g, '_');

    let backupInfo = null;

    // 1. Kiểm tra nếu dự án có Git repo
    if (fs.existsSync(path.join(resolved, '.git'))) {
      const branchName = `aura/${timeStr}`;
      try {
        execSync(`git -C "${resolved}" checkout -b "${branchName}"`, { stdio: 'pipe' });
        backupInfo = {
          mode: 'git',
          branch: branchName,
          projectPath: resolved,
          timestamp: now.toISOString()
        };
        this.writeLog('BACKUP_GIT', `Tự động tạo branch Git: ${branchName} cho dự án ${resolved}`);
      } catch (_) {}
    }

    // 2. Nếu không có Git hoặc Git lỗi -> Sao lưu vào D:\Aura_Backups\<tên>_<time>
    if (!backupInfo) {
      const backupRootDir = 'D:\\Aura_Backups';
      if (!fs.existsSync(backupRootDir)) {
        try {
          fs.mkdirSync(backupRootDir, { recursive: true });
        } catch (_) {}
      }

      const backupDir = path.join(backupRootDir, `${projName}_${timeStr}`);
      try {
        fs.cpSync(resolved, backupDir, {
          recursive: true,
          filter: (src) => {
            const lower = src.toLowerCase();
            return (
              !lower.includes('node_modules') &&
              !lower.includes('.git') &&
              !lower.includes('venv') &&
              !lower.includes('__pycache__') &&
              !lower.includes('obj') &&
              !lower.includes('bin\\debug')
            );
          }
        });
        backupInfo = {
          mode: 'folder_copy',
          backupDir,
          projectPath: resolved,
          timestamp: now.toISOString()
        };
        this.writeLog('BACKUP_FOLDER', `Tự động sao lưu thư mục dự án vào: ${backupDir}`);
      } catch (cpErr) {
        this.writeLog('BACKUP_ERROR', `Lỗi sao lưu dự án ${resolved}: ${cpErr.message}`);
        backupInfo = { mode: 'failed', error: cpErr.message, projectPath: resolved };
      }
    }

    this.sessionBackedUpProjects.set(norm, backupInfo);
    return backupInfo;
  }

  async executeEditFile(filePath, target, replacement) {
    if (!filePath) {
      return { success: false, error: 'Đường dẫn file không được để trống.' };
    }
    const resolvedFile = path.resolve(filePath);

    // Chặn cứng sửa file .env hoặc file hệ thống
    const fileLower = resolvedFile.toLowerCase();
    if (
      fileLower.endsWith('.env') ||
      fileLower.includes('\\windows\\') ||
      fileLower.includes('\\program files\\') ||
      fileLower.includes('\\program files (x86)\\')
    ) {
      return {
        success: false,
        error: 'Chặn cứng: Không được phép sửa file .env, file hệ thống Windows hoặc Program Files.'
      };
    }

    if (!fs.existsSync(resolvedFile)) {
      return { success: false, error: `File không tồn tại: ${resolvedFile}` };
    }

    // Tự động sao lưu dự án trước lần sửa đầu tiên trong phiên
    const projectRoot = this._findProjectRootForFile(resolvedFile);
    const backupInfo = this._ensureBackupOrBranch(projectRoot);

    const originalContent = fs.readFileSync(resolvedFile, 'utf8');
    if (!originalContent.includes(target)) {
      return {
        success: false,
        error: `Không tìm thấy đoạn mã mục tiêu (target) trong file ${path.basename(resolvedFile)}.`
      };
    }

    const updatedContent = originalContent.replace(target, replacement);
    fs.writeFileSync(resolvedFile, updatedContent, 'utf8');

    // Lưu diff vào reports/
    const reportsDir = path.join(this.projectRoot, 'reports');
    if (!fs.existsSync(reportsDir)) {
      try {
        fs.mkdirSync(reportsDir, { recursive: true });
      } catch (_) {}
    }

    const safeBase = path.basename(resolvedFile).replace(/[^a-zA-Z0-9_\-]/g, '_');
    const diffFileName = `diff_${safeBase}_${Date.now()}.txt`;
    const diffFilePath = path.join(reportsDir, diffFileName);

    const diffContent = [
      `--- ${resolvedFile}`,
      `+++ ${resolvedFile}`,
      `@@ Thay đổi tại file: ${path.basename(resolvedFile)} @@`,
      `- ${target.split('\n').join('\n- ')}`,
      `+ ${replacement.split('\n').join('\n+ ')}`
    ].join('\n');

    try {
      fs.writeFileSync(diffFilePath, diffContent, 'utf8');
    } catch (_) {}

    this.writeLog(
      'CODE_EDIT',
      `Edited file ${resolvedFile} (Backup: ${backupInfo?.mode || 'none'}) | Diff: ${diffFileName}`
    );

    return {
      success: true,
      filePath: resolvedFile,
      fileName: path.basename(resolvedFile),
      projectRoot,
      backupInfo,
      diffFile: diffFileName,
      summary: `Đã sửa file ${path.basename(resolvedFile)}. Thay thế đoạn mã mục tiêu thành công. Diff đã lưu tại reports/${diffFileName}.`
    };
  }

  async executeCreateFile(filePath, content) {
    if (!filePath) {
      return { success: false, error: 'Đường dẫn file không được để trống.' };
    }
    const resolvedFile = path.resolve(filePath);

    const fileLower = resolvedFile.toLowerCase();
    if (
      fileLower.includes('\\windows\\') ||
      fileLower.includes('\\program files\\') ||
      fileLower.includes('\\program files (x86)\\')
    ) {
      return {
        success: false,
        error: 'Chặn cứng: Không được phép tạo file trong thư mục hệ thống Windows hoặc Program Files.'
      };
    }

    const projectRoot = this._findProjectRootForFile(resolvedFile);
    const backupInfo = this._ensureBackupOrBranch(projectRoot);

    const dir = path.dirname(resolvedFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(resolvedFile, content || '', 'utf8');

    this.writeLog(
      'CODE_CREATE',
      `Created file ${resolvedFile} (Size: ${(content || '').length}B, Backup: ${backupInfo?.mode || 'none'})`
    );

    return {
      success: true,
      filePath: resolvedFile,
      fileName: path.basename(resolvedFile),
      projectRoot,
      backupInfo,
      summary: `Đã tạo file mới: ${resolvedFile}`
    };
  }

  async executeUndoLastChange(targetPath) {
    const resolved = path.resolve(targetPath || this.projectRoot);
    const norm = resolved.toLowerCase();

    let backupInfo = this.sessionBackedUpProjects.get(norm);
    if (!backupInfo) {
      for (const [pKey, pVal] of this.sessionBackedUpProjects.entries()) {
        if (norm.startsWith(pKey) || pKey.startsWith(norm)) {
          backupInfo = pVal;
          break;
        }
      }
    }

    if (!backupInfo && fs.existsSync('D:\\Aura_Backups')) {
      const projName = path.basename(resolved).replace(/[^a-zA-Z0-9_\-]/g, '_').toLowerCase();
      try {
        const backups = fs.readdirSync('D:\\Aura_Backups').filter((d) => d.toLowerCase().startsWith(projName));
        if (backups.length > 0) {
          const sorted = backups.sort().reverse();
          backupInfo = {
            mode: 'folder_copy',
            backupDir: path.join('D:\\Aura_Backups', sorted[0]),
            projectPath: resolved
          };
        }
      } catch (_) {}
    }

    if (!backupInfo) {
      return {
        success: false,
        error: `Không tìm thấy bản sao lưu hoặc nhánh Git nào cho dự án ${resolved} để hoàn tác.`
      };
    }

    if (backupInfo.mode === 'git') {
      try {
        execSync(`git -C "${backupInfo.projectPath}" checkout .`, { stdio: 'pipe' });
        execSync(`git -C "${backupInfo.projectPath}" clean -fd`, { stdio: 'pipe' });
        this.writeLog('UNDO_GIT', `Đã hoàn tác thay đổi qua Git cho ${backupInfo.projectPath}`);
        return {
          success: true,
          mode: 'git',
          projectPath: backupInfo.projectPath,
          message: `Đã hoàn tác toàn bộ thay đổi mã nguồn qua nhánh Git (${backupInfo.branch}).`
        };
      } catch (gitErr) {
        return { success: false, error: `Lỗi khi hoàn tác Git: ${gitErr.message}` };
      }
    } else if (backupInfo.mode === 'folder_copy' && backupInfo.backupDir) {
      if (!fs.existsSync(backupInfo.backupDir)) {
        return { success: false, error: `Thư mục sao lưu không tồn tại: ${backupInfo.backupDir}` };
      }
      try {
        fs.cpSync(backupInfo.backupDir, backupInfo.projectPath, { recursive: true });
        this.writeLog('UNDO_FOLDER', `Đã khôi phục mã nguồn từ ${backupInfo.backupDir} về ${backupInfo.projectPath}`);
        return {
          success: true,
          mode: 'folder_copy',
          backupDir: backupInfo.backupDir,
          projectPath: backupInfo.projectPath,
          message: `Đã hoàn tác toàn bộ mã nguồn về trạng thái ban đầu từ bản sao lưu ${path.basename(backupInfo.backupDir)}.`
        };
      } catch (cpErr) {
        return { success: false, error: `Lỗi khi khôi phục từ bản sao lưu: ${cpErr.message}` };
      }
    }

    return { success: false, error: 'Không xác định được phương thức hoàn tác.' };
  }

  async executeAutoTestAndFix(projectPath, testCommand, fixAction = null, maxAttempts = 8) {
    const t0 = Date.now();
    const resolvedPath = path.resolve(projectPath);
    const attemptsLog = [];

    this._ensureBackupOrBranch(resolvedPath);

    let currentAttempt = 0;
    let finalResult = null;

    while (currentAttempt < maxAttempts) {
      currentAttempt++;
      this.writeLog('AUTO_FIX_LOOP', `Bắt đầu vòng lặp thứ ${currentAttempt}/${maxAttempts} cho ${resolvedPath}`);

      const testRes = await this.executeRunInProject(resolvedPath, testCommand);
      attemptsLog.push({
        attempt: currentAttempt,
        exitCode: testRes.exitCode,
        success: testRes.success,
        passed: testRes.passed,
        failed: testRes.failed,
        failingTests: testRes.failingTests
      });

      if (testRes.success) {
        finalResult = {
          success: true,
          totalAttempts: currentAttempt,
          passed: testRes.passed,
          failed: 0,
          total: testRes.total,
          durationMs: Date.now() - t0,
          attemptsLog,
          message: `Vòng lặp kiểm thử và sửa code THÀNH CÔNG sau ${currentAttempt} lần chạy. Tất cả test case đã ĐẠT!`
        };
        break;
      }

      if (currentAttempt >= maxAttempts) {
        finalResult = {
          success: false,
          totalAttempts: currentAttempt,
          passed: testRes.passed,
          failed: testRes.failed,
          failingTests: testRes.failingTests,
          durationMs: Date.now() - t0,
          attemptsLog,
          message: `Đã thực hiện tối đa ${maxAttempts} vòng lặp kiểm thử nhưng vẫn còn ${testRes.failed} ca lỗi. (Thất bại: ${testRes.failingTests?.join(', ') || 'Xem log'}).`
        };
        break;
      }

      if (typeof fixAction === 'function') {
        try {
          await fixAction(testRes, currentAttempt);
        } catch (fixErr) {
          this.writeLog('AUTO_FIX_ERROR', `Lỗi khi sửa ở vòng ${currentAttempt}: ${fixErr.message}`);
        }
      } else {
        finalResult = {
          success: false,
          totalAttempts: currentAttempt,
          passed: testRes.passed,
          failed: testRes.failed,
          failingTests: testRes.failingTests,
          durationMs: Date.now() - t0,
          attemptsLog,
          message: `Phát hiện lỗi ở vòng ${currentAttempt}: ${testRes.failingTests?.join(', ')}. Cần chỉ định phương án sửa.`
        };
        break;
      }
    }

    return finalResult;
  }

  /**
   * TOOL: run_live_test(target, goal, autoFix)
   * Kiểm thử thực tế vạn năng cho bất kỳ đối tượng nào
   */
  async executeRunLiveTest(target, goal = 'test toàn bộ', autoFix = false, confirmed = null) {
    if (!target) {
      return {
        success: false,
        error: 'Tham số target là bắt buộc (URL, file HTML, thư mục dự án, hoặc tên ứng dụng).'
      };
    }
    this.writeLog('RUN_LIVE_TEST_INVOKE', `Target: "${target}" | Goal: "${goal}" | AutoFix: ${autoFix}`);
    const res = await this.liveTesterService.runLiveTest(target, goal, { autoFix: Boolean(autoFix) });
    return res;
  }

  /**
   * Bộ điều hướng thực thi tool chung
   */
  async executeTool(name, args = {}, confirmed = null) {
    const t0 = Date.now();
    let result = null;

    try {
      switch (name) {
        case 'open_app':
          result = await this.executeOpenApp(args.name);
          break;
        case 'close_app':
          result = await this.executeCloseApp(args.name);
          break;
        case 'open_url':
          result = await this.executeOpenUrl(args.url);
          break;
        case 'open_youtube_search':
          result = await this.executeYoutubeSearch(args.query);
          break;
        case 'open_youtube_video':
          result = await this.executeYoutubeVideo(args.query);
          break;
        case 'open_live_stream':
          result = await this.executeLiveStream(args.topic || args.query || args.name);
          break;
        case 'list_directory':
          result = await this.executeListDirectory(args.path);
          break;
        case 'open_folder':
          result = await this.executeOpenFolder(args.path, confirmed);
          break;
        case 'open_file':
          result = await this.executeOpenFile(args.path, confirmed);
          break;
        case 'file_search':
          result = await this.executeFileSearch(args.query, args.folder, args.type);
          break;
        case 'read_file':
          result = await this.executeReadFile(args.path);
          break;
        case 'edit_file':
          result = await this.executeEditFile(args.path, args.target, args.replacement);
          break;
        case 'create_file':
          result = await this.executeCreateFile(args.path, args.content);
          break;
        case 'undo_last_change':
          result = await this.executeUndoLastChange(args.path);
          break;
        case 'clipboard_read':
          result = await this.executeClipboardRead();
          break;
        case 'clipboard_write':
          result = await this.executeClipboardWrite(args.text);
          break;
        case 'set_reminder':
          result = await this.executeSetReminder(args.minutes, args.message);
          break;
        case 'get_preferences':
          result = await this.executeGetPreferences();
          break;
        case 'save_preference':
          result = await this.executeSavePreference(args.key, args.value);
          break;
        case 'list_test_topics':
          result = await this.executeListTestTopics();
          break;
        case 'run_test':
          result = await this.executeRunTest(args.topic, confirmed);
          break;
        case 'get_latest_test_report':
          result = await this.executeGetLatestTestReport(args.topic);
          break;
        case 'find_project':
          result = await this.executeFindProject(args.query || args.name || args.path);
          break;
        case 'scan_project':
          result = await this.executeScanProject(args.path || args.projectPath);
          break;
        case 'run_in_project':
          result = await this.executeRunInProject(
            args.path || args.projectPath,
            args.command,
            args.timeoutSec,
            confirmed
          );
          break;
        case 'run_live_test':
          result = await this.executeRunLiveTest(
            args.target,
            args.goal,
            args.autoFix,
            confirmed
          );
          break;
        case 'take_screenshot':
          if (!this.computerUseService) {
            result = { success: false, error: 'Dịch vụ Computer-Use chưa sẵn sàng.' };
          } else {
            const shot = await this.computerUseService.takeScreenshot();
            result = {
              success: shot.success,
              origW: shot.origW,
              origH: shot.origH,
              scaledW: shot.scaledW,
              scaledH: shot.scaledH,
              scaleFactor: shot.scaleFactor,
              message: `Đã chụp màn hình thành công (${shot.scaledW}x${shot.scaledH} trong RAM).`
            };
          }
          break;
        case 'mouse_click':
        case 'double_click':
        case 'scroll':
        case 'type_text':
        case 'press_key':
          if (!this.computerUseService) {
            result = { success: false, error: 'Dịch vụ Computer-Use chưa sẵn sàng.' };
          } else {
            result = await this.computerUseService.executeLowLevelAction(name, args, {
              origW: 1920,
              origH: 1080,
              scaledW: 1280,
              scaledH: 720
            });
          }
          break;
        default:
          result = {
            success: false,
            error: `Công cụ "${name}" không được hỗ trợ hoặc không có trong danh sách cho phép.`
          };
      }
    } catch (err) {
      result = {
        success: false,
        error: `Lỗi ngoại lệ khi chạy tool ${name}: ${err.message}`
      };
    }

    const durationMs = Date.now() - t0;
    this._recordAudit({
      tool: name,
      args,
      confirmed,
      success: Boolean(result?.success),
      result,
      durationMs
    });

    return result;
  }
}

module.exports = {
  AuraToolExecutor
};

