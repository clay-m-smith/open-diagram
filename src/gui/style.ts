export const diagramStyle = `
.open-diagram-gui { display:flex; flex-direction:column; height:100%; min-height:0; gap:10px; padding:12px; color:inherit; font:inherit; }
.open-diagram-gui .od-tools { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
.open-diagram-gui .od-history { display:flex; align-items:center; gap:6px; overflow-x:auto; flex-shrink:0; padding-bottom:4px; }
.open-diagram-gui .od-history button { flex-shrink:0; max-width:240px; text-align:left; }
.open-diagram-gui .od-history small { display:block; font-size:10px; opacity:.75; }
.open-diagram-gui button,.open-diagram-gui select { font:inherit; color:inherit; background:transparent; border:1px solid color-mix(in srgb,currentColor 30%,transparent); border-radius:5px; padding:4px 8px; }
.open-diagram-gui select,.open-diagram-gui option { color:CanvasText; background-color:Canvas; }
.open-diagram-gui button { cursor:pointer; }
.open-diagram-gui button:disabled { opacity:.5; cursor:default; }
.open-diagram-gui button[aria-pressed=true] { border-color:currentColor; font-weight:600; }
.open-diagram-gui .od-status { font-size:12px; overflow-wrap:anywhere; }
.open-diagram-gui .od-viewport { flex:1; min-height:120px; overflow:auto; border:1px solid color-mix(in srgb,currentColor 20%,transparent); }
.open-diagram-gui img { display:block; max-width:none; }
.open-diagram-gui .od-inspector { max-height:35%; overflow:auto; overflow-wrap:anywhere; }
.open-diagram-gui h3,.open-diagram-gui p { margin:4px 0; }
`
