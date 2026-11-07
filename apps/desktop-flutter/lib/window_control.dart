import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

/// Win32 窗口控制（2.1.0）。
///
/// 为什么需要它：Flutter 版的 `window.NeoMD.bridge.win.*` 在 2.0.0 时
/// 全部是 `NOT_IMPLEMENTED`，于是标题栏的「拖动 / 双击最大化 / 最小化 / 关闭」
/// 四条全部静默失效。Flutter 侧引入窗口管理插件会明显增大体积，
/// 这里直接用 dart:ffi 调 user32，零额外依赖。
///
/// 所有方法都应在平台主 isolate 调用。
class WindowControl {
  WindowControl._();

  static final WindowControl instance = WindowControl._();

  /// 本进程主窗口句柄。惰性查找一次后缓存 ——
  /// 每次调用都 EnumWindows 既慢又可能抓到别的窗口。
  int _hwnd = 0;

  static const int _swMinimize = 6;
  static const int _swMaximize = 3;
  static const int _swRestore = 9;
  static const int _wmClose = 0x0010;
  static const int _wmNcLButtonDown = 0x00A1;
  static const int _htCaption = 2;

  static final DynamicLibrary _u32 = DynamicLibrary.open('user32.dll');

  int get hwnd {
    if (_hwnd != 0) return _hwnd;
    _hwnd = _findOwnWindow();
    return _hwnd;
  }

  /// 找到本进程的顶层主窗口。
  ///
  /// 不用 `GetActiveWindow`：后台/开机自启时它返回空。
  /// 改用 `EnumWindows` + `GetWindowThreadProcessId` 按本进程 PID 精确匹配，
  /// 并跳过有 owner 的窗口（工具窗口/对话框），只取真正的顶层主窗口。
  int _findOwnWindow() {
    final enumWindows = _u32.lookupFunction<
        Int32 Function(Pointer<NativeFunction<Int32 Function(IntPtr, IntPtr)>>,
            IntPtr),
        int Function(
            Pointer<NativeFunction<Int32 Function(IntPtr, IntPtr)>>, int)>(
        'EnumWindows');
    final getPid = _u32.lookupFunction<Uint32 Function(IntPtr, Pointer<Uint32>),
        int Function(int, Pointer<Uint32>)>('GetWindowThreadProcessId');
    final getWindow = _u32.lookupFunction<IntPtr Function(IntPtr),
        int Function(int)>('GetWindow');

    final selfPid = pid;
    final pidPtr = calloc<Uint32>();
    final foundPtr = calloc<IntPtr>();
    NativeCallable<Int32 Function(IntPtr, IntPtr)>? callback;
    try {
      callback = NativeCallable<Int32 Function(IntPtr, IntPtr)>.isolateLocal(
        (int hWnd, int lParam) {
          getPid(hWnd, pidPtr);
          if (pidPtr.value != selfPid) return 1; // 继续枚举
          if (getWindow(hWnd) != 0) return 1; // 跳过有 owner 的窗口
          foundPtr.value = hWnd;
          return 0; // 找到即停止枚举
        },
        exceptionalReturn: -1,
      );
      enumWindows(callback.nativeFunction, 0);
      return foundPtr.value;
    } finally {
      callback?.close();
      calloc.free(pidPtr);
      calloc.free(foundPtr);
    }
  }

  bool isWindowValid(int h) =>
      h != 0 && _u32.lookupFunction<Int32 Function(IntPtr), int Function(int)>(
              'IsWindow')(h) !=
          0;

  bool isMaximized() {
    final h = hwnd;
    if (!isWindowValid(h)) return false;
    return _u32.lookupFunction<Int32 Function(IntPtr), int Function(int)>(
            'IsZoomed')(h) !=
        0;
  }

  void toggleMaximize() {
    final h = hwnd;
    if (!isWindowValid(h)) return;
    final show = _u32.lookupFunction<Int32 Function(IntPtr, Int32),
        int Function(int, int)>('ShowWindow');
    show(h, isMaximized() ? _swRestore : _swMaximize);
  }

  void minimize() {
    final h = hwnd;
    if (!isWindowValid(h)) return;
    _u32.lookupFunction<Int32 Function(IntPtr, Int32), int Function(int, int)>(
        'ShowWindow')(h, _swMinimize);
  }

  void close() {
    final h = hwnd;
    if (!isWindowValid(h)) return;
    _u32.lookupFunction<Int32 Function(IntPtr, Uint32, IntPtr, IntPtr),
        int Function(int, int, int, int)>('PostMessageW')(h, _wmClose, 0, 0);
  }

  /// 由页面标题栏拖拽区触发，交给系统做原生窗口拖动。
  void startDrag() {
    final h = hwnd;
    if (!isWindowValid(h)) return;
    _u32.lookupFunction<Int32 Function(), int Function()>('ReleaseCapture')();
    _u32.lookupFunction<IntPtr Function(IntPtr, Uint32, IntPtr, IntPtr),
        int Function(int, int, int, int)>('SendMessageW')(
        h, _wmNcLButtonDown, _htCaption, 0);
  }
}

/* ---------------- 非 Windows 平台的空实现 ---------------- */

/// 非 Windows 平台上的空实现，保证 Dart 侧代码能编译运行。
class NullWindowControl {
  bool isMaximized() => false;
  void toggleMaximize() {}
  void minimize() {}
  void close() {}
  void startDrag() {}
}

/// 按平台取窗口控制器
dynamic windowControl() =>
    Platform.isWindows ? WindowControl.instance : NullWindowControl();
