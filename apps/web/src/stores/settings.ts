import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import type { EditorColorScheme, ServerSettings, Settings, ThemePreset } from '@neomd/shared';
import { allThemes, findTheme, legacyCustomTheme, legacyThemeId, resolveTheme, themeVars } from '@neomd/shared';
import { mergeSettings, defaultSettings, SETTINGS_KEY, detectRuntime } from '@neomd/core';
import { api, getAccessToken } from '@/api/client';
import { DEFAULT_SERVER_SETTINGS, normalizeServerBase } from '@/lib/server-endpoint';

/**
 * 缁?settings 琛ラ綈鏈嶅姟绔厤缃粯璁ゅ€笺€? *
 * `@neomd/core` 鐨?`defaultSettings()` / `mergeSettings()` 涓嶈璇?`server` 瀛楁锛? * 鑰屽畠鏄?1.0.2 鏂板鐨?*绾湰鍦?*閰嶇疆锛堟案涓嶄笂浜戯級锛屽洜姝ゅ彧鑳藉湪 store 灞傚厹搴曪紝
 * 閬垮厤鍚勫璇?`settings.server.xxx` 鏃舵嬁鍒?undefined 鑰岀櫧灞忋€? */
function withServerDefaults(source: Settings): Settings {
  const server = source.server;
  return {
    ...source,
    server: {
      mode: server?.mode === 'custom' ? 'custom' : 'official',
      customBaseUrl: typeof server?.customBaseUrl === 'string' ? server.customBaseUrl : '',
      privacyMode: server?.privacyMode === true,
    },
  };
}

function loadLocal(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return withServerDefaults(defaultSettings());
    const parsed = JSON.parse(raw) as Partial<Settings>;
    // （原注释编码损坏，已清理）
    // （注释原文编码损坏，已清理）
    const merged = mergeSettings(defaultSettings(), migrateSettingsTheme(parsed));
    // （注释原文编码损坏，已清理）
    return withServerDefaults({ ...merged, server: parsed.server ?? merged.server });
  } catch {
    return withServerDefaults(defaultSettings());
  }
}

/* ------------------------------------------------------------------ */
/* 澶氱鍒嗗尯鍚屾                                                        */
/*                                                                     */
/* global 鍖猴紙鍏ㄥ钩鍙板己涓€鑷达級锛歴torage / ai / sync / naming / shortcuts  */
/* platform 鍖猴紙鍏佽鎸夌宸紓鍖栵級锛歛ppearance / layout / enabledPlugins  */
/* 姘镐笉涓婁簯锛堜弗鏍兼湰鍦帮級锛歴erver / localVault / cloudVersion / updatedAt  */
/* ------------------------------------------------------------------ */

/** 浜戠璁剧疆鍝嶅簲锛歷2 鏈嶅姟绔繑鍥炴媿骞宠鍥撅紱鏃ф湇鍔＄鐩存帴杩斿洖骞抽摵 Settings */
interface CloudSettingsResponse {
  payload: Record<string, unknown> | null;
  sensitive: Record<string, unknown> | null;
  version: number;
  updatedAt?: string | null;
  deviceId?: string | null;
  platform?: string | null;
}

interface CloudSensitive {
  storage?: { accessKeyId?: string; accessKeySecret?: string };
  ai?: { apiKey?: string };
}

/** 鍏佽鎸夊钩鍙板樊寮傚寲鐨勫垎鍖猴紝鍏朵綑鍒嗗尯榛樿杩?global */
const PLATFORM_SCOPED_KEYS = new Set(['appearance', 'layout', 'enabledPlugins']);
/** 涓ユ牸鏈湴銆佹案涓嶄笂浜戠殑鍒嗗尯锛堣嚜瀹氫箟鏈嶅姟鍣?绉佹湁鍖栥€佹湰鍦颁粨搴撴牴鐩綍銆佺増鏈按浣嶏級 */
const LOCAL_ONLY_KEYS = new Set(['server', 'localVault', 'cloudVersion', 'updatedAt', 'version']);

/**
 * `appearance` 閲?*搴斿綋璺ㄧ寮轰竴鑷?*鐨勫瓧娈碉紙杩?global 鍖猴級銆? *
 * 鍒嗗眰鍘熷垯锛?.1.1 寤虹珛锛?.1.8 琛ュ叆瀛椾綋锛夛細
 * - **瑙傛劅閫夋嫨**锛堢敤鎴峰浜у搧澶栬鐨勫亸濂斤紝鎹㈣澶囧簲褰撲竴鑷达級鈫?global锛? * - **闃呰浣撻獙**锛堜笌灞忓箷灏哄/瑙傜湅璺濈鐩稿叧锛屾寜璁惧鍙互涓嶅悓锛夆啋 platform銆? *
 * 涓轰粈涔堣鎷嗚€屼笉鏄妸鏁翠釜 `appearance` 鎸埌 global锛? * `fontSize` / `lineHeight` / `zoom` / `pageWidth` / `showLineNumbers` 灞炰簬闃呰浣撻獙锛? * PC 澶у睆涓庢墜鏈哄皬灞忔湰鏉ュ氨璇ヤ笉鍚岋紝蹇呴』鐣欏湪 platform 鍖烘寜绔樊寮傚寲锛? * 鑰屼笅闈㈣繖浜涙槸瑙傛劅閫夋嫨锛屾崲璁惧蹇呴』涓€鑷?鈥斺€?鍚﹀垯灏变細鍑虹幇
 * 銆學eb 绔崲浜嗕富棰?瀛椾綋锛孭C 绔病鍙樸€嶃€? *
 * 1.1.8 琛ュ叆 `fontFamily`锛氱敤鎴锋崲瀛椾綋鏄€屾垜瑕佺敤杩欎釜瀛椾綋鐪嬪緟姝ｆ枃銆嶇殑鍋忓ソ锛? * 涓庤澶囨棤鍏筹紱鍘熷厛瀹冪暀鍦?platform 鍖猴紝瀵艰嚧 PC 璁句簡瀛椾綋缃戦〉绔笉璺熼殢銆? * 锛堝瓧鍙蜂笉璺熺潃璧版槸鍒绘剰鐨勶細24px 鍦ㄦ墜鏈轰笂浼氭槑鏄惧亸澶с€傦級
 *
 * 鏃х増鐨?`editorColorScheme` / `customEditorBg` / `customEditorFg` 涔熷綊鍒拌繖閲岋細
 * 瀹冧滑宸蹭笉鍐嶆毚闇茬粰鐢ㄦ埛锛堟鏂囬厤鑹插苟鍏ヤ富棰橈級锛屼絾浠嶈璺熼殢涓婚涓€璧疯法绔紝
 * 鍚﹀垯鑰佹暟鎹湪鍙︿竴鍙颁笂浼氶噸鏂拌Е鍙?`resolveTheme()` 鐨勬棫鍊煎洖閫€锛屾妸涓婚瑕嗙洊鎺夈€? */
const GLOBAL_APPEARANCE_FIELDS = [
  'theme',
  'themePresetId',
  'accent',
  'customThemes',
  'fontFamily',
  'editorColorScheme',
  'customEditorBg',
  'customEditorFg',
] as const;

const GLOBAL_APPEARANCE_FIELD_SET = new Set<string>(GLOBAL_APPEARANCE_FIELDS);

