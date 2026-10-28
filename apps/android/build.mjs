/**
 * Android 打包：Capacitor 同步 Web 产物后用 Gradle 构建签名 APK。
 * 依赖 tools/jdk21 与 tools/android-sdk（由 setup-toolchain.ps1 准备）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const webDist = path.join(repo, 'apps', 'web', 'dist');
const androidDir = path.join(here, 'android');
const outDir = path.join(repo, 'dist-artifacts');
const jdk = path.join(repo, 'tools', 'jdk21');
const sdk = path.join(repo, 'tools', 'android-sdk');

if (!existsSync(path.join(webDist, 'index.html'))) {
  console.error('[android] 缺少 Web 产物，请先执行 pnpm --filter @neomd/web build');
  process.exit(1);
}
if (!existsSync(path.join(jdk, 'bin', 'java.exe'))) {
  console.error('[android] 缺少 JDK，请先执行 pwsh tools/setup-toolchain.ps1');
  process.exit(1);
}
if (!existsSync(path.join(sdk, 'platforms'))) {
  console.error('[android] 缺少 Android SDK，请先执行 pwsh tools/setup-toolchain.ps1');
  process.exit(1);
}

const env = {
  ...process.env,
  JAVA_HOME: jdk,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  PATH: `${path.join(jdk, 'bin')};${path.join(sdk, 'platform-tools')};${process.env.PATH}`,
  GRADLE_USER_HOME: path.join(repo, 'tools', '.gradle'),
};

function run(cmd, args, cwd) {
  console.log('[android]', cmd, args.join(' '));
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit', env, shell: true });
  if (res.status !== 0) {
    console.error('[android] 命令失败，退出码', res.status);
    process.exit(res.status ?? 1);
  }
}

mkdirSync(env.GRADLE_USER_HOME, { recursive: true });

// 1. 首次生成 android 工程
if (!existsSync(path.join(androidDir, 'app'))) {
  console.log('[android] 初始化 Capacitor Android 工程');
  run('npx', ['cap', 'add', 'android'], here);
}

// 2. 同步 Web 产物
run('npx', ['cap', 'sync', 'android'], here);

// 3. 生成签名密钥（若不存在）
const keystore = path.join(here, 'neomd-release.keystore');
const keystoreInfo = path.join(here, 'keystore.properties');
//
// 安全说明（1.1.8 修复）：此处历史上把发布签名密码**硬编码为字面量**，
// 一旦仓库公开，任何人可用该密码给 APK 签名、冒充本应用发布更新。
// 现在改为从环境变量读取，缺失时明确报错，绝不写入任何默认值。
//   PowerShell: $env:ANDROID_KEYSTORE_PASSWORD='<你的密码>'
//   bash:       export ANDROID_KEYSTORE_PASSWORD='<你的密码>'
const KEYSTORE_PASSWORD = (process.env.ANDROID_KEYSTORE_PASSWORD || '').trim();
if (!existsSync(keystore) && !KEYSTORE_PASSWORD) {
  console.error('[android] 缺少环境变量 ANDROID_KEYSTORE_PASSWORD，无法生成发布签名密钥。');
  console.error('         请先设置该变量（不要写进代码或任何会被提交的文件）。');
  process.exit(1);
}
if (!existsSync(keystore)) {
  console.log('[android] 生成发布签名密钥');
  run(path.join(jdk, 'bin', 'keytool.exe'), [
    '-genkeypair',
    '-keystore',
    keystore,
    '-alias',
    'neomd',
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '10000',
    '-storepass',
    KEYSTORE_PASSWORD,
    '-keypass',
    KEYSTORE_PASSWORD,
    '-dname',
    '"CN=Neo MD, OU=Neo MD, O=Neo MD, L=Guangzhou, ST=Guangdong, C=CN"',
  ]);
  writeFileSync(
    keystoreInfo,
    ['storeFile=neomd-release.keystore', `storePassword=${KEYSTORE_PASSWORD}`, 'keyAlias=neomd', `keyPassword=${KEYSTORE_PASSWORD}`, ''].join(
      '\n',
    ),
    'utf8',
  );
}

// 4. 注入签名配置到 build.gradle（仅在未注入时执行一次）
const gradlePath = path.join(androidDir, 'app', 'build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
if (!gradle.includes('keystorePropsFile')) {
  gradle = gradle.replace(
    /android\s*\{/,
    `def keystorePropsFile = rootProject.file("keystore.properties")
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) {
    keystoreProps.load(new FileInputStream(keystorePropsFile))
}

android {`,
  );
  gradle = gradle.replace(
    /buildTypes\s*\{[\s\S]*?\n    \}/,
    `signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                storeFile rootProject.file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig keystorePropsFile.exists() ? signingConfigs.release : signingConfigs.debug
            minifyEnabled false
            shrinkResources false
        }
    }`,
  );
  writeFileSync(gradlePath, gradle, 'utf8');
  console.log('[android] 已注入签名配置');
}

// keystore 需放在 android 根目录供 rootProject.file 解析
const rootKeystore = path.join(androidDir, 'neomd-release.keystore');
if (existsSync(keystore) && !existsSync(rootKeystore)) copyFileSync(keystore, rootKeystore);
const rootProps = path.join(androidDir, 'keystore.properties');
if (existsSync(keystoreInfo)) copyFileSync(keystoreInfo, rootProps);

// 5. 构建
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', ['assembleRelease', '--no-daemon'], androidDir);

// 6. 收集 APK
const apkPath = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!existsSync(apkPath)) {
  console.error('[android] 未找到 APK:', apkPath);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, 'NeoMD-1.1.7.apk');
copyFileSync(apkPath, target);
console.log('[android] APK 已生成:', target);
