// Print the PXPIPE_TREE_SHA256 value for an extracted pxpipe-proxy package dir.
// Usage: node scripts/pxpipe-tree-hash.mjs <path/to/package>
import { treeHash } from "../src/lib/pxpipe/pin.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/pxpipe-tree-hash.mjs <package dir>");
  process.exit(1);
}
console.log(treeHash(dir));
