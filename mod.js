import {
	common,
	format,
	fromFileUrl,
	join,
	parse,
	resolve,
	toFileUrl,
} from "https://deno.land/std@0.145.0/path/mod.ts";
import { ensureDir } from "https://deno.land/std@0.145.0/fs/mod.ts";
import {
	createEmptyImportMap,
	parseImportMap,
	resolveModuleSpecifier,
} from "https://deno.land/x/import_maps@v0.0.3/mod.js";
import ts from "https://esm.sh/typescript@4.7.4?pin=v87";
import { collectImports } from "./src/collectImports.js";
import { createTypesDir, fillOptionDefaults, loadImportMap, readDirRecursive } from "./src/common.js";
import { parseFileAst } from "./src/parseFileAst.js";

/**
 * @typedef GenerateTypesOptions
 * @property {string[]} [include] A list of local paths to parse the imports from.
 * Any import statement found in any of these .ts or .js files will be collected and their
 * types will be fetched and added to the generated tsconfig.json.
 * @property {string[]} [exclude] A list of local paths to exclude. Any file in this list
 * will not be parsed. This defaults to [".denoTypes", "node_modules"].
 * @property {string[]} [excludeUrls] A list of urls to ignore when fetching types.
 * If a specific import specifier is causing issues, you can add its exact url to this list.
 * If you are using an import map, you can also use the specifier from the import map.
 * An [ambient module](https://www.typescriptlang.org/docs/handbook/modules.html#shorthand-ambient-modules)
 * will be created that contains no types for each excluded url.
 * @property {string?} [importMap] A path to the import map to use. If provided, the paths in the generated
 * tsconfig.json will be set to values in the import map.
 * @property {Object.<string, string>} [extraTypeRoots] Allows you to provide extra type roots
 * which will be fetched and placed in the `@types` directory.
 * @property {Object<string, string>} [exactTypeModules] This is mostly useful for
 * types coming from the DefinitelyTyped repository.
 * This allows you to map a specifier directly to a types file from any url.
 * For example:
 * ```js
 * generateTypes({
 *   exactTypeModules: {
 *     "npm:eslint@8.23.0": "https://unpkg.com/@types/eslint@8.4.6/index.d.ts",
 * 	 },
 * });
 * ```
 * Would allow you to `import {ESLint} from "npm:eslint@8.23.0";` and automatically
 * get the correct types on the `ESLint` object.
 * @property {string} [outputDir] The directory to output the generated files to. This is relative to the main entry point of the script.
 * @property {string?} [cacheHashFile] When set, a file will be written relative to `outputDir` that can be used to
 * determine if the generated are outdated. This option is only used when calling `createCacheHashFile`.
 *
 * This file is useful if you want to store the types in cache across multiple CI runs.
 * The difference between this file and cacheFile.json, is that cacheFile.json is used by this application itself
 * to determine what content specifically is outdated. The cacheHashFile is not used by this application and is meant
 * specifically for external tools to determine if the generated files are outdated.
 *
 * The contents of this file might change at any time, so do not attempt to parse it as this might potentially break
 * your application in future versions. You can create a hash from the contents of this file.
 * For github actions for example:
 * ```
 * - name: Cache Deno types
 *   uses: actions/cache@v3
 *   with:
 *     path: .denoTypes
 *     key: denoTypes-${{ hashFiles('.denoTypes/ciCacheFile') }}
 * ```
 * @property {string?} [preCollectedImportsFile] When using `createCacheHashFile`, import data is collected from all files.
 * However, when using `createCacheHashFile` you usually want to call `generateTypes`, right after that.
 * This call performs the same step a second time. To prevent the same computation from being done twice,
 * you can use this option to store a file that contains the import data.
 *
 * If this option is provided in `createCacheHashFile`, this creates a file at the specified location.
 * If this option is not provided in `generateTypes`, the file at the specfifed location is loaded and used instead
 * of performing the computation again.
 * @property {boolean} [unstable] Whether to include unstable deno apis in the generated types.
 * @property {boolean} [quiet] Whether to suppress output.
 */

