// Backgrounded FIFO client for the coexistence spike: connects to the FIFOs
// r2's target opens, drains startup, releases stop-on-entry (opcode 2), then
// reports every wire message it receives. Proves the wire channel works while
// r2 (ptrace, separate process) drives the same target.
import { PbDebugSession } from "/home/gary/Apps/Pure_Xtension/out-test/src/debug/pbSession.js";
import * as fs from "fs";

const outFifo = process.argv[2];
const inFifo = process.argv[3];
const trace = (s) => { console.log(s); try { fs.appendFileSync("/tmp/fifohelper.trace", s + "\n"); } catch {} };

const pb = new PbDebugSession();
pb.on("debugOutput", (t) => trace("[wire debugOutput] " + JSON.stringify(t)));
pb.on("stopped", (s) => trace("[wire stopped] " + JSON.stringify(s)));
pb.on("terminated", () => trace("[wire terminated]"));

trace("fifo helper: connecting...");
await pb.connect(outFifo, inFifo);
await pb.drainStartupAnnouncement();
trace("fifo helper: connected + startup drained; releasing stop-on-entry (opcode 2)");
pb.continue();

// Give the target time to run under r2; report anything the wire delivers.
await new Promise((r) => setTimeout(r, 12000));
trace("fifo helper: done waiting; closing");
pb.close();
