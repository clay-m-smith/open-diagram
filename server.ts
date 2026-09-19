import { defineDiagramPlugin } from "./src/diagram/server.js"

// Backends are explicit plugin options; installing never selects a paid model.
export default defineDiagramPlugin({})
