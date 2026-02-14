import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";
import { defineConfig } from "vite";

const useCompiler = process.env.REACT_COMPILER === "true";

console.log(
  `\n  React Compiler: ${useCompiler ? "ON" : "OFF"}\n  Run "npm start" for compiler ON, "npm run start:no-compiler" for OFF\n`
);

export default defineConfig({
  plugins: [
    react({
      babel: {
        plugins: useCompiler ? ["babel-plugin-react-compiler"] : []
      }
    }),
    {
      name: "dump-transform",
      transform(code, id) {
        if (id.includes("client.tsx")) {
          const filename = useCompiler
            ? "compiled-output.js"
            : "uncompiled-output.js";
          writeFileSync(filename, code);
          console.log(`  Wrote transformed source to ${filename}`);
        }
      }
    }
  ],
  define: {
    "import.meta.env.REACT_COMPILER": JSON.stringify(useCompiler)
  }
});
