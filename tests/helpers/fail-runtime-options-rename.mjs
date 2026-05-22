import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const marker = process.env.CLAUDE_TEST_FAIL_RENAME_BASENAME;
if (marker) {
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function renameSyncWithRuntimeOptionsFault(from, to) {
    if (String(to).endsWith(`/${marker}`) || String(to).endsWith(`\\${marker}`)) {
      const err = new Error(`injected rename failure for ${marker}`);
      err.code = "EACCES";
      throw err;
    }
    return originalRenameSync.call(this, from, to);
  };
  syncBuiltinESMExports();
}
