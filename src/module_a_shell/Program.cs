using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace AuraShell
{
    public class Program
    {
        [STAThread]
        public static void Main(string[] args)
        {
            var app = new System.Windows.Application();
            var mainWindow = new AuraMainWindow();
            app.Run(mainWindow);
        }
    }

    public class AuraMainWindow : Window
    {
        private readonly WebView2 _webView;
        private readonly string _projectRoot;
        private readonly string _logFilePath;
        private readonly DispatcherTimer _telemetryTimer;

        private TimeSpan _lastTotalCpuTime = TimeSpan.Zero;
        private DateTime _lastCpuSampleTime = DateTime.UtcNow;
        private int _lastReportedFps = 0;
        private bool _lastReportedLiteMode = false;
        private int _telemetryTickCount = 0;

        // Win32 Constants & P/Invoke
        private const int WM_NCLBUTTONDOWN = 0x00A1;
        private const int HTCAPTION = 0x0002;
        private const int WM_HOTKEY = 0x0312;
        private const int HOTKEY_ID_EMERGENCY = 9001;
        private const uint MOD_ALT = 0x0001;
        private const uint MOD_CONTROL = 0x0002;
        private const uint VK_ESCAPE = 0x1B;
        private const uint TH32CS_SNAPPROCESS = 0x00000002;

        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private class MEMORYSTATUSEX
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
            public MEMORYSTATUSEX()
            {
                this.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            }
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX lpBuffer);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
        private struct PROCESSENTRY32
        {
            public uint dwSize;
            public uint cntUsage;
            public uint th32ProcessID;
            public IntPtr th32DefaultHeapID;
            public uint th32ModuleID;
            public uint cntThreads;
            public uint th32ParentProcessID;
            public int pcPriClassBase;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
            public string szExeFile;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

        [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
        private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr hObject);

        public AuraMainWindow()
        {
            _projectRoot = FindProjectRoot();
            string logDir = Path.Combine(_projectRoot, "logs");
            Directory.CreateDirectory(logDir);
            _logFilePath = Path.Combine(logDir, "aura_actions.log");

            Title = "AURA Desktop Assistant";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = System.Windows.Media.Brushes.Transparent;
            Topmost = true;
            ResizeMode = ResizeMode.CanResizeWithGrip;

            // Mặc định mở ở chế độ Ghim góc màn hình (Docked Mode)
            ApplyWindowMode("docked");

            _webView = new WebView2
            {
                DefaultBackgroundColor = System.Drawing.Color.Transparent,
                HorizontalAlignment = System.Windows.HorizontalAlignment.Stretch,
                VerticalAlignment = VerticalAlignment.Stretch
            };

            Content = _webView;

            Loaded += OnWindowLoaded;
            Closed += OnWindowClosed;

            _telemetryTimer = new DispatcherTimer
            {
                Interval = TimeSpan.FromSeconds(1.0)
            };
            _telemetryTimer.Tick += OnTelemetryTick;
        }

        private string FindProjectRoot()
        {
            string dir = AppContext.BaseDirectory;
            for (int i = 0; i < 8; i++)
            {
                if (File.Exists(Path.Combine(dir, "package.json")) ||
                    Directory.Exists(Path.Combine(dir, "assets")))
                {
                    return dir;
                }
                var parent = Directory.GetParent(dir);
                if (parent == null) break;
                dir = parent.FullName;
            }
            return Directory.GetCurrentDirectory();
        }

        private async void OnWindowLoaded(object sender, RoutedEventArgs e)
        {
            WriteLog("SYSTEM", $"Starting AuraMainWindow. ProjectRoot={_projectRoot}");

            // Đăng ký phím tắt khẩn cấp toàn cục Ctrl + Alt + Esc
            var helper = new WindowInteropHelper(this);
            HwndSource source = HwndSource.FromHwnd(helper.Handle);
            source.AddHook(WndProc);
            bool hotkeyOk = RegisterHotKey(helper.Handle, HOTKEY_ID_EMERGENCY, MOD_CONTROL | MOD_ALT, VK_ESCAPE);
            WriteLog("SAFETY", $"Global Emergency Hotkey (Ctrl+Alt+Esc) registered: {hotkeyOk}");

            try
            {
                string userDataFolder = Path.Combine(Path.GetTempPath(), "AURA_Assistant_WebView2_Cache");
                var envOptions = new CoreWebView2EnvironmentOptions("--disable-frame-rate-limit --enable-gpu-rasterization");
                var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, envOptions);
                await _webView.EnsureCoreWebView2Async(env);

                _webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                _webView.CoreWebView2.Settings.AreDevToolsEnabled = true;

                // Ánh xạ thư mục dự án thành tên miền ảo https://aura.local
                _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
                    "aura.local",
                    _projectRoot,
                    CoreWebView2HostResourceAccessKind.Allow
                );

                _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
                _webView.CoreWebView2.Navigate("https://aura.local/src/module_a_shell/ui/index.html");

                _telemetryTimer.Start();
            }
            catch (Exception ex)
            {
                WriteLog("ERROR", $"WebView2 initialization failed: {ex.Message}");
                System.Windows.MessageBox.Show($"Lỗi khởi tạo WebView2: {ex.Message}", "AURA Error", MessageBoxButton.OK, MessageBoxImage.Error);
            }
        }

        private void OnWindowClosed(object? sender, EventArgs e)
        {
            _telemetryTimer.Stop();
            var helper = new WindowInteropHelper(this);
            UnregisterHotKey(helper.Handle, HOTKEY_ID_EMERGENCY);
            WriteLog("SYSTEM", "AuraMainWindow closed cleanly.");
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == WM_HOTKEY && wParam.ToInt32() == HOTKEY_ID_EMERGENCY)
            {
                WriteLog("EMERGENCY_STOP", "User pressed Ctrl+Alt+Esc! Stopping all Aura activities immediately.");
                if (_webView.CoreWebView2 != null)
                {
                    _webView.CoreWebView2.PostWebMessageAsJson("{\"type\":\"host:emergency_stop\"}");
                }
                handled = true;
            }
            return IntPtr.Zero;
        }

        private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            try
            {
                string json = e.TryGetWebMessageAsString();
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;
                string type = root.GetProperty("type").GetString() ?? "";

                switch (type)
                {
                    case "window:drag":
                        Dispatcher.Invoke(() =>
                        {
                            var helper = new WindowInteropHelper(this);
                            ReleaseCapture();
                            SendMessage(helper.Handle, WM_NCLBUTTONDOWN, HTCAPTION, 0);
                        });
                        break;

                    case "window:mode":
                        string mode = root.GetProperty("mode").GetString() ?? "docked";
                        Dispatcher.Invoke(() => ApplyWindowMode(mode));
                        WriteLog("WINDOW", $"Switched window mode to: {mode}");
                        break;

                    case "window:minimize":
                        Dispatcher.Invoke(() => WindowState = WindowState.Minimized);
                        break;

                    case "window:close":
                        Dispatcher.Invoke(() => Close());
                        break;

                    case "telemetry:fps":
                        if (root.TryGetProperty("fps", out var fpsProp))
                            _lastReportedFps = fpsProp.GetInt32();
                        if (root.TryGetProperty("isLiteMode", out var liteProp))
                            _lastReportedLiteMode = liteProp.GetBoolean();
                        break;

                    case "log:action":
                        string cat = root.TryGetProperty("category", out var cProp) ? (cProp.GetString() ?? "INFO") : "INFO";
                        string msg = root.TryGetProperty("message", out var mProp) ? (mProp.GetString() ?? "") : "";
                        WriteLog(cat, msg);
                        break;
                }
            }
            catch (Exception ex)
            {
                WriteLog("WARN", $"Failed handling web message: {ex.Message}");
            }
        }

        private void ApplyWindowMode(string mode)
        {
            var workArea = SystemParameters.WorkArea;
            if (mode == "fullscreen")
            {
                WindowState = WindowState.Normal;
                Left = workArea.Left;
                Top = workArea.Top;
                Width = workArea.Width;
                Height = workArea.Height;
                Topmost = false;
            }
            else if (mode == "expanded")
            {
                WindowState = WindowState.Normal;
                Width = 960;
                Height = 700;
                Left = workArea.Left + (workArea.Width - Width) / 2;
                Top = workArea.Top + (workArea.Height - Height) / 2;
                Topmost = true;
            }
            else // docked (Ghim góc phải dưới màn hình, nền trong suốt)
            {
                WindowState = WindowState.Normal;
                Width = 430;
                Height = 650;
                Left = workArea.Right - Width - 16;
                Top = workArea.Bottom - Height - 16;
                Topmost = true;
            }
        }

        private void OnTelemetryTick(object? sender, EventArgs e)
        {
            try
            {
                // 1. Tính tổng RAM & CPU thực tế của toàn bộ cây tiến trình Aura (AuraShell + WebView2 children)
                var treePids = GetProcessTreeIds((uint)Environment.ProcessId);
                long totalWorkingSetBytes = 0;
                long totalPrivateBytes = 0;
                TimeSpan totalCpuTime = TimeSpan.Zero;

                foreach (uint pid in treePids)
                {
                    try
                    {
                        using var proc = Process.GetProcessById((int)pid);
                        totalWorkingSetBytes += proc.WorkingSet64;
                        totalPrivateBytes += proc.PrivateMemorySize64;
                        totalCpuTime += proc.TotalProcessorTime;
                    }
                    catch { }
                }

                double auraRamMb = totalPrivateBytes / (1024.0 * 1024.0);
                double auraWorkingSetMb = totalWorkingSetBytes / (1024.0 * 1024.0);

                DateTime now = DateTime.UtcNow;
                double wallSec = (now - _lastCpuSampleTime).TotalSeconds;
                double auraCpuPercent = 0.0;
                if (_lastTotalCpuTime != TimeSpan.Zero && wallSec > 0.1)
                {
                    double cpuDeltaSec = (totalCpuTime - _lastTotalCpuTime).TotalSeconds;
                    auraCpuPercent = Math.Max(0.0, (cpuDeltaSec / (wallSec * Environment.ProcessorCount)) * 100.0);
                }
                _lastTotalCpuTime = totalCpuTime;
                _lastCpuSampleTime = now;

                // 2. Đo RAM toàn hệ thống qua GlobalMemoryStatusEx
                var memStatus = new MEMORYSTATUSEX();
                uint sysRamPercent = 0;
                double sysTotalGb = 16.0;
                double sysUsedGb = 0.0;
                if (GlobalMemoryStatusEx(memStatus))
                {
                    sysRamPercent = memStatus.dwMemoryLoad;
                    sysTotalGb = memStatus.ullTotalPhys / (1024.0 * 1024.0 * 1024.0);
                    double availGb = memStatus.ullAvailPhys / (1024.0 * 1024.0 * 1024.0);
                    sysUsedGb = sysTotalGb - availGb;
                }

                // 3. Gửi sang giao diện Overlay
                if (_webView.CoreWebView2 != null)
                {
                    var payload = new
                    {
                        type = "host:telemetry",
                        auraRamMb = Math.Round(auraRamMb, 1),
                        auraCpuPercent = Math.Round(auraCpuPercent, 1),
                        sysRamPercent = sysRamPercent,
                        sysUsedGb = Math.Round(sysUsedGb, 2),
                        sysTotalGb = Math.Round(sysTotalGb, 2),
                        processCount = treePids.Count
                    };
                    _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(payload));
                }

                // Ghi log định kỳ mỗi 3 giây để kiểm chứng số liệu thật
                _telemetryTickCount++;
                if (_telemetryTickCount % 3 == 0)
                {
                    WriteLog("TELEMETRY",
                        $"AuraPrivateRAM={auraRamMb:F1}MB (WorkingSet={auraWorkingSetMb:F1}MB, Procs={treePids.Count}) | AuraCPU={auraCpuPercent:F1}% | SysRAM={sysRamPercent}% ({sysUsedGb:F2}/{sysTotalGb:F2}GB) | FPS={_lastReportedFps} | LiteMode={_lastReportedLiteMode}");
                }
            }
            catch (Exception ex)
            {
                WriteLog("WARN", $"Telemetry error: {ex.Message}");
            }
        }

        private HashSet<uint> GetProcessTreeIds(uint rootPid)
        {
            var result = new HashSet<uint> { rootPid };
            var parentMap = new List<(uint pid, uint ppid)>();

            IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return result;

            try
            {
                PROCESSENTRY32 entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Process32First(snap, ref entry))
                {
                    do
                    {
                        parentMap.Add((entry.th32ProcessID, entry.th32ParentProcessID));
                    } while (Process32Next(snap, ref entry));
                }
            }
            finally
            {
                CloseHandle(snap);
            }

            bool added;
            do
            {
                added = false;
                foreach (var item in parentMap)
                {
                    if (result.Contains(item.ppid) && !result.Contains(item.pid))
                    {
                        result.Add(item.pid);
                        added = true;
                    }
                }
            } while (added);

            return result;
        }

        private void WriteLog(string category, string message)
        {
            try
            {
                string line = $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] [{category}] {message}{Environment.NewLine}";
                File.AppendAllText(_logFilePath, line);
            }
            catch { }
        }
    }
}
