using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Microsoft.UI.Xaml;
using Microsoft.Web.WebView2.Core;
using Windows.Graphics;

namespace NeoMD.WinUI3;

public sealed partial class ShellWindow : Window
{
    private LocalBackend _backend = null!;

    public ShellWindow()
    {
        InitializeComponent();
        Title = "Neo MD";
        ResizeToDefault();

        // 注册窗口句柄 + UI 调度队列，供 LocalBackend 的 dialog/win 桥使用
        RegisterHost();

        Closed += OnClosed;
        _ = InitializeAsync();
    }

    private void RegisterHost()
    {
        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            if (DispatcherQueue != null)
                WindowHost.Register(this, hwnd, DispatcherQueue);
        }
        catch
        {
            // 若句柄尚未就绪，初始化阶段再补一次
        }
    }

    private void OnClosed(object sender, WindowEventArgs args)
    {
        Closed -= OnClosed;
        try { _backend?.Stop(); } catch { /* ignore */ }
    }

    private void ResizeToDefault()
    {
        var scale = GetScale();
        var width = (int)(1440.0 / scale);
        var height = (int)(920.0 / scale);
        try
        {
            AppWindow.Resize(new Windows.Graphics.SizeInt32(width, height));
        }
        catch
        {
            /* AppWindow 未就绪时忽略 */
        }
    }

    private double GetScale()
    {
        try
        {
            var hwnd = WinRT.Interop.WindowNative.GetWindowHandle(this);
            if (hwnd != IntPtr.Zero)
            {
                var dpi = Win32.GetDpiForWindow(hwnd);
                if (dpi > 0) return dpi / 96.0;
            }
        }
        catch { /* ignore */ }
        return 1.0;
    }

    private async Task InitializeAsync()
    {
        try
        {
            string root = WebDistLocator.Resolve();
            _backend = new LocalBackend(root, "winui3");
            var baseUrl = _backend.Start();

            await WebView.EnsureCoreWebView2Async();

            var settings = WebView.CoreWebView2.Settings;
            settings.AreDevToolsEnabled = true;
            settings.AreDefaultContextMenusEnabled = true;

            // 首帧前注入 window.NeoMD
            var script = BridgeScript.Build();
            await WebView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);

            WebView.Source = new Uri(baseUrl);
        }
        catch (Exception ex)
        {
            Debug.WriteLine("[NeoMD.WinUI3] init failed: " + ex);
            TryShowError(ex);
        }
    }

    private void TryShowError(Exception ex)
    {
        try
        {
            if (WebView?.CoreWebView2 != null)
            {
                WebView.CoreWebView2.NavigateToString(
                    "<html><body style='font-family:Consolas,monospace;background:#1c1c1c;color:#eee;padding:24px'>" +
                    "<h3>Neo MD 启动失败</h3><pre style='white-space:pre-wrap'>" +
                    System.Net.WebUtility.HtmlEncode(ex.ToString()) +
                    "</pre></body></html>");
            }
        }
        catch { /* ignore */ }
    }
}