/**
 * 鎶?`appearance` 鎷嗘垚銆岃法绔竴鑷村瓧娈点€嶄笌銆屾湰鏈洪槄璇讳綋楠屽瓧娈点€嶄袱缁勩€? *
 * 瀹归敊锛氶潪瀵硅薄杈撳叆杩斿洖涓や釜绌哄璞★紝鐢辫皟鐢ㄦ柟鍐冲畾鏄惁钀界洏锛? * 閬垮厤鏃х増鏈妸 `appearance` 鍐欏潖鎴愬瓧绗︿覆鏃舵暣鏉″悓姝ラ摼璺姏閿欍€? */
function splitAppearanceFields(appearance: unknown): {
  themePart: Record<string, unknown>;
  readingPart: Record<string, unknown>;
} {
  const themePart: Record<string, unknown> = {};
  const readingPart: Record<string, unknown> = {};
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) {
    return { themePart, readingPart };
  }
  for (const [field, value] of Object.entries(appearance as Record<string, unknown>)) {
    if (GLOBAL_APPEARANCE_FIELD_SET.has(field)) themePart[field] = value;
    else readingPart[field] = value;
  }
  return { themePart, readingPart };
}

/** `appearance` 閲屾槸鍚﹀惈鑷冲皯涓€涓富棰樺瓧娈碉紙鐢ㄤ簬鍒ゆ柇鏃?payload 鏄惁闇€瑕佽縼绉伙級 */
export function appearanceHasThemeFields(appearance: unknown): boolean {
  if (!appearance || typeof appearance !== 'object') return false;
  return GLOBAL_APPEARANCE_FIELDS.some(
    (f) => (appearance as Record<string, unknown>)[f] !== undefined,
  );
}

/**
 * 鑰佺敤鎴锋暟鎹殑涓€娆℃€ц縼绉伙細鎶婃棫鐗堛€屾鏂囬厤鑹叉柟妗堛€嶈縼鍒般€屼富棰橀璁俱€嶃€? *
 * 涓轰粈涔堝繀椤诲仛銆佷笖蹇呴』**鍦ㄥ悎骞堕粯璁ゅ€间箣鍓?*鍋氾細
 * - `defaultSettings()` 鐜板湪鑷甫 `themePresetId: 'daylight'`锛? * - 鑰佺敤鎴风殑 localStorage / 浜戠 payload 閲?*娌℃湁** `themePresetId`锛屽彧鏈?`editorColorScheme`锛? * - 涓€鏃﹀厛 `mergeSettings(defaultSettings(), raw)`锛宍themePresetId` 灏辫琛ユ垚 `'daylight'`锛? *   `resolveTheme()` 浼氱洿鎺ュ懡涓唴缃富棰橈紝**姘歌繙璧颁笉鍒?* `editorColorScheme` 鐨勬槧灏勫垎鏀紝
 *   缁撴灉灏辨槸銆岃€佺敤鎴风殑缁胯壊鎶ょ溂鍗囩骇鍚庡彉鎴愭棩鍏夌櫧銆嶃€? *
 * 鍒ゅ畾渚濇嵁涓ユ牸锛氬彧鏈?*瀹屽叏娌℃湁** `themePresetId` 瀛楁鏃舵墠杩佺Щ锛岀粷涓嶈鐩栫敤鎴峰凡閫夌殑涓婚銆? */
export function migrateLegacyAppearance(appearance: unknown): Record<string, unknown> | null {
  if (!appearance || typeof appearance !== 'object' || Array.isArray(appearance)) return null;
  const ap = { ...(appearance as Record<string, unknown>) };
  const preset = ap.themePresetId;
  // （注释原文编码损坏，已清理）
  if (typeof preset === 'string' && preset.trim()) return null;

  const scheme = ap.editorColorScheme;
  if (typeof scheme !== 'string' || !scheme) return null;

  if (scheme === 'custom') {
    // 旧版「自定义配色」→ 合成一套自定义主题并选中，视觉与原来完全一致
    const legacy = legacyCustomTheme(ap);
    const existing = Array.isArray(ap.customThemes) ? (ap.customThemes as unknown[]) : [];
    const hasIt = existing.some(
      (t) => t && typeof t === 'object' && (t as { id?: string }).id === legacy.id,
    );
    ap.customThemes = hasIt ? existing : [...existing, legacy];
    ap.themePresetId = legacy.id;
    return ap;
  }

  const mappedId = legacyThemeId(scheme as 'white' | 'gray' | 'black' | 'green' | 'lightblue');
  if (!mappedId) return null;
  ap.themePresetId = mappedId;
  return ap;
}

/**
 * 瀵逛换鎰忔潵婧愮殑璁剧疆瀵硅薄鍋氳€佹暟鎹富棰樿縼绉伙紙涓嶆敼鍘熷璞★級銆? *
 * 杩斿洖鍊兼柇瑷€璇存槑锛歚migrateLegacyAppearance` 鍙槸瀵?appearance 鍋氭祬鎷疯礉 + 琛? * `themePresetId` / `customThemes`锛屼笉鍒犻櫎浠讳綍瀛楁锛屽洜姝よ縼绉诲悗鐨勫璞′粛婊¤冻
 * `AppearanceSettings` 鐨勫畬鏁寸粨鏋勶紱鏂█鏄负浜嗙粫寮€銆孭artial<Settings> 閲?appearance
 * 浠嶆槸瀹屾暣绫诲瀷銆嶄笌杩佺Щ鍑芥暟杩斿洖 `Record<string, unknown>` 涔嬮棿鐨勫舰寮忓樊寮傘€? */
function migrateSettingsTheme(input: Partial<Settings>): Partial<Settings> {
  const migrated = migrateLegacyAppearance(input.appearance);
  if (!migrated) return input;
  // （原注释编码损坏，已清理）
  // 先把迁移结果收窄成 AppearanceSettings，再放回 Settings。
  // 这里必须分两步断言：`Record<string, unknown>` → `AppearanceSettings` 是「收窄」，
  // 一步写 `as Partial<Settings>` 会因 appearance 字段类型不兼容而报 TS2322。
  const appearance = migrated as unknown as Settings['appearance'];
  return { ...input, appearance };
}


/* ------------------------------------------------------------------ */
/* 涓婚銆屽簲鐢ㄨ寖鍥淬€嶏紙1.1.1锛?                                           */
/* ------------------------------------------------------------------ */

/** 搴旂敤鑼冨洿锛氭暣浣?/ 浠呮鏂?/ 浠呯晫闈紙鏈満鍋忓ソ锛屽瓨 localStorage锛屼笉杩?settings锛?*/
export type ThemeScope = 'all' | 'content' | 'chrome';

/** localStorage key锛孲ettingsPage 涓庢湰 store 鍏辩敤 */
export const THEME_SCOPE_STORAGE_KEY = 'neomd.themeScope';

/** 姝ｆ枃涓撳睘鍙橀噺锛氱敤浜庢妸 themeVars() 鐨勮緭鍑哄垎鎴愩€屾鏂囥€嶃€岀晫闈€嶄袱缁?*/
export const CONTENT_THEME_VARS = new Set<string>([
  '--content-bg',
  '--content-fg',
  '--code-block-bg',
  '--quote-bg',
  '--table-border',
]);

