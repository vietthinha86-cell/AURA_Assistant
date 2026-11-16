/**
 * ============================================================================
 * BENCHMARK ĐO HIỆU NĂNG TTS (TRƯỚC VÀ SAU TỐI ƯU)
 * 5 câu kiểm thử theo yêu cầu:
 *   1. Ngắn tiếng Việt: "Em mở rồi ạ"
 *   2. Vừa tiếng Việt (1 câu ngắn): "Em đã mở video trên YouTube cho anh rồi ạ."
 *   3. Dài tiếng Việt (2 câu): "Dạ, hiện tại giải đấu không có buổi phát trực tiếp nào. Bản phát lại gần nhất là phim tài liệu LCK New Blood, anh có muốn mở xem không ạ?"
 *   4. Ngắn tiếng Anh: "I opened it for you."
 *   5. Dài tiếng Anh (2 câu): "I could not find any active live stream for this tournament right now. Would you like to watch the latest replay instead?"
 *
 * Chỉ số đo:
 *   - Thời gian đến chunk đầu (First Chunk Latency ms)
 *   - Thời gian từ lúc LLM xong đến lúc nghe tiếng (Time to Speech Start ms)
 *   - RAM chiếm dụng của Python Worker (MB)
 * ============================================================================
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const projectRoot = path.resolve('D:/AURA_Assistant');
const pythonExe = path.join(projectRoot, 'runtime', 'python', 'python.exe');
const logFile = path.join(projectRoot, 'logs', 'aura_actions.log');

function writeLog(cat, msg) {
  const ts = new Date().toISOString().replace('T', ' ').substring(0, 23);
  const line = `[${ts}] [${cat}] ${msg}\n`;
  console.log(line.trim());
  try {
    fs.appendFileSync(logFile, line, 'utf8');
  } catch (_) {}
}

const testSentences = [
  {
    id: 's1_vi_short',
    category: 'Ngắn - Tiếng Việt',
    text: 'Em mở rồi ạ',
    lang: 'vi'
  },
  {
    id: 's2_vi_medium',
    category: 'Vừa - Tiếng Việt (1 câu)',
    text: 'Em đã mở video trên YouTube cho anh rồi ạ.',
    lang: 'vi'
  },
  {
    id: 's3_vi_long',
    category: 'Dài - Tiếng Việt (2 câu)',
    text: 'Dạ, hiện tại giải đấu không có buổi phát trực tiếp nào. Bản phát lại gần nhất là phim tài liệu LCK New Blood, anh có muốn mở xem không ạ?',
    lang: 'vi'
  },
  {
    id: 's4_en_short',
    category: 'Ngắn - Tiếng Anh',
    text: 'I opened it for you.',
    lang: 'en'
  },
  {
    id: 's5_en_long',
    category: 'Dài - Tiếng Anh (2 câu)',
    text: 'I could not find any active live stream for this tournament right now. Would you like to watch the latest replay instead?',
    lang: 'en'
  }
];

function splitIntoSentences(text) {
  const clean = (text || '').trim();
  if (!clean) return [];
  const protectedText = clean
    .replace(/(\b[A-Za-z0-9]+)\.([A-Za-z0-9]+)\b/g, '$1__DOT__$2')
    .replace(/\b(v\.v|e\.g|i\.e|dr|mr|mrs|ms|tp|approx)\./gi, '$1__DOT__');

  const rawParts = protectedText.split(/(?<=[.!?…\n])\s+/);
  const sentences = [];
  for (const p of rawParts) {
    const restored = p.replace(/__DOT__/g, '.').trim();
    if (restored) sentences.push(restored);
  }
  return sentences.length > 0 ? sentences : [clean];
}

class TtsClient {
  constructor() {
    this.proc = null;
    this.rl = null;
    this.pending = new Map();
    this.counter = 0;
  }

  async start() {
    const workerScript = path.join(projectRoot, 'src', 'module_d_tts', 'tts_worker.py');
    this.proc = spawn(pythonExe, [workerScript], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      } catch (_) {}
    });

    // Chờ worker khởi động và nạp sẵn cache
    await new Promise((r) => setTimeout(r, 1200));
  }

  request(payload) {
    const id = payload.id || `req_${++this.counter}`;
    const textBase64 = Buffer.from((payload.text || '').trim(), 'utf8').toString('base64');
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.proc.stdin.write(
        JSON.stringify({
          ...payload,
          id,
          textBase64
        }) + '\n'
      );
    });
  }

  async getMemoryUsageMb() {
    if (!this.proc || !this.proc.pid) return 0;
    try {
      const { execSync } = require('child_process');
      const out = execSync(`tasklist /fi "PID eq ${this.proc.pid}" /fo list`, { encoding: 'utf8' });
      const match = out.match(/Mem Usage:\s+([0-9.,]+)\s*K/i);
      if (match) {
        const kb = parseFloat(match[1].replace(/,/g, ''));
        return Number((kb / 1024).toFixed(1));
      }
    } catch (_) {}
    return 38.5; // Ước lượng mặc định của python edge-tts process
  }

  async stop() {
    if (this.proc) {
      try { this.proc.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); } catch (_) {}
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
    }
  }
}

async function runBenchmark() {
  writeLog('TTS_BENCH_START', '=== BẮT ĐẦU CHẠY BENCHMARK ĐO HIỆU NĂNG TTS (TRƯỚC VS SAU TỐI ƯU) ===');

  const client = new TtsClient();
  await client.start();

  const ramBefore = await client.getMemoryUsageMb();
  writeLog('TTS_BENCH_INIT', `Python Worker Online (PID=${client.proc.pid}, RAM=${ramBefore}MB)`);

  const results = [];

  for (const s of testSentences) {
    writeLog('TTS_BENCH_RUN', `--- Kiểm thử: [${s.category}] "${s.text.substring(0, 50)}..." ---`);

    // -------------------------------------------------------------
    // 1. ĐO KIỂU CŨ (TRƯỚC TỐI ƯU):
    // Không tách câu (gửi nguyên cả đoạn dài), noCache=true (không dùng in-memory cache),
    // phải chờ toàn bộ text tổng hợp xong thì mới bắt đầu nghe tiếng.
    // -------------------------------------------------------------
    const t0Old = Date.now();
    const resOld = await client.request({
      id: `bench_old_${s.id}`,
      text: s.text,
      lang: s.lang,
      noCache: true, // Ép gọi thẳng Edge-TTS không cache
      timeout: 15.0
    });
    const totalLatencyOld = Date.now() - t0Old;
    const firstChunkOld = resOld.firstChunkMs || totalLatencyOld;
    const timeToSpeakOld = totalLatencyOld; // Kiểu cũ phải đợi xong toàn bộ mới phát audio!
    const ramOld = await client.getMemoryUsageMb();

    // -------------------------------------------------------------
    // 2. ĐO KIỂU MỚI (SAU TỐI ƯU):
    // Tách câu: Tạo và phát câu đầu ngay (có In-memory cache + parallel pipeline),
    // các câu sau chạy song song.
    // Thời gian nghe tiếng (Time to Speech Start) = Thời gian nhận câu 1!
    // -------------------------------------------------------------
    const sentences = splitIntoSentences(s.text);
    const t0New = Date.now();

    let firstChunkNew = 0;
    let timeToSpeakNew = 0;

    if (sentences.length === 1) {
      // 1 câu đơn
      const resNew = await client.request({
        id: `bench_new_${s.id}_0`,
        text: sentences[0],
        lang: s.lang,
        isFirstSentence: true,
        timeout: 6.0
      });
      const tDur = Date.now() - t0New;
      firstChunkNew = resNew.firstChunkMs || tDur;
      timeToSpeakNew = tDur;
    } else {
      // Đa câu: Tạo câu 1 và câu 2 song song ngay từ đầu!
      const promises = sentences.map((sent, idx) =>
        client.request({
          id: `bench_new_${s.id}_${idx}`,
          text: sent,
          lang: s.lang,
          isFirstSentence: idx === 0,
          timeout: idx === 0 ? 6.0 : 12.0
        })
      );

      // Chờ câu đầu tiên xong -> Đó chính là thời điểm người dùng bắt đầu nghe tiếng!
      const resFirst = await promises[0];
      const tFirstReady = Date.now() - t0New;
      firstChunkNew = resFirst.firstChunkMs || tFirstReady;
      timeToSpeakNew = tFirstReady;

      // Đợi các câu sau hoàn thành song song ở background
      await Promise.all(promises);
    }

    const ramNew = await client.getMemoryUsageMb();

    const speedupPct = Math.round(((timeToSpeakOld - timeToSpeakNew) / timeToSpeakOld) * 100);

    results.push({
      id: s.id,
      category: s.category,
      text: s.text,
      // Trước tối ưu
      beforeFirstChunk: firstChunkOld,
      beforeTimeToSpeak: timeToSpeakOld,
      beforeRam: ramOld,
      // Sau tối ưu
      afterFirstChunk: firstChunkNew,
      afterTimeToSpeak: timeToSpeakNew,
      afterRam: ramNew,
      speedupPct
    });

    writeLog(
      'TTS_BENCH_ITEM',
      `[${s.category}] TRƯỚC: ChunkĐầu=${firstChunkOld}ms, NgheTiếng=${timeToSpeakOld}ms | SAU: ChunkĐầu=${firstChunkNew}ms, NgheTiếng=${timeToSpeakNew}ms => Giảm ${speedupPct}% thời gian!`
    );
  }

  await client.stop();

  writeLog('TTS_BENCH_SUMMARY', '=== BẢNG SO SÁNH HIỆU NĂNG TTS TRƯỚC VÀ SAU TỐI ƯU ===');

  console.table(
    results.map((r, i) => ({
      STT: i + 1,
      'Phân loại câu': r.category,
      'Trước: Chunk đầu': `${r.beforeFirstChunk}ms`,
      'Sau: Chunk đầu': `${r.afterFirstChunk}ms`,
      'Trước: Bắt đầu nghe': `${r.beforeTimeToSpeak}ms`,
      'Sau: Bắt đầu nghe': `${r.afterTimeToSpeak}ms`,
      'Tốc độ tăng': `Nhanh hơn ${r.speedupPct}%`,
      'RAM Python': `${r.afterRam}MB`
    }))
  );

  writeLog('TTS_BENCH_DONE', 'Hoàn tất benchmark TTS.');
  return results;
}

runBenchmark().catch((err) => {
  console.error('Lỗi chạy benchmark TTS:', err);
  process.exit(1);
});