/**
 * This generates a file that you can use to generate a cache key when running in CI.
 * For example, with github actions:
 * ```
 * - name: Cache Deno types
 *   uses: actions/cache@v3
 *   with:
 *     path: .denoTypes
 *     key: denoTypes-${{ hashFiles('.denoTypes/ciCacheFile') }}
 * ```
 * Make sure you call `createCacheHashFile` before the "Cache Deno types" step.
 * And then you can call `generateTypes` after this step.
 *
 * In general you'll want to provide the same options here as wehn calling `generateTypes`,
 * so it's best to make one options object and pass it to both functions.
 *
 * This function will perform a computation that is also performed in `generateTypes`.
 * So if you don't want to perform the same computation twice, you can provide the
 * `preCollectedImportsFile` option to generate an extra file that contains the required import data.
 * @param {GenerateTypesOptions} [options]
 */
export async function createCacheHashFile(options) {
	const cwd = Deno.cwd();
	const { quiet, include, exclude, excludeUrls, importMap, cacheHashFile, preCollectedImportsFile, outputDir } =
		fillOptionDefaults(
			options,
		);

	/**
	 * @param {Parameters<typeof console.log>} args
	 */
	function log(...args) {
		if (!quiet) console.log(...args);
	}

	if (!cacheHashFile) {
		throw new Error("The `cacheHashFile` option is required when making use of `createCacheHashFile`.");
	}

	log("Collecting import specifiers from script files");

	const { userImportMap } = await loadImportMap(importMap, cwd);
	const collectedImportData = await collectImports({
		baseDir: cwd,
		include,
		exclude,
		excludeUrls,
		userImportMap,
	});

	const absoluteOutputDirPath = resolve(cwd, outputDir);
	await createTypesDir(absoluteOutputDirPath);

	let cacheHashContent = "";

	cacheHashContent += "--options--\n";
	cacheHashContent += JSON.stringify(options) + "\n";

	cacheHashContent += "--resolved specifiers--\n";
	{
		/** @type {Set<string>} */
		const resolvedSpecifiers = new Set();
		for (const { resolvedSpecifier } of collectedImportData.remoteImports) {
			resolvedSpecifiers.add(resolvedSpecifier.href);
		}
		const sorted = [...resolvedSpecifiers].sort();
		for (const specifier of sorted) {
			cacheHashContent += `${specifier}\n`;
		}
	}

	cacheHashContent += "--ambient module specifiers--\n";
	{
		const sorted = [...collectedImportData.needsAmbientModuleImportSpecifiers].sort();
		for (const specifier of sorted) {
			cacheHashContent += `${specifier}\n`;
		}
	}

	const cacheHashFilePath = resolve(absoluteOutputDirPath, cacheHashFile);
	await Deno.writeTextFile(cacheHashFilePath, cacheHashContent);
	log(`Created cache hash file at ${cacheHashFilePath}`);

	if (preCollectedImportsFile) {
		const preCollectedImportsFilePath = resolve(absoluteOutputDirPath, preCollectedImportsFile);
		await Deno.writeTextFile(preCollectedImportsFilePath, JSON.stringify(collectedImportData, null, "\t"), {
			create: true,
		});
		log(`Collected imports file written to ${preCollectedImportsFilePath}`);
	}
}

/**
 * Generates type files and a tsconfig.json file that you can include in your
 * tsconfig to make Deno types work.
 * @param {GenerateTypesOptions} [options]
 */
