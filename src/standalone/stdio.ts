import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio"
import { createDiagramMcpServer } from "./server.js"

// No network listener, credentials, global configuration, or stdout diagnostics.
const handle = serveStdio(createDiagramMcpServer, {
  transport: new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 1024 * 1024 }),
  onerror: () => { console.error("Open Diagram MCP transport error.") },
})
process.once("SIGINT", () => { void handle.close() })
process.once("SIGTERM", () => { void handle.close() })
