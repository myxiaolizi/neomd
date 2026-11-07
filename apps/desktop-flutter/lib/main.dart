import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:webview_windows/webview_windows.dart';

import 'window_control.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const NeoMdFlutterApp());
}

const String _injectScript = r'''<script>
(function () {
  function callBridge(method, args) {
    return fetch('/__bridge/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {})
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () {
          return { error: 'Bridge HTTP error ' + res.status };
        }).then(function (err) {
          throw new Error(err && err.error ? err.error : 'Bridge error');
        });
      }
      return res.json();
    }).then(function (payload) {
      if (payload && payload.__error) {
        throw new Error(payload.__error);
      }
      return payload ? payload.result : null;
    });
  }

  function notImplemented() {
    return Promise.reject(new Error('NOT_IMPLEMENTED'));
  }

  var openFileCallbacks = [];

  window.NeoMD = {
    env: 'desktop',
    version: '2.1.0',
    bridge: {
      fs: {
        readText: function (path) {
          return callBridge('fs.readText', { path: path });
        },
        readBinary: function (path) {
          return callBridge('fs.readBinary', { path: path }).then(function (b64) {
            var binaryString = atob(b64 || '');
            var len = binaryString.length;
            var bytes = new Uint8Array(len);
            for (var i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            return bytes;
          });
        },
        writeText: function (path, content) {
          return callBridge('fs.writeText', { path: path, content: content }).then(function () {});
        },
        writeBinary: function (path, data) {
          var u8 = data instanceof Uint8Array ? data : new Uint8Array(data || []);
          var CHUNK_SIZE = 0x8000;
          var parts = [];
          for (var i = 0; i < u8.length; i += CHUNK_SIZE) {
            parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK_SIZE)));
          }
          var b64 = btoa(parts.join(''));
          return callBridge('fs.writeBinary', { path: path, data: b64 }).then(function () {});
        },
        mkdirp: function (path) {
          return callBridge('fs.mkdirp', { path: path }).then(function () {});
        },
        remove: function (path) {
          return callBridge('fs.remove', { path: path }).then(function () {});
        },
        rename: function (from, to) {
          return callBridge('fs.rename', { from: from, to: to }).then(function () {});
        },
        list: function (path) {
          return callBridge('fs.list', { path: path });
        },
        exists: function (path) {
          return callBridge('fs.exists', { path: path });
        },
        stat: function (path) {
          return callBridge('fs.stat', { path: path });
        }
      },
      dialog: {
        pickDirectory: notImplemented,
        pickFile: notImplemented,
        saveFile: notImplemented
      },
      paths: {
        documents: function () {
          return callBridge('paths.documents', {});
        },
        userData: function () {
          return callBridge('paths.userData', {});
        },
        vaultDefault: function () {
          return callBridge('paths.vaultDefault', {});
        }
      },
      secrets: {
        encrypt: notImplemented,
        decrypt: notImplemented
      },
      shell: {
        openExternal: notImplemented,
        showItemInFolder: notImplemented
      },
      win: {
        // 2.1.0：接上真实窗口控制。2.0.0 时这四个全是 NOT_IMPLEMENTED，
        // 导致标题栏拖拽、双击最大化、最小化、关闭全部静默失效。
        isMaximized: function () { return callBridge('win.isMaximized', {}); },
        toggleMaximize: function () { return callBridge('win.toggleMaximize', {}); },
        minimize: function () { return callBridge('win.minimize', {}); },
        close: function () { return callBridge('win.close', {}); },
        startDrag: function () { return callBridge('win.startDrag', {}); },
        onStateChange: function () {}
      },
      app: {
        version: function () {
          return Promise.resolve('2.1.0');
        },
        onOpenFile: function (cb) {
          if (typeof cb === 'function') {
            openFileCallbacks.push(cb);
          }
        }
      }
    }
  };

  window.addEventListener('DOMContentLoaded', function () {
    setTimeout(function () {
      callBridge('metrics.report', {
        env: window.NeoMD && window.NeoMD.env,
        version: window.NeoMD && window.NeoMD.version,
        title: document.title,
        textSample: (document.body && document.body.innerText || '').slice(0, 300),
        perfNow: Math.round(performance.now()),
        timestamp: Date.now()
      }).catch(function () {});
    }, 800);
  });
})();
</script>''';

const Map<String, String> _mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

class LocalHostServer {
  HttpServer? _server;
  final HttpClient _httpClient = HttpClient();
  late final String exeDir;
  late final String dataDir;
  late final String distDir;
  final List<Map<String, dynamic>> _metrics = [];

  int get port => _server?.port ?? 0;

