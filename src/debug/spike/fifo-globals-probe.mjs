// Nail down opcode 9 (module/global declarations) record layout with varied
// name lengths and types, so a dedicated parser can be written safely.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.PUREBASIC_HOME;
const compiler = path.join(HOME, "compilers", "pbcompiler");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rawprobe2-"));
const src = path.join(dir, "fixture.pb");
const LINES = [
  "Global gg.i = 7",             // 1
  "Define alpha.i = 11",         // 2
  "Define bb.s = \"hi\"",        // 3
  "Define c3.q = 22",            // 4
  "Define z.f = 1.5",            // 5
  "Debug alpha + c3",            // 6
  "",
];
fs.writeFileSync(src, LINES.join("\n"));
const bin = path.join(dir, "target.bin");
const c = spawnSync(compiler, ["-d", "-ds", "-l", "-o", bin, src], { encoding: "utf8" });
console.error("compile:", c.status, c.stderr || "");
const OUT = path.join(dir, "o"), IN = path.join(dir, "i");
spawnSync("mkfifo", [OUT, IN]);
const child = spawn(bin, [], { env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT};${IN}` }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 300));
const rfd = fs.openSync(OUT, "r"), wfd = fs.openSync(IN, "w");
function send(op, f8 = 0, f12 = 0, f16 = 0, p) {
  const b = Buffer.alloc(20);
  b.writeInt32LE(op, 0); b.writeInt32LE(p ? p.length : 0, 4); b.writeInt32LE(f8, 8); b.writeInt32LE(f12, 12); b.writeInt32LE(f16, 16);
  fs.writeSync(wfd, b); if (p) fs.writeSync(wfd, p);
}
function rex(n) { const b = Buffer.alloc(n); let o = 0; while (o < n) { const r = fs.readSync(rfd, b, o, n - o, null); if (!r) throw new Error("EOF"); o += r; } return b; }
function rm() { const h = rex(20); const len = h.readInt32LE(4); return { type: h.readInt32LE(0), len, f8: h.readInt32LE(8), f12: h.readInt32LE(12), payload: len ? rex(len) : Buffer.alloc(0) }; }

rm(); rm(); // hello, announce
send(3, 3, -1); send(3, 1, 6); send(2, 0); // clear, break line 6, continue
for (let i = 0; i < 40; i++) { const m = rm(); if (m.type === 3) break; }
send(9);
const m = rm();
console.error(`op9: type=${m.type} len=${m.len} f8=${m.f8} f12=${m.f12}`);
console.error("hex=", m.payload.toString("hex"));
// annotate byte-by-byte
const p = m.payload;
let off = 0, rec = 0;
while (off < p.length) {
  const type = p[off], flag = p[off + 1], kind = p[off + 2], reserved = p.readInt32LE(off + 3);
  let n = off + 7;
  while (n < p.length && p[n] !== 0) n++;
  const name = p.toString("latin1", off + 7, n);
  const afterNul = n + 1;
  console.error(`rec${rec}: off=${off} type=0x${type.toString(16)} flag=${flag} kind=${kind} reserved=${reserved} name="${name}" nameEndNul@${n} nextBytes=${p.subarray(afterNul, afterNul + 4).toString("hex")}`);
  // guess next record starts where a 0x?? header with plausible type begins;
  // print candidate for +0 and +1 padding
  off = afterNul + 1; rec++;
  if (rec > 12) break;
}
send(3, 3, -1); send(2, 0);
await new Promise((r) => setTimeout(r, 200));
try { fs.closeSync(wfd); } catch {}
try { child.kill("SIGKILL"); } catch {}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
