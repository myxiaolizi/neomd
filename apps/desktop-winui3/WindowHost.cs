using System;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;

namespace NeoMD.WinUI3;

/// <summary>
/// 供后端子线程访问 UI 线程与窗口句柄的静态桥。
/// ShellWindow 创建时注册自身。
/// </summary>
internal static class WindowHost
{
    private static ShellWindow? _window;
    private static IntPtr _hwnd;
    private static DispatcherQueue? _queue;

    public static void Register(ShellWindow window, IntPtr hwnd, DispatcherQueue queue)
    {
        _window = window;
        _hwnd = hwnd;
        _queue = queue;
    }

    public static IntPtr Hwnd => _hwnd;

    public static DispatcherQueue? Queue => _queue;

    /// <summary>在 UI 线程排队执行；队列不可用时返回 false。</summary>
    public static bool TryEnqueue(Action action)
    {
        var q = _queue;
        if (q == null) return false;
        return q.TryEnqueue(() => action());
    }
}