/**
 * themeVars() 浼氫骇鍑虹殑鍏ㄩ儴鍙橀噺鍚嶃€? *
 * 涓轰粈涔堥渶瑕佸畠锛氬垏鎹€屽簲鐢ㄨ寖鍥淬€嶆椂蹇呴』**鍏堟竻绌轰笂涓€杞啓鍏ョ殑鍐呰仈鍙橀噺**锛? * 鍚﹀垯浠庛€屾暣浣撱€嶅垏鍒般€屼粎姝ｆ枃銆嶅悗锛岀晫闈㈢被鍙橀噺浼氫互鏃у€兼畫鐣欙紝鐪嬭捣鏉ヨ寖鍥存病鐢熸晥銆? * 鐩存帴鍒楀瓧闈㈤噺鑰屼笉鏄?`Object.keys(themeVars(someTheme))`锛? * 鏄负浜嗚杩欎唤娓呭崟鍦ㄦā鍧楀姞杞芥湡灏卞浐瀹氾紝涓嶅彈浠讳綍涓婚瀵硅薄褰卞搷銆? */
export const ALL_THEME_VARS: string[] = [
  '--content-bg',
  '--content-fg',
  '--chrome-bg',
  '--bg',
  '--bg-elevated',
  '--bg-sidebar',
  '--bg-hover',
  '--bg-active',
  '--bg-input',
  '--fg',
  '--fg-2',
  '--fg-3',
  '--border',
  '--border-strong',
  '--accent',
  '--accent-hover',
  '--accent-weak',
  '--accent-weak-2',
  '--sky',
  '--sky-2',
  '--code-block-bg',
  '--quote-bg',
  '--table-border',
  '--shadow-1',
  '--shadow-2',
  '--shadow-3',
];

/** 璇诲彇鏈満淇濆瓨鐨勫簲鐢ㄨ寖鍥?*/
export function readThemeScope(): ThemeScope {
  try {
    const v = localStorage.getItem(THEME_SCOPE_STORAGE_KEY);
    if (v === 'content' || v === 'chrome') return v;
  } catch {
    /* localStorage 琚鐢?*/
  }
  return 'all';
}

/** 璇ュ彉閲忓湪褰撳墠鑼冨洿涓嬫槸鍚﹀厑璁歌鐩?*/
export function themeVarAllowed(key: string, scope: ThemeScope): boolean {
  if (scope === 'all') return true;
  const isContent = CONTENT_THEME_VARS.has(key);
  return scope === 'content' ? isContent : !isContent;
}

/** 鑷姩 pull 鑺傛祦绐楀彛锛氬彲瑙佹€?鑱氱劍浜嬩欢鍦?30s 鍐呭彧瑙﹀彂涓€娆?*/
const AUTO_PULL_THROTTLE_MS = 30_000;
/** 杞婚噺鐗堟湰杞闂撮殧锛氬彧姣旂増鏈彿锛屼簯绔湁鍙樺寲鎵嶆媺鍏ㄩ噺璁剧疆 */
const CLOUD_VERSION_POLL_MS = 60_000;

/** 褰撳墠杩愯骞冲彴锛汼SR/寮傚父鐜鍥為€€ web */
function detectPlatform(): string {
  try {
    return detectRuntime().platform;
  } catch {
    return 'web';
  }
}

/**
 * 浠?Settings 鎷嗗嚭 global锛堝己涓€鑷达級涓?platform锛堟寜绔樊寮傚寲锛変袱涓垎鍖恒€? *
 * 銆屽巻鍙茬増鏈?/ AI / S3 璺ㄧ涓€鑷淬€嶇殑瀹屾暣閾捐矾锛堟帓鏌ユ椂鎸夋椤哄簭鐪嬶級锛? *   1. storage锛坋ndpoint/region/bucket/AK/SK/basePrefix锛変笌 sync锛坮ootPrefix锛夊睘浜?global
 *      鈫?鐧诲綍鍚庝换浣曞钩鍙?pull 鍒扮殑閮芥槸鍚屼竴浠斤紝涓ょ鎷煎嚭鐨勫璞″瓨鍌ㄥ墠缂€澶╃劧鐩稿悓锛? *   2. SyncEngine 鍦ㄧ櫥褰曟€佹妸 rootPrefix 鍐嶆帴涓?`users/<username>/`锛堣 stores/app.ts
 *      buildSyncEngine锛夛紝鎸夌敤鎴峰悕闅旂锛岄伩鍏嶅鐢ㄦ埛浜掔浉瑕嗙洊锛? *   3. 浜庢槸 A 绔繚瀛樺啓鍏?`鈥?users/<name>/versions/<docId>/<ts>-<rev>-<hash>.md`锛? *      涓?B 绔€岀増鏈巻鍙层€嶉潰鏉?listRemoteVersions 璇诲彇鐨勫墠缂€瀹屽叏涓€鑷?鈫?鍘嗗彶鐗堟湰璺ㄧ鍙銆? * 鍙 storage / sync 鐣欏湪 global锛堟湰鍑芥暟淇濊瘉杩欎竴鐐癸級锛岃繖鏉￠摼璺氨涓嶄細琚钩鍙板樊寮傚寲鎵撴柇銆? */
function splitSettingsPartitions(source: Settings): {
  global: Record<string, unknown>;
  platform: Record<string, unknown>;
} {
  const plain = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  const globalPart: Record<string, unknown> = {};
  const platformPart: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) {
    // （注释原文编码损坏，已清理）
    if (key === 'appearance') {
      // 主题字段 → global（跨端强一致）；阅读体验字段 → platform（按端差异化）
      const { themePart, readingPart } = splitAppearanceFields(value);
      if (Object.keys(themePart).length) globalPart.appearance = themePart;
      if (Object.keys(readingPart).length) platformPart.appearance = readingPart;
      continue;
    }
    if (PLATFORM_SCOPED_KEYS.has(key)) platformPart[key] = value;
    else globalPart[key] = value;
  }
  return { global: globalPart, platform: platformPart };
}

/** 鍘绘帀鍙睘浜庢湰鏈虹殑瀛楁锛岄槻姝㈡棫浜戠鏁版嵁鎶婃湰鍦拌矾寰?鏈嶅姟鍣ㄩ厤缃甫鍥炴湰绔?*/
function stripLocalOnly(source: Record<string, unknown>): Partial<Settings> {
  const clone = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
  for (const key of LOCAL_ONLY_KEYS) delete clone[key];
  return clone as Partial<Settings>;
}

/**
 * 褰掍竴鍖栦簯绔?payload锛? * - v2锛歚{ global, platform: { desktop: {...} } }` 鈫?鍒嗗埆鍙栧嚭 global 涓庢湰骞冲彴鍒嗙粍锛? * - 鏃ф湇鍔＄/鏃ф暟鎹紙鏃?global/platform 瀛楁锛夛細鏁翠綋瑙嗕负 global銆? *
 * **1.1.1 涓婚璺ㄧ淇鐨勪袱涓姩浣滐紙閮藉湪杩欓噷鍋氾紝鎷夊彇渚у敮涓€鍏ュ彛锛?*锛? * 1. **闅旂**锛氭妸銆屾湰骞冲彴 appearance銆嶉噷鐨勪富棰樺瓧娈靛墧闄わ紝鍙繚鐣欓槄璇讳綋楠屽瓧娈点€? *    鍚﹀垯鏃?payload锛坅ppearance 鏁翠綋瀛樺湪 platform 閲岋級浼氬湪鍚堝苟鏃舵妸 global 鍒氬悓姝ヨ繃鏉ョ殑
 *    涓婚鍙堣鐩栧洖鏈鏃у€?鈥斺€?杩欐鏄€學eb 鏀逛簡涓婚 PC 涓嶇敓鏁堛€嶇殑鏈€鍚庝竴鐜€? * 2. **杩佺Щ**锛氳嫢 global 鍖哄畬鍏ㄦ病鏈変富棰樺瓧娈碉紙鑰佺敤鎴峰崌绾у悗绗竴娆℃媺锛夛紝
 *    鍒欐妸涓婇潰鍓旈櫎涓嬫潵鐨勪富棰樺瓧娈佃ˉ杩?global锛屽疄鐜颁竴娆℃€у钩婊戣縼绉伙紝
 *    涓嶉渶瑕佺敤鎴烽噸鏂伴€変竴娆′富棰樸€? */
