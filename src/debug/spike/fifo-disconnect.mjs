// M5 protocol spike: test whether Control opcode 0 (undecoded until now - see
// PLAN.md M5 notes on ExternalDebugger_Control's instruction-level decode) is
// a clean disconnect command. Static decode: opcode 0's case just sets the
// per-thread reply-buffer's status field to a literal 8 and returns, with no
// SendCommand call and no other side effect - unlike every other Control
// opcode (1's queries clear it to 0, 2/continue clears it to 0, 36 sets
// WarningMode).
//
// Reuses fifo-go.mjs's proven continue+poll flow (confirmed working in an
// earlier session: continue unblocks stop-on-entry, opcode 16 then returns
// real frames) to first confirm the target is genuinely running before
// testing what happens on close, with vs without sending opcode 0 first.
//
// Usage: node fifo-disconnect.mjs [baseline|opcode0]
import { spawn } from "node:child_process";
import fs from "node:fs";
import { execSync } from "node:child_process";

const mode = process.argv[2] === "baseline" ? "baseline" : "opcode0";
const OUT_FIFO = "/tmp/pbspike/pb_out";
const IN_FIFO = "/tmp/pbspike/pb_in";

fs.mkdirSync("/tmp/pbspike", { recursive: true });
for (const p of [OUT_FIFO, IN_FIFO]) {
  try { fs.unlinkSync(p); } catch {}
}
execSync(`mkfifo ${OUT_FIFO} ${IN_FIFO}`);

let stdout = "";
const child = spawn(new URL("./test.bin", import.meta.url).pathname, [], {
  env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT_FIFO};${IN_FIFO}` },
});
child.stdout.on("data", (d) => { stdout += d; console.error(`[child stdout] ${d}`); });
child.stderr.on("data", (d) => process.stderr.write(`[child stderr] ${d}`));
let exitInfo = null;
child.on("exit", (code, signal) => { exitInfo = { code, signal }; console.error(`[child] exited code=${code} signal=${signal}`); });

await new Promise((r) => setTimeout(r, 300));
console.error(`mode=${mode}`);
const readFd = fs.openSync(OUT_FIFO, "r");
const writeFd = fs.openSync(IN_FIFO, "w");

function sendHeader(opcode, len = 0, f8 = 0, f12 = 0, f16 = 0) {
  const buf = Buffer.alloc(20);
  buf.writeInt32LE(opcode, 0);
  buf.writeInt32LE(len, 4);
  buf.writeInt32LE(f8, 8);
  buf.writeInt32LE(f12, 12);
  buf.writeInt32LE(f16, 16);
  fs.writeSync(writeFd, buf);
}

function readExact(fd, n) {
  const buf = Buffer.alloc(n);
  let off = 0;
  while (off < n) {
    const r = fs.readSync(fd, buf, off, n - off, null);
    if (r === 0) throw new Error("EOF");
    off += r;
  }
  return buf;
}

function readMessage() {
  const header = readExact(readFd, 20);
  const type = header.readInt32LE(0);
  const len = header.readInt32LE(4);
  const payload = len > 0 ? readExact(readFd, len) : Buffer.alloc(0);
  return { type, len, payload };
}

function parseFrames(payload) {
  let off = 0;
  const frames = [];
  while (off < payload.length) {
    const intField = payload.readInt32LE(off);
    off += 4;
    const nulIdx = payload.indexOf(0, off);
    const str = payload.toString("latin1", off, nulIdx === -1 ? payload.length : nulIdx);
    off = nulIdx === -1 ? payload.length : nulIdx + 1;
    frames.push({ intField, str });
  }
  return frames;
}

const t0 = Date.now();
const hello = readMessage();
console.error(`[t=${Date.now() - t0}ms] hello: type=${hello.type} len=${hello.len}`);

console.error("sending Control opcode 2 (continue)...");
sendHeader(2, 0, 0);
const ack = readMessage();
console.error(`[t=${Date.now() - t0}ms] post-continue ack: type=${ack.type} len=${ack.len}`);

// Confirm the target is genuinely running (real frames), same as fifo-go.mjs.
let confirmedRunning = false;
for (let i = 0; i < 10 && !confirmedRunning; i++) {
  sendHeader(16);
  const msg = readMessage();
  const frames = msg.type === 22 ? parseFrames(msg.payload) : null;
  console.error(`[t=${Date.now() - t0}ms] stackTrace poll: type=${msg.type} frames=${frames ? frames.length : "n/a"}`);
  if (frames && frames.length > 0) confirmedRunning = true;
  else await new Promise((r) => setTimeout(r, 200));
}
console.error(`confirmedRunning=${confirmedRunning}`);

if (mode === "opcode0") {
  console.error(`[t=${Date.now() - t0}ms] sending Control opcode 0 (disconnect candidate)...`);
  sendHeader(0, 0, 0);
}

console.error(`[t=${Date.now() - t0}ms] closing FIFOs...`);
try { fs.closeSync(readFd); } catch (e) { console.error("close readFd:", e.message); }
try { fs.closeSync(writeFd); } catch (e) { console.error("close writeFd:", e.message); }

const deadline = Date.now() + 6000;
while (!exitInfo && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
console.error(`[t=${Date.now() - t0}ms] final: exitInfo=${JSON.stringify(exitInfo)} stdout=${JSON.stringify(stdout)}`);
if (!exitInfo) {
  console.error("child still alive after 6s - killing");
  child.kill();
}
