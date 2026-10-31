const fs=require('fs');
const path=require('path');
const now=new Date().toISOString();
const root=process.cwd();
const files=['apps/web/src/views/EditorPage.vue','apps/web/src/components/panels/PluginCenter.vue','services/api/src/routes/plugins.js','apps/web/src/components/panels/PluginPanel.vue','packages/shared/src/plugins.ts'];
const mtimes=Object.fromEntries(files.map(f=>{const s=fs.statSync(f);return [f,{mtimeUtc:s.mtime.toISOString(),bytes:s.size}]}));
const readJson = (file) => {
 const b = fs.readFileSync(file);
 const text = b[0] === 0xff && b[1] === 0xfe ? b.subarray(2).toString('utf16le') : b.toString('utf8').replace(/^\uFEFF/, '');
 return JSON.parse(text);
};
const normalize=readJson('tools/re140-probe-C/normalize-results.json');
const audit=readJson('tools/re140-probe-C/builtin-host-audit.json');
const source=fs.readFileSync('apps/web/src/views/EditorPage.vue','utf8');
const allRows=audit.rows.map(r=>({
 id:r.id, declared:{panel:r.panel,commands:r.commands,shortcuts:r.shortcuts,editorExtension:r.editorExtension,chunk:r.chunk},
 hostApi:{
  panel:r.panelHost ? (r.panelHost.rendered?'provided':'missing-render-branch') : (r.panel?'missing':'not-required'),
  command:r.commandStatus.map(c=>({id:c.id,provided:c.hostCase})),
  shortcut:r.shortcuts.length?'missing-manifest-binding':'not-required',
  editorExtension:r.editorExtension?'missing-loader-registration':'not-required',
  ribbon:r.ribbonHost?'hosted-or-forced-candidate':'not-required'
 },
 verdict:r.verdict,
 certainFailure:r.findings.length?true:false,
 findings:r.findings
}));
const certain=allRows.filter(r=>r.certainFailure).map(r=>r.id);
const report={
 schemaVersion:'1.0',
 title:'Neo MD 1.4 Plugin Chain Independent Evidence C',
 measurement:{sampleStartedAt:'2026-10-30T23:28:54+08:00',reportGeneratedAt:now,platform:'Windows / PowerShell / Node 24',services:{web:'http://127.0.0.1:5178',api:'http://127.0.0.1:3200'},fileMtimes:mtimes},
 issue1:{
  rootCause:'Community plugin source is executed as a Function body. normalizePluginSource first does a line-anchored ESM replacement, then performs an unrestricted second replacement anywhere in the source. It does not parse JavaScript; therefore it mutates an export-default phrase inside a string literal. It also cannot repair a source whose // comment was collapsed with later syntax onto the same line. The current version does correctly handle leading block comments, export-default newline object, braces in strings/regex/template literals, normal // comments, and legacy return bodies.',
 evidence:{
  implementation:{file:'apps/web/src/views/EditorPage.vue',lines:[483,492],algorithm:['strip BOM','if no export-default token return unchanged','replace line-start export default with return using m','fallback replace first word-boundary export default anywhere']},
  probe:{script:'tools/re140-probe-C/normalize-probe.cjs',rawResults:'tools/re140-probe-C/normalize-results.json',engine:'Node 24 new Function(cleaned)()'},
  caseTable:normalize.map(x=>({case:x.id,compileExecute:x.compileExecute,error:x.error,semanticIntegrity:x.id==='c_string_export_default'?'FAIL: literal changed from "export default object" to "return object"':'pass',cleaned:x.cleaned}))
 },
 affectedLines:[
  {file:'apps/web/src/views/EditorPage.vue',lines:'483-492',reason:'regex normalization and unsafe fallback'},
  {file:'apps/web/src/views/EditorPage.vue',lines:'511-520',reason:'new Function executes normalized source and only surfaces runtime syntax error'},
  {file:'apps/web/src/components/panels/PluginCenter.vue',lines:'298-309',reason:'market install stores raw codeJs locally'},
  {file:'services/api/src/routes/plugins.js',lines:'312-318',reason:'download endpoint returns formatPlugin(fresh, true), including plugin code'}
 ],
 suggestedFix:'Remove the arbitrary-position fallback replacement. Accept a strict documented Function-body format (return {...}) or parse/transpile the ESM source with a real parser/compiler. Validate source on publish/install with the same executor and reject malformed minified // comments. Preserve strings/comments by AST transform rather than regex.'
 },
 issue2:{
  rootCause:'settings.layout.ribbonItems is an ordered whitelist of known built-in action IDs, not a dynamic plugin registry. EditorPage maps every candidate through the hard-coded PLUGIN_RIBBON_DEFS; unknown IDs are discarded. PluginCenter installation only writes neomd.communityPlugins.v1 and enabledPlugins[pluginId]. It does not append to ribbonItems, and the context-menu add list RIBBON_ALL_ITEMS also contains only built-ins. Community commands are only injected into buildCommands, which is evaluated when the command palette opens.',
 evidence:{
  browserTest:{
   login:'admin (one successful login; no retry)',
   installedPlugin:{pluginId:'meeting-minutes-tpl',name:'商务会议纪要模板'},
   before:{ribbonItems:['daily-notes','random-note','graph','tag-list','bookmarks','file-recovery','whiteboard','slides','database','web-browser','recorder','diagram-flowchart']},
   after:{localCommunityPluginPresent:true,enabledPluginsValue:true,ribbonItemsUnchanged:true,newRibbonButtonPresent:false},
   executionEntrySearch:'No community button was rendered in ribbon/status bar. EditorPage source shows one potential entry: command palette buildCommands() reads localStorage and appends command plugin:<id> only while enabled. The palette is the only discovered execution entry; it is not a persistent function-area entry.'
  },
  sourceEvidence:[
   {file:'apps/web/src/components/panels/PluginCenter.vue',lines:'69-106',fact:'installation persistence is localStorage plus settingsStore.togglePlugin'},
   {file:'apps/web/src/components/panels/PluginCenter.vue',lines:'298-309',fact:'market install downloads and saves raw community package; no ribbon update'},
   {file:'apps/web/src/views/EditorPage.vue',lines:'195-230',fact:'ribbon candidate IDs are resolved exclusively through hard-coded PLUGIN_RIBBON_DEFS; unknown IDs continue'},
   {file:'apps/web/src/views/EditorPage.vue',lines:'446-465',fact:'community commands are added only in buildCommands'},
   {file:'apps/web/src/views/EditorPage.vue',lines:'1915-1929',fact:'right-click add list is hard-coded built-ins'},
   {file:'apps/web/src/views/EditorPage.vue',lines:'525,3279',fact:'paletteCommands is refreshed when palette opens and passed to CommandPalette'}
  ]
 },
 affectedLines:[
  {file:'apps/web/src/components/panels/PluginCenter.vue',lines:'96-109'},
  {file:'apps/web/src/components/panels/PluginCenter.vue',lines:'298-313'},
  {file:'apps/web/src/views/EditorPage.vue',lines:'195-230'},
  {file:'apps/web/src/views/EditorPage.vue',lines:'446-465'},
  {file:'apps/web/src/views/EditorPage.vue',lines:'1915-1974'}
 ],
 suggestedFix:'Keep built-in ribbonItems as a validated built-in whitelist. Add a separate layout.communityRibbonItems:string[] containing IDs prefixed community:. On installation, offer an explicit "Add to ribbon" command only for community manifests that declare a ribbon contribution. Generate the visual action from the installed plugin registry, resolve community:<id> to runCommunityPlugin, and include the separate list in the ribbon context menu. Keep the command palette entry as a secondary discovery path.'
 },
 issue3:{
  rootCause:'The shared manifest is declarative only. PluginPanel hosts 13 component branches plus file-list metadata without a render branch, while several panel=true manifests have no host entry at all. EditorPage’s shortcut/command dispatcher recognizes only random.open and daily.today among the 20 declared built-in command IDs; diagrams are actually exposed by separate ribbon action IDs, not their declared command IDs. No manifest-to-chunk loader or editor-extension registration was found in EditorPage.',
 evidence:{script:'tools/re140-probe-C/builtin-host-audit.cjs',rawResults:'tools/re140-probe-C/builtin-host-audit.json',manifestCount:audit.manifestCount,table:allRows,certainlyIncomplete:certain,notes:['A panel branch proves a panel host path, not every declared command.', 'daily-notes is partially hosted: panel and daily.today exist; daily.open is absent.', 'diagram plugins are feature-hosted via direct ribbon cases diagram-flowchart/diagram-mindmap but their declared command IDs diagram.createFlowchart/diagram.createMindmap are absent.']},
 affectedLines:[
  {file:'packages/shared/src/plugins.ts',lines:'26-299',reason:'26 declarative plugin definitions'},
  {file:'apps/web/src/components/panels/PluginPanel.vue',lines:'29-45',reason:'panel registry excludes outgoing-links,publish,footnote-view,database,word-count'},
  {file:'apps/web/src/components/panels/PluginPanel.vue',lines:'285-345',reason:'file-list has metadata but no branch; supported branches listed'},
  {file:'apps/web/src/views/EditorPage.vue',lines:'630-669',reason:'shortcut dispatcher only has daily.today/random.open of declared plugin command IDs'},
  {file:'apps/web/src/views/EditorPage.vue',lines:'1553-1603',reason:'ribbon action switch does not route most declared built-in command IDs'}
 ],
 suggestedFix:'Define a typed runtime contribution registry and make PLUGINS the source of truth: map each manifest command to a host handler, each panel contribution to a renderable component, and each editorExtension to an actual extension factory. At startup, assert every enabled manifest contribution resolves. Either implement or remove unsupported declared contributions; add explicit tests for all 26 IDs.'
 },
 limitations:['No source files were modified. Only tools/re140-probe-C and docs/evidence-140 were created.', 'The browser test installed one public plugin into the authenticated browser localStorage as requested; no API data or source files were changed.', 'Browser evaluate output contained credentials in localStorage; none are recorded in this report.']
};
fs.writeFileSync('docs/evidence-140/subagent-C-plugins.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({path:path.resolve('docs/evidence-140/subagent-C-plugins.json'),bytes:fs.statSync('docs/evidence-140/subagent-C-plugins.json').size,certain},null,2));