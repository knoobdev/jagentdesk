import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSeededHost } from "../../packages/app/e2e/support/helpers/daemon-registry";
import { chromium } from "../../node_modules/playwright-core/index.js";

const freePort = (): Promise<number> => new Promise((res, rej) => { const s=net.createServer();s.listen(0,"127.0.0.1",()=>{const p=(s.address() as net.AddressInfo).port;s.close(()=>res(p));});s.on("error",rej); });
const waitListen = (port: number, tries=60): Promise<void> => new Promise((res, rej) => { let n=0;const tick=()=>{const c=net.connect(port,"127.0.0.1",()=>{c.destroy();res();});c.on("error",()=>{c.destroy();if(++n>tries)rej(new Error("no listen"));else setTimeout(tick,500);});};tick(); });

async function main() {
  const dPort = await freePort(); const wPort = await freePort();
  const serverId = "srv_e2eflow"; const home = mkdtempSync(path.join(tmpdir(), "jad-flow-"));
  const serverDir = path.resolve(__dirname, "../../packages/server");
  const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
  const distDir = path.resolve(__dirname, "../../packages/app/dist");
  const daemon = spawn(tsxBin, ["scripts/supervisor-entrypoint.ts","--dev"], { cwd: serverDir, env: {
    ...process.env, JAGENTDESK_HOME: home, JAGENTDESK_LISTEN: `127.0.0.1:${dPort}`,
    JAGENTDESK_SERVER_ID: serverId, JAGENTDESK_CORS_ORIGINS: `http://127.0.0.1:${wPort}`,
    JAGENTDESK_NODE_ENV: "development", NODE_ENV: "development",
  }, stdio: ["ignore","ignore","pipe"] });
  let derr=""; daemon.stderr?.on("data",(b:Buffer)=>derr=(derr+b).split("\n").slice(-20).join("\n"));
  const srv = http.createServer((req,res)=>{ let p=decodeURIComponent((req.url||"/").split("?")[0]); let fp=path.join(distDir,p); if(!existsSync(fp)||statSync(fp).isDirectory()){ if(existsSync(fp+".html"))fp=fp+".html"; else fp=path.join(distDir,"index.html"); } try{const buf=readFileSync(fp);const ext=path.extname(fp);const ct=ext===".js"?"application/javascript":ext===".css"?"text/css":ext===".html"?"text/html":ext===".json"?"application/json":"application/octet-stream";res.writeHead(200,{"content-type":ct});res.end(buf);}catch{res.writeHead(404);res.end("nf");} });
  await new Promise<void>(r=>srv.listen(wPort,"127.0.0.1",()=>r()));
  const fin=(ok:boolean,msg:string)=>{console.log(ok?`\n✅ ${msg}`:`\n❌ ${msg}\n${derr}`);try{daemon.kill("SIGKILL");}catch{}srv.close();process.exit(ok?0:1);};
  try {
    await waitListen(dPort); console.log("[flow] daemon up");
    const host = buildSeededHost({ serverId, endpoint:`127.0.0.1:${dPort}`, label:"e2e", nowIso:"2026-08-24T00:00:00.000Z" });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport:{width:1440,height:900}, deviceScaleFactor:2 });
    await page.addInitScript((h:any)=>{ localStorage.setItem("@jagentdesk:daemon-registry", JSON.stringify([h])); }, host);
    await page.goto(`http://127.0.0.1:${wPort}/h/${serverId}/clusters`, { waitUntil:"domcontentloaded" });
    await page.getByText("Clusters", { exact:true }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path:"/tmp/k8s-fix-1-clusters.png" });
    console.log("[flow] shot 1 clusters");

    // Connect the current (green-dot) GKE context — click a Connect button
    const connectBtn = page.getByText("Connect", { exact:true }).first();
    await connectBtn.waitFor({ timeout: 15000 });
    await connectBtn.click();
    console.log("[flow] clicked Connect, waiting for Open workloads...");
    await page.getByText("Open workloads", { exact:true }).first().waitFor({ timeout: 90000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path:"/tmp/k8s-fix-2-connected.png" });
    console.log("[flow] shot 2 connected");

    // Open workloads -> separate screen
    await page.getByText("Open workloads", { exact:true }).first().click();
    await page.waitForTimeout(5000);
    await page.screenshot({ path:"/tmp/k8s-fix-3-workloads.png" });
    const wbody = await page.evaluate(()=>document.body.innerText.slice(0,300));
    console.log("[flow] shot 3 after open-workloads. body:", JSON.stringify(wbody));

    // Select Pods in nav rail
    const pods = page.getByText("Pod", { exact:true }).first();
    await pods.waitFor({ timeout: 15000 });
    await pods.click();
    await page.getByText("NAMESPACE", { exact:true }).first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path:"/tmp/k8s-fix-4-pods.png" });
    const body = await page.evaluate(()=>document.body.innerText);
    console.log("[flow] shot 4 pods. Has NAMESPACE header:", /NAMESPACE/.test(body), "Has AGE:", /AGE/.test(body));
    await browser.close();
    fin(true, "DESKTOP FLOW OK: clusters -> connect -> open workloads (separate) -> pods table");
  } catch(e:any){ fin(false, `flow exception: ${e?.message}`); }
}
main();
