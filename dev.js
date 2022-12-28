#!/usr/bin/env -S deno run -A

/**
 * @fileoverview This serves as both a usage example as well as for generating
 * types for ./generateTypes.js itself.
 */

import { generateTypes } from "./mod.js";
import { setCwd } from "https://deno.land/x/chdir_anywhere@v0.0.2/mod.js";
setCwd();

await generateTypes({
	include: [
		"./dev.js",
		"./mod.js",
	],
	logLevel: "DEBUG",
});
