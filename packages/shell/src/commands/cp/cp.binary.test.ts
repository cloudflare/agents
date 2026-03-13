import { describe, expect, it } from "vitest";
import { Bash } from "../../Shell";

describe("cp with binary files", () => {
  it("should copy binary file preserving content", async () => {
    const data = new Uint8Array([0x00, 0xff, 0x00, 0xff, 0x7f]);
    const env = new Bash({
      files: { "/src.bin": data }
    });

    await env.exec("cp /src.bin /dst.bin");

    // Check the copied file's raw bytes via the fs directly
    // (cat returns string which can't faithfully represent 0xff bytes)
    const copiedContent = await env.fs.readFileBuffer("/dst.bin");
    expect(copiedContent.length).toBe(5);
    expect(copiedContent[0]).toBe(0x00);
    expect(copiedContent[1]).toBe(0xff);
    expect(copiedContent[2]).toBe(0x00);
    expect(copiedContent[3]).toBe(0xff);
    expect(copiedContent[4]).toBe(0x7f);
  });
});
