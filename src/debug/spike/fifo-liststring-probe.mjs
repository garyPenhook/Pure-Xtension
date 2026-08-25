// M5 protocol spike: chase the LinkedList<String> element-data gap left
// open by fifo-arrayslists.mjs. That script found opcode 15's List-data
// reply for `names.s()` was 9 bytes/element (an 8-byte sequence number +
// 1 always-zero byte), not the confirmed 16-byte numeric layout, and
// couldn't explain why. Disassembling ExternalDebugger_SendListData
// (debugger.a's ExternalDebugger.o, +0x4f10) explains it: it delegates
// each element's value to a shared CopyValue helper (+0x960) keyed off a
// type tag, and for a String list element that tag takes CopyValue's
// single-byte fallback path (+0x9f0) instead of its real String-copy path
// (+0xa50) -- the string text is never put on the wire by this opcode at
// all. This script confirms the one workaround that does exist: opcode 33
// (Expression, "evaluate") CAN read a String list's *current* element as
// real text (reply kind 4, live-confirmed here for the first time -- see
// PLAN.md's 2026-08-25 M5 entry), it just can't enumerate every element,
// since the expression evaluator only recognizes bare variable/array/
// list/map names and rejects any function call outright (SelectElement/
// FirstElement/ListSize all tried below and rejected), so there's no way
// to move a list's cursor through this protocol.
// Uses the same test-arrays.pb/.bin fixture as fifo-arrayslists.mjs.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike-al3/pb_out";
const IN_FIFO = "/tmp/pbspike-al3/pb_in";
const BREAK_LINE = 33; // test-arrays.pb line 33: "Repeat" (top of the spin loop)

fs.mkdirSync("/tmp/pbspike-al3", { recursive: true });
for (const p of [OUT_FIFO, IN_FIFO]) {
  try { fs.unlinkSync(p); } catch {}
}
execSync(`mkfifo ${OUT_FIFO} ${IN_FIFO}`);

const child = spawn(new URL("./test-arrays.bin", import.meta.url).pathname, [], {
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
function sendWithPayload(opcode, payload, f8 = 0, f12 = 0, f16 = 0) {
  sendHeader(opcode, payload.length, f8, f12, f16);
  fs.writeSync(writeFd, payload);
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

readMessage(); // hello
readMessage(); // startup announcement

console.error(`sending opcode 3 sub-command 1 (add line breakpoint), key=${BREAK_LINE}...`);
sendHeader(3, 0, 1, BREAK_LINE);
console.error("sending Control opcode 2 (continue)...");
sendHeader(2, 0, 0);

let stopped = false;
for (let i = 0; i < 30 && !stopped; i++) {
  const msg = readMessage();
  if (msg.type === 3) {
    console.error(`*** STOP notification received: f8(line?)=${msg.f8} f12(reason?)=${msg.f12} ***`);
    stopped = true;
  }
}

if (stopped) {
  // "names()" bare: does opcode 33 read the list's current element as a
  // real string (reply kind 4)? "names(0)"/"names(1)": does the evaluator
  // support indexed list access the way arrays do? FirstElement/ListSize:
  // does the evaluator support any function calls at all, which would let
  // us move the cursor and enumerate every element ourselves?
  for (const expr of ["names()", "names(0)", "names(1)", "FirstElement(names())", "ListSize(names())"]) {
    const payload = Buffer.concat([Buffer.from(expr, "latin1"), Buffer.from([0])]);
    console.error(`\nsending opcode 33 (evaluate), expr="${expr}"...`);
    sendWithPayload(33, payload, 0, -1, 0);
    dump("  reply", readMessage());
  }
}

console.error("\nwaiting for target to finish (clearing breakpoint + continuing)...");
sendHeader(3, 0, 3, -1); // bulk-clear line breakpoints (key=0xffffffff)
sendHeader(2, 0, 0); // continue
for (let i = 0; i < 5; i++) {
  try {
    dump("[drain]", readMessage());
  } catch {
    break;
  }
}

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill("SIGKILL"), 300);