  Future<int> start() async {
    exeDir = File(Platform.resolvedExecutable).parent.path;
    dataDir = '$exeDir${Platform.pathSeparator}data';
    await Directory(dataDir).create(recursive: true);
    distDir = _resolveDistDir(exeDir);

    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    await File('$dataDir${Platform.pathSeparator}server-port.txt')
        .writeAsString('${_server!.port}', flush: true);
    _server!.listen(_handleRequest, onError: (e) {});
    return _server!.port;
  }

  String _resolveDistDir(String baseExeDir) {
    final candidates = <String>[
      // 绿色版首选：exe 同级 web-dist/
      '$baseExeDir\\web-dist',
      '$baseExeDir\\data\\web-dist',
    ];
    for (final c in candidates) {
      final f = File('$c\\index.html');
      if (f.existsSync()) {
        return Directory(c).resolveSymbolicLinksSync();
      }
    }

    // 开发态兜底：从 exe 位置逐级向上找 apps/web/dist。
    // 注意这里**不能**写死绝对路径（例如 C:\Data\BAC\neomd\...），
    // 否则打出来的绿色版一旦拷到别的机器/别的目录，就会指到一个不存在的路径，
    // 表现为窗口空白或 404。绿色版必须只依赖自身所在目录的相对位置。
    var dir = Directory(baseExeDir).absolute;
    for (var i = 0; i < 8; i++) {
      final cand = File('${dir.path}\\apps\\web\\dist\\index.html');
      if (cand.existsSync()) {
        return Directory('${dir.path}\\apps\\web\\dist').resolveSymbolicLinksSync();
      }
      final parent = dir.parent;
      if (parent.path == dir.path) break;
      dir = parent;
    }

    // 实在找不到就返回 exe 同级的空目录，让上层给出明确的错误提示，
    // 而不是悄悄去读一个本机才存在的绝对路径。
    return '$baseExeDir\\web-dist';
  }

  Future<void> _handleRequest(HttpRequest req) async {
    try {
      final path = req.uri.path;
      if (path.startsWith('/__bridge/')) {
        await _handleBridge(req, path.substring('/__bridge/'.length));
        return;
      }
      if (path.startsWith('/api/')) {
        await _handleProxy(req);
        return;
      }
      await _handleStatic(req);
    } catch (e) {
      try {
        req.response.statusCode = HttpStatus.internalServerError;
        req.response.write('Internal Server Error: $e');
        await req.response.close();
      } catch (_) {}
    }
  }

