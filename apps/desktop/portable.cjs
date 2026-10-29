/**
 * 绿色版（便携）模式支持：把 userData 放到 exe 同目录，实现「不污染系统」。
 *
 * ## 为什么要单独一个文件
 * 这段决策逻辑（要不要便携、目录能不能写）最容易在打包后才暴露问题，
 * 而 main.cjs 一旦 require('electron') 就只能跑在 Electron 里。
 * 抽成不依赖 Electron 的纯函数，就能用 node 直接单测各种目录/权限/环境变量组合。
 *
 * ## 关键约束（改动前必读）
 * 1. **必须在 app ready 之前、且在任何 app.getPath() 之前调用**。
 *    userData 决定了单实例锁文件、Local Storage（含 neomd.lastVault、登录态）、缓存的位置，
 *    一旦有代码先读过旧路径，再 setPath 就会留下「半新半旧」的目录布局。
 * 2. **默认不开便携模式**。1.1.x 用户的仓库路径与登录态都记在 AppData 的 Local Storage 里，
 *    若升级后默认切到 exe 同目录，那些数据会「凭空消失」，用户看到的是"文档仓库丢了"。
 *    因此便携模式由用户显式开启（放一个 data/ 目录或 portable.txt，或设 NEOMD_PORTABLE=1）。
 * 3. 便携目录不可写（例如解压到 Program Files 又没管理员权限）时**必须优雅回退**到 AppData，
 *    否则程序直接起不来；回退原因写进启动日志，方便排查。
 * 4. 目录一律由 process.execPath / PORTABLE_EXECUTABLE_DIR 动态推算，不写任何绝对路径，
 *    这样 U 盘换盘符、解压到含中文或空格的路径都不受影响。
 */
'use strict';

const path = require('node:path');

/** 便携数据的子目录名（与 exe 同级） */
const PORTABLE_DATA_DIRNAME = 'data';
/** 显式开启便携模式的标记文件名（内容不解析，存在即生效） */
const PORTABLE_MARKER = 'portable.txt';

/**
 * 默认是否启用便携模式。
 *
 * 保持 false 是为了向后兼容（见文件头约束 2）。若将来产品决定绿色版一律便携，
 * 只需把这里改成 true —— 但必须同时提供一次性数据迁移，否则老用户会丢仓库与登录态。
 */
const DEFAULT_PORTABLE = false;

function isTruthyFlag(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function isFalsyFlag(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
}

/**
 * 便携根目录：exe 所在目录。
 *
 * - electron-builder 的 portable target 会注入 `PORTABLE_EXECUTABLE_DIR`（它指向用户实际放 exe 的目录，
 *   而 process.execPath 在那种自解压模式下指向临时解包目录，两者不同，所以优先用环境变量）；
 * - 绿色版 zip 解压后直接跑 `Neo MD.exe`，process.execPath 就是真实路径，取它的目录即可。
 *
 * @returns {string|null} 绝对路径；推算不出来时返回 null
 */
function resolvePortableRoot(env, execPath) {
  const fromEnv = env && typeof env.PORTABLE_EXECUTABLE_DIR === 'string' ? env.PORTABLE_EXECUTABLE_DIR.trim() : '';
  if (fromEnv) return path.resolve(fromEnv);
  if (typeof execPath === 'string' && execPath) return path.dirname(path.resolve(execPath));
  return null;
}

/**
 * 决定本次启动要不要用便携 userData 目录。
 *
 * @param {object} opts
 * @param {string|null} opts.root 便携根目录（exe 所在目录）
 * @param {object} [opts.env] 环境变量（默认空对象）
 * @param {boolean} opts.isPackaged 是否是打包后的运行态；开发态一律不启用
 * @param {(dir:string)=>boolean} opts.canWrite 传入目标目录，返回是否可创建且可写
 * @param {(p:string)=>boolean} [opts.exists] 存在性判断（默认不提供则跳过标记文件检测）
 * @returns {{portable:boolean, dir:string|null, reason:string}}
 */
function decidePortableUserData(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const env = options.env && typeof options.env === 'object' ? options.env : {};
  const root = typeof options.root === 'string' && options.root ? options.root : null;
  const canWrite = typeof options.canWrite === 'function' ? options.canWrite : () => false;
  const exists = typeof options.exists === 'function' ? options.exists : () => false;

  // 开发态（electron .）不启用：userData 应与正式版隔离，避免污染测试数据
  if (!options.isPackaged) return { portable: false, dir: null, reason: 'development' };

  // 显式关闭优先于一切（便于管理员强制走 AppData）
  if (isFalsyFlag(env.NEOMD_PORTABLE)) return { portable: false, dir: null, reason: 'disabled-by-env' };

  if (!root) return { portable: false, dir: null, reason: 'no-root' };

  const dataDir = path.join(root, PORTABLE_DATA_DIRNAME);

  // 开启条件：环境变量显式要求 / 已存在 data 目录 / 存在 portable.txt 标记
  let optIn = isTruthyFlag(env.NEOMD_PORTABLE) || DEFAULT_PORTABLE;
  let reason = optIn ? 'enabled-by-env' : '';
  if (!optIn) {
    try {
      if (exists(path.join(root, PORTABLE_MARKER))) {
        optIn = true;
        reason = 'marker-file';
      } else if (exists(dataDir)) {
        optIn = true;
        reason = 'data-dir-exists';
      }
    } catch {
      /* 存在性检查失败时按未开启处理 */
    }
  }
  if (!optIn) return { portable: false, dir: null, reason: 'not-opted-in' };

  // 目录不可写时回退 AppData：宁可"污染"一点，也不能让程序起不来
  let writable = false;
  try {
    writable = canWrite(dataDir) === true;
  } catch {
    writable = false;
  }
  if (!writable) return { portable: false, dir: null, reason: 'not-writable' };

  return { portable: true, dir: dataDir, reason };
}

module.exports = {
  PORTABLE_DATA_DIRNAME,
  PORTABLE_MARKER,
  DEFAULT_PORTABLE,
  resolvePortableRoot,
  decidePortableUserData,
};
