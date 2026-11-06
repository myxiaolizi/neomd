using System;
using System.Runtime.InteropServices;

namespace NeoMD.WinUI3;

internal static class Win32
{
    [DllImport("user32.dll")]
    internal static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    internal static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    internal static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    internal static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    internal static extern bool IsZoomed(IntPtr hWnd);

    /// <summary>
    /// 判断句柄是否仍是有效窗口。
    /// 窗口关闭后 hwnd 会失效，如果继续拿它去 ShowWindow/IsZoomed 会静默失败或异常，
    /// 所以所有 win.* 桥调用前都先用它校验一次。
    /// </summary>
    [DllImport("user32.dll")]
    internal static extern bool IsWindow(IntPtr hWnd);

    internal const int SW_MINIMIZE = 6;
    internal const int SW_MAXIMIZE = 3;
    internal const int SW_RESTORE = 9;
    internal const uint WM_CLOSE = 0x0010;
}
