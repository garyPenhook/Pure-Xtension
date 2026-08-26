// Spike 3: coexistence + introspection bridge.
// r2 LAUNCHES the target WITH the FIFO env; the FIFO client releases
// stop-on-entry; a ptrace breakpoint fires; then we characterize whether wire
// introspection works at the raw ptrace stop and validate a bridge to make it work.
import r2pipe from "/home/gary/Apps/Pure_Xtension/node_modules/r2pipe/index.js";
import { PbDebugSession } from "/home/gary/Apps/Pure_Xtension/out-test/src/debug/pbSession.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const BIN = "/home/gary/Apps/Pure_Xtension/src/debug/spike/blk2.bin";
const BP_LINE13 = "0x405171"; // Debug "tick" -- fires each loop iter after Delay(2000)

const cmd = (r2, c) => new Promise((res, rej) => r2.cmd(c, (e, o) => (e ? rej(e) : res(o ?? ""))));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fifoDir = fs.mkdtempSync(path.join(os.tmpdir(), "spike3-fifo-"));
const outFifo = path.join(fifoDir, "pb_out");
const inFifo = path.join(fifoDir, "pb_in");
import * as cp from "child_process";
cp.execFileSync("mkfifo", [outFifo, inFifo]);

// r2 launches the target with the FIFO env inherited.
process.env.PB_DEBUGGER_Communication = `FifoFiles;${outFifo};${inFifo}`;
r2pipe.options = ["-d"];

const log = [];
const say = (...a) => { const s = a.join(" "); log.push(s); console.log(s); try { fs.appendFileSync("/tmp/spike3.trace", s + "\n"); } catch {} };

r2pipe.open(BIN, async (err, r2) => {
  if (err) { console.error("r2 open failed:", err); return; }
  const pb = new PbDebugSession();
  pb.on("debugOutput", (t) => say("[wire debugOutput]", JSON.stringify(t)));
  try {
    say("r2 launched target with FIFO env; pid:", (await cmd(r2, "dp")).trim());
    await cmd(r2, `db ${BP_LINE13}`);
    say(`set ptrace bp at line 13 (${BP_LINE13})`);

    // Kick dc WITHOUT awaiting: the target will run, open the FIFO, send hello,
    // and spin in stop-on-entry until the wire releases it.
    let stoppedAtBp = false;
    const dcPromise = cmd(r2, "dc").then(() => { stoppedAtBp = true; });

    // Connect the FIFO now that the target is running toward opening it.
    await pb.connect(outFifo, inFifo);
    await pb.drainStartupAnnouncement();
    say("FIFO connected + startup drained (target spinning at stop-on-entry under r2 dc)");

    // Release stop-on-entry over the wire; target runs into the loop and hits
    // the ptrace bp at line 13 after the first Delay(2000).
    pb.continue();
    say("sent wire opcode 2 (continue); waiting for ptrace bp at line 13...");
    await Promise.race([dcPromise, sleep(8000)]);
    const rip = (await cmd(r2, "dr rip")).trim();
    say(`ptrace bp state: stoppedAtBp=${stoppedAtBp}, rip=${rip}  ${rip.endsWith("405171") ? "COEXISTENCE ✓" : "✗"}`);

    // --- Bridge test: is wire introspection usable at this raw ptrace stop? ---
    // The main thread is ptrace-frozen at the CLN-write addr, NOT in the wire
    // wait loop, so a wire request should NOT be serviced. Confirm (bounded).
    say("\n[bridge] trying a wire stackTrace at the raw ptrace stop (expect timeout - main thread frozen)...");
    let wireWorked = false;
    try {
      const frames = await Promise.race([
        pb.stackTrace().then((f) => { wireWorked = true; return f; }),
        sleep(2500).then(() => "TIMEOUT"),
      ]);
      say("  wire stackTrace result:", wireWorked ? JSON.stringify(frames) : frames);
    } catch (e) { say("  wire stackTrace error:", String(e)); }

    say(`\n[bridge] wire introspection at raw ptrace stop worked: ${wireWorked}`);
    say("(if false, the bridge must transition the target into its wait loop first)");

    await cmd(r2, "dk 9");
    r2.quit();
    pb.close();
    say("\ndone.");
  } catch (e) {
    console.error("spike3 error:", e);
    try { await cmd(r2, "dk 9"); r2.quit(); pb.close(); } catch {}
  } finally {
    fs.writeFileSync("/tmp/spike3.log", log.join("\n") + "\n");
  }
});
