// The QuickJS engine binary, imported as a pre-compiled WebAssembly.Module (wrangler CompiledWasm rule).
declare module "*/emscripten-module.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
