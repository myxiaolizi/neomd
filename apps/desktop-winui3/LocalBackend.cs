using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace NeoMD.WinUI3;

/// <summary>
/// 本地静态 HTTP 服务器：
///   1. 根目录 = apps/web/dist（或发布目录 web/dist）；
///   2. /api/* 反向代理到 https://md.zhengl.vip，并加请求头 x-neomd-shell；
///   3. /__bridge/{method} 处理 window.NeoMD.bridge 的调用（fs / dialog / paths / shell / win / secrets）。
/// </summary>
internal sealed class LocalBackend
{
    private const string Upstream = "https://md.zhengl.vip";
    private const string ShellHeader = "winui3";

    private readonly string _webRoot;
    private readonly HttpListener _listener;
    private readonly HttpClient _http;
    private readonly CancellationTokenSource _cts = new();
    private Task? _loop;
    private int _port = -1;
    private volatile bool _started;

    public int Port => _port;

    public LocalBackend(string webRoot, string shellTag = ShellHeader)
    {
        _webRoot = Path.GetFullPath(webRoot);
        _listener = new HttpListener();
        _http = new HttpClient(new HttpClientHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            UseCookies = false,
            // 关键：本机 WinINET 代理指向已关闭的 127.0.0.1:10801，反代必须直连上游
            UseProxy = false,
        })
        {
            Timeout = TimeSpan.FromSeconds(60),
        };
        _http.DefaultRequestHeaders.Add("x-neomd-shell", shellTag);
    }

    public string Start()
    {
        // 随机空闲端口，只绑定回环地址（127.0.0.1）
        using (var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
        {
            probe.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            _port = ((IPEndPoint)probe.LocalEndPoint!).Port;
        }

        _listener.Prefixes.Add($"http://127.0.0.1:{_port}/");
        _listener.Start();
        _started = true;
        _loop = Task.Run(ListenLoop);
        return $"http://127.0.0.1:{_port}/";
    }

    public void Stop()
    {
        try
        {
            _started = false;
            _cts.Cancel();
            _listener.Stop();
            _listener.Close();
            _http.Dispose();
        }
        catch { /* ignore */ }
    }

    private async Task ListenLoop()
    {
        while (_started && !_cts.IsCancellationRequested)
        {
            HttpListenerContext? ctx = null;
            try
            {
                ctx = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception) when (_cts.IsCancellationRequested || !_started)
            {
                return;
            }
            catch
            {
                return;
            }

            var captured = ctx;
            _ = Task.Run(() => HandleAsync(captured));
        }
    }

    private async Task HandleAsync(HttpListenerContext ctx)
    {
        try
        {
            var path = ctx.Request.Url?.AbsolutePath ?? "/";
            if (path.StartsWith("/__bridge", StringComparison.OrdinalIgnoreCase))
                await HandleBridgeAsync(ctx).ConfigureAwait(false);
            else if (path.Equals("/api", StringComparison.OrdinalIgnoreCase) ||
                     path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase))
                await ProxyAsync(ctx).ConfigureAwait(false);
            else
                ServeStatic(ctx);
        }
        catch (Exception ex)
        {
            try
            {
                RespondText(ctx, 500, "application/json; charset=utf-8",
                    JsonSerializer.Serialize(new { ok = false, error = ex.Message }));
            }
            catch { /* ignore */ }
        }
        finally
        {
            try { ctx.Response.Close(); } catch { /* ignore */ }
        }
    }

    /* ------------------------------------------------------------------ 桥 */

    private async Task HandleBridgeAsync(HttpListenerContext ctx)
    {
        // POST /__bridge/{method}   body = JSON 参数数组
        var rawMethod = ctx.Request.Url!.AbsolutePath.Trim('/');
        var method = rawMethod.StartsWith("__bridge", StringComparison.OrdinalIgnoreCase)
            ? rawMethod.Substring("__bridge".Length).Trim('/')
            : string.Empty;

        string body;
        using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            body = await reader.ReadToEndAsync().ConfigureAwait(false);

        object[] args;
        try
        {
            var parsed = JsonSerializer.Deserialize<JsonElement>(string.IsNullOrEmpty(body) ? "[]" : body);
            args = parsed.ValueKind == JsonValueKind.Array
                ? parsed.EnumerateArray().Select(e => e.Clone()).Cast<object>().ToArray()
                : Array.Empty<object>();
        }
        catch
        {
            args = Array.Empty<object>();
        }

        var result = await InvokeBridgeAsync(method, args).ConfigureAwait(false);
        var json = JsonSerializer.Serialize(result);
        RespondText(ctx, 200, "application/json; charset=utf-8", json);
    }

    private async Task<object> InvokeBridgeAsync(string method, object[] args)
    {
        try
        {
            object value = method switch
            {
                "fs.readText" => await FsReadText(Str(args, 0)).ConfigureAwait(false),
                "fs.readBinary" => await FsReadBinary(Str(args, 0)).ConfigureAwait(false),
                "fs.writeText" => await FsWriteText(Str(args, 0), Str(args, 1)).ConfigureAwait(false),
                "fs.writeBinary" => await FsWriteBinary(Str(args, 0), Str(args, 1)).ConfigureAwait(false),
                "fs.mkdirp" => await FsMkdirp(Str(args, 0)).ConfigureAwait(false),
                "fs.remove" => await FsRemove(Str(args, 0)).ConfigureAwait(false),
                "fs.rename" => await FsRename(Str(args, 0), Str(args, 1)).ConfigureAwait(false),
                "fs.list" => FsList(Str(args, 0)),
                "fs.exists" => FsExists(Str(args, 0)),
                "fs.stat" => FsStat(Str(args, 0)),
                "dialog.pickDirectory" => await DialogPickDirectory().ConfigureAwait(false),
                "dialog.pickFile" => await DialogPickFile(args).ConfigureAwait(false),
                "dialog.saveFile" => await DialogSaveFile(Str(args, 0)).ConfigureAwait(false),
                "paths.documents" => PathsDocuments(),
                "paths.userData" => App.DataDir,
                "paths.vaultDefault" => PathsVaultDefault(),
                "app.version" => App.AppVersion,
                "app.ready" => await AppReady(Str(args, 0), Str(args, 1), Str(args, 2)).ConfigureAwait(false),
                "shell.openExternal" => await ShellOpenExternal(Str(args, 0)).ConfigureAwait(false),
                "shell.showItemInFolder" => await ShellShowItemInFolder(Str(args, 0)).ConfigureAwait(false),
                "win.isMaximized" => WinIsMaximized(),
                "win.toggleMaximize" => WinToggleMaximize(),
                "win.minimize" => WinMinimize(),
                "win.close" => WinClose(),
                "secrets.encrypt" => SecretsEncrypt(Str(args, 0)),
                "secrets.decrypt" => SecretsDecrypt(Str(args, 0)),
                _ => throw new NotSupportedException("NOT_IMPLEMENTED"),
            };
            return new { ok = true, value };
        }
        catch (Exception ex)
        {
            var msg = ex is NotSupportedException ? "NOT_IMPLEMENTED" : ex.Message;
            return new { ok = false, error = msg };
        }
    }

    private static string Str(object?[] args, int i)
    {
        if (i >= args.Length) return "";
        return args[i] switch
        {
            string s => s,
            JsonElement j when j.ValueKind == JsonValueKind.String => j.GetString() ?? "",
            JsonElement j when j.ValueKind == JsonValueKind.Null => "",
            null => "",
            _ => args[i]?.ToString() ?? "",
        };
    }

    /* ------------------------------------------------------------------ fs */

    private static async Task<object> FsReadText(string path)
    {
        return await File.ReadAllTextAsync(SafePath(path), new UTF8Encoding(false)).ConfigureAwait(false);
    }

    private static async Task<object> FsReadBinary(string path)
    {
        var bytes = await File.ReadAllBytesAsync(SafePath(path)).ConfigureAwait(false);
        return Convert.ToBase64String(bytes);
    }

    private static async Task<object> FsWriteText(string path, string content)
    {
        var p = SafePath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(p) ?? "");
        await File.WriteAllTextAsync(p, content ?? "", new UTF8Encoding(false)).ConfigureAwait(false);
        return true;
    }

    private static async Task<object> FsWriteBinary(string path, string base64)
    {
        var p = SafePath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(p) ?? "");
        var bytes = Convert.FromBase64String(base64 ?? "");
        await File.WriteAllBytesAsync(p, bytes).ConfigureAwait(false);
        return true;
    }

    private static async Task<object> FsMkdirp(string path)
    {
        Directory.CreateDirectory(SafePath(path));
        return await Task.FromResult(true).ConfigureAwait(false);
    }

    private static async Task<object> FsRemove(string path)
    {
        var p = SafePath(path);
        if (Directory.Exists(p)) Directory.Delete(p, recursive: true);
        else if (File.Exists(p)) File.Delete(p);
        return await Task.FromResult(true).ConfigureAwait(false);
    }

    private static async Task<object> FsRename(string from, string to)
    {
        var a = SafePath(from);
        var b = SafePath(to);
        Directory.CreateDirectory(Path.GetDirectoryName(b) ?? "");
        if (Directory.Exists(a)) Directory.Move(a, b);
        else if (File.Exists(a)) File.Move(a, b, overwrite: false);
        return await Task.FromResult(true).ConfigureAwait(false);
    }

    private object FsList(string path)
    {
        var dir = SafePath(path);
        if (!Directory.Exists(dir)) return Array.Empty<object>();
        var entries = new List<object>();
        foreach (var full in Directory.EnumerateFileSystemEntries(dir))
        {
            var name = Path.GetFileName(full);
            if (string.IsNullOrEmpty(name) || name.StartsWith('.')) continue;
            try
            {
                if (Directory.Exists(full))
                {
                    entries.Add(new { name, isDirectory = true, size = 0L, mtime = 0L });
                }
                else
                {
                    var fi = new FileInfo(full);
                    entries.Add(new { name, isDirectory = false, size = fi.Length, mtime = ToUnixMs(fi.LastWriteTimeUtc) });
                }
            }
            catch { /* 无权限条目忽略 */ }
        }
        return entries;
    }

    private object FsExists(string path)
    {
        var p = SafePath(path);
        return File.Exists(p) || Directory.Exists(p);
    }

    private object FsStat(string path)
    {
        var p = SafePath(path);
        if (File.Exists(p))
        {
            var fi = new FileInfo(p);
            return new { size = fi.Length, mtime = ToUnixMs(fi.LastWriteTimeUtc) };
        }
        if (Directory.Exists(p))
        {
            var di = new DirectoryInfo(p);
            return new { size = 0L, mtime = ToUnixMs(di.LastWriteTimeUtc) };
        }
        return null!;
    }

    private static long ToUnixMs(DateTime utc) =>
        (long)(utc.ToUniversalTime() - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;

    private static string SafePath(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) throw new ArgumentException("非法路径（空）");
        return Path.GetFullPath(raw);
    }

    /* ------------------------------------------------------------------ dialog */

    private Task<string?> DialogPickDirectory() => RunDialog(async (hwnd) =>
    {
        var picker = new Windows.Storage.Pickers.FolderPicker();
        InitPicker(picker, hwnd);
        picker.FileTypeFilter.Add("*");
        var folder = await picker.PickSingleFolderAsync();
        return folder?.Path ?? null;
    });

    private Task<string?> DialogPickFile(object?[] args) => RunDialog(async (hwnd) =>
    {
        var picker = new Windows.Storage.Pickers.FileOpenPicker();
        InitPicker(picker, hwnd);
        var exts = Str(args, 0)
            .Split(new[] { ',', ';', '|', ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
            .Select(s => s.Trim().TrimStart('.', '*'))
            .Where(s => s.Length > 0)
            .ToArray();
        if (exts.Length > 0)
            foreach (var e in exts) picker.FileTypeFilter.Add("." + e);
        else
            picker.FileTypeFilter.Add("*");
        var file = await picker.PickSingleFileAsync();
        return file?.Path ?? null;
    });

    private Task<string?> DialogSaveFile(string defaultName) => RunDialog(async (hwnd) =>
    {
        var picker = new Windows.Storage.Pickers.FileSavePicker();
        InitPicker(picker, hwnd);
        var name = string.IsNullOrWhiteSpace(defaultName) ? "document.md" : defaultName;
        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        if (string.IsNullOrEmpty(ext)) ext = ".md";
        if (string.IsNullOrEmpty(stem)) stem = "document";
        picker.SuggestedFileName = stem;
        picker.FileTypeChoices.Add("Markdown", new List<string> { ext });
        var file = await picker.PickSaveFileAsync();
        return file?.Path ?? null;
    });

    private static async Task<string?> RunDialog(Func<IntPtr, Task<string?>> body)
    {
        var tcs = new TaskCompletionSource<string?>(TaskCreationOptions.RunContinuationsAsynchronously);
        var queued = WindowHost.TryEnqueue(async () =>
        {
            try
            {
                tcs.SetResult(await body(WindowHost.Hwnd));
            }
            catch (Exception ex)
            {
                tcs.SetException(ex);
            }
        });

        if (!queued)
        {
            // UI 队列尚未就绪：直接在当前线程尝试（初始化早期极少发生）
            try { tcs.SetResult(await body(IntPtr.Zero)); }
            catch (Exception ex) { tcs.SetException(ex); }
        }

        return await tcs.Task;
    }

    private static void InitPicker(object picker, IntPtr hwnd)
    {
        try
        {
            if (hwnd != IntPtr.Zero && Win32.IsWindow(hwnd))
                WinRT.Interop.InitializeWithWindow.Initialize(picker, hwnd);
        }
        catch { /* 无 owner 也能弹出 */ }
    }

    /* ------------------------------------------------------------------ paths / shell / win / secrets */

    private static async Task<object> AppReady(string url, string env, string version)
    {
        try
        {
            var boot = new
            {
                at = DateTimeOffset.Now.ToString("o"),
                url,
                env,
                version,
                up = true,
            };
            var p = Path.Combine(App.DataDir, "boot.json");
            await File.WriteAllTextAsync(p, JsonSerializer.Serialize(boot), new UTF8Encoding(false)).ConfigureAwait(false);
        }
        catch { /* ignore */ }
        return true;
    }

    private static string PathsDocuments() =>
        Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);

    private static string PathsVaultDefault()
    {
        var p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Neo MD");
        Directory.CreateDirectory(p);
        return p;
    }

    private static async Task<object> ShellOpenExternal(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var u) && (u.Scheme == "http" || u.Scheme == "https"))
        {
            await Windows.System.Launcher.LaunchUriAsync(u);
        }
        return true;
    }

    private static async Task<object> ShellShowItemInFolder(string path)
    {
        var p = SafePath(path);
        await Task.Run(() =>
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = "explorer.exe",
                Arguments = $"/select,\"{p}\"",
                UseShellExecute = true,
            });
        }).ConfigureAwait(false);
        return true;
    }

    private bool WinIsMaximized()
    {
        var h = WindowHost.Hwnd;
        return h != IntPtr.Zero && Win32.IsWindow(h) && Win32.IsZoomed(h);
    }

    private bool WinToggleMaximize()
    {
        var h = WindowHost.Hwnd;
        if (h == IntPtr.Zero || !Win32.IsWindow(h)) return false;
        var maximized = Win32.IsZoomed(h);
        WindowHost.TryEnqueue(() =>
        {
            var hw = WindowHost.Hwnd;
            if (hw == IntPtr.Zero || !Win32.IsWindow(hw)) return;
            Win32.ShowWindow(hw, maximized ? Win32.SW_RESTORE : Win32.SW_MAXIMIZE);
        });
        return !maximized;
    }

    private bool WinMinimize()
    {
        var h = WindowHost.Hwnd;
        if (h == IntPtr.Zero || !Win32.IsWindow(h)) return false;
        WindowHost.TryEnqueue(() =>
        {
            var hw = WindowHost.Hwnd;
            if (hw != IntPtr.Zero && Win32.IsWindow(hw)) Win32.ShowWindow(hw, Win32.SW_MINIMIZE);
        });
        return true;
    }

    private bool WinClose()
    {
        var h = WindowHost.Hwnd;
        if (h == IntPtr.Zero || !Win32.IsWindow(h)) return false;
        WindowHost.TryEnqueue(() =>
        {
            var hw = WindowHost.Hwnd;
            if (hw != IntPtr.Zero && Win32.IsWindow(hw)) Win32.PostMessage(hw, Win32.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
        });
        return true;
    }

    private static string SecretsEncrypt(string plain) =>
        Convert.ToBase64String(ProtectedDataLocal.Protect(Encoding.UTF8.GetBytes(plain ?? "")));

    private static string SecretsDecrypt(string cipher)
    {
        try
        {
            return Encoding.UTF8.GetString(ProtectedDataLocal.Unprotect(Convert.FromBase64String(cipher ?? "")));
        }
        catch
        {
            return "";
        }
    }

    /* ------------------------------------------------------------------ 反向代理 */

    private async Task ProxyAsync(HttpListenerContext ctx)
    {
        var req = ctx.Request;
        var rel = req.Url!.PathAndQuery ?? "/";
        var target = Upstream + rel;

        using var upstreamReq = new HttpRequestMessage(new HttpMethod(req.HttpMethod), target);

        if (req.HttpMethod != "GET" && req.HttpMethod != "HEAD" && req.HasEntityBody)
        {
            using var ms = new MemoryStream();
            await req.InputStream.CopyToAsync(ms).ConfigureAwait(false);
            upstreamReq.Content = new ByteArrayContent(ms.ToArray());
            if (req.ContentType != null)
                upstreamReq.Content.Headers.TryAddWithoutValidation("Content-Type", req.ContentType);
        }

        foreach (var key in req.Headers.AllKeys)
        {
            if (key == null) continue;
            if (key.Equals("Host", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Connection", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Keep-Alive", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Transfer-Encoding", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Proxy-Connection", StringComparison.OrdinalIgnoreCase) ||
                key.Equals("Upgrade", StringComparison.OrdinalIgnoreCase))
                continue;
            foreach (var v in req.Headers.GetValues(key) ?? Array.Empty<string>())
                if (!upstreamReq.Headers.TryAddWithoutValidation(key, v))
                    upstreamReq.Content?.Headers.TryAddWithoutValidation(key, v);
        }

        var resp = await _http.SendAsync(upstreamReq, HttpCompletionOption.ResponseHeadersRead, _cts.Token).ConfigureAwait(false);

        // 已开启自动解压，这里缓冲整个响应体再回写，避免复制受限头（Content-Length/Content-Encoding 会抛异常）。
        var body = await resp.Content.ReadAsByteArrayAsync().ConfigureAwait(false);

        ctx.Response.StatusCode = (int)resp.StatusCode;
        var ct = resp.Content.Headers.ContentType?.ToString();
        if (!string.IsNullOrEmpty(ct))
            ctx.Response.ContentType = ct;
        else
            ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength64 = body.LongLength;
        await ctx.Response.OutputStream.WriteAsync(body).ConfigureAwait(false);
    }

    /* ------------------------------------------------------------------ 静态文件 */

    private void ServeStatic(HttpListenerContext ctx)
    {
        var rel = Uri.UnescapeDataString(ctx.Request.Url!.AbsolutePath);
        rel = (rel ?? "/").TrimStart('/');
        if (rel.Length == 0) rel = "index.html";

        var full = Path.GetFullPath(Path.Combine(_webRoot, rel));
        var rootWithSep = _webRoot.EndsWith(Path.DirectorySeparatorChar)
            ? _webRoot
            : _webRoot + Path.DirectorySeparatorChar;

        if (!full.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase) && !full.Equals(_webRoot, StringComparison.OrdinalIgnoreCase))
        {
            RespondText(ctx, 403, "text/plain", "forbidden");
            return;
        }

        if (!File.Exists(full) || Directory.Exists(full))
        {
            full = Path.Combine(_webRoot, "index.html");
            rel = "index.html";
        }

        var ct = ContentTypeFor(rel);
        var bytes = File.ReadAllBytes(full);
        ctx.Response.StatusCode = 200;
        ctx.Response.ContentType = ct;
        ctx.Response.ContentLength64 = bytes.LongLength;
        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
    }

    private static string ContentTypeFor(string rel)
    {
        var ext = Path.GetExtension(rel).ToLowerInvariant();
        return ext switch
        {
            ".html" => "text/html; charset=utf-8",
            ".js" => "application/javascript; charset=utf-8",
            ".mjs" => "application/javascript; charset=utf-8",
            ".css" => "text/css; charset=utf-8",
            ".json" => "application/json; charset=utf-8",
            ".svg" => "image/svg+xml",
            ".png" => "image/png",
            ".ico" => "image/x-icon",
            ".woff" => "font/woff",
            ".woff2" => "font/woff2",
            ".wasm" => "application/wasm",
            ".txt" => "text/plain; charset=utf-8",
            _ => "application/octet-stream",
        };
    }

    private static void RespondText(HttpListenerContext ctx, int status, string contentType, string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        ctx.Response.StatusCode = status;
        ctx.Response.ContentType = contentType;
        ctx.Response.ContentLength64 = bytes.LongLength;
        ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
    }
}