// Replicate step("in")'s wire behaviour: stop at line 13 (the Add call),
// then breakpoint every line and continue, to see where the target actually
// stops. step() expects the very next executable line (inside Add). If it
// lands past the call instead, the emulation can't step into calls.
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = process.env.PUREBASIC_HOME;
const compiler = path.join(HOME, "compilers", "pbcompiler");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rawprobe3-"));
const src = path.join(dir, "fixture.pb");
fs.writeFileSync(
  src,
  [
    "; probe",                     // 1
    "EnableExplicit",              // 2
    "Global g.i = 100",            // 3
    "",                            // 4
    "Procedure.i Add(x.i, y.i)",   // 5
    "  Protected r.i",             // 6
    "  r = x + y",                 // 7
    "  ProcedureReturn r",         // 8
    "EndProcedure",                // 9
    "",                            // 10
    "Define a.i = 3",              // 11
    "Define b.i = 4",              // 12
    "Define c.i = Add(a, b)",      // 13
    "Define d.i = c + g",          // 14
    "Debug d",                     // 15
    "",
  ].join("\n"),
);
const bin = path.join(dir, "target.bin");
console.error("compile:", spawnSync(compiler, ["-d", "-ds", "-l", "-o", bin, src], { encoding: "utf8" }).status);
const OUT = path.join(dir, "o"), IN = path.join(dir, "i");
spawnSync("mkfifo", [OUT, IN]);
const child = spawn(bin, [], { env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT};${IN}` }, stdio: "inherit" });
await new Promise((r) => setTimeout(r, 300));
const rfd = fs.openSync(OUT, "r"), wfd = fs.openSync(IN, "w");
function send(op, f8 = 0, f12 = 0) { const b = Buffer.alloc(20); b.writeInt32LE(op, 0); b.writeInt32LE(0, 4); b.writeInt32LE(f8, 8); b.writeInt32LE(f12, 12); fs.writeSync(wfd, b); }
function rex(n) { const b = Buffer.alloc(n); let o = 0; while (o < n) { const r = fs.readSync(rfd, b, o, n - o, null); if (!r) throw new Error("EOF"); o += r; } return b; }
function rm() { const h = rex(20); const len = h.readInt32LE(4); return { type: h.readInt32LE(0), len, f8: h.readInt32LE(8), f12: h.readInt32LE(12), payload: len ? rex(len) : Buffer.alloc(0) }; }

rm(); rm(); // hello, announce
send(3, 3, -1); send(3, 1, 7); send(2, 0); // clear, bp line 7 (inside Add), continue
for (let i = 0; i < 40; i++) { const m = rm(); if (m.type === 3) { console.error(`first stop at line ${m.f8} (inside Add)`); break; } }

// From inside Add (line 7), breakpoint every line and continue repeatedly:
// does line-stepping WITHIN the current procedure, then out of it, work?
console.error("arming all lines 1..16 (except 7) and continuing, 3x...");
for (let ln = 1; ln <= 16; ln++) if (ln !== 7) send(3, 1, ln);
for (let step = 0; step < 3; step++) {
  send(2, 0);
  let stopped = false;
  for (let i = 0; i < 40 && !stopped; i++) {
    const m = rm();
    if (m.type === 3) { console.error(`>>> step ${step}: stop at line ${m.f8}`); stopped = true; }
  }
  if (!stopped) { console.error(`>>> step ${step}: no stop (ran to end)`); break; }
}

send(3, 3, -1); send(2, 0);
await new Promise((r) => setTimeout(r, 200));
try { fs.closeSync(wfd); } catch {}
try { child.kill("SIGKILL"); } catch {}
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
