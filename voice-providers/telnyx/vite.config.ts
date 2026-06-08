import { packageBuildTask } from "../../scripts/vite-task-cache";
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      "build:package": packageBuildTask
    }
  }
});
