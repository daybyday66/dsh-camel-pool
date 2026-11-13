import { execFileSync } from "node:child_process";
const ROOT = process.argv[2];
const exe = process.execPath;
const f = ROOT + "/scripts/probe-ca-ab-child.mjs";
for (let i = 1; i <= 4; i++) {
  for (const mode of ["A", "B"]) {
    let out = "";
    try { out = execFileSync(exe, [f, ROOT, mode], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", timeout: 60000 }).trim(); } catch (e) { out = "ERR " + (e.stdout || e.message); }
    const line = out.split("\n").find((l) => l.startsWith("RESULT")) || out.slice(-160);
    console.log("pair " + i + " " + line + "  @ " + new Date().toISOString());
  }
}