function splitRemotePayload(raw: Record<string, unknown> | null): {
  global: Record<string, unknown> | null;
  platform: Record<string, unknown> | null;
} {
  if (!raw || typeof raw !== 'object') return { global: null, platform: null };
  const grouped =
    Object.prototype.hasOwnProperty.call(raw, 'global') ||
    Object.prototype.hasOwnProperty.call(raw, 'platform');
  if (!grouped) return { global: raw, platform: null };
  const globalPart =
    raw.global && typeof raw.global === 'object' ? { ...(raw.global as Record<string, unknown>) } : null;
  const groups =
    raw.platform && typeof raw.platform === 'object'
      ? (raw.platform as Record<string, Record<string, unknown>>)
      : null;
  const rawPlatform = groups ? groups[detectPlatform()] ?? null : null;
  if (!rawPlatform) return { global: globalPart, platform: null };

  const platformPart: Record<string, unknown> = { ...rawPlatform };
  if (rawPlatform.appearance && typeof rawPlatform.appearance === 'object') {
    const { themePart, readingPart } = splitAppearanceFields(rawPlatform.appearance);
    platformPart.appearance = readingPart;
    // （注释原文编码损坏，已清理）
    if (Object.keys(themePart).length) {
      const mergedGlobalAppearance = {
        ...((globalPart?.appearance && typeof globalPart.appearance === 'object'
          ? globalPart.appearance
          : {}) as Record<string, unknown>),
      };
      for (const field of GLOBAL_APPEARANCE_FIELDS) {
        if (mergedGlobalAppearance[field] === undefined && themePart[field] !== undefined) {
          mergedGlobalAppearance[field] = themePart[field];
        }
      }
      if (globalPart) globalPart.appearance = mergedGlobalAppearance;
    }
  }
  return { global: globalPart, platform: platformPart };
}