  Future<void> _handleBridge(HttpRequest req, String method) async {
    req.response.headers.contentType = ContentType.json;
    try {
      final bodyStr = await utf8.decoder.bind(req).join();
      final Map<String, dynamic> args = bodyStr.isEmpty
          ? <String, dynamic>{}
          : (jsonDecode(bodyStr) as Map<String, dynamic>);

      dynamic result;
      switch (method) {
        case 'fs.readText':
          final p = args['path'] as String;
          result = await File(p).readAsString(encoding: utf8);
          break;
        case 'fs.readBinary':
          final p = args['path'] as String;
          final bytes = await File(p).readAsBytes();
          result = base64Encode(bytes);
          break;
        case 'fs.writeText':
          final p = args['path'] as String;
          final content = args['content'] as String? ?? '';
          final f = File(p);
          await f.parent.create(recursive: true);
          await f.writeAsString(content, encoding: utf8, flush: true);
          result = null;
          break;
        case 'fs.writeBinary':
          final p = args['path'] as String;
          final b64 = args['data'] as String? ?? '';
          final bytes = base64Decode(b64);
          final f = File(p);
          await f.parent.create(recursive: true);
          await f.writeAsBytes(bytes, flush: true);
          result = null;
          break;
        case 'fs.mkdirp':
          final p = args['path'] as String;
          await Directory(p).create(recursive: true);
          result = null;
          break;
        case 'fs.remove':
          final p = args['path'] as String;
          final type = await FileSystemEntity.type(p, followLinks: false);
          if (type == FileSystemEntityType.directory) {
            await Directory(p).delete(recursive: true);
          } else if (type != FileSystemEntityType.notFound) {
            await File(p).delete();
          }
          result = null;
          break;
        case 'fs.rename':
          final from = args['from'] as String;
          final to = args['to'] as String;
          final type = await FileSystemEntity.type(from, followLinks: false);
          if (type == FileSystemEntityType.directory) {
            await Directory(from).rename(to);
          } else {
            await File(to).parent.create(recursive: true);
            await File(from).rename(to);
          }
          result = null;
          break;
        case 'fs.list':
          final p = args['path'] as String;
          final dir = Directory(p);
          if (!await dir.exists()) {
            result = <Map<String, dynamic>>[];
          } else {
            final entries = <Map<String, dynamic>>[];
            await for (final entity in dir.list(followLinks: false)) {
              final st = await entity.stat();
              final name = entity.uri.pathSegments
                  .where((s) => s.isNotEmpty)
                  .lastOrNull ??
                  entity.path.split(Platform.pathSeparator).last;
              entries.add({
                'name': name,
                'isDirectory': st.type == FileSystemEntityType.directory,
                'size': st.size,
                'mtime': st.modified.millisecondsSinceEpoch,
              });
            }
            result = entries;
          }
          break;
        case 'fs.exists':
          final p = args['path'] as String;
          final type = await FileSystemEntity.type(p, followLinks: true);
          result = type != FileSystemEntityType.notFound;
          break;
        case 'fs.stat':
          final p = args['path'] as String;
          final type = await FileSystemEntity.type(p, followLinks: true);
          if (type == FileSystemEntityType.notFound) {
            result = null;
          } else {
            final st = await FileStat.stat(p);
            if (st.type == FileSystemEntityType.notFound) {
              result = null;
            } else {
              result = {
                'size': st.size,
                'mtime': st.modified.millisecondsSinceEpoch,
              };
            }
          }
          break;
        case 'paths.documents':
          final userProfile = Platform.environment['USERPROFILE'] ?? exeDir;
          final docs = '$userProfile\\Documents';
          result = Directory(docs).existsSync() ? docs : userProfile;
          break;
        case 'paths.userData':
          final ud = '$dataDir\\userData';
          await Directory(ud).create(recursive: true);
          result = ud;
          break;
        case 'paths.vaultDefault':
          final vd = '$dataDir\\vault';
          await Directory(vd).create(recursive: true);
          result = vd;
          break;
        case 'app.version':
          result = '2.1.0';
          break;
        case 'win.isMaximized':
          result = windowControl().isMaximized();
          break;
        case 'win.toggleMaximize':
          windowControl().toggleMaximize();
          result = true;
          break;
        case 'win.minimize':
          windowControl().minimize();
          result = true;
          break;
        case 'win.close':
          windowControl().close();
          result = true;
          break;
        case 'win.startDrag':
          windowControl().startDrag();
          result = true;
          break;
        case 'metrics.report':
          _metrics.add(args);
          await File('$dataDir${Platform.pathSeparator}runtime-probe.json')
              .writeAsString(jsonEncode(args), flush: true);
          result = true;
          break;
        default:
          req.response.statusCode = HttpStatus.notImplemented;
          req.response.write(jsonEncode({'__error': 'NOT_IMPLEMENTED'}));
          await req.response.close();
          return;
      }

      req.response.statusCode = HttpStatus.ok;
      req.response.write(jsonEncode({'result': result}));
      await req.response.close();
    } catch (e) {
      req.response.statusCode = HttpStatus.badRequest;
      req.response.write(jsonEncode({'__error': e.toString()}));
      await req.response.close();
    }
  }

  Future<void> _handleProxy(HttpRequest req) async {
    final targetUri = Uri.parse('https://md.zhengl.vip').replace(
      path: req.uri.path,
      query: req.uri.query.isEmpty ? null : req.uri.query,
    );
    try {
      final upReq = await _httpClient.openUrl(req.method, targetUri);
      req.headers.forEach((name, values) {
        final lower = name.toLowerCase();
        if (lower == 'host' || lower == 'connection' || lower == 'content-length') {
          return;
        }
        for (final v in values) {
          upReq.headers.add(name, v);
        }
      });
      upReq.headers.set('host', 'md.zhengl.vip');
      upReq.headers.set('x-neomd-shell', 'flutter');
      upReq.headers.set('x-forwarded-host', req.headers.value('host') ?? '');
      /*
       * 强制上游不要压缩响应（2.1.0 修复「登录成功但仓库为空」）。
       *
       * 之前把浏览器的 accept-encoding: gzip 透传上去，上游回 gzip 体；
       * 而下面回写响应时又跳过了 content-encoding 头（属于逐跳头），
       * 于是浏览器拿到「无编码标记的 gzip 字节」→ JSON.parse 失败。
       * /api/vaults 这种大响应必挂，登录（小响应）却能成功，
       * 用户看到的就是「登录了但仓库不同步」。
       *
       * 要求 identity 后响应体是明文 JSON，与其它壳行为一致。
       */
      upReq.headers.set('accept-encoding', 'identity');

      final bodyBytes = await req.fold<List<int>>(<int>[], (prev, el) => prev..addAll(el));
      if (bodyBytes.isNotEmpty) {
        upReq.contentLength = bodyBytes.length;
        upReq.add(bodyBytes);
      }

      final upRes = await upReq.close();
      req.response.statusCode = upRes.statusCode;
      upRes.headers.forEach((name, values) {
        final lower = name.toLowerCase();
        if (lower == 'transfer-encoding' || lower == 'content-encoding' || lower == 'content-length') {
          return;
        }
        for (final v in values) {
          req.response.headers.add(name, v);
        }
      });
      await upRes.pipe(req.response);
    } catch (e) {
      req.response.statusCode = HttpStatus.badGateway;
      req.response.headers.contentType = ContentType.json;
      req.response.write(jsonEncode({
        'error': 'UPSTREAM_FAIL',
        'message': e.toString(),
      }));
      await req.response.close();
    }
  }

