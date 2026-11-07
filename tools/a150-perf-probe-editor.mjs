import { pathToFileURL } from "node:url";
const P = "C:/Data/BAC/neomd/neomd-V1/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs";
const { chromium } = await import(pathToFileURL(P).href);
const login = await (await fetch("http://127.0.0.1:3200/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account:"admin",password:process.env.AUDIT_PASS})})).json();
const b = await chromium.launch({args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--js-flags=--expose-gc"]});
const ctx = await b.newContext({viewport:{width:1600,height:950},locale:"zh-CN"});
await ctx.addInitScript(([a,r,u])=>{localStorage.setItem("neomd.access",a);localStorage.setItem("neomd.refresh",r);localStorage.setItem("neomd.user.cache",u);localStorage.setItem("neomd.deviceId","a150-probe");},[login.data.accessToken,login.data.refreshToken,JSON.stringify(login.data.user)]);
const p = await ctx.newPage();
p.on("pageerror",e=>console.log("PAGEERR:",String(e).slice(0,300)));
p.on("console",m=>{if(m.type()==="error")console.log("CONSOLE-ERR:",m.text().slice(0,200));});
await p.goto("http://127.0.0.1:5178/app",{waitUntil:"load",timeout:90000});
await p.waitForSelector(".shell__main",{timeout:40000});
await new Promise(r=>setTimeout(r,2500));
const vaultState = await p.evaluate(()=>{
  const app=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("app");
  return {vault:app.vault, vaultReady:app.vaultReady, vaultName:app.vaultName, vaults:(app.vaults||[]).map(v=>({id:v.vaultId??v.id,name:v.name,status:v.status})), docs:(app.docs||[]).length, storageConfigProblem:app.storageConfigProblem};
});
console.log("vaultState:", JSON.stringify(vaultState,null,2));
const t0=Date.now();
const created = await p.evaluate(async ()=>{
  const app=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("app");
  try { const r = await app.createDoc({title:"A150-PROBE", content:"# probe\n\nhello"}); return {ok:true, docId:app.activeTab?.docId??null, tabs:app.tabs.length}; }
  catch(e){ return {ok:false, err:String(e?.message||e).slice(0,300)}; }
});
console.log("createDoc:", JSON.stringify(created), "elapsed", Date.now()-t0);
await p.waitForSelector(".ProseMirror",{timeout:20000}).then(()=>console.log("ProseMirror attached")).catch(()=>console.log("ProseMirror TIMEOUT"));
await new Promise(r=>setTimeout(r,1500));
const ed = await p.evaluate(()=>({pm:document.querySelectorAll(".ProseMirror").length, cm:document.querySelectorAll(".cm-content").length, readView:document.querySelectorAll(".read-view").length, mode:document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("app").activeMode}));
console.log("editor:",JSON.stringify(ed));
await b.close();
