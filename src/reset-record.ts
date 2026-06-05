/**
 * Maintenance: clear the per-opponent/per-class W/L and shot stats while keeping
 * the heatmaps (the actual learned priors). Run this once after a win-detection
 * fix to flush corrupted records:
 *
 *   npm run reset-record
 *
 * The ship/fire heatmaps — what makes the agent fire smarter and hide better —
 * are preserved, so no real learning is lost.
 */
import { loadMemory, saveMemory, resetRecords } from "./memory.js";
import { MEMORY_FILE } from "./config.js";

const mem = loadMemory(MEMORY_FILE);
const opps = Object.keys(mem.opponents).length;
resetRecords(mem);
saveMemory(MEMORY_FILE, mem);
console.log(
  `Reset W/L + shot stats for ${opps} opponents and ${Object.keys(mem.classes).length} classes. ` +
    `Heatmaps kept. Scoreboard will rebuild from the next run.`,
);
