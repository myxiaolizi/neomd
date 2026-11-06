using System;
using System.IO;

namespace NeoMD.WinUI3;

internal static class WebDistLocator
{
    /// <summary>
    /// 定位构建好的 Web 产物（apps/web/dist）。
    /// 发布目录用的是 exe 同级 webdist/；开发态回退到源码仓库路径。
    /// </summary>
    public static string Resolve()
    {
        var candidates = new[]
        {
            // 发布目录：NeoMD-2.0.0-winui3-x64/NeoMD.WinUI3.exe 同级的 webdist/
            Path.Combine(AppContext.BaseDirectory, "webdist"),
            // 发布目录：exe 同级 web/dist
            Path.Combine(AppContext.BaseDirectory, "web", "dist"),
            // 源码工程内直接运行（bin/.../NeoMD.WinUI3.exe 往上走）
            Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "apps", "web", "dist"),
            // 绝对兜底（本机工程路径）
            @"C:\Data\BAC\neomd\neomd-V1\apps\web\dist",
        };

        foreach (var c in candidates)
        {
            try
            {
                var full = Path.GetFullPath(c);
                if (File.Exists(Path.Combine(full, "index.html")))
                    return full;
            }
            catch { /* ignore */ }
        }

        throw new InvalidOperationException(
            "找不到 Web 构建产物 webdist/（已尝试：\n" + string.Join("\n", candidates) + "\n）");
    }
}