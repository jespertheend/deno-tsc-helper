import * as path from "https://deno.land/std@0.145.0/path/mod.ts";
import { createEmptyImportMap, parseImportMap } from "https://deno.land/x/import_maps@v0.0.3/mod.js";

/**
 * Resolves a path relative to the main entry point of the script.
 * @param {string} resolvePath
 */
export function resolveFromMainModule(resolvePath) {
	return path.resolve(path.dirname(path.fromFileUrl(Deno.mainModule)), resolvePath);
}

/**
 * Creates the types directory and populates it with some default files such
 * as a readme.md and a .gitignore file.
 * @param {string} absoluteOutputDirPath
 */
export async function createTypesDir(absoluteOutputDirPath) {
	let hasOutputDir = true;
	try {
		await Deno.stat(absoluteOutputDirPath);
	} catch {
		hasOutputDir = false;
	}

	if (!hasOutputDir) {
		await Deno.mkdir(absoluteOutputDirPath, { recursive: true });

		// Add .gitignore
		const gitIgnorePath = path.resolve(absoluteOutputDirPath, ".gitignore");
		await Deno.writeTextFile(gitIgnorePath, "**");

		// Add readme.md
		const readmePath = path.resolve(absoluteOutputDirPath, "readme.md");
		await Deno.writeTextFile(
			readmePath,
			`# Deno types

All files in this directory are generated by [deno-tsc-helper](https://deno.land/x/deno_tsc_helper). The purpose of
these files is to make types work using the standard \`tsc\` process and language server, without the need for a Deno
extension.
`,
		);
	}
}

/** @typedef {(entry: Deno.DirEntry) => boolean} ReadDirRecursiveFilter */

/**
 * Reads all directives recursively and yields all files.
 * Directories are not included.
 * @param {string} dirPath
 * @param {ReadDirRecursiveFilter} [filter] A filter function that you can use
 * to filter out certain files from the result. If the filter returns false, the file will
 * not be included in the results. If false is returned for a directory, all of its files
 * will be excluded from the results. You can use this to prevent recursing large
 * directories that you know you won't need anyway.
 * @returns {AsyncIterable<string>}
 */
export async function* readDirRecursive(dirPath, filter) {
	for await (const entry of Deno.readDir(dirPath)) {
		if (filter && !filter(entry)) continue;
		if (entry.isDirectory) {
			yield* readDirRecursive(path.join(dirPath, entry.name));
		} else {
			yield path.resolve(dirPath, entry.name);
		}
	}
}

/**
 * @param {import("../mod.js").GenerateTypesOptions} [options]
 */
export function fillOptionDefaults({
	include = ["."],
	exclude = [".denoTypes", "node_modules"],
	excludeUrls = [],
	importMap = null,
	outputDir = "./.denoTypes",
	cacheHashFile = null,
	preCollectedImportsFile = null,
	unstable = false,
	extraTypeRoots = {},
	quiet = false,
} = {}) {
	return {
		include,
		exclude,
		excludeUrls,
		importMap,
		outputDir,
		cacheHashFile,
		preCollectedImportsFile,
		unstable,
		extraTypeRoots,
		quiet,
	};
}

/**
 * Traverses a directory and collects all the paths of all files that match the
 * given include and exclude arrays.
 * @param {Object} options
 * @param {string} options.baseDir The path to start searching for files.
 * @param {string[]} options.include List of paths to include.
 * @param {string[]} options.exclude List of paths to exclude.
 * @param {string[]} options.extensions Only these extensions will be included.
 */
export async function getIncludeExcludeFiles({
	baseDir,
	include,
	exclude,
	extensions,
}) {
	const files = [];
	for (const includePath of include) {
		const absoluteIncludePath = path.resolve(
			baseDir,
			includePath,
		);
		const fileInfo = await Deno.stat(absoluteIncludePath);
		if (fileInfo.isDirectory) {
			/** @type {ReadDirRecursiveFilter} */
			const filter = (entry) => {
				if (exclude.includes(entry.name)) return false;
				return true;
			};
			for await (const filePath of readDirRecursive(absoluteIncludePath, filter)) {
				let hasValidExtension = false;
				for (const extension of extensions) {
					if (filePath.endsWith(extension)) {
						hasValidExtension = true;
						break;
					}
				}
				if (hasValidExtension) {
					files.push(filePath);
				}
			}
		} else {
			files.push(absoluteIncludePath);
		}
	}
	return files;
}

/**
 * Loads the import map specified using the `importMap` option.
 * If the option is not provided, an empty import map is returned.
 * @param {string?} importMap
 */
export async function loadImportMap(importMap) {
	const userImportMapPath = importMap ? resolveFromMainModule(importMap) : null;
	let userImportMap;
	if (userImportMapPath) {
		const userImportMapStr = await Deno.readTextFile(userImportMapPath);
		const userImportMapJson = JSON.parse(userImportMapStr);
		const baseUrl = new URL(path.toFileUrl(userImportMapPath));
		userImportMap = parseImportMap(userImportMapJson, baseUrl);
	} else {
		userImportMap = createEmptyImportMap();
	}

	return {
		userImportMap,
		userImportMapPath,
	};
}
