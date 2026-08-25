// M5 protocol spike: poll opcode 16 (call stack) repeatedly across test.pb's
// ~4s non-blocking spin loop inside Inner(), draining any interleaved
// spontaneous messages by type instead of assuming strict request/reply
// pairing (see PLAN.md M5 notes on the spontaneous type=3 traffic found by
// fifo-client.mjs). Goal: settle whether Thread+0x48 (the call-depth counter
// EnterProcedure/LeaveProcedure maintain) is EVER nonzero while genuinely
// nested two calls deep, or always reads back 0.
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

readMessage(); // hello
sendHeader(1, 0, -1);
readMessage(); // control reply (or whatever's first)

const start = Date.now();
for (let i = 0; i < 18; i++) {
  sendHeader(16);
  let msg;
  do {
    msg = readMessage();
    if (msg.type !== 22) {
      console.error(`[t=${Date.now() - start}ms] spontaneous type=${msg.type} len=${msg.len} raw=${msg.payload.toString("hex")}`);
    }
  } while (msg.type !== 22);
  const frames = parseFrames(msg.payload);
  console.error(`[t=${Date.now() - start}ms] opcode16 reply: len=${msg.len} frames=${frames.length}`, frames);
  await new Promise((r) => setTimeout(r, 200));
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 500);
