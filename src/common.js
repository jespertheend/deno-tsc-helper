import * as path from "https://deno.land/std@0.145.0/path/mod.ts";

/**
 * Resolves a path relative to the main entry point of the script.
 * @param {string} resolvePath
 */
export function resolveFromMainModule(resolvePath) {
	return path.resolve(path.dirname(path.fromFileUrl(Deno.mainModule)), resolvePath);
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
export function fillOptionDefaults(options) {
	/** @type {Required<import("../mod.js").GenerateTypesOptions>} */
	const filledOptions = {
		include: ["."],
		exclude: [".denoTypes", "node_modules"],
		excludeUrls: [],
		importMap: null,
		outputDir: "./.denoTypes",
		unstable: false,
		extraTypeRoots: {},
		quiet: false,
		...options,
	};
	return filledOptions;
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
