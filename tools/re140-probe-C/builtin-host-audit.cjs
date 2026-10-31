const fs = require('fs');
const shared = fs.readFileSync('packages/shared/src/plugins.ts', 'utf8');
const editor = fs.readFileSync('apps/web/src/views/EditorPage.vue', 'utf8');
const panel = fs.readFileSync('apps/web/src/components/panels/PluginPanel.vue', 'utf8');
const manifests = [...shared.matchAll(/\{\s*id:\s*'([^']+)'[\s\S]*?contributes:\s*\{([^}]*)\}[\s\S]*?chunk:\s*'([^']+)'[\s\S]*?\n\s*\}/g)].map(m => {
 const body=m[2]; return {id:m[1], chunk:m[3], panel:/panel:\s*true/.test(body), commands:[...body.matchAll(/commands:\s*\[([^\]]*)\]/g)].flatMap(x=>[...x[1].matchAll(/'([^']+)'/g)].map(y=>y[1])), shortcuts:[...body.matchAll(/shortcuts:\s*\[([^\]]*)\]/g)].flatMap(x=>[...x[1].matchAll(/'([^']+)'/g)].map(y=>y[1])), editorExtension:/editorExtension:\s*true/.test(body)};
});
const panelPluginIds = [...panel.matchAll(/plugin:\s*'([^']+)'/g)].map(m=>m[1]);
const renderedPanels = [...panel.matchAll(/v-(?:if|else-if)="panel === '([^']+)'/g)].map(m=>m[1]);
const commandCases = [...editor.matchAll(/case '([^']+)'/g)].map(m=>m[1]);
const ribbonIds = [...editor.matchAll(/^\s*'([^']+)'\s*:\s*\{ icon:.*pluginId:/gm)].map(m=>m[1]);
const panelMap={
 'file-list':'file-list',outline:'outline','tag-list':'tag-list',backlinks:'backlinks',properties:'properties',bookmarks:'bookmarks',daily:'daily-notes',graph:'graph',recovery:'file-recovery',slides:'slides',whiteboard:'whiteboard',browser:'web-browser',recorder:'recorder',reorganize:'note-reorganize'
};
const panelByPlugin={}; for(const [p,id] of Object.entries(panelMap)) panelByPlugin[id]={panel:p,rendered:renderedPanels.includes(p)};
const rows=manifests.map(x=>{
 const p=panelByPlugin[x.id]; const commandStatus=x.commands.map(c=>({id:c,hostCase:commandCases.includes(c)}));
 const ribbon=x.id==='diagram-flowchart'||x.id==='diagram-mindmap'||ribbonIds.includes(x.id);
 const findings=[];
 if(x.panel && !p) findings.push('manifest panel=true but PluginPanel has no PANEL_META/render branch');
 if(p && !p.rendered) findings.push('PANEL_META exists but no render branch');
 if(x.commands.length && commandStatus.every(c=>!c.hostCase)) findings.push('declared command has no EditorPage command dispatcher case');
 if(x.shortcuts.length) findings.push('manifest shortcut is declarative; no command-id binding from manifest found');
 if(x.editorExtension) findings.push('manifest editorExtension is declarative; no chunk loader/extension registration found in EditorPage');
 return {...x,panelHost:p??null,commandStatus,ribbonHost:ribbon,verdict:findings.length?'definitely incomplete':'host path observed',findings};
});
console.log(JSON.stringify({manifestCount:rows.length, panelPluginIds,renderedPanels,commandCases,rows},null,2));