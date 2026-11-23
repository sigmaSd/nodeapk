// Builds the shell's classes.dex into shell/ for the npm package (run by `prepack`), with the key of the
// sources it came from (shell/classes.dex.key): `nodeapk build` then uses it as is, and users need no Kotlin
// compiler. Both files are build output, not in git.

import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureShellDex, shellKey } from "../src/android/kotlin.ts";
import { ensureSdk } from "../src/android/sdk.ts";

const shell = join(import.meta.dirname, "..", "shell");
const { key } = await shellKey(shell);
const dex = await ensureShellDex(await ensureSdk(), shell);
if (dex !== join(shell, "classes.dex")) await copyFile(dex, join(shell, "classes.dex"));
await writeFile(join(shell, "classes.dex.key"), `${key}\n`);
console.log(`shell/classes.dex (${key})`);
