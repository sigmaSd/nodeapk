// Imported first by every test: data goes to node_modules/.cache, never to real folders or /tmp.
import { join } from "node:path";

process.env.NODEAPK_DATA = join(
  import.meta.dirname,
  "..",
  "node_modules",
  ".cache",
  "nodeapk-tests",
  `data-${process.env.VITEST_POOL_ID ?? 0}`,
);
