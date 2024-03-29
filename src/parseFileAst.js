import ts from "npm:typescript@4.7.4";
import * as path from "https://deno.land/std@0.145.0/path/mod.ts";

/**
 * @typedef ParseFileAstExtra
 * @property {ts.SourceFile} sourceFile
 */

/**
 * Reads a file, parses its ast and traverses it.
 * @param {string} filePath
 * @param {(node: ts.Node, extra: ParseFileAstExtra) => void} [cbNode] The
 * callback that is called for each node in the ast.
 */
export async function parseFilePathAst(filePath, cbNode) {
	const fileContent = await Deno.readTextFile(filePath);
	return parseFileAst(fileContent, filePath, cbNode);
}

/**
 * Reads a file, parses its ast and traverses it.
 * @param {string} fileContent
 * @param {string} filePath
 * @param {(node: ts.Node, extra: ParseFileAstExtra) => void} [cbNode] The
 * callback that is called for each node in the ast.
 */
export function parseFileAst(fileContent, filePath, cbNode) {
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
			// Normalizing is required to make the two paths match on Windows.
			if (path.normalize(fileName) === filePath) {
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