/** 褰掍竴鍖栨晱鎰熷瓧娈碉細v2 鍒嗙粍锛坓lobal + 鏈钩鍙帮級涓庢棫鐗堝钩閾洪兘鏀寔 */
function splitRemoteSensitive(raw: Record<string, unknown> | null): CloudSensitive {
  if (!raw || typeof raw !== 'object') return {};
  const pick = (src: unknown): CloudSensitive =>
    src && typeof src === 'object' ? (src as CloudSensitive) : {};
  const grouped =
    Object.prototype.hasOwnProperty.call(raw, 'global') ||
    Object.prototype.hasOwnProperty.call(raw, 'platform');
  if (!grouped) return pick(raw);
  const groups =
    raw.platform && typeof raw.platform === 'object'
      ? (raw.platform as Record<string, unknown>)
      : null;
  const globalPart = pick(raw.global);
  const platformPart = pick(groups?.[detectPlatform()]);
  return {
    storage: { ...(globalPart.storage ?? {}), ...(platformPart.storage ?? {}) },
    ai: { ...(globalPart.ai ?? {}), ...(platformPart.ai ?? {}) },
  };
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>(loadLocal());
  const ready = ref(false);

  /** 鏁忔劅瀛楁鍗曠嫭瀛樻斁锛堟闈㈢浜ょ粰瀹夊叏瀛樺偍锛岀綉椤电浠呭唴瀛橈級 */
  const secrets = ref<{ storageSecret: string; storageKeyId: string; aiKey: string }>({
    storageSecret: settings.value.storage.accessKeySecret ?? '',
    storageKeyId: settings.value.storage.accessKeyId ?? '',
    aiKey: settings.value.ai.apiKey ?? '',
  });

  function persist(): void {
    try {
      const snapshot = JSON.parse(JSON.stringify(settings.value)) as Settings;
      // （注释原文编码损坏，已清理）
      snapshot.storage.accessKeySecret = '';
      snapshot.ai.apiKey = '';
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
    } catch {
      /* 瀛樺偍宸叉弧鎴栬绂佺敤鏃跺拷鐣?*/
    }
  }

  /* ------------------------ 涓婚棰勮锛?.0.2锛宼ask-3锛?------------------------ */

  /**
   * 銆屾湰鍦颁富棰樻敼鍔ㄥ皻鏈‘璁ゆ帹閫佸埌浜戠銆嶆爣璁帮紙1.1.7 淇涓婚琚簯绔棫鍊煎洖婊氾級銆?   *
   * ## 涓轰粈涔堝繀椤绘湁瀹冿紙瀹炴祴澶嶇幇鐨勭湡瀹炵己闄凤級
   *
   * 鐢ㄦ埛鎿嶄綔搴忓垪锛氶€変富棰?鈫?鍏抽棴璁剧疆 鈫?閲嶅紑璁剧疆銆?   * 閫変富棰樻椂 `applyThemePreset()` 浼?`scheduleCloudPush()`锛? 绉掗槻鎶栵級銆?   * 鑻ヨ繖娈垫椂闂村唴鎺ㄩ€佽繕娌″畬鎴愶紙鎴栨帹閫佸け璐ャ€佹柇缃戙€佽绉佹湁鍖栨ā寮忔嫤鎴級锛?   * 浜戠浠嶆槸**鏃т富棰?*锛涜€岄噸寮€璁剧疆椤垫椂 `SettingsPage` 浼?`pullCloudSettings()`锛?   * 浜庢槸 `mergeSettings` 鐢ㄤ簯绔棫鍊兼妸鏈湴鍒氶€夌殑涓婚瑕嗙洊鎺?鈥斺€?鐢ㄦ埛鐪嬪埌鐨勫氨鏄?   * 銆岃缃富棰樺悗鍐嶆鐐瑰嚮璁剧疆椤典富棰樺張浼氭仮澶嶄负榛樿涓婚銆嶃€?   *
   * ## 鏂规锛氭湰鍦版敼鍔ㄤ紭鍏堬紝鐩村埌鎺ㄩ€佹垚鍔?   *
   * - 鏈湴鏀逛富棰?鈫?缃?`themeDirtySince = Date.now()`锛?*鎸佷箙鍖?*锛屽埛鏂板悗浠嶇敓鏁堬級锛?   * - 鎺ㄩ€佹垚鍔?鈫?娓呯┖鏍囪锛堟鏃朵簯绔凡鍚湰鍦板€硷紝鍐嶆媺鍙栦篃鏄悓涓€浠斤級锛?   * - 鎷夊彇鏃惰嫢鏍囪浠嶅湪 鈫?**涓嶄粠浜戠瑕嗙洊涓婚瀛楁**锛屽苟閲嶆柊瀹夋帓涓€娆℃帹閫併€?   *
   * 杩欐牱鏃慨鎺夊洖婊氾紝鍙堜繚鐣欒法绔悓姝ワ細鍙︿竴鍙拌澶囨敼鐨勪富棰橈紙鏈満鏃犳湭鎺ㄩ€佹敼鍔級
   * 渚濈劧鑳藉湪鏈満鎷夊彇鐢熸晥銆?   */
  const THEME_DIRTY_KEY = 'neomd.themeDirtySince';

  function loadThemeDirty(): number | null {
    try {
      const raw = localStorage.getItem(THEME_DIRTY_KEY);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  }

  const themeDirtySince = ref<number | null>(loadThemeDirty());

  function markThemeDirty(): void {
    const now = Date.now();
    themeDirtySince.value = now;
    try {
      localStorage.setItem(THEME_DIRTY_KEY, String(now));
    } catch {
      /* 瀛樺偍琚鐢ㄦ椂浠呭唴瀛樼敓鏁?*/
    }
  }

  function clearThemeDirty(): void {
    themeDirtySince.value = null;
    try {
      localStorage.removeItem(THEME_DIRTY_KEY);
    } catch {
      /* 蹇界暐 */
    }
  }

  /**
   * 「本地布局已确认与云端一致」的基线快照（1.1.9）。
   *
   * ## 为什么不用「脏标记」布尔量
   *
   * 最初的实现是照抄主题那套 `*DirtySince` 布尔标记，但实测发现它**会永久置位**：
   * `updateLayout()` 除了用户拖拽，还被大量程序化路径调用（面板开合、功能区切换、
   * 启动时恢复布局状态……）。只要启动过程中有过一次 `updateLayout()`，标记就被点亮，
   * 于是**永远不再接受云端布局**——跨设备（同平台两个浏览器）的布局同步彻底失效。
   *
   * ## 现在的做法：按字段比对「本地 vs 上次同步基线」
   *
   * - `layoutBaseline` 记录**上一次与云端达成一致时**的 layout 快照；
   * - 拉取时逐字段比对：`本地值 !== 基线值` 说明这是本地未同步的改动 → 保留本地；
   *   `本地值 === 基线值` 说明本地没动过 → 接受云端值。
   *
   * 这样既不会把用户的拖拽结果回滚，也不会因为「曾经调用过 updateLayout」而永久
   * 拒绝远端更新。粒度也从「整块 layout」细化到「单个字段」——用户只改了工具栏顺序时，
   * 另一台设备改的面板宽度仍能正常同步下来。
   */
  const LAYOUT_BASELINE_KEY = 'neomd.layoutBaseline.v1';

  function loadLayoutBaseline(): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(LAYOUT_BASELINE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** 上一次与云端一致时的 layout 快照（null 表示还没有基线，此时完全接受云端） */
  const layoutBaseline = ref<Record<string, unknown> | null>(loadLayoutBaseline());

  /** 记录当前 layout 为「已同步基线」（推送或拉取成功后调用） */
  function snapshotLayoutBaseline(): void {
    try {
      const snap = JSON.parse(JSON.stringify(settings.value.layout ?? {})) as Record<string, unknown>;
      layoutBaseline.value = snap;
      localStorage.setItem(LAYOUT_BASELINE_KEY, JSON.stringify(snap));
    } catch {
      /* 序列化/存储失败时退化为「无基线」，下次拉取会完全接受云端 */
    }
  }

  /**
   * 拉取前快照本地 layout 与基线，用于 merge 之后把「本地未同步字段」还原回来。
   *
   * 返回一个「还原函数」而不是数据：调用点只需在 merge 之后执行它，
   * 不必了解比对细节。
   */
  function captureLocalLayoutOverrides(): () => void {
    const local = JSON.parse(JSON.stringify(settings.value.layout ?? {})) as Record<string, unknown>;
    const base = layoutBaseline.value;
    return () => {
      // 没有基线 → 首次登录该端，全盘接受云端（这是跨端首次同步的正确行为）
      if (!base) return;
      const merged = { ...(settings.value.layout ?? {}) } as Record<string, unknown>;
      let changed = false;
      for (const key of Object.keys(local)) {
        // 本地值与基线不同 = 本地有未同步改动 → 用本地值覆盖云端值
        if (JSON.stringify(local[key]) !== JSON.stringify(base[key])) {
          merged[key] = local[key];
          changed = true;
        }
      }
      if (changed) {
        // merged 由「云端合并结果 + 本地未同步字段」拼成，键集合与 LayoutSettings 一致；
        // 中间的 Record 只是逐字段比对的载体，故经 unknown 转回正式类型
        settings.value.layout = merged as unknown as Settings['layout'];
        // 让云端尽快收敛到本地值
        scheduleCloudPush();
      }
    };
  }

  /** 姝ｆ枃缂╂斁姣斾緥澶圭揣鍒?50-300锛堜笌 stores/app.ts 鐨?zoom 閫昏緫淇濇寔鍚屼竴鍙ｅ緞锛?*/
  function clampZoomPercent(v: number): number {
    if (!Number.isFinite(v)) return 100;
    return Math.min(300, Math.max(50, Math.round(v)));
  }
  /* 涓?task-2锛坰erver锛夈€乼ask-4锛坈loud sync锛夊叡鐢ㄦ湰鏂囦欢锛氭湰娈靛彧鏀句富棰樼浉鍏充唬鐮侊紝
     璇峰嬁鍦ㄦ鏂囦欢鍏跺畠浣嶇疆鍋氭棤鍏虫暣鐞嗭紝浠ュ厤涓庡苟琛屾敼鍔ㄥ啿绐併€?*/

  /** 鎶婁富棰樼殑鏁村 CSS 鍙橀噺鍐欏埌 <html>锛堟鏂囦笌鐣岄潰鍏辩敤鍚屼竴濂楀彉閲忥級 */
  function applyThemeVars(theme: ThemePreset): void {
    const root = document.documentElement;
    // 主题强调色为基准；用户在「通用」页签手动改过主色调时以用户值为准
    const accent = settings.value.appearance.accent?.trim();
    const effective: ThemePreset = accent ? { ...theme, accent } : theme;
    const vars = themeVars(effective);
    // 先清空上一次写入的变量：切换「应用范围」时若不清理，上一轮的主题变量会残留
    for (const key of ALL_THEME_VARS) root.style.removeProperty(key);
    const scope = readThemeScope();
    for (const [key, value] of Object.entries(vars)) {
      if (!themeVarAllowed(key, scope)) continue;
      root.style.setProperty(key, value);
    }
  }

  function applyTheme(): void {
    if (typeof document === 'undefined') return;
    const appearance = settings.value.appearance;
    const root = document.documentElement;
    const prefersDark =
      typeof window !== 'undefined'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
        : false;
    // （注释原文编码损坏，已清理）
    // 主题决定整体明暗：未显式选主题的旧数据由 resolveTheme 按 appearance.theme
    // 回退到对应明暗的内置主题（dark → 午夜黑，其余 → 日光白），老用户外观不突变。
    const theme = resolveTheme(appearance, { prefersDark });
    root.dataset.themePreset = theme.id;
    root.dataset.theme = theme.mode === 'dark' ? 'dark' : 'light';
    applyThemeVars(theme);
    // 正文缩放：以 fontSize 为基准按 zoom 百分比放大字号，行高同步换算；只影响正文排版
    const zoom = clampZoomPercent(appearance.zoom ?? 100);
    // 这样只影响正文排版，不会像 CSS zoom 那样把侧栏/工具栏一起放大。
    const scaledFont = Math.round(appearance.fontSize * (zoom / 100) * 100) / 100;
    root.style.setProperty('--content-font-size', `${scaledFont}px`);
    root.style.setProperty('--content-line-height', String(appearance.lineHeight));
    /**
     * 姝ｆ枃瀛椾綋锛?.1.8 淇銆岃缃瓧浣撲笉鐢熸晥銆嶏級銆?     *
     * 鏍瑰洜锛歚content.css` 閲?`.nm-content` 鍐欑殑鏄?`font-family: var(--font-content)`锛?     * 鑰?`--font-content` 姝ゅ墠鍙湪 `index.css` 閲岃闈欐€佸畾涔変负 `var(--font-ui)`锛?     * **浠庢潵娌℃湁璇诲彇杩囩敤鎴风殑 `appearance.fontFamily`** 鈥斺€?浜庢槸璁剧疆閲屾崲瀛椾綋
     * 鍦ㄧ晫闈笂姣棤鍙樺寲銆?     *
     * 杩欓噷鎶婄敤鎴烽€夋嫨鐨勫瓧浣撳啓鍒?`--font-content` 涓婏紙`!important` 涓嶉渶瑕侊紝
     * 鍥犱负鍐呰仈 style 鐨勪紭鍏堢骇楂樹簬鏍峰紡琛級銆傛湭璁剧疆鏃跺洖钀藉埌 `--font-ui`锛?     * 淇濇寔涓庣晫闈竴鑷寸殑榛樿瑙傛劅銆?     */
    const family = String(appearance.fontFamily ?? '').trim();
    if (family) {
      root.style.setProperty('--font-content', family);
    } else {
      // （注释原文编码损坏，已清理）
      root.style.setProperty('--font-content', 'var(--font-ui)');
    }
    // （原注释编码损坏，已清理）
    root.style.setProperty('--content-zoom', String(zoom / 100));
    root.dataset.contentZoom = String(zoom);
  }

  /**
   * 鏃х増銆屾鏂囬厤鑹叉柟妗堛€嶁啋 涓婚 id 鐨勫弽鍚戝悓姝ヨ〃銆?   *
   * `EditorPage.vue` 浠嶈 `editorColorScheme` 鐢熸垚姝ｆ枃鍐呰仈鏍峰紡锛堣鏂囦欢鐢?Lead 鎸傝浇锛?   * 鏈换鍔′笉鏀癸級锛屽洜姝ゅ簲鐢ㄤ富棰樻椂蹇呴』鎶婅€佸瓧娈靛啓鎴愮瓑浠锋柟妗堬紝鍚﹀垯鏃у唴鑱旇壊浼氱洊浣?   * 鏂扮殑涓婚鍙橀噺銆傛槧灏勪笉鍒扮殑涓婚缁熶竴鐢?`custom` + `customEditorBg/Fg`
   * 锛堝€煎嵆涓婚鐨?contentBg/contentFg锛夛紝瑙嗚涓庝富棰樺畬鍏ㄤ竴鑷淬€?   */
  const PRESET_TO_LEGACY_SCHEME: Record<string, EditorColorScheme> = {
    daylight: 'white',
    graphite: 'gray',
    midnight: 'black',
    'eyecare-green': 'green',
    'ocean-blue': 'lightblue',
  };

  /** 应用主题预设（内置或自定义）：同步维护旧版正文字段与明暗基调，保证全链路一致 */
  function applyThemePreset(id: string): void {
    const appearance = settings.value.appearance;
    const theme = findTheme(id, appearance.customThemes);
    if (!theme) return;
    settings.value.appearance = {
      ...appearance,
      theme: theme.mode,
      themePresetId: theme.id,
      accent: theme.accent,
      editorColorScheme: PRESET_TO_LEGACY_SCHEME[theme.id] ?? 'custom',
      customEditorBg: theme.contentBg,
      customEditorFg: theme.contentFg,
    };
    markThemeDirty();
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  /** 褰撳墠鐢熸晥涓婚锛堝搷搴斿紡锛涙湭閫変富棰樻椂鎸夋棫瀛楁鍥為€€锛?*/
  const activeTheme = computed<ThemePreset>(() => {
    const prefersDark =
      typeof window !== 'undefined'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
        : false;
    return resolveTheme(settings.value.appearance, { prefersDark });
  });

  /** 涓婚搴擄細鍐呯疆涓婚 + 鐢ㄦ埛鑷畾涔変富棰?*/
  const themeList = computed<ThemePreset[]>(() => allThemes(settings.value.appearance.customThemes));

  let cloudPushTimer: ReturnType<typeof setTimeout> | null = null;
  let autoPullTimer: ReturnType<typeof setTimeout> | null = null;
  let versionPollTimer: ReturnType<typeof setInterval> | null = null;
  let lastAutoPullAt = 0;
  let autoPullInstalled = false;
  let pullingCloud = false;

  function scheduleCloudPush(): void {
    if (pullingCloud || !getAccessToken()) return;
    if (cloudPushTimer) clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
      cloudPushTimer = null;
      void pushCloudSettings();
    }, 1000);
  }

  /**
   * 鑺傛祦鍚庣殑鑷姩鎷夊彇锛?0s 绐楀彛锛夈€?   * 瑙﹀彂鐐癸細搴旂敤鍚姩銆佺獥鍙ｉ噸鏂板彲瑙侊紙visibilitychange锛夈€佺獥鍙ｈ仛鐒︼紙focus锛夈€佹墦寮€璁剧疆椤点€?   */
  function requestCloudPull(): void {
    if (!getAccessToken()) return;
    const wait = AUTO_PULL_THROTTLE_MS - (Date.now() - lastAutoPullAt);
    if (wait <= 0) {
      void pullCloudSettings();
      return;
    }
    if (autoPullTimer) return;
    autoPullTimer = setTimeout(() => {
      autoPullTimer = null;
      if (getAccessToken()) void pullCloudSettings();
    }, wait);
  }

  async function pullCloudSettings(): Promise<void> {
    if (!getAccessToken()) return;
    if (pullingCloud) return;
    pullingCloud = true;
    lastAutoPullAt = Date.now();
    try {
      const platform = detectPlatform();
      const res = await api<CloudSettingsResponse>(
        `/api/settings?platform=${encodeURIComponent(platform)}`,
        { auth: true },
      );
      const remoteVer = Number(res.version ?? 0);
      const { global: remoteGlobal, platform: remotePlatform } = splitRemotePayload(res.payload);
      // 本地主题改动尚未推送成功 → 记下本地主题字段，合并后原样还原，避免被云端旧值回滚
      // （这正是「设置主题后重开设置页又恢复默认」的直接原因）
      const pendingTheme = themeDirtySince.value ? { ...settings.value.appearance } : null;
      // 布局同理：本地有未同步改动时，merge 后要把本地 layout 原样还原（1.1.9）
      const restoreLocalLayout = captureLocalLayoutOverrides();

      // global 区：强一致，云端值覆盖本地 —— 任何平台登录后都拿到同一份 S3 / AI / 同步前缀 / 命名 / 快捷键
      // 主题：global 里可能来自旧 payload（只有 editorColorScheme），合并前先迁移成 themePresetId
      if (remoteGlobal) {
        settings.value = mergeSettings(settings.value, migrateSettingsTheme(stripLocalOnly(remoteGlobal)));
      }
      // （原注释编码损坏，已清理）
      // 注意：这里的 appearance 已被 splitRemotePayload 剔除主题字段，只含阅读体验字段，
      // 因此不会把 global 刚同步过来的主题覆盖回本端旧值（这正是跨端不生效的最后一环）。
      if (remotePlatform) {
        settings.value = mergeSettings(settings.value, stripLocalOnly(remotePlatform));
      }

      if (pendingTheme) {
        // 只还原「主题字段」，阅读体验字段（字号/行高/页宽等）仍接受云端值
        settings.value.appearance = {
          ...settings.value.appearance,
          theme: pendingTheme.theme,
          themePresetId: pendingTheme.themePresetId,
          accent: pendingTheme.accent,
          customThemes: pendingTheme.customThemes,
          editorColorScheme: pendingTheme.editorColorScheme,
          customEditorBg: pendingTheme.customEditorBg,
          customEditorFg: pendingTheme.customEditorFg,
        };
        // 云端还没拿到本地主题 → 合并后再推一次，让两端收敛
        scheduleCloudPush();
      }

      /*
       * 还原本地未同步的布局字段（逐字段比对基线，见 captureLocalLayoutOverrides）。
       *
       * 只还原「本地改过而云端不知道」的字段：工具栏顺序 / 功能区 / 面板宽度都是
       * 用户刚拖出来的显式意图，被云端旧值覆盖会让人觉得「拖拽无效」；
       * 而本地没动过的字段仍接受云端值，保证另一台设备的改动能同步下来。
       * 放在 pendingTheme 之后、cloudVersion 赋值之前，二者作用对象不重叠（appearance vs layout）。
       */
      restoreLocalLayout();

      const sens = splitRemoteSensitive(res.sensitive);
      if (sens.storage?.accessKeyId) {
        secrets.value.storageKeyId = sens.storage.accessKeyId;
        settings.value.storage.accessKeyId = sens.storage.accessKeyId;
      }
      if (sens.storage?.accessKeySecret) {
        secrets.value.storageSecret = sens.storage.accessKeySecret;
        settings.value.storage.accessKeySecret = sens.storage.accessKeySecret;
      }
      if (sens.ai?.apiKey) {
        secrets.value.aiKey = sens.ai.apiKey;
        settings.value.ai.apiKey = sens.ai.apiKey;
      }
      settings.value.cloudVersion = remoteVer;
      /*
       * 拉取成功且已处理完「本地未同步字段」→ 此刻的 layout 就是与云端一致的基线。
       * 若本地仍有未同步字段，restoreLocalLayout() 内部已安排一次推送，
       * 推送成功时会把基线更新为含本地改动的版本。
       */
      snapshotLayoutBaseline();
      persist();
      applyTheme();
    } catch {
      /* 绂荤嚎 / 鏈櫥褰?/ 绉佹湁鍖栨ā寮忥紙PrivacyModeError锛夋椂闈欓粯蹇界暐 */
    } finally {
      pullingCloud = false;
    }
  }

  async function pushCloudSettings(attempt = 0): Promise<void> {
    if (!getAccessToken() || pullingCloud) return;
    const platform = detectPlatform();
    try {
      const { global: globalPart, platform: platformPart } = splitSettingsPartitions(settings.value);
      // （注释原文编码损坏，已清理）
      const payload = { global: globalPart, platform: { [platform]: platformPart } };
      const sensitive = {
        global: {
          storage: {
            accessKeyId: settings.value.storage.accessKeyId || secrets.value.storageKeyId || '',
            accessKeySecret: settings.value.storage.accessKeySecret || secrets.value.storageSecret || '',
          },
          ai: {
            apiKey: settings.value.ai.apiKey || secrets.value.aiKey || '',
          },
        },
      };
      const deviceId = localStorage.getItem('neomd.deviceId') || 'device';
      const saved = await api<{ version: number }>('/api/settings', {
        method: 'PUT',
        auth: true,
        body: {
          payload,
          sensitive,
          version: settings.value.cloudVersion ?? 0,
          deviceId,
          platform,
        },
      });
      settings.value.cloudVersion = Number(saved.version ?? settings.value.cloudVersion ?? 0);
      // （注释原文编码损坏，已清理）
      clearThemeDirty();
      // 推送成功 → 当前 layout 即「与云端一致」的基线（1.1.9）
      snapshotLayoutBaseline();
      persist();
    } catch {
      if (attempt >= 1) return;
      // （注释原文编码损坏，已清理）
      await pushCloudSettings(attempt + 1);
    }
  }

  /** 杞婚噺鐗堟湰杞锛氬彧姣旇緝鐗堟湰鍙凤紝浜戠鏈夊彉鍖栨墠鎷夊叏閲忚缃?*/
  async function pollCloudVersion(): Promise<void> {
    if (!getAccessToken() || pullingCloud) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    try {
      const res = await api<{ version: number }>('/api/settings/version', { auth: true });
      const remote = Number(res.version ?? 0);
      if (remote > Number(settings.value.cloudVersion ?? 0)) await pullCloudSettings();
    } catch {
      /* 蹇界暐缃戠粶鎶栧姩涓庣鏈夊寲妯″紡鎷︽埅 */
    }
  }

  /** 瀹夎鑷姩鍚屾瑙﹀彂鍣細绐楀彛鑱氱劍 / 閲嶆柊鍙 / 60s 鐗堟湰杞 + 鍚姩鍗虫媺涓€娆?*/
  function installCloudAutoPull(): void {
    if (autoPullInstalled || typeof window === 'undefined') return;
    autoPullInstalled = true;
    window.addEventListener('focus', () => requestCloudPull());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') requestCloudPull();
    });
    versionPollTimer = setInterval(() => {
      void pollCloudVersion();
    }, CLOUD_VERSION_POLL_MS);
    requestCloudPull();
  }

  /** 鍗歌浇鑷姩鍚屾瑙﹀彂鍣紙娴嬭瘯/HMR 鏃堕伩鍏嶉噸澶嶆敞鍐岋級 */
  function disposeCloudAutoPull(): void {
    if (autoPullTimer) {
      clearTimeout(autoPullTimer);
      autoPullTimer = null;
    }
    if (cloudPushTimer) {
      clearTimeout(cloudPushTimer);
      cloudPushTimer = null;
    }
    if (versionPollTimer) {
      clearInterval(versionPollTimer);
      versionPollTimer = null;
    }
    autoPullInstalled = false;
  }

  function update(patch: Partial<Settings>): void {
    settings.value = mergeSettings(settings.value, patch);
    settings.value.updatedAt = Date.now();
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  /** 鍒ゆ嵁锛氳繖娆?appearance 鏀瑰姩鏄惁纰板埌浜嗐€岃法绔己涓€鑷淬€嶇殑涓婚瀛楁 */
  function touchesThemeFields(patch: Partial<Settings['appearance']>): boolean {
    return GLOBAL_APPEARANCE_FIELDS.some((f) => (patch as Record<string, unknown>)[f] !== undefined);
  }

  function updateAppearance(patch: Partial<Settings['appearance']>): void {
    const next = { ...settings.value.appearance, ...patch };
    // 当用户切换明暗外观（light / dark / system）时，若当前主题预设的 mode 与目标明暗不一致，
    // 自动切换到匹配的默认浅色（daylight）或深色（midnight）主题预设，确保点击立即生效。
    if (patch.theme !== undefined && patch.themePresetId === undefined) {
      const prefersDark =
        typeof window !== 'undefined'
          ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
          : false;
      const wantDark = patch.theme === 'dark' || (patch.theme === 'system' && prefersDark);
      const currentPreset = findTheme(next.themePresetId, next.customThemes);
      if (!currentPreset || (currentPreset.mode === 'dark') !== wantDark) {
        const targetId = wantDark ? 'midnight' : 'daylight';
        const targetTheme = findTheme(targetId, next.customThemes);
        if (targetTheme) {
          next.themePresetId = targetTheme.id;
          next.editorColorScheme = PRESET_TO_LEGACY_SCHEME[targetTheme.id] ?? 'custom';
          next.customEditorBg = targetTheme.contentBg;
          next.customEditorFg = targetTheme.contentFg;
        }
      }
    }
    settings.value.appearance = next;
    if (touchesThemeFields(patch)) markThemeDirty();
    persist();
    applyTheme();
    scheduleCloudPush();
  }

  function updateLayout(patch: Partial<Settings['layout']>): void {
    settings.value.layout = { ...settings.value.layout, ...patch };
    /*
     * 这里**不**置「脏标记」。布局是否与云端一致由 `captureLocalLayoutOverrides()`
     * 逐字段比对基线决定（见该函数的注释）——因为 `updateLayout()` 除了用户拖拽，
     * 还被面板开合、功能区切换等程序化路径大量调用，用布尔标记会永久置位，
     * 反而让跨端布局同步彻底失效。
     */
    persist();
    scheduleCloudPush();
  }

  /**
   * 鏇存柊鏈嶅姟绔繛鎺ラ厤缃紙浠呮闈㈢浣跨敤锛夈€?   *
   * 涓変釜瀛楁鍏ㄩ儴鏄?*涓ユ牸鏈湴**閰嶇疆锛坄server` 鍦?`LOCAL_ONLY_KEYS` 涓紝姘镐笉杩涗簯绔?payload锛夛紝
   * 鍥犳杩欓噷鐩存帴鏀瑰唴瀛?+ 钀界洏锛屼笉璧?`update()`锛堝悗鑰呬細瑙﹀彂浜戠鎺ㄩ€侊級銆?   * `customBaseUrl` 浼氬厛鍋氳鑼冨寲锛氬幓灏炬枩鏉犮€佸幓鎺夎濉殑 `/api` 鍚庣紑銆佹牎楠?http(s)銆?   */
  function updateServer(patch: Partial<ServerSettings>): void {
    const cur = settings.value.server ?? DEFAULT_SERVER_SETTINGS;
    const next: ServerSettings = {
      mode: patch.mode ?? cur.mode,
      customBaseUrl:
        patch.customBaseUrl === undefined ? cur.customBaseUrl : normalizeServerBase(patch.customBaseUrl),
      privacyMode: patch.privacyMode ?? cur.privacyMode,
    };
    settings.value.server = next;
    settings.value.updatedAt = Date.now();
    persist();
  }

  function setSecret(kind: 'ai' | 'storage', value: string): void {
    if (kind === 'ai') {
      secrets.value.aiKey = value;
      settings.value.ai.apiKey = value;
    } else {
      secrets.value.storageSecret = value;
      settings.value.storage.accessKeySecret = value;
    }
    scheduleCloudPush();
  }

  function setStorageKeyId(value: string): void {
    secrets.value.storageKeyId = value;
    settings.value.storage.accessKeyId = value;
    scheduleCloudPush();
  }

  function togglePlugin(id: string, enabled: boolean): void {
    settings.value.enabledPlugins = { ...settings.value.enabledPlugins, [id]: enabled };
    persist();
    scheduleCloudPush();
  }

  function pluginOn(id: string): boolean {
    return settings.value.enabledPlugins[id] !== false;
  }

  const aiConfigured = computed(
    () => Boolean(settings.value.ai.apiKey) || settings.value.ai.usePlatform,
  );
  const storageConfigured = computed(
    () => Boolean(settings.value.storage.bucket && (settings.value.storage.accessKeyId || settings.value.storage.accessKeySecret)),
  );

  /** 鏁版嵁绉佹湁鍖栨槸鍚﹀紑鍚細寮€鍚悗缂栬緫鍣ㄩ櫎搴旂敤鍟嗗簵澶栧畬鍏ㄤ笉鍐嶈姹傛湇鍔＄ */
  const privacyMode = computed(() => settings.value.server?.privacyMode === true);

  /**
   * 鏈嶅姟绔槸鍚﹀凡"鏄庣‘閰嶇疆"锛?   * - 瀹樻柟妯″紡瑙嗕负宸查厤缃紙寮€绠卞嵆鐢級锛?   * - 鑷缓妯″紡瑕佹眰濉簡鍚堟硶鐨?http(s) 鍦板潃銆?   */
  const serverConfigured = computed(() => {
    const server = settings.value.server;
    if (!server) return true;
    if (server.mode !== 'custom') return true;
    return Boolean(normalizeServerBase(server.customBaseUrl));
  });

  /** AI 鍙敤妯″瀷锛氫紭鍏堢敤鎴峰嬀閫夛紝鍏舵鏈嶅姟鍟嗛璁?*/
  const aiModels = computed(() => {
    const ai = settings.value.ai;
    if (ai.models && ai.models.length) return ai.models;
    return [];
  });

  function init(): void {
    applyTheme();
    ready.value = true;
    if (typeof window !== 'undefined') {
      window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
    }
    // （注释原文编码损坏，已清理）
  }

  watch(() => settings.value.appearance.theme, applyTheme);

  // （注释原文编码损坏，已清理）
  watch(
    () => [settings.value.appearance.themePresetId, settings.value.appearance.customThemes] as const,
    applyTheme,
    { deep: true },
  );

  return {
    settings,
    secrets,
    ready,
    init,
    update,
    updateAppearance,
    updateLayout,
    updateServer,
    setSecret,
    setStorageKeyId,
    togglePlugin,
    pluginOn,
    persist,
    pullCloudSettings,
    pushCloudSettings,
    /** 鑺傛祦鐗堟媺鍙栵細鎵撳紑璁剧疆椤点€佺獥鍙ｉ噸鏂板彲瑙佺瓑鍦烘櫙璋冪敤 */
    requestCloudPull,
    pollCloudVersion,
    disposeCloudAutoPull,
    aiConfigured,
    storageConfigured,
    aiModels,
    privacyMode,
    serverConfigured,
    /* 涓婚棰勮锛坱ask-3锛?*/
    activeTheme,
    themeList,
    applyThemePreset,
    /** 閲嶆柊濂楃敤褰撳墠涓婚锛堝垏鎹€屽簲鐢ㄨ寖鍥淬€嶇瓑鏈満鍋忓ソ鍚庤皟鐢紝璁╁彉閲忕珛鍗抽噸绠楋級 */
    reapplyTheme: applyTheme,
  };
});
