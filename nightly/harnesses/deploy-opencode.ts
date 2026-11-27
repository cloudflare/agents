import type { TestProject } from "vitest/node";
import { setup } from "./deploy";

export default (project: TestProject) => setup(project, "nightly-opencode");
