import { describe, expect, it } from 'vitest';
import { buildDiaryName, isDiaryTitle, DIARY_SUFFIX } from '@neomd/shared';

/**
 * 日记命名（1.1.7 需求）。
 *
 * 用户原话：「点击今日日记时在文件名后面添加日记2个字，
 * 完整名称为：2026-10-27 日记（当前日记的第一行就是文件名）」。
 */
describe('buildDiaryName', () => {
  it('今天的日记名称为 `YYYY-MM-DD 日记`', () => {
    const now = new Date(2026, 9, 27, 21, 30); // 2026-10-27 21:30 本地时间
    expect(buildDiaryName(now)).toBe('2026-10-27 日记');
  });

  it('月份与日期补零', () => {
    expect(buildDiaryName(new Date(2026, 0, 5))).toBe('2026-01-05 日记');
    expect(buildDiaryName(new Date(2026, 11, 31))).toBe('2026-12-31 日记');
  });

  it('传入 `YYYY-MM-DD` 字符串时按本地日期解析，不会因 UTC 跨日', () => {
    expect(buildDiaryName('2026-10-27')).toBe('2026-10-27 日记');
    // 非补零输入也能规范化
    expect(buildDiaryName('2026-1-5')).toBe('2026-01-05 日记');
  });

  it('后缀是「日记」且与日期之间有一个空格', () => {
    const name = buildDiaryName('2026-10-27');
    expect(name).toBe(`2026-10-27 ${DIARY_SUFFIX}`);
    expect(name.includes(' ')).toBe(true);
    expect(name.startsWith(' ')).toBe(false);
    expect(name.endsWith(' ')).toBe(false);
  });

  it('不含 `.md` 后缀（文件名由 vault 负责补扩展名）', () => {
    expect(buildDiaryName('2026-10-27').endsWith('.md')).toBe(false);
  });

  it('不包含路径分隔符（日记文件放在「日记」文件夹下，名字本身不带路径）', () => {
    const name = buildDiaryName('2026-10-27');
    expect(name.includes('/')).toBe(false);
    expect(name.includes('\\')).toBe(false);
  });

  it('不再使用 `YYMMDD日HHMM-` 模板格式', () => {
    const name = buildDiaryName(new Date(2026, 9, 27, 21, 30));
    expect(/^\d{6}日/.test(name)).toBe(false);
    expect(name.endsWith('-')).toBe(false);
  });
});

describe('isDiaryTitle', () => {
  it('识别新格式的当日日记', () => {
    expect(isDiaryTitle('2026-10-27 日记', '2026-10-27')).toBe(true);
  });

  it('兼容旧格式 `YYYY-MM-DD`（升级后不会同日出现两篇）', () => {
    expect(isDiaryTitle('2026-10-27', '2026-10-27')).toBe(true);
  });

  it('不同日期不误判', () => {
    expect(isDiaryTitle('2026-10-26 日记', '2026-10-27')).toBe(false);
    expect(isDiaryTitle('2026-10-26', '2026-10-27')).toBe(false);
  });

  it('普通文档标题不误判', () => {
    expect(isDiaryTitle('会议记录', '2026-10-27')).toBe(false);
    expect(isDiaryTitle('日记', '2026-10-27')).toBe(false);
    expect(isDiaryTitle('', '2026-10-27')).toBe(false);
  });

  it('缺省日期时按今天判断', () => {
    const today = buildDiaryName(new Date());
    expect(isDiaryTitle(today)).toBe(true);
  });
});
