import { describe, expect, it } from "vitest";
import * as skills from "../skills";

type FakeObject = {
  key: string;
  content: string;
  etag?: string;
  uploaded?: Date;
};

type FakeBucket = R2Bucket & {
  getCalls: string[];
  setObjects(objects: FakeObject[]): void;
};

function fakeBucket(initialObjects: FakeObject[]): FakeBucket {
  let objects = initialObjects;
  let byKey = new Map(objects.map((object) => [object.key, object]));
  const getCalls: string[] = [];

  return {
    getCalls,
    setObjects(nextObjects: FakeObject[]) {
      objects = nextObjects;
      byKey = new Map(objects.map((object) => [object.key, object]));
    },
    async list(options?: R2ListOptions) {
      const prefix = options?.prefix ?? "";
      const listed = objects
        .filter((object) => object.key.startsWith(prefix))
        .map((object) => ({
          key: object.key,
          size: object.content.length,
          etag: object.etag ?? object.content,
          uploaded: object.uploaded ?? new Date("2026-01-01T00:00:00.000Z")
        }));

      return {
        objects: listed,
        truncated: false,
        delimitedPrefixes: []
      } as unknown as R2Objects;
    },
    async get(key: string) {
      getCalls.push(key);
      const object = byKey.get(key);
      if (!object) return null;

      return {
        key: object.key,
        size: object.content.length,
        etag: object.etag ?? object.content,
        uploaded: object.uploaded ?? new Date("2026-01-01T00:00:00.000Z"),
        text: async () => object.content,
        arrayBuffer: async () => new TextEncoder().encode(object.content).buffer
      } as unknown as R2ObjectBody;
    }
  } as unknown as FakeBucket;
}

const bucket = fakeBucket([
  {
    key: "skills/code-review/SKILL.md",
    etag: "skill-1",
    content: `---
name: code-review
description: Review code carefully.
allowed-tools: Read Bash(git:*)
---
# Code Review
Check correctness first.
`
  },
  {
    key: "skills/code-review/references/checklist.md",
    etag: "resource-1",
    content: "Review checklist"
  },
  {
    key: "skills/code-review/scripts/review.ts",
    etag: "resource-2",
    content: "export default function review() {}"
  },
  {
    key: "skills/code-review/assets/logo.png",
    etag: "resource-3",
    content: "hello"
  },
  {
    key: "skills/code-review/../input.json",
    etag: "unsafe",
    content: "unsafe"
  },
  {
    key: "skills/debug-plan/SKILL.md",
    etag: "skill-2",
    content: `---
name: debug-plan
description: Make a debugging plan.
metadata:
  owner: support
---
# Debug Plan
Reproduce, isolate, fix.
`
  },
  {
    key: "other/ignored/SKILL.md",
    etag: "ignored",
    content: `---
name: ignored
description: Ignored by prefix.
---
Ignored.
`
  }
]);