export async function generateTypes(options) {
	const cwd = Deno.cwd();
	const {
		include,
		exclude,
		excludeUrls,
		importMap,
		extraTypeRoots,
		exactTypeModules,
		outputDir,
		unstable,
		quiet,
		preCollectedImportsFile,
	} = fillOptionDefaults(options);

	/**
	 * @param {Parameters<typeof console.log>} args
	 */
	function log(...args) {
		if (!quiet) console.log(...args);
	}

	const absoluteOutputDirPath = resolve(cwd, outputDir);

	/**
	 * @typedef CacheFileData
	 * @property {string[]} [vendoredImports]
	 * @property {string} [denoTypesVersion]
	 * @property {Object.<string, string>} [fetchedTypeRoots]
	 * @property {Object<string, string>} [fetchedExactTypeModules]
	 */

	const cacheFilePath = resolve(absoluteOutputDirPath, "cacheFile.json");
	/** @type {CacheFileData?} */
	let cache = null;
	let cacheExists = true;
	try {
		await Deno.stat(cacheFilePath);
	} catch (e) {
		if (e instanceof Deno.errors.NotFound) {
			cacheExists = false;
		} else {
			throw e;
		}
	}
	if (cacheExists) {
		const cacheStr = await Deno.readTextFile(cacheFilePath);
		cache = JSON.parse(cacheStr);
	}

	/**
	 * A list of import specifier that were vendored the last time the script was run.
	 * @type {Set<string>}
	 */
	const cachedImportSpecifiers = new Set();
	if (cache?.vendoredImports) {
		for (const importSpecifier of cache.vendoredImports) {
			cachedImportSpecifiers.add(importSpecifier);
		}
	}

	const denoTypesVersion = cache?.denoTypesVersion || "";
	const cachedTypeRoots = cache?.fetchedTypeRoots || {};
	const cachedExactTypeModules = cache?.fetchedExactTypeModules || {};

	/** @type {CacheFileData} */
	let newCacheData = {
		...cache,
	};

	/**
	 * @param {Partial<CacheFileData>} setProps
	 */
	async function updateCacheData(setProps) {
		newCacheData = {
			...newCacheData,
			...setProps,
		};
		const cacheDataStr = JSON.stringify(newCacheData, null, "\t");
		await Deno.writeTextFile(cacheFilePath, cacheDataStr);
	}

	await createTypesDir(absoluteOutputDirPath);

	// Add deno types file from the `deno types` command.
	const typeRootsDirPath = resolve(absoluteOutputDirPath, "@types");
	const desiredDenoTypesVersion = Deno.version.deno + (unstable ? "-unstable" : "");
	if (denoTypesVersion != desiredDenoTypesVersion) {
		log("Generating Deno types");
		const denoTypesCmd = ["deno", "types"];
		if (unstable) denoTypesCmd.push("--unstable");
		const getDenoTypesProcess = Deno.run({
			cmd: denoTypesCmd,
			stdout: "piped",
		});
		const typesBuffer = await getDenoTypesProcess.output();
		const typesContent = new TextDecoder().decode(typesBuffer);
		let lines = typesContent.split("\n");
		lines = lines.filter((line) => !line.startsWith("/// <reference"));
		const newTypesContent = lines.join("\n");

		const denoTypesDirPath = resolve(typeRootsDirPath, "deno-types");
		await Deno.mkdir(denoTypesDirPath, { recursive: true });
		const denoTypesFilePath = resolve(denoTypesDirPath, "index.d.ts");
		await Deno.writeTextFile(denoTypesFilePath, newTypesContent);

		await updateCacheData({
			denoTypesVersion: desiredDenoTypesVersion,
		});
	}

	// Fetch type roots from the `extraTypeRoots` option:

	// Reset the cache in case anything goes wrong while fetching type roots.
	// This ensures subsequent runs will start with a fresh cache.
	await updateCacheData({
		fetchedTypeRoots: {},
	});
	/** @type {Object.<string, string>} */
	const newFetchedTypeRoots = {};
	for (const [folderName, url] of Object.entries(extraTypeRoots)) {
		if (cachedTypeRoots[folderName] != url) {
			log(`Fetching type root ${folderName}`);
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch type root ${folderName}, the server responded with status code ${response.status}`,
				);
			}
			const typeRootDirPath = resolve(typeRootsDirPath, folderName);
			await ensureDir(typeRootDirPath);
			const typeRootFilePath = resolve(typeRootDirPath, "index.d.ts");
			await Deno.writeTextFile(typeRootFilePath, await response.text());
		}
		newFetchedTypeRoots[folderName] = url;
	}
	await updateCacheData({
		fetchedTypeRoots: newFetchedTypeRoots,
	});

	// Fetch types from the `exactTypeModules` option:

	// Clear the cache in case anything goes wrong.
	await updateCacheData({ fetchedExactTypeModules: {} });
	/** @type {Object<string, string>} */
	const newFetchedExactTypeModules = {};
	const exactTypesDirPath = resolve(absoluteOutputDirPath, "exactTypes");
	for (const [specifier, url] of Object.entries(exactTypeModules)) {
		if (cachedExactTypeModules[specifier] != url) {
			log(`Fetching npm types for ${specifier}`);
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch npm types for ${specifier}, the server responded with status code ${response.status}.`,
				);
			}
			const dirPath = resolve(exactTypesDirPath, specifier);
			await ensureDir(dirPath);
			const filePath = resolve(dirPath, "index.d.ts");
			await Deno.writeTextFile(filePath, await response.text());
		}
		newFetchedExactTypeModules[specifier] = url;
	}
	await updateCacheData({ fetchedExactTypeModules: newFetchedExactTypeModules });

	const { userImportMap, userImportMapPath } = await loadImportMap(importMap, cwd);

	/** @type {import("./src/collectImports.js").PreCollectedImportsData?} */
	let preCollectedImports = null;
	if (preCollectedImportsFile) {
		const preCollectedImportsFilePath = resolve(absoluteOutputDirPath, preCollectedImportsFile);
		let preCollectedImportsStr = null;
		try {
			preCollectedImportsStr = await Deno.readTextFile(preCollectedImportsFilePath);
		} catch (e) {
			if (!(e instanceof Deno.errors.NotFound)) {
				throw e;
			}
		}
		if (preCollectedImportsStr) {
			let preCollectedImportsJson = null;
			try {
				preCollectedImportsJson = JSON.parse(preCollectedImportsStr);
			} catch (e) {
				throw new Error(
					`The file at ${preCollectedImportsFilePath} appears to be corrupt and couldn't be parsed.`,
				);
			}
			for (const remoteImport of preCollectedImportsJson.remoteImports) {
				remoteImport.resolvedSpecifier = new URL(remoteImport.resolvedSpecifier);
			}
			preCollectedImports = preCollectedImportsJson;
		} else {
			log(`No pre-collected imports file was found at ${preCollectedImportsFilePath}.`);
		}
	}

	if (!preCollectedImports) {
		log("Collecting import specifiers from script files");
		preCollectedImports = await collectImports({
			baseDir: cwd,
			include,
			exclude,
			excludeUrls,
			userImportMap,
		});
	}

	const { remoteImports, needsAmbientModuleImportSpecifiers } = preCollectedImports;

	{
		let allCached = true;
		for (const { resolvedSpecifier } of remoteImports) {
			if (!cachedImportSpecifiers.has(resolvedSpecifier.href)) {
				allCached = false;
				break;
			}
		}

		if (allCached) {
			log("No imports have changed since the last run");
			// TODO: Don't return here, instead only vendor the specifiers that have
			// changed. #18
			// If no specifiers have changed that doesn't necessarily mean that
			// there's no work left to do. For instance the exactTypeModules
			// property might have changed.
			return;
		}
	}

	// At this point, we know we'll be regenerating all the files, so we'll remove
	// vendoredImports from cache file. This is because if the script fails at this
	// point, the generated types might be corrupted. Removing the cache file
	// ensures that subsequent runs are forced to start with a fresh cache.
	if (cacheExists) {
		await updateCacheData({
			vendoredImports: [],
		});
	}

	const vendorOutputPath = resolve(absoluteOutputDirPath, "vendor");
	const importMapPath = join(vendorOutputPath, "import_map.json");
	/** @type {import("https://deno.land/x/import_maps@v0.0.3/mod.js").ParsedImportMap[]} */
	const parsedImportMaps = [];

	/**
	 * The list of remote imports mapped by their resolved specifier.
	 * This is to ensure we don't vendor the same module twice.
	 * @type {Map<string, import("./src/collectImports.js").RemoteImportData[]>}
	 */
	const mergedRemoteImports = new Map();
	for (const remoteImport of remoteImports) {
		const specifier = remoteImport.resolvedSpecifier.href;
		let arr = mergedRemoteImports.get(specifier);
		if (!arr) {
			arr = [];
			mergedRemoteImports.set(specifier, arr);
		}
		arr.push(remoteImport);
	}

	for (const [resolvedSpecifier, importDatas] of mergedRemoteImports) {
		const cmd = ["deno", "vendor", "--force", "--no-config"];
		cmd.push("--output", vendorOutputPath);
		if (userImportMapPath) {
			cmd.push("--import-map", userImportMapPath);
		}
		cmd.push(resolvedSpecifier);
		log(`Vendoring ${resolvedSpecifier}`);
		const vendorProcess = Deno.run({
			cmd,
			stdout: "null",
			stdin: "null",
			stderr: "piped",
		});
		const status = await vendorProcess.status();
		if (!status.success) {
			const rawError = await vendorProcess.stderrOutput();
			const errorString = new TextDecoder().decode(rawError);

			let excludeString = resolvedSpecifier;
			const importSpecifiers = new Set(importDatas.map((d) => d.importSpecifier));
			const importFilePaths = new Set(importDatas.map((d) => d.importerFilePath));
			if (importSpecifiers.size == 1) {
				const importSpecifier = importSpecifiers.values().next().value;
				if (resolvedSpecifier != importSpecifier) {
					excludeString = `${importSpecifier}" or "${resolvedSpecifier}`;
				}
			}
			throw new Error(
				`${errorString}

Failed to vendor files for ${resolvedSpecifier}. 'deno vendor' exited with status ${status.code}.
The output of the 'deno vendor' command is shown above.

The error occurred while running:
  ${cmd.join(" ")}

${resolvedSpecifier} was imported in the following files:
${Array.from(importFilePaths).map((f) => `  ${f}`).join("\n")}

Consider adding "${excludeString}" to 'excludeUrls' to skip this import.`,
			);
		}

		// Since we're calling `deno vendor` with `--force`, the generated import map
		// will be overwritten every time we run `deno vendor`.
		// So we'll parse it now and store the result for later.
		const importMapText = await Deno.readTextFile(importMapPath);
		const importMapJson = JSON.parse(importMapText);
		const importMapBaseUrl = new URL(toFileUrl(importMapPath));
		const parsedImportMap = parseImportMap(importMapJson, importMapBaseUrl);
		parsedImportMaps.push(parsedImportMap);
	}

	/**
	 * Loops over all the parsed import maps and returns the resolved specifier
	 * for the first occurrence that resolves to a file location inside the
	 * vendor directory. Returns `null` if no import map resolves to a file
	 * inside the vendor directory.
	 * @param {URL} baseUrl
	 * @param {string} moduleSpecifier
	 */
	function resolveModuleSpecifierAll(baseUrl, moduleSpecifier) {
		for (const importMap of parsedImportMaps) {
			const resolved = resolveModuleSpecifier(importMap, baseUrl, moduleSpecifier);
			if (resolved.protocol !== "file:") continue;
			const commonPath = resolve(common([resolved.pathname, absoluteOutputDirPath]));
			if (commonPath != absoluteOutputDirPath) continue;

			return resolved;
		}
		return null;
	}

	/**
	 * A transformer that does several things to fix up the vendored files:
	 * - rewrites all external imports to other vendored files using the import maps.
	 * - Renames imports from .ts to .js since TypeScript doesn't allow .ts imports.
	 * @param {ts.TransformationContext} context
	 */
	const transformer = (context) => {
		/**
		 * @param {ts.Node} rootNode
		 */
		return (rootNode) => {
			/**
			 * @param {ts.Node} node
			 * @returns {ts.Node}
			 */
			function visit(node) {
				// Rename .ts imports to .js
				if (
					ts.isStringLiteral(node) && node.parent &&
					(
						ts.isImportDeclaration(node.parent) ||
						ts.isExportDeclaration(node.parent)
					)
				) {
					let newSpecifier = null;
					if (ts.isSourceFile(rootNode)) {
						const baseUrl = new URL(toFileUrl(rootNode.fileName));
						const oldSpecifier = node.text;
						const resolvedUrl = resolveModuleSpecifierAll(baseUrl, oldSpecifier);
						if (resolvedUrl) {
							newSpecifier = resolvedUrl.pathname;
						}
						if (newSpecifier && newSpecifier.endsWith(".ts")) {
							newSpecifier = newSpecifier.slice(0, -3) + ".js";
						}
						if (newSpecifier) {
							return ts.factory.createStringLiteral(newSpecifier);
						}
					}
				}

				return ts.visitEachChild(node, visit, context);
			}
			const result = ts.visitNode(rootNode, visit);
			return result;
		};
	};

	/**
	 * @typedef CollectedDtsFile
	 * @property {string} denoTypesUrl The url containing types that should be fetched and placed at the `moduleSpecifier`.
	 * @property {string} vendorFilePath The file that imported the `moduleSpecifier`.
	 * @property {string} moduleSpecifier The module specifier that was imported for which the `dtsUrl` types should be fetched and placed at.
	 */

	/** @type {CollectedDtsFile[]} */
	const collectedDtsFiles = [];

	const denoTypesRegex = /\/\/\s*@deno-types\s*=\s*"(?<url>.*)"/;
	const printer = ts.createPrinter();
	log("Modifying vendored files");
	for await (const filePath of readDirRecursive(vendorOutputPath)) {
		const ast = await parseFileAst(filePath, (node, { sourceFile }) => {
			// Collect imports/exports with a deno-types comment
			if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
				const commentRanges = ts.getLeadingCommentRanges(sourceFile.text, node.pos);
				if (commentRanges && commentRanges.length > 0) {
					const lastRange = commentRanges.at(-1);
					if (lastRange) {
						const comment = sourceFile.text.substring(lastRange.pos, lastRange.end);
						const match = denoTypesRegex.exec(comment);
						if (match?.groups?.url) {
							if (ts.isStringLiteral(node.moduleSpecifier)) {
								collectedDtsFiles.push({
									denoTypesUrl: match.groups.url,
									vendorFilePath: filePath,
									moduleSpecifier: node.moduleSpecifier.text,
								});
							}
						}
					}
				}
			}
		});
		if (!ast) continue;

		const transformationResult = ts.transform(ast, [transformer]);
		let modified = printer.printNode(
			ts.EmitHint.Unspecified,
			transformationResult.transformed[0],
			ast.getSourceFile(),
		);
		// Add ts-nocheck to suppress type errors for vendored files
		const castAst = /** @type {typeof ast & {scriptKind: ts.ScriptKind}} */ (ast);
		const tsNocheckScriptKinds = [
			ts.ScriptKind.JS,
			ts.ScriptKind.JSX,
			ts.ScriptKind.TS,
			ts.ScriptKind.TSX,
		];
		if (tsNocheckScriptKinds.includes(castAst.scriptKind)) {
			const lines = modified.split("\n");
			let insertionIndex = 0;
			if (lines.length > 0) {
				const firstLine = lines[0];
				if (firstLine.startsWith("#!")) {
					insertionIndex = 1;
				}
			}
			lines.splice(insertionIndex, 0, "// @ts-nocheck");
			modified = lines.join("\n");
		}
		await Deno.writeTextFile(filePath, modified);
	}

	log("Fetching .d.ts files for vendored files.");
	const dtsFetchPromises = [];
	// We'll use an empty import map for resolving the urls in @deno-types comments.
	// Otherwise the urls end up resolving to the local file system since the types url is
	// likely the same as the .js file.
	const emptyImportMap = createEmptyImportMap();
	for (const { denoTypesUrl, vendorFilePath, moduleSpecifier } of collectedDtsFiles) {
		const promise = (async () => {
			const baseUrl = new URL(toFileUrl(vendorFilePath));
			const resolvedDenoTypesUrl = resolveModuleSpecifier(emptyImportMap, baseUrl, denoTypesUrl);
			if (resolvedDenoTypesUrl && resolvedDenoTypesUrl.protocol === "file:") {
				// The types url is already pointing to a local file, so we don't need to fetch it.
				return;
			}
			log(`Fetching ${denoTypesUrl}`);
			const response = await fetch(denoTypesUrl);
			const text = await response.text();
			const dtsDestination = resolveModuleSpecifierAll(baseUrl, moduleSpecifier);
			if (!dtsDestination) {
				// TODO: Show a warning
				return;
			}
			const parsedDestination = parse(fromFileUrl(dtsDestination));
			const dtsDestinationPath = format({
				dir: parsedDestination.dir,
				name: parsedDestination.name,
				root: parsedDestination.root,
				ext: ".d.ts",
			});
			await Deno.writeTextFile(dtsDestinationPath, text);
		})();
		dtsFetchPromises.push(promise);
	}
	await Promise.allSettled(dtsFetchPromises);

	/**
	 * A list of paths that should be added to the generated tsconfig.json.
	 * @type {[string, string][]}
	 */
	const tsConfigPaths = [];

	if (needsAmbientModuleImportSpecifiers.length > 0) {
		log("Creating ambient modules for excluded urls");
		const ambientModulesDirPath = resolve(typeRootsDirPath, "deno-tsc-helper-ambient-modules");
		await Deno.mkdir(ambientModulesDirPath, { recursive: true });
		const ambientModulesFilePath = resolve(ambientModulesDirPath, "index.d.ts");

		let ambientModulesContent = "";
		for (const specifier of needsAmbientModuleImportSpecifiers) {
			ambientModulesContent += `declare module "${specifier}";\n`;
		}

		await Deno.writeTextFile(ambientModulesFilePath, ambientModulesContent);
	}

	for (const { importSpecifier, importerFilePath, resolvedSpecifier } of remoteImports) {
		const baseUrl = new URL(toFileUrl(importerFilePath));

		const vendorResolvedSpecifier = resolveModuleSpecifierAll(
			baseUrl,
			resolvedSpecifier.href,
		);

		// If the resolved location doesn't point to something inside
		// the .denoTypes directory, we don't need to do anything.
		if (!vendorResolvedSpecifier) continue;

		tsConfigPaths.push([importSpecifier, vendorResolvedSpecifier.pathname]);
	}

	for (const specifier of Object.keys(newFetchedExactTypeModules)) {
		tsConfigPaths.push([
			specifier,
			resolve(exactTypesDirPath, specifier, "index.d.ts"),
		]);
	}

	// Add tsconfig.json
	log("Creating tsconfig.json");
	const tsconfigPath = join(absoluteOutputDirPath, "tsconfig.json");
	/** @type {Object.<string, string[]>} */
	const tsConfigPathsObject = {};
	for (const [url, path] of tsConfigPaths) {
		tsConfigPathsObject[url] = [path];
	}
	const tsconfigContent = JSON.stringify(
		{
			compilerOptions: {
				typeRoots: [typeRootsDirPath],
				paths: tsConfigPathsObject,
			},
		},
		null,
		2,
	);
	await Deno.writeTextFile(tsconfigPath, tsconfigContent);

	// Update the cache file so that files aren't vendored in future runs.
	{
		const vendoredImports = new Set(remoteImports.map((i) => i.resolvedSpecifier.href));
		await updateCacheData({
			vendoredImports: Array.from(vendoredImports),
		});
	}

	log("Done creating types for remote imports.");
}
