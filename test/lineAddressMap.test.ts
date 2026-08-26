// Unit tests for the line<->address extractor in src/debug/lineAddressMap.ts.
// Primary tests build synthetic `.text` buffers (deterministic, no files); a
// final test cross-checks against the real spike binary when present, matching
// the self-skipping pattern of pbDebugAdapter.e2e.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { scanClnWrites, buildLineAddressMap, findSymbolAddress } from "../src/debug/lineAddressMap";

const MOV_LEN = 10;

/** Encode `mov dword [CLN], line` (C7 05 disp32 imm32) at instrVaddr, RIP-relative to clnAddr. */
function clnWrite(instrVaddr: number, clnAddr: number, line: number): Buffer {
  const b = Buffer.alloc(MOV_LEN);
  b[0] = 0xc7;
  b[1] = 0x05;
  b.writeInt32LE(clnAddr - (instrVaddr + MOV_LEN), 2); // disp32
  b.writeUInt32LE(line, 6);
  return b;
}

test("scanClnWrites decodes statement-boundary line writes into a line->address map", () => {
  const textVaddr = 0x400000;
  const clnAddr = 0x500000;
  // Lay three CLN writes at offsets 0x00, 0x10, 0x30 for lines 7, 8, 9.
  const text = Buffer.alloc(0x40, 0x90); // NOP fill
  clnWrite(textVaddr + 0x00, clnAddr, 7).copy(text, 0x00);
  clnWrite(textVaddr + 0x10, clnAddr, 8).copy(text, 0x10);
  clnWrite(textVaddr + 0x30, clnAddr, 9).copy(text, 0x30);

  const { lineToAddrs, addrToLine } = scanClnWrites(text, textVaddr, clnAddr);
  assert.deepEqual(lineToAddrs.get(7), [0x400000]);
  assert.deepEqual(lineToAddrs.get(8), [0x400010]);
  assert.deepEqual(lineToAddrs.get(9), [0x400030]);
  assert.equal(addrToLine.get(0x400010), 8);
});

test("scanClnWrites records multiple addresses for one line (e.g. a For header's two writes)", () => {
  const textVaddr = 0x400000;
  const clnAddr = 0x500000;
  const text = Buffer.alloc(0x30, 0x90);
  clnWrite(textVaddr + 0x00, clnAddr, 10).copy(text, 0x00);
  clnWrite(textVaddr + 0x20, clnAddr, 10).copy(text, 0x20);
  const { lineToAddrs } = scanClnWrites(text, textVaddr, clnAddr);
  assert.deepEqual(lineToAddrs.get(10), [0x400000, 0x400020]);
});

test("scanClnWrites ignores a C7 05 mov whose RIP target is NOT the CLN global", () => {
  const textVaddr = 0x400000;
  const clnAddr = 0x500000;
  const text = Buffer.alloc(0x20, 0x90);
  // A real CLN write for line 5...
  clnWrite(textVaddr + 0x00, clnAddr, 5).copy(text, 0x00);
  // ...and a decoy `mov dword [someOtherGlobal], 5` targeting 0x600000, not CLN.
  clnWrite(textVaddr + 0x10, 0x600000, 5).copy(text, 0x10);
  const { lineToAddrs, addrToLine } = scanClnWrites(text, textVaddr, clnAddr);
  assert.deepEqual(lineToAddrs.get(5), [0x400000]); // only the real one
  assert.equal(addrToLine.size, 1);
});

test("scanClnWrites skips a zero/garbage line number", () => {
  const textVaddr = 0x400000;
  const clnAddr = 0x500000;
  const text = Buffer.alloc(0x10, 0x90);
  clnWrite(textVaddr + 0x00, clnAddr, 0).copy(text, 0x00); // line 0 -> ignored
  const { lineToAddrs } = scanClnWrites(text, textVaddr, clnAddr);
  assert.equal(lineToAddrs.size, 0);
});

// Cross-check against a real compiled -d -l target if the spike binary exists.
// (Built during the M8 spike: src/debug/spike/blk2.bin from a fixture whose
// line 13 `Debug "tick"` is known to sit at 0x405171.) Self-skips otherwise so
// CI without the toolchain stays green.
const spikeBin = path.resolve(__dirname, "..", "..", "src", "debug", "spike", "blk2.bin");
const realBinPresent = fs.existsSync(spikeBin);
test("buildLineAddressMap extracts a real target's map (line 13 -> 0x405171)", { skip: realBinPresent ? false : "spike binary not present" }, () => {
  const buf = fs.readFileSync(spikeBin);
  // The CLN global's address is binary-specific; assert only that it resolves.
  assert.ok(findSymbolAddress(buf, "PB_DEBUGGER_LineNumber") !== undefined, "CLN symbol should resolve");
  const map = buildLineAddressMap(buf);
  assert.ok(map, "expected a non-empty map for a real -d -l build");
  // .text addresses are deterministic for this fixture source + compiler.
  assert.deepEqual(map!.lineToAddrs.get(13), [0x405171]); // Debug "tick", after Delay(2000)
  assert.deepEqual(map!.lineToAddrs.get(10), [0x4050ae, 0x4050d1]); // For header, two writes
  assert.equal(map!.addrToLine.get(0x405171), 13);
});
