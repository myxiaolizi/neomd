/**
 * 只读校验：settings.ts 的词法结构是否平衡（块注释 / 行注释 / 字符串 / 模板串）。
 * 用来确认「按行号重写注释」没有把注释结束符丢掉、也没有把代码吞进注释。
 *
 * 用逐字符状态机而不是正则，因为注释结束符可能出现在字符串或模板串里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.join(path.resolve(here, '..'), 'apps', 'web', 'src', 'stores', 'settings.ts');
const src = fs.readFileSync(TARGET, 'utf8');

let state = 'code';
let blockStart = null;
let unclosedBlock = null;
let i = 0;
let line = 1;

while (i < src.length) {
  const c = src[i];
  const n = src[i + 1];
  if (c === '\n') line += 1;

  if (state === 'code') {
    if (c === '/' && n === '/') {
      state = 'line';
      i += 2;
      continue;
    }
    if (c === '/' && n === '*') {
      state = 'block';
      blockStart = line;
      i += 2;
      continue;
    }
    if (c === "'") {
      state = 'sq';
      i += 1;
      continue;
    }
    if (c === '"') {
      state = 'dq';
      i += 1;
      continue;
    }
    if (c === '`') {
      state = 'tpl';
      i += 1;
      continue;
    }
    i += 1;
    continue;
  }

  if (state === 'line') {
    if (c === '\n') state = 'code';
    i += 1;
    continue;
  }

  if (state === 'block') {
    if (c === '*' && n === '/') {
      state = 'code';
      blockStart = null;
      i += 2;
      continue;
    }
    i += 1;
    continue;
  }

  if (state === 'sq' || state === 'dq' || state === 'tpl') {
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    ) {
      state = 'code';
    }
    i += 1;
    continue;
  }
}

if (state === 'block') unclosedBlock = blockStart;

console.log(`文件：${TARGET}`);
console.log(`总行数：${src.split('\n').length}`);
console.log(`结束状态：${state}`);
console.log(`未闭合块注释：${unclosedBlock === null ? '无' : `第 ${unclosedBlock} 行`}`);
process.exit(state === 'code' ? 0 : 1);
