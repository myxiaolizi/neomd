import { pathToFileURL } from "node:url";
const P = "C:/Data/BAC/neomd/neomd-V1/node_modules/.pnpm/playwright-core@1.64.1/node_modules/playwright-core/index.mjs";
const { chromium } = await import(pathToFileURL(P).href);
const login = await (await fetch("http://127.0.0.1:3200/api/auth/login",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({account:"admin",password:process.env.AUDIT_PASS})})).json();
if(!login.ok){console.log("LOGIN FAIL",JSON.stringify(login).slice(0,300));process.exit(1);}
console.log("login ok user:", login.data.user.username, "role:", login.data.user.role);
const b = await chromium.launch({args:["--no-sandbox","--disable-gpu","--disable-dev-shm-usage","--js-flags=--expose-gc"]});
const ctx = await b.newContext({viewport:{width:1600,height:950},locale:"zh-CN"});
await ctx.addInitScript(([a,r,u])=>{localStorage.setItem("neomd.access",a);localStorage.setItem("neomd.refresh",r);localStorage.setItem("neomd.user.cache",u);localStorage.setItem("neomd.deviceId","a150-probe");},[login.data.accessToken,login.data.refreshToken,JSON.stringify(login.data.user)]);
const p = await ctx.newPage();
p.on("pageerror",e=>console.log("PAGEERR:",String(e).slice(0,200)));
await p.goto("http://127.0.0.1:5178/app",{waitUntil:"load",timeout:90000});
await p.waitForSelector(".shell__main",{timeout:40000});
await new Promise(r=>setTimeout(r,2500));
const info = await p.evaluate(()=>{
  const pinia = document.querySelector("#app")?.__vue_app__?.config?.globalProperties?.$pinia;
  const stores = pinia?._s instanceof Map ? [...pinia._s.keys()] : Object.keys(pinia?._s||{});
  const app = pinia?._s?.get?.("app");
  const vault = pinia?._s?.get?.("vault");
  return {
    stores,
    appKeys: app? Object.keys(app).slice(0,80):null,
    tabs: app?.tabs?.length ?? null,
    activeTab: app?.activeTab ? {keys:Object.keys(app.activeTab), docId:app.activeTab.docId, path:app.activeTab.path, len:(app.activeTab.content||"").length}:null,
    vaultKeys: vault? Object.keys(vault).slice(0,40):null,
    vaults: vault?.vaults?.map?.(v=>({id:v.id,name:v.name,provider:v.provider,type:v.type,status:v.status}))?.slice(0,6) ?? null,
    hasCreateDoc: typeof app?.createDoc,
    editor: document.querySelectorAll(".ProseMirror").length,
    btnTexts: [...document.querySelectorAll("button")].map(b=>b.textContent.trim()).filter(t=>t&&t.length<12).slice(0,25),
  };
});
console.log(JSON.stringify(info,null,2));
await b.close();
