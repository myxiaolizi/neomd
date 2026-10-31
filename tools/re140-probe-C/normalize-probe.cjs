function normalizePluginSource(codeJs) {
  const src = String(codeJs ?? '').replace(/^\uFEFF/, '');
  if (!/\bexport\s+default\b/.test(src)) return src;
  const cleaned = src.replace(/^\s*export\s+default\s+/m, 'return ');
  return cleaned.replace(/\bexport\s+default\s+/, 'return ');
}
const cases = [
  ['a_block_comment', '/* header */\nexport default { id: "a", setup() {} };'],
  ['b_newline_after_export', 'export default\n{ id: "b", setup() {} };'],
  ['c_string_export_default', 'export default { id: "c", note: "literal export default object", setup() {} };'],
  ['d_brace_in_string_template_regex', 'export default { id: "d", template: `contains } brace`, re: /}/, setup() {} };'],
  ['e_single_line_comment', 'export default { id: "e", // comment then code\n setup() {} };'],
  ['e_single_line_comment_minified', 'export default { id: "emin", // comment then code setup() {} };'],
  ['f_template_literal', 'export default { id: "f", text: `hello ${1 + 2}`, setup() {} };'],
  ['g_legacy_return', 'return { id: "g", setup() {} };'],
];
const results = cases.map(([id, source]) => {
  const cleaned = normalizePluginSource(source);
  try {
    const value = new Function(cleaned)();
    return { id, source, cleaned, compileExecute: 'ok', returnedId: value && value.id, keys: value ? Object.keys(value) : [], error: null };
  } catch (e) {
    return { id, source, cleaned, compileExecute: 'fail', returnedId: null, keys: [], error: `${e.name}: ${e.message}` };
  }
});
console.log(JSON.stringify(results, null, 2));