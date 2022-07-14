#!/usr/bin/env -S deno run -A

/**
 * @fileoverview This serves as both a usage example as well as for generating
 * types for ./generateTypes.js itself.
 */

import { generateTypes } from "./mod.js";

await generateTypes({
	include: [
		"./dev.js",
		"./mod.js",
	],
});
