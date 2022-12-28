The purpose of this module is to fetch Deno types so that you can perform type checking with tools other than Deno
itself, such as tsc.

## Pros

- Choose which version of tsc to use, rather than being stuck with the one included with Deno.
- You can use the existing type checking available in your IDE, without the need for a Deno plugin.
- The 'project diagnostics' setting in VSCode works within your project.
- Uses well established configuration that already exists in Deno, such as import maps and npm specifiers. So you can
  always

## Cons

- This has only been tested with .js files for now. Tsc doesn't allow importing paths ending with `.ts`, so using this
  with .ts files will likely not work. That said, the TypeScript team is actively working on module resolution
  improvements, so this tool might become useful for .ts files as well in the future.

## Usage

This is not a command line tool, you are expected to configure things in a JavaScript file and then run it. For a very
basic setup, something like the following should be enough:

```js
import { generateTypes } from "https://deno.land/x/deno_tsc_helper/mod.js";
await generateTypes({
	include: [
		"./main.js",
		"./src/",
	],
});
```

Normally you would start a http server or run other processes required for development in this script. When the script
is run, a `.denoTypes` folder is created in the cwd containing all the required type files in order to make to make type
checking succeed.

The only thing that's left to do now is to hook up the generated `tsconfig.json` to yours using the `extends` property:

```json
{
	"extends": "./.denoTypes/tsconfig.json",
	...
}
```

And that's it! Now every time the script is run, it checks if any modifications have been made to any imports you have,
and if so, its types will be downloaded. If none of the imports have changed this check is generally pretty fast.
