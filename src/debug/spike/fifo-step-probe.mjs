// M5 protocol spike: test whether Control opcode 2's nonzero sub-command
// (header f8) is a distinct step-vs-run mode, per PLAN.md's open question
// ("a nonzero sub-command additionally fires one more SendCommand with a
// hardcoded value 4, not yet decoded further - plausibly a step-vs-run
// distinction; untested").
//
// Uses test-step.pb (five sequential, non-looping statements inside Add(),
// unlike test.pb's busy-wait loop) so a genuine single-step and a free-run
// are distinguishable: a free-run past the breakpoint produces no further
// type=3 stop and the child exits almost immediately (no loop to catch it
// on); a real step should produce a second type=3 stop at the very next
// statement (line 5) with the child still alive.
//
// Sets a breakpoint at line 3 ("c = a + b"), continues, and once stopped
// there sends opcode 2 with f8=1 (arbitrary nonzero sub-command) instead of
// f8=0. Prints every message for 2s afterward and whether the child is still
// running.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";

const OUT_FIFO = "/tmp/pbspike/pb_out";
const IN_FIFO = "/tmp/pbspike/pb_in";
const BREAK_LINE = 3;
const SUBCOMMAND = process.argv[2] ? Number(process.argv[2]) : 1;

fs.rmSync("/tmp/pbspike", { recursive: true, force: true });
fs.mkdirSync("/tmp/pbspike", { recursive: true });
execFileSync("mkfifo", [OUT_FIFO]);
execFileSync("mkfifo", [IN_FIFO]);

const child = spawn(new URL("./test-step.bin", import.meta.url).pathname, [], {
  env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT_FIFO};${IN_FIFO}` },
  stdio: ["ignore", "pipe", "inherit"],
});
child.stdout.on("data", (d) => console.error(`[child stdout] ${d.toString().trimEnd()}`));
let childAlive = true;
child.on("exit", (code) => {
  childAlive = false;
  console.error(`[child] exited ${code}`);
});

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

console.error(`setting breakpoint at line ${BREAK_LINE}...`);
sendHeader(3, 0, 1, BREAK_LINE);

console.error("continue (sub-command 0)...");
sendHeader(2, 0, 0);
const ack = readMessage();
console.error(`[t=${Date.now() - t0}ms] post-continue ack: type=${ack.type} f8=${ack.f8} f12=${ack.f12}`);

const stop = readMessage();
console.error(`[t=${Date.now() - t0}ms] stop: type=${stop.type} f8=${stop.f8} f12=${stop.f12} (expect line ${BREAK_LINE})`);

console.error(`sending Control opcode 2 with nonzero sub-command f8=${SUBCOMMAND}...`);
sendHeader(2, 0, SUBCOMMAND);

try {
  for (let i = 0; i < 20; i++) {
    const next = readMessage();
    console.error(
      `[t=${Date.now() - t0}ms] msg ${i}: type=${next.type} len=${next.len} f8=${next.f8} f12=${next.f12}` +
        (next.type === 3 ? " *** SECOND STOP - looks like a real step ***" : "") +
        (next.payload.length ? ` payload=${JSON.stringify(next.payload.toString("latin1"))}` : ""),
    );
  }
} catch (err) {
  console.error(`[t=${Date.now() - t0}ms] read failed: ${err.message} (EOF - child closed the pipe / exited)`);
}
await new Promise((r) => setTimeout(r, 300));
console.error(`[t=${Date.now() - t0}ms] childAlive=${childAlive}`);

fs.closeSync(readFd);
fs.closeSync(writeFd);
setTimeout(() => child.kill(), 300);
