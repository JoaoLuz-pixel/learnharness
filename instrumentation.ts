/** Plugins use the documented per-server initialization hook. A plugin failure
 * must not prevent access to existing learning data or teaching/practice. */
export async function register() {
	if (process.env.NEXT_RUNTIME === "nodejs") {
		// Device Sync resumes on launch when the learner left it enabled.
		try { (await import("./src/server/device-sync.ts")).deviceSync(); }
		catch (error) { console.error("[device-sync] Start failed; learning continues locally:", error); }
		const { initializePlugins } = await import("./src/server/plugins.ts");
		try { await initializePlugins(); }
		catch (error) { console.error("[plugins] Initialization failed; plugin management will report the error:", error); }
	}
}
