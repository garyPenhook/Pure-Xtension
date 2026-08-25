// M5 protocol spike: throwaway end-to-end test of the pbdebugger FIFO wire
// protocol decoded in PLAN.md's M5 section. Not part of the extension build.
//
// Setup (see PLAN.md for why): compile test.pb with the debugger backend,
// e.g. `pbcompiler -e ./test.bin -d test.pb`, then:
//   mkfifo /tmp/pbspike/pb_out /tmp/pbspike/pb_in
//   node fifo-client.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike/pb_out"; // target writes here, we read
const IN_FIFO = "/tmp/pbspike/pb_in";   // target reads here, we write

const child = spawn(new URL("./test.bin", import.meta.url).pathname, [], {
  env: {
    ...process.env,
    PB_DEBUGGER_Communication: `FifoFiles;${OUT_FIFO};${IN_FIFO}`,
  },
  stdio: "inherit",
});
child.on("exit", (code) => console.error(`[child] exited ${code}`));

// Give the child a moment to reach FifoConnect's fopen64 calls.
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
  console.error("sent", buf.toString("hex"));
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

function readMessage(label) {
  const header = readExact(readFd, 20);
  const type = header.readInt32LE(0);
  const len = header.readInt32LE(4);
  console.error(`[${label}] header type=${type} len=${len} raw=${header.toString("hex")}`);
  const payload = len > 0 ? readExact(readFd, len) : Buffer.alloc(0);
  console.error(`[${label}] payload (${payload.length}B):`, payload.toString("hex"));
  return { type, len, payload };
}

// The target sends an unsolicited "hello" (type 0: source path + filename)
// as soon as FifoConnect succeeds, before any request is processed.
readMessage("hello");

// Try the Control handshake first (opcode 1, sub-command -1 at header+0x8:
// version/build-pair query), per the already-decoded Control handler.
sendHeader(1, 0, -1);
readMessage("control-1,-1-reply");

// Give the target plenty of time to reach the middle of the Inner() spin
// loop (test.pb's loop runs ~4s) before asking for the call stack, to rule
// out "request landed before Outer/Inner were even entered".
await new Promise((r) => setTimeout(r, 1500));

// Drain any unsolicited traffic that queued up during the wait (non-blocking
// peek on a second fd to the same FIFO) so it isn't misread as the reply to
// our next request below.
{
  const peekFd = fs.openSync(OUT_FIFO, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const peekBuf = Buffer.alloc(65536);
  try {
    while (true) {
      const n = fs.readSync(peekFd, peekBuf, 0, peekBuf.length, null);
      if (n === 0) break;
      console.error(`[drain] ${n}B pending:`, peekBuf.subarray(0, n).toString("hex"));
    }
  } catch (e) {
    if (e.code !== "EAGAIN") throw e;
    console.error("[drain] nothing pending");
  }
  fs.closeSync(peekFd);
}

// Request opcode 16 (call stack), per the M5 spike decode.
sendHeader(16);
const { payload } = readMessage("opcode16-reply");

// Parse as repeated (int32 LE, cstring) pairs per the opcode-16 decode.
let off = 0;
let frame = 0;
while (off < payload.length) {
  const intField = payload.readInt32LE(off);
  off += 4;
  const nulIdx = payload.indexOf(0, off);
  const str = payload.toString("latin1", off, nulIdx === -1 ? payload.length : nulIdx);
  off = nulIdx === -1 ? payload.length : nulIdx + 1;
  console.error(`frame ${frame}: int=${intField} (0x${intField.toString(16)}) name=${JSON.stringify(str)}`);
  frame++;
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 500);
