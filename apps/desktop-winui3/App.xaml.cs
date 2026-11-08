// WinUI 3 应用入口。
//
// 注意这里必须是 partial 且**不要**自己写 Main()：
// App.xaml 声明了 x:Class="NeoMD.WinUI3.App"，XAML 编译器会生成
// InitializeComponent() 与 Main()。自己再写 Main() 会报「程序包含多个入口点」。
//
// 本类型同时承载两个全局常量/路径，供 LocalBackend / ProtectedDataLocal 使用：
//   App.DataDir     绿色版可写数据目录（exe 同级 data/）
//   App.AppVersion  版本号字符串，与其它三版保持一致

using System;
using System.IO;
using Microsoft.UI.Xaml;

namespace NeoMD.WinUI3;

public partial class App : Application
{
    /// <summary>应用版本，四个壳统一 2.1.0。</summary>
    public const string AppVersion = "2.3.0";

    private Window? _window;

    public App()
    {
        /*
         * 绿色版 WebView2 profile 重定向（必须在任何 WebView2 初始化之前）。
         *
         * 目的：让登录态（cookie/localStorage）跟着 exe 目录走，而不是落在
         * %LOCALAPPDATA%。绿色版要求「整包拷走即可用、不往系统盘写东西」，
         * 且重启后必须还能保持登录。
         *
         * 为什么不用 CoreWebView2Environment.CreateAsync 指定目录：
         * 本壳的 WebView2 由 WindowsAppSDK 1.7 作为传递依赖引入
         * （Microsoft.Web.WebView2 1.0.2903.40），该包在编译期暴露的只有 WinRT
         * 投影 Microsoft.Web.WebView2.Core.Projection.dll，其中并不包含
         * CreateAsync 的可用托管重载 —— 无论写 2 参还是 3 参都会 CS1501 编译失败。
         *
         * WEBVIEW2_USER_DATA_FOLDER 是 WebView2 官方的进程级环境变量，
         * 在创建环境时被读取，语义与 CreateAsync 的 userDataFolder 参数等价。
         * 放在构造函数里、且在 ShellWindow 创建之前设置，保证先于任何 WebView2 初始化。
         */
        try
        {
            var profileDir = Path.Combine(DataDir, "webview2");
            Directory.CreateDirectory(profileDir);
            Environment.SetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", profileDir, EnvironmentVariableTarget.Process);
        }
        catch
        {
            // 目录不可写（只读介质等）时退回默认 profile：功能可用性优先，
            // 只是登录态不再随目录迁移。
        }

        InitializeComponent();
    }

    /// <summary>
    /// 绿色版可写目录：exe 同级 data/。
    /// 用 exe 目录而不是 %LOCALAPPDATA%，这样整个目录可以整包拷走，
    /// 符合「绿色版」要求；同时保证目录一定存在。
    /// </summary>
    public static string DataDir
    {
        get
        {
            var exe = Environment.ProcessPath;
            var baseDir = string.IsNullOrEmpty(exe)
                ? AppContext.BaseDirectory
                : (Path.GetDirectoryName(exe) ?? AppContext.BaseDirectory);
            var dir = Path.Combine(baseDir, "data");
            Directory.CreateDirectory(dir);
            return dir;
        }
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        _window = new ShellWindow();
        _window.Activate();
    }
}
