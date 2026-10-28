import { Command, MenuItem, Panel, Plugin, Style, type PanelTab } from "@opencode/plugin/gui"
import { DiagramPanel } from "./gui/panel.js"
import { diagramStyle } from "./gui/style.js"

export default Plugin.define({
  setup(ctx) {
    const tab: PanelTab = { id: "main", title: "Diagram" }
    const key = `${ctx.id}:main`
    const open = () => {
      const session = ctx.sessions.current()
      if (session && ctx.screen.current()) ctx.layout.open(key, session)
    }
    ctx.add(Style, diagramStyle)
    ctx.add(Command, { id: "open-diagram", title: "Open Diagram", group: "Diagram", get enabled() { return !!ctx.sessions.current() }, run: open })
    ctx.add(MenuItem, { id: "open-diagram", menu: "session.panel", title: "Diagram", get opened() {
      const session = ctx.sessions.current()
      return !!session && ctx.layout.state(key, session) !== "closed"
    }, run: open })
    ctx.add(Panel, { id: "main", region: "side", list: (input) => input.open.includes("main") ? [tab] : [],
      render: (props) => <DiagramPanel ctx={ctx} panel={props} /> })
  },
})
