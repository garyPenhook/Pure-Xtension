// Connect-only variant of fifo-go.mjs for use alongside an externally-spawned
// target (e.g. under gdb) - does not spawn test.bin itself. Sends Control
// opcode 2 (the "continue" candidate from PLAN.md's M5 notes) and logs replies.
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike/pb_out";
const IN_FIFO = "/tmp/pbspike/pb_in";

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
console.error(`[t=${Date.now() - t0}ms] hello: type=${hello.type} len=${hello.len} payload=${JSON.stringify(hello.payload.toString("latin1"))}`);

console.error("sending Control opcode 2...");
sendHeader(2, 0, 0);

for (let i = 0; i < 4; i++) {
  const msg = readMessage();
  console.error(`[t=${Date.now() - t0}ms] msg ${i}: type=${msg.type} len=${msg.len} f8=${msg.f8} f12=${msg.f12} str=${JSON.stringify(msg.payload.toString("latin1"))}`);
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
