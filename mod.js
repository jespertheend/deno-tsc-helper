import {join, resolve, dirname, fromFileUrl, toFileUrl, common, basename} from "https://deno.land/std@0.145.0/path/mod.ts";
import {parseImportMap, resolveModuleSpecifier} from "https://deno.land/x/import_maps@v0.0.2/mod.js";
import * as ts from "https://esm.sh/typescript@4.7.4?pin=v87";

/**
 * @typedef GenerateTypesOptions
 * @property {string[]} [include] A list of urls to fetch types from.
 * @property {string} [outputDir] The directory to output the generated files to. This is relative to the main entry point of the script.
 * @property {boolean} [unstable] Whether to include unstable deno apis in the generated types.
 */

/**
 * @param {string | URL} path
 * @returns {AsyncIterable<Deno.DirEntry>}
 */
async function *readDirRecursive(path) {
	for await (const entry of Deno.readDir(path)) {
		if (entry.isDirectory) {
			yield* readDirRecursive(join(path, entry.name));
		} else {
			entry.name = join(path, entry.name);
			yield entry;
		}
	}
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
	const absoluteOutputDirPath = resolve(dirname(fromFileUrl(Deno.mainModule)), outputDir);
	await Deno.mkdir(absoluteOutputDirPath, {recursive: true});

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
	lines = lines.filter(line => !line.startsWith("/// <reference"));
	const newTypesContent = lines.join("\n");

	const denoTypesDirPath = join(absoluteOutputDirPath, "@types");
	const denoTypesDirPathFull = join(denoTypesDirPath, "deno-types");
	await Deno.mkdir(denoTypesDirPathFull, {recursive: true});
	const denoTypesFilePath = join(denoTypesDirPathFull, "index.d.ts");
	await Deno.writeTextFile(denoTypesFilePath, newTypesContent);

	/** @type {string[]} */
	const vendorFiles = [];
	for (const includePath of include) {
		const absoluteIncludePath = resolve(dirname(fromFileUrl(Deno.mainModule)), includePath);
		const fileInfo = await Deno.stat(absoluteIncludePath);
		if (fileInfo.isDirectory) {
			throw new Error("Not yet implemented");
			// for await (const entry of readDirRecursive(includePath)) {
			// }
		} else {
			vendorFiles.push(absoluteIncludePath);
		}
	}

	const vendorOutput = resolve(absoluteOutputDirPath, "vendor");
	const vendorProcess = Deno.run({
		cmd: ["deno", "vendor", "--force", "--output", vendorOutput, ...vendorFiles],
		stdout: "null",
		stdin: "null",
		stderr: "inherit",
	});
	const status = await vendorProcess.status();
	if (!status.success) {
		throw new Error(`Failed to vendor files. \`deno vendor\` exited with status ${status.code}`);
	}

	/**
	 * @typedef ImportData
	 * @property {string} importerFilePath
	 * @property {string} importSpecifier
	 */

	/** @type {ImportData[]} */
	const allImports = [];
	for (const vendorFile of vendorFiles) {
		const vendorFileName = basename(vendorFile);
		const fileContent = await Deno.readTextFile(vendorFile);
		const program = await ts.createProgram([vendorFileName], {
			noResolve: true,
			target: ts.ScriptTarget.Latest,
			module: ts.ModuleKind.ESNext,
			allowJs: true,
		}, {
			fileExists: () => true,
			getCanonicalFileName: filePath => filePath,
			getCurrentDirectory: () => "",
			getDefaultLibFileName: () => "lib.d.ts",
			getNewLine: () => "\n",
			getSourceFile: (fileName) => {
				if (fileName === vendorFileName) {
					return ts.createSourceFile(fileName, fileContent, ts.ScriptTarget.Latest);
				}
				return undefined;
			},
			readFile: () => null,
			useCaseSensitiveFileNames: () => true,
			writeFile: () => null,
		});

		const sourceFile = program.getSourceFile(vendorFileName);

		// TODO: Add a warning or maybe even throw?
		if (!sourceFile) continue;

		function traverseAst(node) {
			if (node.kind == ts.SyntaxKind.ImportDeclaration) {
				allImports.push({
					importerFilePath: vendorFile,
					importSpecifier: node.moduleSpecifier.text,
				});
			}
			ts.forEachChild(node, traverseAst);
		}

		traverseAst(sourceFile);
	}

	// Read the generated import map
	const importMapPath = join(vendorOutput, "import_map.json");
	const importMapText = await Deno.readTextFile(importMapPath);
	const importMapJson = JSON.parse(importMapText);

	/** @type {[string, string][]} */
	const tsConfigPaths = [];

	const baseUrl = new URL(toFileUrl(importMapPath));
	const parsedImportMap = parseImportMap(importMapJson, baseUrl);
	for (const importData of allImports) {
		const apiBaseUrl = new URL(toFileUrl(importData.importerFilePath));
		const resolvedModuleSpecifier = resolveModuleSpecifier(parsedImportMap, apiBaseUrl, importData.importSpecifier);
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
	const tsconfigContent = JSON.stringify({
		compilerOptions: {
			typeRoots: [denoTypesDirPath],
			paths: tsConfigPathsObject,
		},
	}, null, 2);
	await Deno.writeTextFile(tsconfigPath, tsconfigContent);
}
