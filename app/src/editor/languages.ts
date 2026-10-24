import { LanguageDescription } from '@codemirror/language';

/**
 * 代码块语法高亮语言集合。
 * 只登记常用语言并按需动态加载，避免把上百种语言打进首屏包。
 */
export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'JavaScript',
    alias: ['js', 'jsx', 'mjs', 'cjs', 'typescript', 'ts', 'tsx'],
    extensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'],
    load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  }),
  LanguageDescription.of({
    name: 'Python',
    alias: ['py', 'python3'],
    extensions: ['py', 'pyw'],
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: 'HTML',
    alias: ['htm', 'xml', 'vue', 'svg'],
    extensions: ['html', 'htm', 'xml', 'svg', 'vue'],
    load: () => import('@codemirror/lang-html').then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: 'CSS',
    alias: ['scss', 'less', 'sass'],
    extensions: ['css', 'scss', 'less'],
    load: () => import('@codemirror/lang-css').then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: 'JSON',
    alias: ['jsonc', 'json5'],
    extensions: ['json', 'jsonc'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'SQL',
    alias: ['mysql', 'postgres', 'sqlite', 'pgsql'],
    extensions: ['sql'],
    load: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: 'Rust',
    alias: ['rs'],
    extensions: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: 'C++',
    alias: ['cpp', 'c', 'h', 'hpp', 'c++', 'objc'],
    extensions: ['c', 'h', 'cpp', 'hpp', 'cc', 'cxx'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'Java',
    alias: ['java', 'kotlin', 'kts', 'csharp', 'cs', 'scala'],
    extensions: ['java', 'kt', 'cs'],
    load: () => import('@codemirror/lang-java').then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: 'Go',
    alias: ['golang'],
    extensions: ['go'],
    load: () => import('@codemirror/lang-go').then((m) => m.go()),
  }),
];
