import { pathToFileURL } from "node:url";
import path from "node:path";
const M = "C:/Data/BAC/neomd/neomd-V1/node_modules/.pnpm/mysql2@3.24.6_@types+node@22.19.1/node_modules/mysql2/promise.js";
const mysql = (await import(pathToFileURL(M).href)).default;
const c = await mysql.createConnection({host:"tx.zhengl.vip",port:3306,user:"neomd_audit150b",password:"37700a7853ae36fa",database:"neomd_audit150b",connectTimeout:10000});
const [v] = await c.query("SELECT VERSION() v, DATABASE() d");
console.log("connected", v[0]);
const [t] = await c.query("SHOW TABLES");
console.log("tables:", t.length);
for (const row of t) {
  const name = Object.values(row)[0];
  const [cnt] = await c.query(`SELECT COUNT(*) c FROM \`${name}\``);
  const [idx] = await c.query(`SHOW INDEX FROM \`${name}\``);
  console.log(name.padEnd(26), String(cnt[0].c).padStart(8), "idx:", [...new Set(idx.map(i=>i.Key_name))].join(",") || "(NONE)");
}
await c.end();
