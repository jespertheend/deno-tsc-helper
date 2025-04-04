import {
	dirname,
	format,
	fromFileUrl,
	join,
	parse,
	resolve,
	toFileUrl,
} from "https://deno.land/std@0.145.0/path/mod.ts";
import { ensureDir, ensureFile } from "https://deno.land/std@0.145.0/fs/mod.ts";
import * as streams from "https://deno.land/std@0.167.0/streams/mod.ts";
import { createEmptyImportMap, resolveModuleSpecifier } from "https://deno.land/x/import_maps@v0.2.0/mod.js";
import { collectImports } from "./src/collectImports.js";
import { createTypesDir, fillOptionDefaults, loadImportMap, sanitizeFileName } from "./src/common.js";
import { blue, yellow } from "https://deno.land/std@0.157.0/fmt/colors.ts";
import { createLogger } from "./src/logging.js";
import { fetchNpmPackage, splitNameAndVersion } from "https://deno.land/x/npm_fetcher@v0.1.0/mod.ts";
import { vendor } from "https://deno.land/x/vendor@v0.2.0/mod.js";
import { modifyVendoredFiles } from "./src/modifyVendoredFiles.js";

/**
 * @typedef GenerateTypesOptions
 * @property {string[]} [include] A list of local paths to parse the imports from.
 * Any import statement found in any of these .ts or .js files will be collected and their
 * types will be fetched and added to the generated tsconfig.json.
 * Note that the module graph is not traversed, i.e. only the imports of files and
 * directories in this array are checked. Imported files are not checked.
 * If the path to a directory is provided, then its contents are checked recursively.
 * @property {string[]} [exclude] A list of local paths to exclude. Any file in this list
 * will not be parsed. This defaults to [".denoTypes", "node_modules"].
 * @property {string[]} [excludeUrls] A list of urls to ignore when fetching types.
 * If a specific import specifier is causing issues, you can add its exact url to this list.
 * If you are using an import map, you can also use the specifier from the import map.
 * An [ambient module](https://www.typescriptlang.org/docs/handbook/modules.html#shorthand-ambient-modules)
 * will be created that contains no types for each excluded url.
 * Additionally, when vendoring, a temporary import map is created containing
 * each of the excluded urls pointing to a dummy module. This way, if a module
 * is failing to vendor, but you would still like to use its types, you can
 * provide the specific url at which the module fails. That way only the failing
 * portion of a module is excluded.
 * @property {string?} [importMap] A path to the import map to use. If provided, the paths in the generated
 * tsconfig.json will be set to values in the import map.
 * @property {Object.<string, string[]>} [extraPaths] A set of extra paths that will be added to the generated tsconfig.
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
 * @property {import("https://deno.land/std@0.159.0/log/mod.ts").LevelName} [logLevel]
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
	const { logLevel, include, exclude, excludeUrls, importMap, cacheHashFile, preCollectedImportsFile, outputDir } =
		fillOptionDefaults(
			options,
		);

	const logger = createLogger(logLevel);

	if (!cacheHashFile) {
		throw new Error("The `cacheHashFile` option is required when making use of `createCacheHashFile`.");
	}

	logger.info("Collecting import specifiers from script files");

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
	logger.debug(`Created cache hash file at ${cacheHashFilePath}`);

	if (preCollectedImportsFile) {
		const preCollectedImportsFilePath = resolve(absoluteOutputDirPath, preCollectedImportsFile);
		await Deno.writeTextFile(preCollectedImportsFilePath, JSON.stringify(collectedImportData, null, "\t"), {
			create: true,
		});
		logger.info(`Collected imports file written to ${preCollectedImportsFilePath}`);
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
		extraPaths,
		extraTypeRoots,
		exactTypeModules,
		outputDir,
		unstable,
		logLevel,
		preCollectedImportsFile,
	} = fillOptionDefaults(options);

	const logger = createLogger(logLevel);

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

	let hasDummyModule = true;
	const dummyModulePath = resolve(absoluteOutputDirPath, "dummyModule.js");
	try {
		await Deno.stat(dummyModulePath);
	} catch {
		hasDummyModule = false;
	}
	if (!hasDummyModule) {
		await Deno.writeTextFile(
			dummyModulePath,
			`// This is an empty module which is used for replacing modules that causes 'deno vendor' to fail.
// The path to this module is added to a temporary import map when vendoring.
// Every path added to the 'excludeUrls' option gets added to the import map with this module as its destination.
export default {};
export {};
`,
		);
	}

	// Add deno types file from the `deno types` command.
	const typeRootsDirPath = resolve(absoluteOutputDirPath, "@types");
	const desiredDenoTypesVersion = Deno.version.deno + (unstable ? "-unstable" : "");
	if (denoTypesVersion != desiredDenoTypesVersion) {
		logger.info("Generating Deno types");
		const denoTypesArgs = ["types"];
		if (unstable) denoTypesArgs.push("--unstable");
		const denoTypesCommand = new Deno.Command(Deno.execPath(), {
			args: denoTypesArgs,
			stdout: "piped",
		});
		const typesCommandOutput = await denoTypesCommand.output();
		const typesContent = new TextDecoder().decode(typesCommandOutput.stdout);
		let lines = typesContent.split("\n");
		// Remove tripple slash directives as this causes errors since the files
		// they are pointing to don't exist.
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
			logger.debug(`Fetching type root ${folderName}`);
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
	/**
	 * The new `fetchedExactTypeModules` value that will eventually replace the old one.
	 * @type {Object<string, string>}
	 */
	const newFetchedExactTypeModules = {};
	/**
	 * A collection that maps specifiers to the absolute path of the file that it should point to.
	 * @type {Map<string, string>}
	 */
	const fetchedExactTypeModulesPathMappings = new Map();
	const exactTypesDirPath = resolve(absoluteOutputDirPath, "exactTypes");
	for (const [specifier, url] of Object.entries(exactTypeModules)) {
		// Note that this sanitization can cause different specifiers to point to the same file.
		// i.e. 'my:specifier' and 'my%specifier' will both end up being sanitized to 'my_specifier'.
		// But this case seems pretty rare so this will do for now.
		const sanitizedSpecifier = sanitizeFileName(specifier);
		const dirPath = resolve(exactTypesDirPath, sanitizedSpecifier);
		const filePath = resolve(dirPath, "index.d.ts");
		fetchedExactTypeModulesPathMappings.set(specifier, filePath);

		if (cachedExactTypeModules[specifier] != url) {
			logger.debug(`Fetching exact types for ${specifier}`);
			const response = await fetch(url);
			if (!response.ok) {
				throw new Error(
					`Failed to fetch exact types for ${specifier}, the server responded with status code ${response.status}.`,
				);
			}
			await ensureDir(dirPath);
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
			} catch {
				throw new Error(
					`The file at ${preCollectedImportsFilePath} appears to be corrupt and couldn't be parsed.`,
				);
			}
			for (const remoteImport of preCollectedImportsJson.remoteImports) {
				remoteImport.resolvedSpecifier = new URL(remoteImport.resolvedSpecifier);
			}
			preCollectedImports = preCollectedImportsJson;
		} else {
			logger.warning(`No pre-collected imports file was found at ${preCollectedImportsFilePath}.`);
		}
	}

	if (!preCollectedImports) {
		logger.info("Collecting import specifiers from script files");
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
			logger.info("No imports have changed since the last run");
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
	/**
	 * Maps imported urls to paths of where the resources were saved.
	 * @type {Map<string, string>}
	 */
	const allVendoredFiles = new Map();

	/**
	 * A list of found npm imports to be added to the tsconfig.json later.
	 * Key is the import specifier, value is the absolute path to the downloaded .d.ts file in the .denoTypes directory.
	 * @type {Map<string, string>}
	 */
	const npmImports = new Map();

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

	logger.info("Vendoring collected import urls.");

	/** @type {import("https://deno.land/x/import_maps@v0.2.0/mod.js").ImportMapData} */
	let temporaryImportMap = {};
	if (userImportMapPath) {
		const text = await Deno.readTextFile(userImportMapPath);
		temporaryImportMap = JSON.parse(text);
	}
	if (!temporaryImportMap.imports) {
		temporaryImportMap.imports = {};
	}
	if (temporaryImportMap.imports) {
		const dummyUrl = toFileUrl(dummyModulePath).href;
		for (const url of excludeUrls) {
			temporaryImportMap.imports[url] = dummyUrl;
		}

		// See https://github.com/denoland/deno/issues/17210
		// Deno currently panics when vendoring remote imports that contain npm specifiers.
		// And since deno_tsc_helper is likely going to be vendored by the user, we'll
		// exclude the typescript import, which is the only npm specifier this module uses.
		// This way at least deno_tsc_helper can be vendored without any configuration by the user.
		// Unfortunately any other modules importing npm specifiers will have to be manually excluded
		// by the user in order to prevent panics.
		// Though this is likely pretty rare at the moment since npm specifiers in remote modules still requires
		// the --unstable flag for now.
		temporaryImportMap.imports["npm:typescript@4.7.4"] = dummyUrl;
	}

	for (const [resolvedSpecifier, importDatas] of mergedRemoteImports) {
		// If we already vendored this specifier in the last run, there's no need
		// to vendor it again. This should speed things up significantly when there
		// are a lot of remote imports.
		if (cachedImportSpecifiers.has(resolvedSpecifier)) continue;

		if (resolvedSpecifier.startsWith("npm:")) {
			const npmSpecifier = resolvedSpecifier.slice(4);
			const packageData = await fetchNpmPackage(splitNameAndVersion(npmSpecifier));
			const typesPath = packageData.registryData.types || packageData.registryData.typings;
			if (!typesPath || typeof typesPath != "string") continue;

			const absoluteTypesPath = resolve("/", typesPath);
			logger.debug(`Fetching types for ${resolvedSpecifier}`);
			const npmPackageDestinationDir = resolve(
				absoluteOutputDirPath,
				"npmTypes",
				packageData.packageName,
				packageData.version,
			);
			await ensureDir(npmPackageDestinationDir);
			for await (const entry of packageData.getPackageContents()) {
				if (entry.type != "file") continue;
				const destinationPath = resolve(npmPackageDestinationDir, entry.fileName);
				const destinationDir = dirname(destinationPath);
				await ensureDir(destinationDir);
				await ensureFile(destinationPath);
				const file = await Deno.open(destinationPath, { write: true });
				await streams.copy(entry, file);
				file.close();

				const resolved = resolve("/", entry.fileName);
				if (resolved == absoluteTypesPath) {
					for (const importData of importDatas) {
						npmImports.set(importData.importSpecifier, destinationPath);
					}
				}
			}
		} else {
			logger.debug(`Vendoring ${resolvedSpecifier}`);
			/** @type {string[]} */
			let failedSubmoduleUrls = [];
			const vendorFiles = await vendor({
				entryPoints: [resolvedSpecifier],
				outDir: vendorOutputPath,
				parsedImportMap: userImportMap || {},
				includeTypeImports: true,
				onFetchError: (error) => {
					failedSubmoduleUrls.push(error.url);
				},
			});
			for (const { url, path } of vendorFiles) {
				allVendoredFiles.set(url, path);
			}

			if (failedSubmoduleUrls.length > 0) {
				let excludeString = yellow(resolvedSpecifier);
				const importSpecifiers = new Set(importDatas.map((d) => d.importSpecifier));
				const importFilePaths = new Set(importDatas.map((d) => d.importerFilePath));
				if (importSpecifiers.size == 1) {
					const importSpecifier = importSpecifiers.values().next().value;
					if (!importSpecifier) {
						throw new Error("Assertion failed, importSpecifier is undefined");
					}
					if (resolvedSpecifier != importSpecifier) {
						excludeString = `${yellow(importSpecifier)}" or "${yellow(resolvedSpecifier)}`;
					}
				}
				let importmapMessage;
				if (userImportMapPath) {
					importmapMessage =
						`Aternatively you can add any offending imports to your import map at "${userImportMapPath}".`;
				} else {
					importmapMessage = `Aternatively you can add any offending imports to an import map.`;
				}
				console.warn(
					`

${yellow(`Failed to fetch some files for ${resolvedSpecifier}.`)}

The error occurred while vendoring "${blue(resolvedSpecifier)}" which was imported in the following files:
${Array.from(importFilePaths).map((f) => `  ${f}`).join("\n")}

Some or all files of this module may not have been downloaded. Specifically these files failed:
${failedSubmoduleUrls.map((f) => `  ${f}`).join("\n")}

Consider adding "${excludeString}" to 'excludeUrls' to skip this import.
${importmapMessage}
`,
				);
			}
		}
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
		const resolved = resolveModuleSpecifier(userImportMap, baseUrl, moduleSpecifier);
		const filePath = allVendoredFiles.get(resolved.href);
		if (!filePath) return null;
		return new URL("file://" + filePath);
	}

	const collectedDtsFiles = await modifyVendoredFiles({
		logger,
		vendorOutputPath,
		resolveModuleSpecifier: resolveModuleSpecifierAll,
	});

	logger.debug("Fetching .d.ts files for vendored files.");
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
			logger.debug(`Fetching ${denoTypesUrl}`);
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

	const tsconfigPath = join(absoluteOutputDirPath, "tsconfig.json");

	/** @type {Object.<string, string[]>} */
	let tsConfigPathsObject = {};

	// First we check for an existing tsconfig and its paths, since we don't want to override this.
	let existingTsConfigText;
	try {
		existingTsConfigText = await Deno.readTextFile(tsconfigPath);
	} catch (e) {
		if (!(e instanceof Deno.errors.NotFound)) {
			throw e;
		}
	}
	if (existingTsConfigText) {
		let existingTsConfig;
		try {
			existingTsConfig = JSON.parse(existingTsConfigText);
		} catch {
			throw new Error(`Failed to parse existing tsconfig at "${tsconfigPath}".`);
		}
		tsConfigPathsObject = existingTsConfig.compilerOptions?.paths || {};
	}

	/**
	 * A list of paths that should be added to the generated tsconfig.json.
	 * @type {[string, string][]}
	 */
	const tsConfigPaths = [];

	if (needsAmbientModuleImportSpecifiers.length > 0) {
		logger.debug("Creating ambient modules for excluded urls");
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
		const pathname = fromFileUrl(vendorResolvedSpecifier);
		tsConfigPaths.push([importSpecifier, pathname]);
	}

	for (const [specifier, path] of fetchedExactTypeModulesPathMappings) {
		tsConfigPaths.push([
			specifier,
			path,
		]);
	}

	for (const [specifier, path] of npmImports) {
		tsConfigPaths.push([specifier, path]);
	}

	// Add tsconfig.json
	logger.debug("Creating tsconfig.json");
	for (const [url, path] of tsConfigPaths) {
		tsConfigPathsObject[url] = [path];
	}
	for (const [url, paths] of Object.entries(extraPaths)) {
		tsConfigPathsObject[url] = paths;
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

	logger.info("Done creating types for remote imports.");
}
