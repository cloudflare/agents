/**
 * Unit tests for AgentWorkflow prototype wrapping behavior.
 *
 * These tests verify the prototype-based run() method wrapping logic works correctly.
 * Since AgentWorkflow extends WorkflowEntrypoint which requires a Cloudflare ExecutionContext,
 * we test the static prototype relationships and the wrapping mechanism indirectly
 * through the integration tests.
 */
import { describe, expect, it } from "vitest";
import { AgentWorkflow } from "../workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "../workflows";

describe("AgentWorkflow prototype wrapping", () => {
  describe("static prototype analysis", () => {
    it("should define run method on subclass prototype when declared", () => {
      // Create a test class - don't instantiate
      class TestWorkflowWithRun extends AgentWorkflow {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { success: true };
        }
      }

      // Before instantiation, the prototype should have its own run
      expect(Object.hasOwn(TestWorkflowWithRun.prototype, "run")).toBe(true);
      expect(typeof TestWorkflowWithRun.prototype.run).toBe("function");
    });

    it("should not have own run on subclass that inherits", () => {
      class ParentWorkflow extends AgentWorkflow {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { from: "parent" };
        }
      }

      class ChildWorkflow extends ParentWorkflow {
        // No run override - inherits from parent
      }

      // Parent has own run
      expect(Object.hasOwn(ParentWorkflow.prototype, "run")).toBe(true);

      // Child does NOT have own run (inherits via prototype chain)
      expect(Object.hasOwn(ChildWorkflow.prototype, "run")).toBe(false);

      // But child can access run via inheritance
      expect(ChildWorkflow.prototype.run).toBe(ParentWorkflow.prototype.run);
    });

    it("should have separate run methods when child overrides", () => {
      class ParentWorkflow2 extends AgentWorkflow {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { from: "parent" };
        }
      }

      class ChildWorkflow2 extends ParentWorkflow2 {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { from: "child" };
        }
      }

      // Both have their own run
      expect(Object.hasOwn(ParentWorkflow2.prototype, "run")).toBe(true);
      expect(Object.hasOwn(ChildWorkflow2.prototype, "run")).toBe(true);

      // They should be different functions
      expect(ParentWorkflow2.prototype.run).not.toBe(
        ChildWorkflow2.prototype.run
      );
    });

    it("should have correct prototype chain", () => {
      class MyWorkflow extends AgentWorkflow {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { success: true };
        }
      }

      // Check prototype chain
      const myWorkflowProto = MyWorkflow.prototype;
      const agentWorkflowProto = Object.getPrototypeOf(myWorkflowProto);

      expect(agentWorkflowProto).toBe(AgentWorkflow.prototype);
    });
  });

  describe("AgentWorkflow base class", () => {
    it("should not have own run method on base class", () => {
      // AgentWorkflow itself should not define run - subclasses do
      expect(Object.hasOwn(AgentWorkflow.prototype, "run")).toBe(false);
    });

    it("should have required private methods", () => {
      // Check that the class has the methods that will be used in wrapping
      // These are defined on AgentWorkflow.prototype
      expect(typeof AgentWorkflow.prototype).toBe("object");

      // The _initAgent and _wrapStep methods should be accessible
      // (they're private but exist on the prototype)
      const proto = AgentWorkflow.prototype;
      expect(Object.hasOwn(proto, "_initAgent")).toBe(true);
      expect(Object.hasOwn(proto, "_wrapStep")).toBe(true);
    });
  });

  describe("error auto-reporting", () => {
    it("should have _autoReportError method on prototype", () => {
      expect(Object.hasOwn(AgentWorkflow.prototype, "_autoReportError")).toBe(
        true
      );
      const proto = AgentWorkflow.prototype as unknown as Record<
        string,
        unknown
      >;
      expect(typeof proto["_autoReportError"]).toBe("function");
    });
  });

  describe("multi-level inheritance", () => {
    it("should maintain correct hasOwn for deep inheritance", () => {
      class Level1 extends AgentWorkflow {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { level: 1 };
        }
      }

      class Level2 extends Level1 {
        // No override - inherits from Level1
      }

      class Level3 extends Level2 {
        // No override - inherits from Level1 via Level2
      }

      // Only Level1 has own run
      expect(Object.hasOwn(Level1.prototype, "run")).toBe(true);
      expect(Object.hasOwn(Level2.prototype, "run")).toBe(false);
      expect(Object.hasOwn(Level3.prototype, "run")).toBe(false);

      // All share the same run reference
      expect(Level2.prototype.run).toBe(Level1.prototype.run);
      expect(Level3.prototype.run).toBe(Level1.prototype.run);
    });

    it("should handle mixed inheritance with overrides", () => {
      class Base extends AgentWorkflow {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { level: "base" };
        }
      }

      class Middle extends Base {
        // No override
      }

      class Top extends Middle {
        async run(
          _event: AgentWorkflowEvent<unknown>,
          _step: AgentWorkflowStep
        ) {
          return { level: "top" };
        }
      }

      // Base and Top have own run, Middle does not
      expect(Object.hasOwn(Base.prototype, "run")).toBe(true);
      expect(Object.hasOwn(Middle.prototype, "run")).toBe(false);
      expect(Object.hasOwn(Top.prototype, "run")).toBe(true);

      // Middle inherits from Base
      expect(Middle.prototype.run).toBe(Base.prototype.run);

      // Top has its own
      expect(Top.prototype.run).not.toBe(Base.prototype.run);
    });
  });
});
