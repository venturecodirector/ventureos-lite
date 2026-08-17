/**
 * Start the machine. The last file in the injected list, so its value is what
 * `chrome.scripting.executeScript` resolves to.
 *
 * It is a separate file for one dull but load-bearing reason: `executeScript`
 * returns the completion value of the LAST script it injects, and machine.js is a
 * module that only registers `globalThis.VentureMachine`. Calling `run()` at the
 * bottom of machine.js instead would mean the module could not be injected without
 * also being executed — which is exactly what the tests need to do, and what the
 * diagnostics path needs when it wants the machine's account of a page without
 * pressing anything.
 *
 * Everything real lives in machine.js. This is the ignition key.
 */
(async () => {
  const M = globalThis.VentureMachine;
  if (!M || typeof M.run !== "function") {
    return {
      machine: {
        version: 3,
        state: "FAILED",
        transitions: [],
        steps: [{ name: "IDLE", ok: false, reason: "machine_module_not_injected", ms: 0 }],
        timings: {},
        cleanupSteps: ["cleanup_not_reached"],
        cleanupVerified: null,
        totalMs: 0,
      },
      contact: null,
    };
  }
  try {
    return await M.run();
  } catch (e) {
    // The machine is written not to throw; if it ever does, the capture still has
    // to be able to continue and save whatever the reader can find.
    return {
      machine: {
        version: 3,
        state: "FAILED",
        transitions: [],
        steps: [
          { name: "IDLE", ok: false, reason: `run_threw_${String(e?.name ?? "Error")}`, ms: 0 },
        ],
        timings: {},
        cleanupSteps: ["cleanup_not_reached"],
        cleanupVerified: null,
        totalMs: 0,
      },
      contact: null,
    };
  }
})();
