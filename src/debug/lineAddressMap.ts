// Extracts a source-line <-> machine-address map from a compiled PureBasic
// `-d -l` target, so a ptrace engine can set real hardware breakpoints at the
// address a given source line's code begins (see src/debug/ptraceEngine.ts).
//
// Why this works (verified live, PLAN.md M8 / src/debug/spike/scan_lines.mjs):
// every statement in a `-d -l` build is emitted as
//   MOV dword [CLN], <lineNumber>
// immediately before that statement's code, where CLN is the exported global
// `PB_DEBUGGER_LineNumber`. On x86-64 fasm encodes this RIP-relatively as
//   C7 05 <disp32> <imm32=line>            (10 bytes total)
// with the target address = instructionAddr + 10 + disp32 == CLN address.
// Scanning `.text` for that exact pattern therefore yields, for every
// statement, (line number -> the address of its CLN-write instruction). A
// breakpoint at that address stops the target exactly at the statement
// boundary -- the same point PB_DEBUGGER_Check runs, so target state is
// wire-consistent for introspection.
//
// This replaces the missing DWARF line table: a `-d` build's DWARF only covers
// statically-linked libgcc, never the PureBasic source (confirmed). The target
// is non-PIE (ELF EXEC), so scanned addresses are the real runtime addresses --
// no ASLR slide to apply.
//
// Pure functions over a Buffer (the ELF file bytes); no external tools, so the
// extension needs neither objdump/nm/readelf nor a shell.

/** The CLN-write instruction opcode+ModRM: `mov dword [rip+disp32], imm32`. */
const MOV_DWORD_RIPREL = [0xc7, 0x05];
/** Full length of `C7 05 <disp32> <imm32>`; RIP is measured from the end of it. */
const MOV_DWORD_RIPREL_LEN = 10;

export interface LineAddressMap {
  /** Every address (>=1) mapped for a line, in ascending file order. A line can
   * map to multiple addresses (e.g. a `For` header emits two CLN writes). */
  lineToAddrs: Map<number, number[]>;
  /** Reverse: the source line at a given CLN-write address. */
  addrToLine: Map<number, number>;
}

interface ElfSection {
  name: string;
  type: number;
  addr: number;
  offset: number;
  size: number;
  link: number;
  entsize: number;
}

/** Minimal ELF64 section-header table read (enough to locate .text + symbols). */
function readSections(buf: Buffer): ElfSection[] {
  if (buf.length < 0x40 || buf.readUInt32LE(0) !== 0x464c457f) {
    throw new Error("not an ELF64 file");
  }
  const shoff = Number(buf.readBigUInt64LE(0x28));
  const shentsize = buf.readUInt16LE(0x3a);
  const shnum = buf.readUInt16LE(0x3c);
  const shstrndx = buf.readUInt16LE(0x3e);

  const raw = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    raw.push({
      nameOff: buf.readUInt32LE(o + 0),
      type: buf.readUInt32LE(o + 4),
      addr: Number(buf.readBigUInt64LE(o + 16)),
      offset: Number(buf.readBigUInt64LE(o + 24)),
      size: Number(buf.readBigUInt64LE(o + 32)),
      link: buf.readUInt32LE(o + 40),
      entsize: Number(buf.readBigUInt64LE(o + 56)),
    });
  }
  const shstr = raw[shstrndx];
  const nameAt = (nameOff: number): string => {
    let e = shstr.offset + nameOff;
    while (e < buf.length && buf[e] !== 0) e++;
    return buf.toString("latin1", shstr.offset + nameOff, e);
  };
  return raw.map((s) => ({
    name: nameAt(s.nameOff),
    type: s.type,
    addr: s.addr,
    offset: s.offset,
    size: s.size,
    link: s.link,
    entsize: s.entsize,
  }));
}

/** Resolve a symbol's value (virtual address) from `.symtab`. */
export function findSymbolAddress(buf: Buffer, symbolName: string): number | undefined {
  const sections = readSections(buf);
  const symtab = sections.find((s) => s.name === ".symtab");
  if (!symtab || symtab.entsize === 0) return undefined;
  const strtab = sections[symtab.link];
  if (!strtab) return undefined;
  for (let o = symtab.offset; o + symtab.entsize <= symtab.offset + symtab.size; o += symtab.entsize) {
    const nameOff = buf.readUInt32LE(o + 0);
    let e = strtab.offset + nameOff;
    while (e < buf.length && buf[e] !== 0) e++;
    if (buf.toString("latin1", strtab.offset + nameOff, e) === symbolName) {
      return Number(buf.readBigUInt64LE(o + 8));
    }
  }
  return undefined;
}

/**
 * Scan `.text` for the `mov dword [CLN], line` statement-boundary writes and
 * build the line<->address map. `clnAddr` is the virtual address of
 * `PB_DEBUGGER_LineNumber` (from {@link findSymbolAddress}). Exposed separately
 * from {@link buildLineAddressMap} so it can be unit-tested against a hand-built
 * `.text` buffer without a full ELF.
 */
export function scanClnWrites(
  text: Buffer,
  textVaddr: number,
  clnAddr: number,
): LineAddressMap {
  const lineToAddrs = new Map<number, number[]>();
  const addrToLine = new Map<number, number>();
  for (let i = 0; i + MOV_DWORD_RIPREL_LEN <= text.length; i++) {
    if (text[i] !== MOV_DWORD_RIPREL[0] || text[i + 1] !== MOV_DWORD_RIPREL[1]) continue;
    const disp32 = text.readInt32LE(i + 2);
    const instrVaddr = textVaddr + i;
    if (instrVaddr + MOV_DWORD_RIPREL_LEN + disp32 !== clnAddr) continue; // not a CLN write
    const line = text.readUInt32LE(i + 6);
    if (line <= 0) continue;
    const list = lineToAddrs.get(line);
    if (list) list.push(instrVaddr);
    else lineToAddrs.set(line, [instrVaddr]);
    addrToLine.set(instrVaddr, line);
  }
  return { lineToAddrs, addrToLine };
}

/**
 * Build the full line<->address map for a compiled `-d -l` target ELF.
 * Returns `undefined` if the binary isn't a recognizable PureBasic debug build
 * (no `PB_DEBUGGER_LineNumber` symbol, no `.text`, or no CLN writes found) --
 * the caller should then fall back to the wire-only debugger path.
 */
export function buildLineAddressMap(buf: Buffer): LineAddressMap | undefined {
  const clnAddr = findSymbolAddress(buf, "PB_DEBUGGER_LineNumber");
  if (clnAddr === undefined) return undefined;
  const text = readSections(buf).find((s) => s.name === ".text");
  if (!text) return undefined;
  const textBytes = buf.subarray(text.offset, text.offset + text.size);
  const map = scanClnWrites(textBytes, text.addr, clnAddr);
  if (map.lineToAddrs.size === 0) return undefined;
  return map;
}
