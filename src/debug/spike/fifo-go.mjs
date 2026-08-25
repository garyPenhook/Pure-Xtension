// M5 protocol spike: send Control opcode 2 (confirmed live via gdb to be the
// continue/go command that releases PB_DEBUGGER_StoppedExternal's stop-on-entry
// wait - see PLAN.md M5 notes), then immediately poll opcode 16 (call stack)
// while still inside Inner's ~4s busy-wait, instead of blocking on other
// messages first (which previously ran out the clock before any opcode16
// request went out).
import { spawn } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike/pb_out";
const IN_FIFO = "/tmp/pbspike/pb_in";

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
// Drain the one immediate auto-reply (type=2/f12=0x20002, confirmed to be
// unconditional and unrelated to our request) without blocking further.
const ack = readMessage();
console.error(`[t=${Date.now() - t0}ms] post-continue ack: type=${ack.type} len=${ack.len} f8=${ack.f8} f12=${ack.f12}`);

for (let i = 0; i < 20; i++) {
  sendHeader(16);
  const msg = readMessage();
  const frames = msg.type === 22 ? parseFrames(msg.payload) : null;
  console.error(`[t=${Date.now() - t0}ms] reply type=${msg.type} len=${msg.len}` + (frames ? ` frames=${frames.length} ${JSON.stringify(frames)}` : ` raw=${msg.payload.toString("hex")}`));
  await new Promise((r) => setTimeout(r, 200));
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 500);
