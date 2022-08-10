import ts from "https://esm.sh/typescript@4.7.4?pin=v87";

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
export async function parseFileAst(filePath, cbNode) {
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
