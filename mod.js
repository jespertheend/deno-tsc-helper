import {
	common,
	dirname,
	format,
	fromFileUrl,
	join,
	parse,
	resolve,
	toFileUrl,
} from "https://deno.land/std@0.145.0/path/mod.ts";
import {
	createEmptyImportMap,
	parseImportMap,
	resolveModuleSpecifier,
} from "https://deno.land/x/import_maps@v0.0.3/mod.js";
import ts from "https://esm.sh/typescript@4.7.4?pin=v87";

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
 * @property {string} [outputDir] The directory to output the generated files to. This is relative to the main entry point of the script.
 * @property {boolean} [unstable] Whether to include unstable deno apis in the generated types.
 * @property {boolean} [quiet] Whether to suppress output.
 */

/** @typedef {(entry: Deno.DirEntry) => boolean} ReadDirRecursiveFilter */

/**
 * Reads all directives recursively and yields all files.
 * Directories are not included.
 * @param {string} path
 * @param {ReadDirRecursiveFilter} [filter] A filter function that you can use
 * to filter out certain files from the result. If the filter returns false, the file will
 * not be included in the results. If false is returned for a directory, all of its files
 * will be excluded from the results. You can use this to prevent recursing large
 * directories that you know you won't need anyway.
 * @returns {AsyncIterable<string>}
 */
async function* readDirRecursive(path, filter) {
	for await (const entry of Deno.readDir(path)) {
		if (filter && !filter(entry)) continue;
		if (entry.isDirectory) {
			yield* readDirRecursive(join(path, entry.name));
		} else {
			yield resolve(path, entry.name);
		}
	}
}

/**
 * @typedef ParseFileAstExtra
 * @property {ts.SourceFile} sourceFile
 */

/**
 * @param {string} filePath
 * @param {(node: ts.Node, extra: ParseFileAstExtra) => void} [cbNode]
 */
async function parseFileAst(filePath, cbNode) {
	const fileContent = await Deno.readTextFile(filePath);
	const program = ts.createProgram([filePath], {
		noResolve: true,
		target: ts.ScriptTarget.Latest,
		module: ts.ModuleKind.ESNext,
		allowJs: true,
	}, {
		fileExists: () => true,
		getCanonicalFileName: (filePath) => filePath,
		getCurrentDirectory: () => "",
		getDefaultLibFileName: () => "lib.d.ts",
		getNewLine: () => "\n",
		getSourceFile: (fileName) => {
			if (fileName === filePath) {
				return ts.createSourceFile(
					fileName,
					fileContent,
					ts.ScriptTarget.Latest,
				);
			}
			return undefined;
		},
		readFile: () => undefined,
		useCaseSensitiveFileNames: () => true,
		writeFile: () => null,
	});

	const sourceFile = program.getSourceFile(filePath);

	// TODO: Add a warning or maybe even throw?
	if (!sourceFile) return null;
	const sourceFile2 = sourceFile;

	if (cbNode) {
		const cb = cbNode;
		/**
		 * @param {ts.Node} node
		 */
		function traverseAst(node) {
			cb(node, {
				sourceFile: sourceFile2,
			});
			ts.forEachChild(node, traverseAst);
		}

		traverseAst(sourceFile);
	}

	return sourceFile;
}

/**
 * Resolves a path relative to the main entry point of the script.
 * @param {string} path
 */
function resolveFromMainModule(path) {
	return resolve(dirname(fromFileUrl(Deno.mainModule)), path);
}

/**
 * Generates type files and a tsconfig.json file that you can include in your
 * tsconfig to make Deno types work.
 * @param {GenerateTypesOptions} [options]
 */
