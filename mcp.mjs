// Resolve the TypeScript loader relative to this checkout, not the caller's cwd.
import "tsx/esm"
await import("./src/standalone/stdio.ts")
