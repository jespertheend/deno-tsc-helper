import * as path from "https://deno.land/std@0.119.0/path/mod.ts";
import { generateTypes } from "../mod.js";

/**
 * @typedef {Omit<import("npm:typescript@4.7.4").CompilerOptions, "target"> & {target?: string}} CompilerOptions
 */

/**
 * @typedef Jsconfig
 * @property {CompilerOptions} [compilerOptions]
 * @property {string[]} [include]
 * @property {string} [extends]
 */

/**
 * Creates a temporary directory, runs `generateTypes` in it with the specified options,
 * and finally type checks the project using the specified jsconfig.json.
 * @param {Object} options
 * @param {Object.<string, string>} [options.files] A map of files to create where keys are their relative path and value their content.
 * @param {import("../mod.js").GenerateTypesOptions} [options.options]
 * @param {Jsconfig} [options.jsconfig] When set, will be stringified and placed in a jsconfig.json file.
 */
export async function basicTest({
	files = {},
	options = {},
	jsconfig = getBasicJsconfig(),
} = {}) {
	const originalCwd = Deno.cwd();
	const dirPath = await Deno.makeTempDir();
	try {
		files["jsconfig.json"] = JSON.stringify(jsconfig);
		const promises = [];
		for (const [fileName, fileContent] of Object.entries(files)) {
			const filePath = path.resolve(dirPath, fileName);
			const promise = (async () => {
				await Deno.mkdir(path.dirname(filePath), { recursive: true });
				await Deno.writeTextFile(filePath, fileContent);
			})();
			promises.push(promise);
		}
		await Promise.all(promises);

		Deno.chdir(dirPath);

		await generateTypes(options);

		const proc = Deno.run({
			cmd: [
				"deno",
				"run",
				"--allow-env",
				"--allow-read",
				"npm:typescript@4.8.3/tsc",
				"--noEmit",
				"-p",
				"./jsconfig.json",
			],
			stdout: "piped",
		});
		try {
			const status = await proc.status();
			if (!status.success) {
				const stdout = new TextDecoder().decode(await proc.output());
				throw new Error("tsc typecheck failed\n" + stdout);
			} else {
				proc.stdout.close();
			}
		} finally {
			proc.close();
		}
	} finally {
		Deno.chdir(originalCwd); // https://github.com/denoland/deno/issues/15849
		await Deno.remove(dirPath, { recursive: true });
	}
}

function getBasicJsconfig() {
	/** @type {Jsconfig} */
	const jsconfig = {
		extends: "./.denoTypes/tsconfig.json",
		compilerOptions: {
			lib: ["dom", "dom.iterable", "esnext"],
			target: "esnext",
			checkJs: true,
			module: "esnext",
			useDefineForClassFields: true,
			strict: true,
			exactOptionalPropertyTypes: true,
		},
	};
	return jsconfig;
}

/**
 * Creates javascript code that does a typecheck assertion to verify that the type of a variable isn't `any`.
 */
function createNotAny() {
	return `
	/**
	 * @template T
	 * @typedef {unknown extends T ? T extends {} ? T : never : never} IsAny
	 */

	/**
	 * @template T
	 * @typedef {T extends IsAny<T> ? never : T} NotAny
	 */

	/**
	 * @template T
	 * @param {NotAny<T>} x
	 */
	function notAny(x) {}
	`;
}

Deno.test({
	name: "Basic type generation",
	async fn() {
		await basicTest({
			files: {
				"foo.js": `
					import * as path from "https://deno.land/std@0.119.0/path/mod.ts";

					${createNotAny()}
					notAny(path.resolve);
				`,
			},
		});
	},
});

Deno.test({
	name: "Dynamic import",
	async fn() {
		await basicTest({
			files: {
				"foo.js": `
					const mod = await import("https://deno.land/std@0.119.0/path/mod.ts");

					${createNotAny()}
					notAny(mod.resolve);

					export {}
				`,
			},
		});
	},
});
