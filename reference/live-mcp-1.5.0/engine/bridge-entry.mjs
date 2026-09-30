import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "OrbitFS", version: "1.0.0" }, {}, { autoResize: true });
window.__orbitfsApp = app;
window.__orbitfsCallTool = async (name, args = {}) => app.callServerTool({ name, arguments: args });
app.ontoolresult = (params) => {
  window.__orbitfsInitialToolResult = params;
  window.dispatchEvent(new CustomEvent("orbitfs:toolresult", { detail: params }));
};
app.connect().then(() => {
  window.__orbitfsConnected = true;
  window.dispatchEvent(new CustomEvent("orbitfs:connected"));
}).catch((error) => {
  window.__orbitfsBridgeError = String(error?.message || error);
  window.dispatchEvent(new CustomEvent("orbitfs:bridge-error", { detail: window.__orbitfsBridgeError }));
});