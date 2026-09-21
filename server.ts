import { defineDiagramPlugin } from "./src/diagram/server.js"
import { withNativeSessionCancellation } from "./src/diagram/native-session.js"

// Backends are explicit plugin options; installing never selects a paid model.
export default withNativeSessionCancellation(defineDiagramPlugin({}))
