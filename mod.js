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
 * @property {string[]} [include] A list of urls to fetch types from.
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
	const vendorFileName = basename(filePath);
	const fileContent = await Deno.readTextFile(filePath);
	const program = ts.createProgram([vendorFileName], {
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
			if (fileName === vendorFileName) {
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

	const sourceFile = program.getSourceFile(vendorFileName);

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

	const denoTypesDirPath = join(absoluteOutputDirPath, "@types");
	const denoTypesDirPathFull = join(denoTypesDirPath, "deno-types");
	await Deno.mkdir(denoTypesDirPathFull, { recursive: true });
	const denoTypesFilePath = join(denoTypesDirPathFull, "index.d.ts");
	await Deno.writeTextFile(denoTypesFilePath, newTypesContent);

	/** @type {string[]} */
	const vendorFiles = [];
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
			vendorFiles.push(absoluteIncludePath);
		}
	}

	const vendorOutputPath = resolve(absoluteOutputDirPath, "vendor");
	const vendorProcess = Deno.run({
		cmd: [
			"deno",
			"vendor",
			"--force",
			"--no-config",
			"--output",
			vendorOutputPath,
			...vendorFiles,
		],
		stdout: "null",
		stdin: "null",
		stderr: "inherit",
	});
	const status = await vendorProcess.status();
	if (!status.success) {
		throw new Error(
			`Failed to vendor files. \`deno vendor\` exited with status ${status.code}`,
		);
	}

	/**
	 * @typedef ImportData
	 * @property {string} importerFilePath
	 * @property {string} importSpecifier
	 */

	/** @type {ImportData[]} */
	const allImports = [];
	for (const vendorFile of vendorFiles) {
		await parseFileAst(vendorFile, (node) => {
			if (
				ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)
			) {
				allImports.push({
					importerFilePath: vendorFile,
					importSpecifier: node.moduleSpecifier.text,
				});
			}
		});
	}

	/**
	 * A transformer that replaces all imports ending with .ts with .js.
	 * This is because, while Deno can import .ts files just fine, tsc cannot.
	 * Simply replacing .ts with .js should be enought to make tsc stop complaining.
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
					(ts.isImportDeclaration(node.parent) ||
						ts.isExportDeclaration(node.parent))
				) {
					if (node.text.endsWith(".ts")) {
						const importSpecifier = node.text.slice(0, -3) + ".js";
						const created = ts.factory.createStringLiteral(importSpecifier);
						return created;
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
		const modified = printer.printNode(
			ts.EmitHint.Unspecified,
			transformationResult.transformed[0],
			ast.getSourceFile(),
		);
		await Deno.writeTextFile(entry.name, modified);
	}

	// Read the generated import map
	const importMapPath = join(vendorOutputPath, "import_map.json");
	const importMapText = await Deno.readTextFile(importMapPath);
	const importMapJson = JSON.parse(importMapText);
	const importMapBaseUrl = new URL(toFileUrl(importMapPath));
	const parsedImportMap = parseImportMap(importMapJson, importMapBaseUrl);

	const dtsFetchPromises = [];
	for (const { dtsUrl, vendorFilePath, moduleSpecifier } of collectedDtsFiles) {
		const promise = (async () => {
			const response = await fetch(dtsUrl);
			const text = await response.text();
			const baseUrl = new URL(toFileUrl(vendorFilePath));
			const dtsDestination = resolveModuleSpecifier(parsedImportMap, baseUrl, moduleSpecifier);
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

	/** @type {[string, string][]} */
	const tsConfigPaths = [];

	for (const importData of allImports) {
		const apiBaseUrl = new URL(toFileUrl(importData.importerFilePath));
		const resolvedModuleSpecifier = resolveModuleSpecifier(
			parsedImportMap,
			apiBaseUrl,
			importData.importSpecifier,
		);
		const resolvedUrl = new URL(resolvedModuleSpecifier);

		// If the resolved location doesn't point to something inside
		// the .denoTypes directory, we don't need to do anything.
		if (resolvedUrl.protocol !== "file:") continue;
		const resolvedPath = resolvedUrl.pathname;
		const commonPath = resolve(common([resolvedPath, absoluteOutputDirPath]));
		if (commonPath != absoluteOutputDirPath) continue;

		tsConfigPaths.push([importData.importSpecifier, resolvedPath]);
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
				typeRoots: [denoTypesDirPath],
				paths: tsConfigPathsObject,
			},
		},
		null,
		2,
	);
	await Deno.writeTextFile(tsconfigPath, tsconfigContent);
}
