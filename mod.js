import {
	basename,
	common,
	dirname,
	format,
	fromFileUrl,
	join,
	parse,
	resolve,
	toFileUrl,
} from "https://deno.land/std@0.145.0/path/mod.ts";
import { parseImportMap, resolveModuleSpecifier } from "https://deno.land/x/import_maps@v0.0.2/mod.js";
import ts from "https://esm.sh/typescript@4.7.4?pin=v87";

/**
 * @typedef GenerateTypesOptions
 * @property {string[]} [include] A list of local paths to parse the imports from.
 * Any import statement found in any of these .ts or .js files will be collected and their
 * types will be fetched and added to the generated tsconfig.json.
 * @property {string[]} [excludeUrls] A list of urls to ignore when fetching types.
 * If a specific import specifier is causing issues, you can add its exact url to this list.
 * An [ambient module](https://www.typescriptlang.org/docs/handbook/modules.html#shorthand-ambient-modules)
 * will be created that contains no types for each of these.
 * @property {string} [outputDir] The directory to output the generated files to. This is relative to the main entry point of the script.
 * @property {boolean} [unstable] Whether to include unstable deno apis in the generated types.
 */

/**
 * @param {string} path
 * @returns {AsyncIterable<Deno.DirEntry>}
 */
async function* readFilesRecursive(path) {
	for await (const entry of Deno.readDir(path)) {
		if (entry.isDirectory) {
			yield* readFilesRecursive(join(path, entry.name));
		} else {
			entry.name = join(path, entry.name);
			yield entry;
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
 * Generates type files and a tsconfig.json file that you can include in your
 * tsconfig to make Deno types work.
 * @param {GenerateTypesOptions} [options]
 */
export async function generateTypes({
	include = ["."],
	excludeUrls = [],
	outputDir = "./.denoTypes",
	unstable = false,
} = {}) {
	const absoluteOutputDirPath = resolve(
		dirname(fromFileUrl(Deno.mainModule)),
		outputDir,
	);
	await Deno.mkdir(absoluteOutputDirPath, { recursive: true });

	// Add .gitignore
	const gitIgnorePath = join(absoluteOutputDirPath, ".gitignore");
	await Deno.writeTextFile(gitIgnorePath, "**");

	// Add deno types file from the `deno types` command.
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

	const typeRootsDirPath = join(absoluteOutputDirPath, "@types");
	const denoTypesDirPath = join(typeRootsDirPath, "deno-types");
	await Deno.mkdir(denoTypesDirPath, { recursive: true });
	const denoTypesFilePath = join(denoTypesDirPath, "index.d.ts");
	await Deno.writeTextFile(denoTypesFilePath, newTypesContent);

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
			throw new Error("Not yet implemented");
			// for await (const entry of readDirRecursive(includePath)) {
			// }
		} else {
			userFiles.push(absoluteIncludePath);
		}
	}

	/**
	 * @typedef ImportData
	 * @property {string} importerFilePath
	 * @property {string} importSpecifier
	 */

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

	const vendorOutputPath = resolve(absoluteOutputDirPath, "vendor");
	const importMapPath = join(vendorOutputPath, "import_map.json");
	/** @type {import("https://deno.land/x/import_maps@v0.0.2/mod.js").ParsedImportMap[]} */
	const parsedImportMaps = [];

	/** @type {Set<string>} */
	const needsDummyImportSpecifiers = new Set();

	for (const { importSpecifier } of allImports) {
		// TODO: Use a better way to detect if an import specifier is a remote url.
		if (!importSpecifier.startsWith("https://")) continue;
		if (excludeUrls.includes(importSpecifier)) {
			needsDummyImportSpecifiers.add(importSpecifier);
			continue;
		}

		const cmd = ["deno", "vendor", "--force", "--no-config"];
		cmd.push("--output", vendorOutputPath);
		cmd.push(importSpecifier);
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
			throw new Error(
				`Failed to vendor files for ${importSpecifier}. \`deno vendor\` exited with status ${status.code}.
Consider adding "${importSpecifier}" to \`excludeUrls\` to skip this import.

The error occurred while running:
${cmd.join(" ")}
The command resulted in the following error:
${errorString}`,
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
	 * @property {string} dtsUrl The url containing types that should be fetched and placed at the `moduleSpecifier`.
	 * @property {string} vendorFilePath The file that imported the `moduleSpecifier`.
	 * @property {string} moduleSpecifier The module specifier that was imported for which the `dtsUrl` types should be fetched and placed at.
	 */

	/** @type {CollectedDtsFile[]} */
	const collectedDtsFiles = [];

	const denoTypesRegex = /\/\/\s*@deno-types\s*=\s*"(?<url>.*)"/;
	const printer = ts.createPrinter();
	for await (const entry of readFilesRecursive(vendorOutputPath)) {
		const ast = await parseFileAst(entry.name, (node, { sourceFile }) => {
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
									dtsUrl: match.groups.url,
									vendorFilePath: entry.name,
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
		if (entry.name.endsWith(".js")) {
			modified = "// @ts-nocheck\n" + modified;
		}
		await Deno.writeTextFile(entry.name, modified);
	}

	const dtsFetchPromises = [];
	for (const { dtsUrl, vendorFilePath, moduleSpecifier } of collectedDtsFiles) {
		const promise = (async () => {
			const response = await fetch(dtsUrl);
			const text = await response.text();
			const baseUrl = new URL(toFileUrl(vendorFilePath));
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

	if (needsDummyImportSpecifiers.size > 0) {
		const ambientModulesDirPath = resolve(typeRootsDirPath, "deno-tsc-helper-ambient-modules");
		await Deno.mkdir(ambientModulesDirPath, { recursive: true });
		const ambientModulesFilePath = resolve(ambientModulesDirPath, "index.d.ts");

		let ambientModulesContent = "";
		for (const specifier of needsDummyImportSpecifiers) {
			ambientModulesContent += `declare module "${specifier}";\n`;
		}

		await Deno.writeTextFile(ambientModulesFilePath, ambientModulesContent);
	}

	for (const importData of allImports) {
		const apiBaseUrl = new URL(toFileUrl(importData.importerFilePath));
		const resolvedModuleSpecifier = resolveModuleSpecifierAll(
			apiBaseUrl,
			importData.importSpecifier,
		);

		// If the resolved location doesn't point to something inside
		// the .denoTypes directory, we don't need to do anything.
		if (!resolvedModuleSpecifier) continue;

		if (needsDummyImportSpecifiers.has(importData.importSpecifier)) continue;

		tsConfigPaths.push([importData.importSpecifier, resolvedModuleSpecifier.pathname]);
	}

	// Add tsconfig.json
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
}
