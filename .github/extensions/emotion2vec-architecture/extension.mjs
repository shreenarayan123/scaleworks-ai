import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const diagramPath = path.join(extensionDir, "architecture.excalidraw");
const instances = new Map();

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const html = (diagram) => {
  const json = escapeHtml(JSON.stringify(diagram, null, 2));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>emotion2vec architecture</title>
<style>
:root{font-family:ui-rounded,system-ui,sans-serif;color:#1f2937;background:#fffdf8}
body{margin:0;padding:24px}main{max-width:1280px;margin:auto}
h1{font-size:24px;margin:0 0 6px}p{margin:0 0 18px;color:#4b5563}
.toolbar{display:flex;gap:8px;align-items:center;margin-bottom:16px}
button{border:1px solid #9ca3af;border-radius:8px;background:white;padding:8px 12px;cursor:pointer}
button:hover,button:focus-visible{background:#f3f4f6;outline:2px solid #2563eb;outline-offset:2px}
#status{min-height:1.4em;color:#166534}.board{overflow:auto;border:1px solid #d6d3d1;border-radius:12px;background:#fffdf8}
svg{display:block;min-width:1200px;width:1200px;height:850px}
.node{stroke-width:2}.label{font-size:18px;font-weight:600;white-space:pre}
details{margin-top:16px}summary{cursor:pointer;font-weight:600}
textarea{box-sizing:border-box;width:100%;height:220px;font:12px ui-monospace,monospace}
</style>
</head>
<body><main>
<h1>emotion2vec Sales Call Analyzer</h1>
<p>Editable project architecture derived from the current frontend, backend, emotion service, integrations, and data model.</p>
<div class="toolbar"><button id="refresh" type="button">Reload diagram</button><button id="download" type="button">Download .excalidraw</button><span id="status" role="status" aria-live="polite"></span></div>
<div class="board" aria-label="Architecture diagram">${renderSvg(diagram)}</div>
<details><summary>Excalidraw JSON</summary><textarea aria-label="Excalidraw JSON">${json}</textarea></details>
</main>
<script>
const status = document.getElementById("status");
document.getElementById("refresh").onclick = async () => { status.textContent = "Reloading…"; location.reload(); };
document.getElementById("download").onclick = () => {
  const blob = new Blob([document.querySelector("textarea").value], {type:"application/json"});
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob);
  link.download = "emotion2vec-architecture.excalidraw"; link.click(); URL.revokeObjectURL(link.href);
  status.textContent = "Downloaded architecture.excalidraw";
};
</script>
</body></html>`;
};

const renderSvg = (diagram) => {
  const elements = diagram.elements.filter((element) => !element.isDeleted);
  const shapes = elements
    .filter((element) => element.type === "rectangle")
    .map(
      (element) =>
        `<rect class="node" x="${element.x}" y="${element.y}" width="${element.width}" height="${element.height}" rx="14" fill="${element.backgroundColor}" stroke="${element.strokeColor}"/>`,
    )
    .join("");
  const arrows = elements
    .filter((element) => element.type === "arrow")
    .map((element) => {
      const x2 = element.x + element.width;
      const y2 = element.y + element.height;
      return `<line x1="${element.x}" y1="${element.y}" x2="${x2}" y2="${y2}" stroke="${element.strokeColor}" stroke-width="2" marker-end="url(#arrow)"/>`;
    })
    .join("");
  const text = elements
    .filter((element) => element.type === "text")
    .map((element) => {
      const lines = escapeHtml(element.text).split("\n");
      return `<text class="label" x="${element.x}" y="${element.y + element.fontSize}">${lines
        .map((line, index) => `<tspan x="${element.x}" dy="${index === 0 ? 0 : element.fontSize * 1.25}">${line || " "}</tspan>`)
        .join("")}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 1225 850" role="img" aria-label="emotion2vec system architecture"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#374151"/></marker></defs>${arrows}${shapes}${text}</svg>`;
};

const readDiagram = async () => {
  try {
    const raw = await readFile(diagramPath, "utf8");
    const diagram = JSON.parse(raw);
    if (diagram.type !== "excalidraw" || !Array.isArray(diagram.elements)) {
      throw new Error("The architecture artifact is not a valid Excalidraw document.");
    }
    return diagram;
  } catch (error) {
    throw new CanvasError("diagram_read_failed", error instanceof Error ? error.message : String(error));
  }
};

const serverFor = async (instanceId) => {
  const diagram = await readDiagram();
  const server = createServer(async (request, response) => {
    if (request.url !== "/" || request.method !== "GET") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html(diagram));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise((resolve) => server.close(resolve));
    throw new CanvasError("server_bind_failed", "The architecture canvas could not bind to a local port.");
  }
  instances.set(instanceId, server);
  return `http://127.0.0.1:${address.port}/`;
};

const canvas = createCanvas({
  id: "emotion2vec-architecture",
  displayName: "emotion2vec Architecture",
  description: "Displays the editable Excalidraw architecture for the emotion2vec project.",
  inputSchema: {
    type: "object",
    properties: { workspaceRoot: { type: "string", minLength: 1 } },
    required: ["workspaceRoot"],
    additionalProperties: false,
  },
  actions: [
    {
      name: "reloadArchitecture",
      description: "Reload the versioned architecture.excalidraw artifact.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => {
        await readDiagram();
        return { reloaded: true, artifact: diagramPath };
      },
    },
  ],
  open: async ({ instanceId, input }) => {
    if (!input || typeof input !== "object" || typeof input.workspaceRoot !== "string" || input.workspaceRoot.length === 0) {
      throw new CanvasError("invalid_input", "workspaceRoot is required to open the architecture canvas.");
    }
    const existing = instances.get(instanceId);
    if (existing) await new Promise((resolve) => existing.close(resolve));
    return { url: await serverFor(instanceId), title: "emotion2vec Architecture" };
  },
  onClose: async ({ instanceId }) => {
    const server = instances.get(instanceId);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      instances.delete(instanceId);
    }
  },
});

await joinSession({ canvases: [canvas] });
