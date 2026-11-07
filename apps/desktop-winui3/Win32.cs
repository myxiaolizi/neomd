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

    /* -------- 标题栏合并（2.1.0）-------- */

    /// <summary>取窗口样式位（GWL_STYLE = -16）</summary>
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    internal static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    internal static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int nIndex, IntPtr dwNewLong);

    [DllImport("user32.dll")]
    internal static extern bool SetWindowPos(
        IntPtr hWnd,
        IntPtr hWndInsertAfter,
        int x,
        int y,
        int cx,
        int cy,
        uint uFlags
    );

    /// <summary>释放鼠标捕获（拖动前必须调用）</summary>
    [DllImport("user32.dll")]
    internal static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    internal static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    internal const int GWL_STYLE = -16;
    internal const int WS_CAPTION = 0x00C00000;
    internal const int WS_THICKFRAME = 0x00040000;

    internal const uint WM_NCLBUTTONDOWN = 0x00A1;
    internal static readonly IntPtr HTCAPTION = new(2);

    internal const uint SWP_NOSIZE = 0x0001;
    internal const uint SWP_NOMOVE = 0x0002;
    internal const uint SWP_NOZORDER = 0x0004;
    internal const uint SWP_FRAMECHANGED = 0x0020;
}