export async function generateTypes({
	include = ["."],
	exclude = [".denoTypes", "node_modules"],
	excludeUrls = [],
	importMap = null,
	outputDir = "./.denoTypes",
	unstable = false,
	extraTypeRoots = {},
	quiet = false,
} = {}) {
	/**
	 * @param {Parameters<typeof console.log>} args
	 */
	function log(...args) {
		if (!quiet) console.log(...args);
	}

	const absoluteOutputDirPath = resolveFromMainModule(outputDir);

	/**
	 * @typedef CacheFileData
	 * @property {string[]} [vendoredImports]
	 * @property {string} [denoTypesVersion]
	 * @property {Object.<string, string>} [fetchedTypeRoots]
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

	let hasOutputDir = true;
	try {
		await Deno.stat(absoluteOutputDirPath);
	} catch {
		hasOutputDir = false;
	}

	if (!hasOutputDir) {
		await Deno.mkdir(absoluteOutputDirPath, { recursive: true });

		// Add .gitignore
		const gitIgnorePath = join(absoluteOutputDirPath, ".gitignore");
		await Deno.writeTextFile(gitIgnorePath, "**");

		// Add readme.md
		const readmePath = join(absoluteOutputDirPath, "readme.md");
		await Deno.writeTextFile(
			readmePath,
			`# Deno types

All files in this directory are generated by [deno-tsc-helper](https://deno.land/x/deno_tsc_helper). The purpose of
these files is to make types work using the standard \`tsc\` process and language server, without the need for a Deno
extension.
`,
		);
	}

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
			await Deno.mkdir(typeRootDirPath, { recursive: true });
			const typeRootFilePath = resolve(typeRootDirPath, "index.d.ts");
			await Deno.writeTextFile(typeRootFilePath, await response.text());
		}
		newFetchedTypeRoots[folderName] = url;
	}
	await updateCacheData({
		fetchedTypeRoots: newFetchedTypeRoots,
	});

	/**
	 * A list of absolute paths pointing to all .js and .ts files that the user
	 * wishes to parse and detect imports from.
	 * @type {string[]}
	 */
	const userFiles = [];
	for (const includePath of include) {
		const absoluteIncludePath = resolve(
			dirname(fromFileUrl(Deno.mainModule)),
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
				if (filePath.endsWith(".js") || filePath.endsWith(".ts") || filePath.endsWith(".d.ts")) {
					userFiles.push(filePath);
				}
			}
		} else {
			userFiles.push(absoluteIncludePath);
		}
	}

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
	 * List of imports found in the user files.
	 * @type {ImportData[]}
	 */
	const allImports = [];
	log("Collecting import specifiers from script files");
	for (const userFile of userFiles) {
		log(`Collecting imports from ${userFile}`);
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

	const userImportMapPath = importMap ? resolveFromMainModule(importMap) : null;
	let userImportMapAny;
	if (userImportMapPath) {
		const userImportMapStr = await Deno.readTextFile(userImportMapPath);
		const userImportMapJson = JSON.parse(userImportMapStr);
		const baseUrl = new URL(toFileUrl(userImportMapPath));
		userImportMapAny = parseImportMap(userImportMapJson, baseUrl);
	} else {
		userImportMapAny = createEmptyImportMap();
	}
	const userImportMap = userImportMapAny;

	/** @type {RemoteImportData[]} */
	const remoteImports = [];
	for (const { importSpecifier, importerFilePath } of allImports) {
		if (excludeUrls.includes(importSpecifier)) continue;

		const baseUrl = new URL(toFileUrl(importerFilePath));
		const resolvedSpecifier = resolveModuleSpecifier(userImportMap, baseUrl, importSpecifier);

		if (excludeUrls.includes(resolvedSpecifier.href)) continue;
		if (resolvedSpecifier.protocol == "file:") continue;

		remoteImports.push({
			importerFilePath,
			importSpecifier,
			resolvedSpecifier,
		});
	}

	{
		let allCached = true;
		for (const { resolvedSpecifier } of remoteImports) {
			if (!cachedImportSpecifiers.has(resolvedSpecifier.href)) {
				allCached = false;
				break;
			}
		}

		// If all imports are already cached, we don't need to do anything.
		if (allCached) {
			log("No imports have changed since the last run");
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
	 * @type {Map<string, RemoteImportData[]>}
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
			// Collect imports/exports with an deno-types comment
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
		if (filePath.endsWith(".js")) {
			modified = "// @ts-nocheck\n" + modified;
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

	if (needsAmbientModuleImportSpecifiers.size > 0) {
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

		if (needsAmbientModuleImportSpecifiers.has(importSpecifier)) continue;

		tsConfigPaths.push([importSpecifier, vendorResolvedSpecifier.pathname]);
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
