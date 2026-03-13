import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("timeout nested cancellation", () => {
  // NOTE: timeout + env cancellation is covered in
  // src/security/attacks/timeout-signal-propagation-gaps.test.ts

  it("cancels xargs subcommands and prevents late side effects", async () => {
    const bash = new Bash();

    const result = await bash.exec(`
      rm -f /tmp/timeout-nested-xargs-marker
      printf "item\\n" | timeout 0.01 xargs -I {} bash -c 'sleep 0.05; echo XARGS_LATE > /tmp/timeout-nested-xargs-marker'
      echo "TIMEOUT_EXIT=$?"
      if [ -f /tmp/timeout-nested-xargs-marker ]; then
        echo NOW_PRESENT
      else
        echo NOW_ABSENT
      fi
      sleep 0.15
      if [ -f /tmp/timeout-nested-xargs-marker ]; then
        echo LATE_PRESENT
      else
        echo LATE_ABSENT
      fi
    `);

    expect(result.stdout).toBe(
      ["TIMEOUT_EXIT=124", "NOW_ABSENT", "LATE_ABSENT", ""].join("\n")
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("cancels find -exec subcommands and prevents late side effects", async () => {
    const bash = new Bash();

    const result = await bash.exec(`
      rm -f /tmp/timeout-nested-find-marker
      mkdir -p /tmp/timeout-nested-find
      touch /tmp/timeout-nested-find/a.txt
      timeout 0.01 find /tmp/timeout-nested-find -type f -exec bash -c 'sleep 0.05; echo FIND_LATE > /tmp/timeout-nested-find-marker' \\;
      echo "TIMEOUT_EXIT=$?"
      if [ -f /tmp/timeout-nested-find-marker ]; then
        echo NOW_PRESENT
      else
        echo NOW_ABSENT
      fi
      sleep 0.15
      if [ -f /tmp/timeout-nested-find-marker ]; then
        echo LATE_PRESENT
      else
        echo LATE_ABSENT
      fi
    `);

    expect(result.stdout).toBe(
      ["TIMEOUT_EXIT=124", "NOW_ABSENT", "LATE_ABSENT", ""].join("\n")
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("cancels /usr/bin/time wrapped command and prevents late side effects", async () => {
    const bash = new Bash();

    const result = await bash.exec(`
      rm -f /tmp/timeout-nested-time-marker /tmp/timeout-nested-time.out
      timeout 0.01 /usr/bin/time -o /tmp/timeout-nested-time.out bash -c 'sleep 0.05; echo TIME_LATE > /tmp/timeout-nested-time-marker'
      echo "TIMEOUT_EXIT=$?"
      if [ -f /tmp/timeout-nested-time-marker ]; then
        echo NOW_PRESENT
      else
        echo NOW_ABSENT
      fi
      sleep 0.15
      if [ -f /tmp/timeout-nested-time-marker ]; then
        echo LATE_PRESENT
      else
        echo LATE_ABSENT
      fi
    `);

    expect(result.stdout).toBe(
      ["TIMEOUT_EXIT=124", "NOW_ABSENT", "LATE_ABSENT", ""].join("\n")
    );
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });
});