  Future<void> _handleStatic(HttpRequest req) async {
    String relPath = Uri.decodeComponent(req.uri.path);
    if (relPath == '/' || relPath.isEmpty) {
      relPath = '/index.html';
    }
    final normalizedDist = Directory(distDir).uri.toFilePath(windows: true);
    final candidatePath = File('$normalizedDist${relPath.replaceAll('/', '\\')}').absolute.path;

    if (!candidatePath.toLowerCase().startsWith(normalizedDist.toLowerCase())) {
      req.response.statusCode = HttpStatus.forbidden;
      req.response.write('Forbidden');
      await req.response.close();
      return;
    }

    File file = File(candidatePath);
    if (await Directory(candidatePath).exists()) {
      file = File('$candidatePath\\index.html');
    }

    if (await file.exists()) {
      await _serveFile(req, file);
    } else {
      // SPA fallback to index.html
      final indexFile = File('$normalizedDist\\index.html');
      if (await indexFile.exists()) {
        await _serveFile(req, indexFile);
      } else {
        req.response.statusCode = HttpStatus.notFound;
        req.response.write('Not Found');
        await req.response.close();
      }
    }
  }

  Future<void> _serveFile(HttpRequest req, File file) async {
    final pathLower = file.path.toLowerCase();
    String ext = '';
    final dotIdx = pathLower.lastIndexOf('.');
    if (dotIdx != -1) {
      ext = pathLower.substring(dotIdx);
    }

    final mime = _mimeTypes[ext] ?? 'application/octet-stream';
    req.response.headers.set('content-type', mime);
    req.response.headers.set('cache-control', 'no-store');

    if (ext == '.html') {
      final html = await file.readAsString(encoding: utf8);
      final injected = html.replaceFirst('<head>', '<head>\n$_injectScript');
      final bytes = utf8.encode(injected);
      req.response.statusCode = HttpStatus.ok;
      req.response.contentLength = bytes.length;
      req.response.add(bytes);
      await req.response.close();
    } else {
      final bytes = await file.readAsBytes();
      req.response.statusCode = HttpStatus.ok;
      req.response.contentLength = bytes.length;
      req.response.add(bytes);
      await req.response.close();
    }
  }
}

class NeoMdFlutterApp extends StatelessWidget {
  const NeoMdFlutterApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      title: 'Neo MD',
      debugShowCheckedModeBanner: false,
      home: NeoMdShellPage(),
    );
  }
}

class NeoMdShellPage extends StatefulWidget {
  const NeoMdShellPage({super.key});

  @override
  State<NeoMdShellPage> createState() => _NeoMdShellPageState();
}

class _NeoMdShellPageState extends State<NeoMdShellPage> {
  final WebviewController _controller = WebviewController();
  final LocalHostServer _server = LocalHostServer();
  bool _ready = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _initShell();
  }

  Future<void> _initShell() async {
    try {
      final port = await _server.start();
      final webviewDataDir = '${_server.dataDir}\\webview2';
      await Directory(webviewDataDir).create(recursive: true);

      try {
        await WebviewController.initializeEnvironment(
          userDataPath: webviewDataDir,
        );
      } catch (_) {
        // Ignore if environment was already initialized
      }

      await _controller.initialize();
      await _controller.setBackgroundColor(const Color(0xFF1E1E1E));
      await _controller.setPopupWindowPolicy(WebviewPopupWindowPolicy.allow);
      await _controller.loadUrl('http://127.0.0.1:$port/');

      if (!mounted) return;
      setState(() {
        _ready = true;
      });
    } on PlatformException catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'PlatformException(${e.code}): ${e.message}';
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
      });
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        backgroundColor: const Color(0xFF1E1E1E),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24.0),
            child: SelectableText(
              'Neo MD (Flutter Shell) failed to initialize:\n$_error',
              style: const TextStyle(color: Colors.redAccent, fontSize: 14),
            ),
          ),
        ),
      );
    }

    if (!_ready || !_controller.value.isInitialized) {
      return const Scaffold(
        backgroundColor: Color(0xFF1E1E1E),
        body: Center(
          child: SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(strokeWidth: 2.5),
          ),
        ),
      );
    }

    return Scaffold(
      backgroundColor: const Color(0xFF1E1E1E),
      body: SizedBox.expand(
        child: Webview(_controller),
      ),
    );
  }
}
