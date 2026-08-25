// M5 protocol spike: live-test the Variables opcodes (9/10/11/17,
// ExternalDebugger_Variables, statically decoded in PLAN.md as dispatching
// on the raw opcode value itself rather than a sub-command field). Sets a
// breakpoint inside Inner() so locals (a, b, c, t) exist, continues to the
// stop, then sends each Variables opcode and hex/ascii-dumps the raw reply
// payload so the wire format can be read off known values (a=5, b=10,
// c=15, t=an elapsed-ms integer).
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

function dump(label, msg) {
  console.error(
    `${label}: type=${msg.type} len=${msg.len} f8=${msg.f8} f12=${msg.f12}\n` +
      `  hex=${msg.payload.toString("hex")}\n` +
      `  ascii=${JSON.stringify(msg.payload.toString("latin1"))}`
  );
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

let stopped = false;
for (let i = 0; i < 30 && !stopped; i++) {
  const msg = readMessage();
  console.error(`[t=${Date.now() - t0}ms] msg: type=${msg.type} len=${msg.len} f8=${msg.f8} f12=${msg.f12} raw=${msg.payload.toString("hex")}`);
  if (msg.type === 3) {
    console.error(`*** STOP notification received: f8(line?)=${msg.f8} f12(reason?)=${msg.f12} ***`);
    stopped = true;
  }
}

if (stopped) {
  // opcode 11: examine variables for the current/topmost frame (no args).
  console.error("\nsending opcode 11 (examine current-frame variables)...");
  sendHeader(11, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 9: examine "global"/threaded variables (edi=-1 path). test.pb
  // declares no Threaded vars, so expect an empty/terminator reply.
  console.error("\nsending opcode 9 (examine variables, -1 scope)...");
  sendHeader(9, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 17: examine variables for explicit frame index f8=0.
  console.error("\nsending opcode 17 (examine frame-index variables), f8=0...");
  sendHeader(17, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 17: frame index f8=1 (Outer, the caller) to see multi-frame behavior.
  console.error("\nsending opcode 17 (examine frame-index variables), f8=1...");
  sendHeader(17, 0, 1, 0);
  dump("  reply", readMessage());

  // opcode 10 once, just to see the bare "no more" shape after opcode 11's
  // single-shot reply (not looped further — it re-queries the -1 scope).
  console.error("\nsending opcode 10 (continue examine) once...");
  sendHeader(10, 0, 0, 0);
  dump("  reply", readMessage());
}

// let the spin loop finish and the process exit cleanly rather than killing it.
console.error("\nwaiting for target to finish (clearing breakpoint + continuing)...");
sendHeader(3, 0, 3, -1); // bulk-clear line breakpoints (key=0xffffffff)
sendHeader(2, 0, 0); // continue
for (let i = 0; i < 10; i++) {
  try {
    const msg = readMessage();
    dump("[drain]", msg);
  } catch {
    break;
  }
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 500);
