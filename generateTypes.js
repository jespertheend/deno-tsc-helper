import {join, resolve, dirname, fromFileUrl} from "https://deno.land/std@0.145.0/path/mod.ts";

/**
 * @typedef GenerateTypesOptions
 * @property {string[]} [typeUrls] A list of urls to fetch types from.
 * @property {string} [outputDir] The directory to output the generated files to. This is relative to the main entry point of the script.
 * @property {boolean} [unstable] Whether to include unstable deno apis in the generated types.
 */

/**
 * Generates type files and a tsconfig.json file that you can include in your
 * tsconfig to make Deno types work.
 * @param {GenerateTypesOptions} [options]
 */
export async function generateTypes({
	typeUrls = [],
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

	// Fetch all the type urls
	/** @type {Map<string, string>} */
	const tsConfigPaths = new Map();
	/**
	 * @param {string} url
	 * @param {string} dtsContent
	 */
	async function writeTypesFile(url, dtsContent, {
		rootPath = join(absoluteOutputDirPath, "urlImports"),
	} = {}) {
		let filePath = url;
		filePath = filePath.replaceAll(":", "_");
		const fullPath = join(rootPath, filePath);
		const dir = dirname(fullPath);
		await Deno.mkdir(dir, {recursive: true});
		await Deno.writeTextFile(fullPath, dtsContent);
		return {fullPath};
	}

	const fetchTypeUrlPromises = [];
	const tripleSlashReferences = new Set();
	const referenceTypesRegex = /\/\/\/\s*<\s*reference\s*types\s*=\s*['"](?<url>.*)['"]\s*\/\s*>$/gm;
	for (const url of typeUrls) {
		const promise = (async () => {
			const tsResponse = await fetch(url);
			if (!tsResponse.ok) {
				console.error(`Failed to fetch types for ${url}`);
			} else {
				const emitResult = await Deno.emit(url, {
					compilerOptions: {
						declaration: true,
						removeComments: false,
					}
				})
				for (const [fileUrl, fileContent] of Object.entries(emitResult.files)) {
					for (const match of fileContent.matchAll(referenceTypesRegex)) {
						const relativeUrl = match.groups?.url;
						if (relativeUrl) {
							const absoluteUrl = new URL(relativeUrl, fileUrl);
							tripleSlashReferences.add(absoluteUrl.href);
						}
					}
					let newFileContent;
					if (fileUrl.endsWith(".js") || fileUrl.endsWith(".mjs")) {
						newFileContent = "// @ts-nocheck\n" + fileContent;
					} else {
						newFileContent = fileContent;
					}
					const {fullPath} = await writeTypesFile(fileUrl, newFileContent);
					if (fileUrl == url + ".js") {
						// Remove .js from the written file path
						const fullTsPath = fullPath.slice(0, -3);
						tsConfigPaths.set(url, fullTsPath);
						console.log(`Adding mapping for ${url} to tsconfig.`);
					}
				}
			}
		})();
		fetchTypeUrlPromises.push(promise);
	}
	await Promise.all(fetchTypeUrlPromises);

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
