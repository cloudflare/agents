import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("sleep command", () => {
  describe("basic functionality", () => {
    it("should sleep for specified seconds", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 2");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(2000);
    });

    it("should handle decimal seconds", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 0.5");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(500);
    });
  });

  describe("duration suffixes", () => {
    it("should handle seconds suffix", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 3s");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(3000);
    });

    it("should handle minutes suffix", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 2m");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(120000);
    });

    it("should handle hours suffix", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 1h");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(3600000);
    });

    it("should handle days suffix", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 1d");
      expect(result.exitCode).toBe(0);
      // Capped to MAX_SLEEP_MS (1 hour) to prevent DoS
      expect(sleptMs).toBe(3600000);
    });

    it("should handle decimal values with suffix", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 0.5m");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(30000);
    });
  });

  describe("multiple arguments", () => {
    it("should sum multiple durations", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 1 2 3");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(6000); // 1+2+3 = 6 seconds
    });

    it("should sum durations with mixed suffixes", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 1s 1m");
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(61000); // 1s + 60s = 61s
    });
  });

  describe("error handling", () => {
    it("should error on missing operand", async () => {
      const env = new Bash({ sleep: async () => {} });

      const result = await env.exec("sleep");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("missing operand");
    });

    it("should error on invalid time interval", async () => {
      const env = new Bash({ sleep: async () => {} });

      const result = await env.exec("sleep abc");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid time interval");
    });

    it("should error on invalid suffix", async () => {
      const env = new Bash({ sleep: async () => {} });

      const result = await env.exec("sleep 1x");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("invalid time interval");
    });
  });

  describe("help", () => {
    it("should show help with --help", async () => {
      const env = new Bash({ sleep: async () => {} });

      const result = await env.exec("sleep --help");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("sleep");
      expect(result.stdout).toContain("delay");
    });
  });

  describe("short duration sleep", () => {
    it("should handle very short sleep durations", async () => {
      let sleptMs = 0;
      const env = new Bash({
        sleep: async (ms) => {
          sleptMs = ms;
        }
      });

      const result = await env.exec("sleep 0.01"); // 10ms
      expect(result.exitCode).toBe(0);
      expect(sleptMs).toBe(10);
    });
  });
});
