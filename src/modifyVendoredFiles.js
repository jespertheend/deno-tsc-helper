import { fromFileUrl, toFileUrl } from "https://deno.land/std@0.145.0/path/mod.ts";
import ts from "npm:typescript@4.7.4";
import { parseFileAst } from "./parseFileAst.js";
import { readDirRecursive } from "./common.js";
import { Logger } from "./logging.js";

/**
 * The comment to look for to determine if the vendored file has already
 * been modified. The string is split in two parts and concatenated in order
 * to prevent tsc helper from incorrectly marking itself as already modified.
 */
const modifiedComment = "// tsc_" + "helper_modified";

/**
 * @param {Object} options
 * @param {Logger} options.logger
 * @param {string} options.vendorOutputPath
 * @param {(baseUrl: URL, moduleSpecifier: string) => URL | null} options.resolveModuleSpecifier
 */
export async function modifyVendoredFiles({ logger, vendorOutputPath, resolveModuleSpecifier }) {
	logger.info("Modifying vendored files");

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
						const resolvedUrl = resolveModuleSpecifier(baseUrl, oldSpecifier);
						if (resolvedUrl) {
							// Resolved urls should always be absolute. So we don't need the file:// prefix here I think.
							// Either way, TypeScript doesn't seem to have support for resolving file:// specifiers.
							newSpecifier = fromFileUrl(resolvedUrl.href);
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

	const denoTypesRegex = /\/\/\s*@deno-types\s*=\s*"(?<url>.*)"/;
	const printer = ts.createPrinter();

	/**
	 * @typedef CollectedDtsFile
	 * @property {string} denoTypesUrl The url containing types that should be fetched and placed at the `moduleSpecifier`.
	 * @property {string} vendorFilePath The file that imported the `moduleSpecifier`.
	 * @property {string} moduleSpecifier The module specifier that was imported for which the `dtsUrl` types should be fetched and placed at.
	 */

	/** @type {CollectedDtsFile[]} */
	const collectedDtsFiles = [];

	// readDirRecursive seems to skip some entries when you modify files as you are iterating over them.
	// So we'll store all paths in an array before making our modifications.
	const filePaths = [];
	for await (const filePath of readDirRecursive(vendorOutputPath)) {
		filePaths.push(filePath);
	}
	for (const filePath of filePaths) {
		const fileContent = await Deno.readTextFile(filePath);

		// Modifying the file is pretty expensive, especially for large files.
		// This is mostly because the ast needs to be parsed.
		// Modifying the file multiple times also causes duplicate modifications,
		// for instance a ts-nocheck comment gets added every time these steps
		// are run. In order to prevent this, we check if we have modified this
		// file before and then simply skip these checks.
		if (fileContent.includes(modifiedComment)) continue;

		logger.debug(`Modifying ${filePath}`);

		const ast = parseFileAst(fileContent, filePath, (node, { sourceFile }) => {
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
		let lines = modified.split("\n");

		/**
		 * The place where comments can safely be inserted without breaking the shebang
		 */
		let scriptStart = 0;
		if (lines.length > 0) {
			const firstLine = lines[0];
			if (firstLine.startsWith("#!")) {
				scriptStart = 1;
			}
		}

		// Add a the modified tag so that this file won't be modified again in the future.
		lines.splice(scriptStart, 0, modifiedComment);

		// Add ts-nocheck to suppress type errors for vendored files
		const castAst = /** @type {typeof ast & {scriptKind: ts.ScriptKind}} */ (ast);
		const tsNocheckScriptKinds = [
			ts.ScriptKind.JS,
			ts.ScriptKind.JSX,
			ts.ScriptKind.TS,
			ts.ScriptKind.TSX,
		];
		if (tsNocheckScriptKinds.includes(castAst.scriptKind)) {
			lines.splice(scriptStart, 0, "// @ts-nocheck");
			// Adding a ts-nocheck comment does not seem to be enough to suppress
			// errors from missing tripple slash directive files. So we'll remove these.
			lines = lines.filter((line) => !line.startsWith("/// <reference"));
		}

		modified = lines.join("\n");
		await Deno.writeTextFile(filePath, modified);
	}

	return collectedDtsFiles;
}
