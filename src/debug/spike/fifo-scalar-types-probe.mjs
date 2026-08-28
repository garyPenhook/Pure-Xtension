// M12 protocol spike: live-confirm opcode 11 (ExamineCurrentFrame)'s
// per-scalar-type wire encoding of a variable record's trailing value.
//
// Earlier code treated every non-structure record's trailing value as a
// uniform 8-byte little-endian int64. That's only actually true for
// Integer (.i) and Quad (.q) -- every other PB scalar type uses its own
// byte width and, for Float/Double, its own IEEE754 encoding, and String
// (.s) carries no inline value at all. Reading the wrong width for one
// record desyncs every record parsed after it in the same reply -- this
// was reproduced live with a String declared ahead of other locals in one
// Procedure, corrupting all of their names/types/values.
//
// Run: node src/debug/spike/fifo-scalar-types-probe.mjs
// (requires `pbcompiler` on PATH or PUREBASIC_HOME set)
//
// Confirmed live (PureBasic 6.41, Linux x64), one type at a time via an
// isolated `Protected` local (so no other record's parse state could mask
// a bug in this one) -- see test/pbSession.test.ts's "parseVariables
// decodes every confirmed scalar type from real captured wire bytes" for
// the exact byte-for-byte regression fixtures this run produces:
//   type 0x01 Byte      .b  1 byte  signed
//   type 0x18 Ascii     .a  1 byte  unsigned
//   type 0x0b Character .c  4 bytes unsigned (Unicode code point)
//   type 0x03 Word      .w  2 bytes signed
//   type 0x19 Unicode   .u  2 bytes unsigned
//   type 0x05 Long      .l  4 bytes signed
//   type 0x15 Integer   .i  8 bytes signed (previously the only confirmed tag)
//   type 0x0d Quad      .q  8 bytes signed
//   type 0x09 Float     .f  4 bytes IEEE754 single
//   type 0x0c Double    .d  8 bytes IEEE754 double
//   type 0x95 Pointer   *x  8 bytes unsigned (rendered as 0x-hex, not decimal)
//   type 0x08 String    .s  NO inline value -- 1 trailing pad byte only,
//                           same shape opcode 9's value-less module-scope
//                           declarations already use. The real text needs
//                           a separate evaluate() (opcode 33) call.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pbspike-scalar-types-"));
const OUT_FIFO = path.join(DIR, "pb_out");
const IN_FIFO = path.join(DIR, "pb_in");

const TYPES = {
  byte: "varByte.b = -12",
  ascii: "varAscii.a = 65",
  char: "varChar.c = 66",
  word: "varWord.w = -1234",
  unicode: "varUnicode.u = 9731",
  long: "varLong.l = -100000",
  integer: "varInteger.i = 123456789012",
  quad: "varQuad.q = 9223372036854775807",
  float: "varFloat.f = 3.140000104904175",
  double: "varDouble.d = 2.718281828",
  string: 'varString.s = "Hi"',
  pointer: "*varPointer = 12345",
};

function compile(name, decl) {
  const src = path.join(DIR, `${name}.pb`);
  const bin = path.join(DIR, `${name}.bin`);
  fs.writeFileSync(
    src,
    ["EnableExplicit", "Procedure Probe()", `  Protected ${decl}`, "  Repeat", "    Delay(10)", "  ForEver", "EndProcedure", "Probe()"].join("\n"),
  );
  execSync(`pbcompiler -d -ds -l -o ${bin} ${src}`, { stdio: "ignore" });
  return bin;
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

function readMessage(fd) {
  const header = readExact(fd, 20);
  const type = header.readInt32LE(0);
  const len = header.readInt32LE(4);
  const f8 = header.readInt32LE(8);
  const f12 = header.readInt32LE(12);
  const payload = len > 0 ? readExact(fd, len) : Buffer.alloc(0);
  return { type, len, f8, f12, payload };
}

async function probeOne(name, decl) {
  const bin = compile(name, decl);
  for (const p of [OUT_FIFO, IN_FIFO]) {
    try {
      fs.unlinkSync(p);
    } catch {}
  }
  execSync(`mkfifo ${OUT_FIFO} ${IN_FIFO}`);
  const child = spawn(bin, [], { env: { ...process.env, PB_DEBUGGER_Communication: `FifoFiles;${OUT_FIFO};${IN_FIFO}` } });
  await new Promise((r) => setTimeout(r, 300));
  const readFd = fs.openSync(OUT_FIFO, "r");
  const writeFd = fs.openSync(IN_FIFO, "w");

  const sendHeader = (opcode, len = 0, f8 = 0, f12 = 0, f16 = 0) => {
    const buf = Buffer.alloc(20);
    buf.writeInt32LE(opcode, 0);
    buf.writeInt32LE(len, 4);
    buf.writeInt32LE(f8, 8);
    buf.writeInt32LE(f12, 12);
    buf.writeInt32LE(f16, 16);
    fs.writeSync(writeFd, buf);
  };

  readMessage(readFd); // hello
  readMessage(readFd); // startup announcement
  sendHeader(3, 0, 1, 4); // add line breakpoint at the Repeat line
  sendHeader(2, 0, 0); // continue
  for (let i = 0; i < 30; i++) {
    if (readMessage(readFd).type === 3) break; // stopped
  }
  sendHeader(11, 0, 0, 0); // ExamineCurrentFrame
  const reply = readMessage(readFd);
  console.log(`${name.padEnd(9)} hex=${reply.payload.toString("hex")}`);

  fs.closeSync(readFd);
  fs.closeSync(writeFd);
  child.kill("SIGKILL");
}

for (const [name, decl] of Object.entries(TYPES)) {
  await probeOne(name, decl);
}
fs.rmSync(DIR, { recursive: true, force: true });
