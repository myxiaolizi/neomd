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
    public const string AppVersion = "2.1.0";

    private Window? _window;

    public App()
    {
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