describe("R2 Think skills", () => {
  it("lists Agent Skills directories from R2", async () => {
    const source = skills.r2(bucket, { prefix: "skills/" });

    await expect(source.list()).resolves.toMatchObject([
      {
        name: "code-review",
        description: "Review code carefully.",
        allowedTools: "Read Bash(git:*)"
      },
      {
        name: "debug-plan",
        description: "Make a debugging plan.",
        metadata: { owner: "support" }
      }
    ]);
    expect(bucket.getCalls).toEqual([
      "skills/code-review/SKILL.md",
      "skills/debug-plan/SKILL.md"
    ]);
  });

  it("loads SKILL.md content and resource descriptors", async () => {
    const source = skills.r2(bucket, { prefix: "skills/" });

    await expect(source.load("code-review")).resolves.toMatchObject({
      name: "code-review",
      body: "# Code Review\nCheck correctness first.\n",
      resources: [
        {
          path: "assets/logo.png",
          kind: "asset",
          encoding: "base64",
          mimeType: "image/png",
          size: "hello".length
        },
        {
          path: "references/checklist.md",
          kind: "reference",
          size: "Review checklist".length
        },
        {
          path: "scripts/review.ts",
          kind: "script",
          size: "export default function review() {}".length
        }
      ]
    });
  });

  it("reads resources by skill name and relative path", async () => {
    const source = skills.r2(bucket, { prefix: "skills/" });
    bucket.getCalls.length = 0;

    await expect(
      source.readResource?.("code-review", "references/checklist.md")
    ).resolves.toMatchObject({
      path: "references/checklist.md",
      kind: "reference",
      content: "Review checklist"
    });
    expect(bucket.getCalls).toContain(
      "skills/code-review/references/checklist.md"
    );

    await expect(
      source.readResource?.("code-review", "missing.md")
    ).resolves.toBeNull();
  });

  it("reads binary resources as base64", async () => {
    const source = skills.r2(bucket, { prefix: "skills/" });

    await expect(
      source.readResource?.("code-review", "assets/logo.png")
    ).resolves.toMatchObject({
      path: "assets/logo.png",
      kind: "asset",
      encoding: "base64",
      mimeType: "image/png",
      content: "aGVsbG8="
    });
    await expect(
      source.readResource?.("code-review", "../input.json")
    ).resolves.toBeNull();
  });

  it("filters skills by parsed skill name", async () => {
    const source = skills.r2(bucket, {
      prefix: "skills/",
      skills: ["debug-plan"]
    });

    await expect(source.list()).resolves.toMatchObject([
      {
        name: "debug-plan",
        description: "Make a debugging plan."
      }
    ]);
    await expect(source.load("code-review")).resolves.toBeNull();
  });

  it("updates fingerprints after indexing R2 metadata", async () => {
    const first = skills.r2(bucket, { prefix: "skills/" });
    const beforeLoad = first.fingerprint;

    await first.list();

    expect(first.fingerprint).not.toBe(beforeLoad);

    const changed = skills.r2(
      fakeBucket([
        {
          key: "skills/code-review/SKILL.md",
          etag: "changed",
          content: `---
name: code-review
description: Review code carefully.
---
# Code Review
Check correctness first.
`
        }
      ]),
      { prefix: "skills/" }
    );

    await changed.list();

    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("refreshes mutable R2 indexes after the refresh interval", async () => {
    const mutableBucket = fakeBucket([
      {
        key: "skills/code-review/SKILL.md",
        etag: "before",
        content: `---
name: code-review
description: Review code carefully.
---
Before.
`
      }
    ]);
    const source = skills.r2(mutableBucket, {
      prefix: "skills/",
      refreshIntervalMs: 0
    });

    await source.list();
    const before = source.fingerprint;

    mutableBucket.setObjects([
      {
        key: "skills/code-review/SKILL.md",
        etag: "after",
        content: `---
name: code-review
description: Review code after updates.
---
After.
`
      }
    ]);

    await expect(source.list()).resolves.toMatchObject([
      {
        name: "code-review",
        description: "Review code after updates."
      }
    ]);
    expect(source.fingerprint).not.toBe(before);
  });

  it("can fingerprint resource contents when requested", async () => {
    const first = skills.r2(bucket, {
      prefix: "skills/",
      fingerprint: "content"
    });
    const changedContent = skills.r2(
      fakeBucket([
        {
          key: "skills/code-review/SKILL.md",
          etag: "same-etag",
          content: `---
name: code-review
description: Review code carefully.
---
Different instructions.
`
        }
      ]),
      { prefix: "skills/", fingerprint: "content" }
    );

    await first.list();
    await changedContent.list();

    expect(changedContent.fingerprint).not.toBe(first.fingerprint);
  });

  it("fingerprints binary resource contents when requested", async () => {
    const first = skills.r2(bucket, {
      prefix: "skills/",
      fingerprint: "content"
    });
    const changedContent = skills.r2(
      fakeBucket([
        {
          key: "skills/code-review/SKILL.md",
          etag: "skill-1",
          content: `---
name: code-review
description: Review code carefully.
---
# Code Review
Check correctness first.
`
        },
        {
          key: "skills/code-review/assets/logo.png",
          etag: "resource-3",
          content: "different"
        }
      ]),
      { prefix: "skills/", fingerprint: "content" }
    );

    await first.list();
    await changedContent.list();

    expect(changedContent.fingerprint).not.toBe(first.fingerprint);
  });
});
