#!/usr/bin/env -S deno run -A --unstable

/**
 * @fileoverview This serves as both a usage example as well as for generating
 * types for ./generateTypes.js itself.
 */

import { generateTypes } from "./generateTypes.js";

await generateTypes({
	typeUrls: ["https://deno.land/std@0.145.0/path/mod.ts"],
	unstable: true,
});
