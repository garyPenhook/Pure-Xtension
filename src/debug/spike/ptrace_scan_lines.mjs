// Spike 1: extract a line->address map by scanning .text for the
// `mov dword [CLN], imm32` statement-boundary instruction (C7 05 disp32 imm32,
// RIP-relative to PB_DEBUGGER_LineNumber). Pure byte-scan; ELF metadata
// (.text location, CLN symbol) via a minimal ELF64 parser so the real
// implementation needs no external tools.
import * as fs from "fs";

const buf = fs.readFileSync(process.argv[2]);

// --- minimal ELF64 parsing: section headers + symtab ---
if (buf.readUInt32LE(0) !== 0x464c457f) throw new Error("not ELF");
const shoff = Number(buf.readBigUInt64LE(0x28));
const shentsize = buf.readUInt16LE(0x3a);
const shnum = buf.readUInt16LE(0x3c);
const shstrndx = buf.readUInt16LE(0x3e);

const sections = [];
for (let i = 0; i < shnum; i++) {
  const off = shoff + i * shentsize;
  sections.push({
    nameOff: buf.readUInt32LE(off + 0),
    type: buf.readUInt32LE(off + 4),
    addr: Number(buf.readBigUInt64LE(off + 16)),
    offset: Number(buf.readBigUInt64LE(off + 24)),
    size: Number(buf.readBigUInt64LE(off + 32)),
    link: buf.readUInt32LE(off + 40),
    entsize: Number(buf.readBigUInt64LE(off + 56)),
  });
}
const shstr = sections[shstrndx];
const secName = (s) => {
  let e = shstr.offset + s.nameOff;
  while (buf[e] !== 0) e++;
  return buf.toString("latin1", shstr.offset + s.nameOff, e);
};

const text = sections.find((s) => secName(s) === ".text");
const symtab = sections.find((s) => secName(s) === ".symtab");
const strtab = sections[symtab.link];

// find PB_DEBUGGER_LineNumber
let clnAddr = null;
for (let o = symtab.offset; o < symtab.offset + symtab.size; o += symtab.entsize) {
  const nameOff = buf.readUInt32LE(o + 0);
  let e = strtab.offset + nameOff;
  while (buf[e] !== 0) e++;
  const name = buf.toString("latin1", strtab.offset + nameOff, e);
  if (name === "PB_DEBUGGER_LineNumber") {
    clnAddr = Number(buf.readBigUInt64LE(o + 8));
    break;
  }
}
if (clnAddr === null) throw new Error("CLN symbol not found");
console.log(`CLN (PB_DEBUGGER_LineNumber) = 0x${clnAddr.toString(16)}`);
console.log(`.text vaddr=0x${text.addr.toString(16)} size=0x${text.size.toString(16)}`);

// --- scan .text for C7 05 <disp32> <imm32> targeting CLN ---
const lineToAddrs = new Map();
for (let i = 0; i + 10 <= text.size; i++) {
  const fo = text.offset + i;
  if (buf[fo] !== 0xc7 || buf[fo + 1] !== 0x05) continue;
  const disp32 = buf.readInt32LE(fo + 2);
  const instrVaddr = text.addr + i;
  if (instrVaddr + 10 + disp32 !== clnAddr) continue; // not a CLN write
  const line = buf.readUInt32LE(fo + 6);
  if (!lineToAddrs.has(line)) lineToAddrs.set(line, []);
  lineToAddrs.get(line).push(instrVaddr);
}

console.log(`\nline -> address(es):`);
for (const line of [...lineToAddrs.keys()].sort((a, b) => a - b)) {
  console.log(`  line ${line}: ${lineToAddrs.get(line).map((a) => "0x" + a.toString(16)).join(", ")}`);
}
