/**
 * @fileoverview Some utility functions for collecting import specifiers from a set of files.
 */

import { getIncludeExcludeFiles } from "./common.js";
import { parseFileAst } from "./parseFileAst.js";
import ts from "https://esm.sh/typescript@4.7.4?pin=v87";
import * as path from "https://deno.land/std@0.145.0/path/mod.ts";
import { resolveModuleSpecifier } from "https://deno.land/x/import_maps@v0.0.3/mod.js";

/**
 * @typedef ImportData
 * @property {string} importerFilePath The absolute path to the file that imports the module.
 * @property {string} importSpecifier The import specifier string used in the import statement.
 */

/**
 * @typedef RemoteImportData
 * @property {string} importerFilePath The absolute path to the file that imports the module.
 * @property {string} importSpecifier The import specifier string used in the import statement.
 * @property {URL} resolvedSpecifier The import specifier resolved against the user import map.
 */

/**
 * @typedef PreCollectedImportsData
 * @property {RemoteImportData[]} remoteImports
 * @property {string[]} needsAmbientModuleImportSpecifiers
 */

/**
 * Traverses a directory and collects import specifiers from all .js, .ts, and .d.ts files.
 * @param {Object} options
 * @param {string} options.baseDir The path to start searching for files.
 * @param {string[]} options.include List of paths to include.
 * @param {string[]} options.exclude List of paths to exclude.
 * @param {string[]} options.excludeUrls List of urls to exclude from the remoteImports result.
 * @param {import("../.denoTypes/vendor/deno.land/x/import_maps@v0.0.3/mod.js").ParsedImportMap} options.userImportMap,
 * @returns {Promise<PreCollectedImportsData>}
 */
export async function collectImports({
	baseDir,
	include,
	exclude,
	excludeUrls,
	userImportMap,
}) {
	/**
	 * A list of absolute paths pointing to all .js and .ts files that the user
	 * wishes to parse and detect imports from.
	 */
	const userFiles = await getIncludeExcludeFiles({
		baseDir,
		include,
		exclude,
		extensions: ["js", "ts", "d.ts"],
	});

	/**
	 * List of imports found in the user files.
	 * @type {ImportData[]}
	 */
	const allImports = [];
	for (const userFile of userFiles) {
		await parseFileAst(userFile, (node) => {
			if (
				ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
			) {
				allImports.push({
					importerFilePath: userFile,
					importSpecifier: node.moduleSpecifier.text,
				});
			}
		});
	}

	/** @type {Set<string>} */
	const needsAmbientModuleImportSpecifiers = new Set();
	for (const { importSpecifier } of allImports) {
		if (excludeUrls.includes(importSpecifier)) {
			needsAmbientModuleImportSpecifiers.add(importSpecifier);
		}
	}

	/** @type {RemoteImportData[]} */
	const remoteImports = [];
	for (const { importSpecifier, importerFilePath } of allImports) {
		if (excludeUrls.includes(importSpecifier)) continue;

		const baseUrl = new URL(path.toFileUrl(importerFilePath));
		const resolvedSpecifier = resolveModuleSpecifier(userImportMap, baseUrl, importSpecifier);

		if (excludeUrls.includes(resolvedSpecifier.href)) continue;
		if (resolvedSpecifier.protocol == "file:") continue;

		remoteImports.push({
			importerFilePath,
			importSpecifier,
			resolvedSpecifier,
		});
	}

	return {
		remoteImports,
		needsAmbientModuleImportSpecifiers: Array.from(needsAmbientModuleImportSpecifiers),
	};
}
