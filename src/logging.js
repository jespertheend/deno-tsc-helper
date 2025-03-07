import { handlers, Logger } from "https://deno.land/std@0.159.0/log/mod.ts";

/**
 * @param {import("https://deno.land/std@0.159.0/log/mod.ts").LevelName} level
 */
export function createLogger(level) {
	const logger = new Logger("deno_tsc_helper", level, {
		handlers: [
			new handlers.ConsoleHandler(level, {
				formatter: "{msg}",
			}),
		],
	});
	return logger;
}
export { Logger };
