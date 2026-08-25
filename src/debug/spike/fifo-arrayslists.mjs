// M5 protocol spike: live-test the ArraysLists opcodes (12/13/14/15,
// ExternalDebugger_ArraysLists, statically decoded from ExternalDebugger.o
// via `ar x debugger.a ExternalDebugger.o` + `objdump -d -r -M intel`,
// address range 0x6220-0x6ca0, cross-referenced with the three send-helper
// functions it calls: ExternalDebugger_SendArrayData.isra.0 (0x5e80),
// ExternalDebugger_SendListData (0x4f10), ExternalDebugger_SendMapData
// (0x5290)). See PLAN.md's M5 section for the full decode + live-test
// write-up. Summary of what this script confirmed live:
//   - opcode 12: enumerate arrays -> ExamineArrays/NextArray, reply type
//     tag 0x10. f8=0 selects the current/topmost frame's arrays,
//     f8!=0 selects ExamineArrays(-1) (global scope) -- only f8=0 is
//     live-tested here. Record: `<name>(<dims, not fully decoded>)\0`
//     + 1 byte type tag + 1 byte kind byte.
//   - opcode 13: enumerate linked lists -> ExamineLinkedLists/
//     NextLinkedList, reply type tag 0x12, same f8 convention. Record:
//     `<name>\0` + flag byte + type byte + kind byte + int64 LE ListCount
//     + int64 LE ListIndex (0-based "current element" position).
//   - opcode 14: enumerate maps -> ExamineMaps/NextMap, reply type tag
//     0x14, same f8 convention. Record: `<name>\0` + flag + type + kind
//     + int64 LE MapSize + 1 byte hasCurrentKey + (if set) `<key>\0`.
//   - opcode 15: parse an expression from the NUL-terminated payload
//     (ParseExpressionExternal, f12=-1 confirmed to mean "current
//     frame/line context", other values untested) and, if the parsed
//     result is an Array/LinkedList/Map, dispatch to SendArrayData/
//     SendListData/SendMapData for the actual element data; otherwise
//     replies with a PB_Language_GetKey error string ("The input did not
//     specify an Array, LinkedList or Map." for a non-compound expression,
//     or a parse error for garbage input). Confirmed record shapes:
//       * Array data (reply type 0x11): `<echoed expr>\0` + repeated
//         (`<decimal index string>\0` + int64 LE value) -- confirmed only
//         for a numeric (.i) element type.
//       * Map data (reply type 0x15): `<echoed expr>\0` + repeated
//         (`<key string>\0` + int64 LE value) -- confirmed for a
//         string-keyed, numeric-valued map.
//       * List data (reply type 0x13): `<echoed expr>\0` + repeated
//         (int64 LE index + int64 LE value), confirmed ONLY for a numeric
//         (.i) element type (16 bytes/element, matches f12's element
//         count exactly). A string-element list's reply payload is too
//         short to hold the actual text (18 bytes total for 2 elements,
//         not a clean multiple of any fixed record size) -- the wire
//         format for List<String> element data is NOT decoded; treated as
//         unsupported downstream rather than guessed at.
//       * Reply type 0x13 is AMBIGUOUS: it's used both for real List data
//         AND for the generic "not an Array/LinkedList/Map"/parse-error
//         message (SendListData hardcodes type 0x13 for its own replies,
//         confirmed at ExternalDebugger.o+0x4f4c, which happens to collide
//         with ArraysLists's own error-reply type at +0x68e8). The two
//         are only distinguishable by content: a genuine List reply's
//         payload starts with the exact echoed expression text; an error
//         reply's payload is a human-readable sentence. The wire header
//         alone cannot tell them apart.
// f12 in every opcode-15 success reply equals the element count (3 for
// nums() with 3 elements, 2 for the 2-element list/map cases) -- confirmed
// across all three data kinds.
// Structures turned out NOT to be part of this opcode family at all: `p`
// (a `Point` structure local) is flatly rejected by opcode 15 ("The input
// did not specify an Array, LinkedList or Map.") -- it's already available
// through the existing opcode-11/17 scalar path instead (see the
// dedicated opcode-11 probe below), which is a correction to this task's
// original framing, not a gap.
// Uses test-arrays.pb / test-arrays.bin, which populates a Dim array
// (nums.i), two NewLists (names.s, counts.i), a NewMap (scores.i), and a
// structured variable (p.Point) before spin-waiting on line 33 so there's
// something to inspect while stopped.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike-al/pb_out";
const IN_FIFO = "/tmp/pbspike-al/pb_in";
const BREAK_LINE = 33; // test-arrays.pb line 33: "Repeat" (top of the spin loop)

fs.mkdirSync("/tmp/pbspike-al", { recursive: true });
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

const t0 = Date.now();
const hello = readMessage();
console.error(`[t=${Date.now() - t0}ms] hello: type=${hello.type} len=${hello.len}`);
const startup = readMessage();
console.error(`[t=${Date.now() - t0}ms] startup announcement: type=${startup.type} len=${startup.len}`);

console.error(`sending opcode 3 sub-command 1 (add line breakpoint), key=${BREAK_LINE}...`);
sendHeader(3, 0, 1, BREAK_LINE);

console.error("sending Control opcode 2 (continue)...");
sendHeader(2, 0, 0);

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
  // opcode 11: examine current-frame scalar variables, to see how a
  // Structure-typed local ("p") is represented there (ArraysLists/opcode 15
  // flatly rejects non-Array/LinkedList/Map expressions, so structures must
  // be reachable some other way -- this checks whether opcode 11 already
  // embeds structure fields inline).
  console.error("\nsending opcode 11 (examine current-frame variables)...");
  sendHeader(11, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 33: evaluate "p" directly (Expression category read side) to see
  // if its f12 "kind" tag is 5 (structure descriptor, per PLAN.md's existing
  // Expression decode) and what that payload actually looks like live.
  {
    const expr = "p";
    const payload = Buffer.concat([Buffer.from(expr, "latin1"), Buffer.from([0])]);
    console.error(`\nsending opcode 33 (evaluate), expr="${expr}"...`);
    sendWithPayload(33, payload, 0, -1, 0);
    dump("  reply", readMessage());
  }

  // opcode 12: enumerate arrays, f8=0 (current/topmost frame scope).
  console.error("\nsending opcode 12 (examine arrays), f8=0 (current frame)...");
  sendHeader(12, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 13: enumerate linked lists, f8=0.
  console.error("\nsending opcode 13 (examine linked lists), f8=0 (current frame)...");
  sendHeader(13, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 14: enumerate maps, f8=0.
  console.error("\nsending opcode 14 (examine maps), f8=0 (current frame)...");
  sendHeader(14, 0, 0, 0);
  dump("  reply", readMessage());

  // opcode 15: parse expression "nums" (the array's bare name) and fetch its data.
  for (const expr of ["nums()", "names()", "counts()", "scores()", "p", "p\\x"]) {
    const payload = Buffer.concat([Buffer.from(expr, "latin1"), Buffer.from([0])]);
    console.error(`\nsending opcode 15 (parse+examine expression), expr="${expr}"...`);
    sendWithPayload(15, payload, 0, -1, 0);
    dump("  reply", readMessage());
  }
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
setTimeout(() => child.kill("SIGKILL"), 500);
