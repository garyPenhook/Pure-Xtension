// Extends fifo-breakpoint.mjs: after the first stop, removes the breakpoint
// (opcode 3 sub-command 2, same key) and confirms the target then runs to
// completion (Debug "result=..." stdout line) instead of stopping again,
// even though line 4 is a loop top hit every iteration.
import { spawn } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike/pb_out";
const IN_FIFO = "/tmp/pbspike/pb_in";
const BREAK_LINE = 4;

const child = spawn(new URL("./test.bin", import.meta.url).pathname, [], {
  env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT_FIFO};${IN_FIFO}` },
  stdio: "inherit",
});
child.on("exit", (code) => console.error(`[child] exited ${code}`));

await new Promise((r) => setTimeout(r, 300));
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
  const f8 = header.readInt32LE(8);
  const f12 = header.readInt32LE(12);
  const payload = len > 0 ? readExact(readFd, len) : Buffer.alloc(0);
  return { type, len, f8, f12, payload };
}

const t0 = Date.now();
const hello = readMessage();
console.error(`[t=${Date.now() - t0}ms] hello`);

sendHeader(3, 0, 1, BREAK_LINE);
console.error("continue...");
sendHeader(2, 0, 0);
readMessage(); // post-continue ack

const stop = readMessage();
console.error(`[t=${Date.now() - t0}ms] stop: type=${stop.type} f8=${stop.f8} f12=${stop.f12}`);

console.error(`removing breakpoint (sub-command 2, key=${BREAK_LINE})...`);
sendHeader(3, 0, 2, BREAK_LINE);
console.error("continue again...");
sendHeader(2, 0, 0);

for (let i = 0; i < 10; i++) {
  const msg = readMessage();
  console.error(`[t=${Date.now() - t0}ms] msg: type=${msg.type} f8=${msg.f8} f12=${msg.f12}`);
  if (msg.type === 3) {
    console.error("*** unexpected second stop - breakpoint removal did not take effect ***");
  }
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 500);
