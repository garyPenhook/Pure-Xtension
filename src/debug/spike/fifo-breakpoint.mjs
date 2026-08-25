// M5 protocol spike: live-test opcode 3 (PB_DEBUGGER_ExternalBreakpoints,
// statically decoded in PLAN.md as a 7-way sub-dispatch). Sets a line
// breakpoint on test.pb's spin-loop line inside Inner() via sub-command 1
// (key = (moduleID<<20)|line, moduleID=0 for a single-file target), then
// sends continue (opcode 2, confirmed live) and watches for the type=3
// StoppedExternal notification instead of the free-run completion.
import { spawn } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike/pb_out";
const IN_FIFO = "/tmp/pbspike/pb_in";
const BREAK_LINE = 4; // test.pb line 4: "Repeat" (top of Inner's spin loop)

const child = spawn(new URL("./test.bin", import.meta.url).pathname, [], {
  env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT_FIFO};${IN_FIFO}` },
  stdio: "inherit",
});
child.on("exit", (code) => console.error(`[child] exited ${code}`));

await new Promise((r) => setTimeout(r, 300));
console.error("opening fifos...");
const readFd = fs.openSync(OUT_FIFO, "r");
const writeFd = fs.openSync(IN_FIFO, "w");
console.error("fifos open");

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
  const f8 = header.readInt32LE(8);
  const f12 = header.readInt32LE(12);
  const payload = len > 0 ? readExact(readFd, len) : Buffer.alloc(0);
  return { type, len, f8, f12, payload };
}

const t0 = Date.now();
const hello = readMessage();
console.error(`[t=${Date.now() - t0}ms] hello: type=${hello.type} len=${hello.len}`);

console.error(`sending opcode 3 sub-command 1 (add line breakpoint), key=${BREAK_LINE}...`);
sendHeader(3, 0, 1, BREAK_LINE);

console.error("sending Control opcode 2 (continue)...");
sendHeader(2, 0, 0);
const ack = readMessage();
console.error(`[t=${Date.now() - t0}ms] post-continue ack: type=${ack.type} len=${ack.len} f8=${ack.f8} f12=${ack.f12}`);

for (let i = 0; i < 30; i++) {
  const msg = readMessage();
  console.error(`[t=${Date.now() - t0}ms] msg: type=${msg.type} len=${msg.len} f8=${msg.f8} f12=${msg.f12} raw=${msg.payload.toString("hex")}`);
  if (msg.type === 3) {
    console.error(`*** STOP notification received: f8(line?)=${msg.f8} f12(reason?)=${msg.f12} ***`);
    break;
  }
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 500);
