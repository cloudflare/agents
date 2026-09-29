import { afterEach, describe, expect, it, vi } from "vitest";
import { setupPlivoApplication } from "../src/setup.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function mockFetchSequence(responses: Array<Record<string, unknown>>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const fetchMock = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const spec = responses[Math.min(index++, responses.length - 1)];
    return Promise.resolve({
      ok: spec.ok ?? true,
      status: spec.status ?? 200,
      json: async () => spec.body ?? {}
    });
  };
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return calls;
}

const config = {
  authId: "MA123",
  authToken: "secret-token",
  phoneNumber: "+12025551234",
  answerUrl: "https://worker.example.com/answer"
};

describe("setupPlivoApplication", () => {
  it("updates an existing cloudflare-agents application", async () => {
    const calls = mockFetchSequence([
      {
        body: {
          objects: [
            { app_id: "a-1", app_name: "other-app", answer_url: "" },
            {
              app_id: "a-2",
              app_name: "cloudflare-agents-12025551234",
              answer_url: ""
            }
          ]
        }
      },
      { body: {} },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    expect(calls).toHaveLength(3);
    expect(calls[0].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/?limit=20&offset=0"
    );
    expect(calls[1].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/a-2/"
    );
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({
      answer_url: config.answerUrl,
      answer_method: "GET"
    });
  });

  it("pages past the first page using Plivo pagination metadata", async () => {
    // App lives on page 2 — must be found and updated, not duplicated.
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      app_id: `other-${index}`,
      app_name: `other-${index}`,
      answer_url: ""
    }));
    const calls = mockFetchSequence([
      {
        body: {
          objects: firstPage,
          meta: { limit: 20, offset: 0, total_count: 21 }
        }
      },
      {
        body: {
          objects: [
            {
              app_id: "a-2",
              app_name: "cloudflare-agents-12025551234",
              answer_url: ""
            }
          ],
          meta: { limit: 20, offset: 20, total_count: 21 }
        }
      },
      { body: {} },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    expect(calls[0].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/?limit=20&offset=0"
    );
    expect(calls[1].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/?limit=20&offset=20"
    );
    // Found on page 2 → update that app, no create.
    expect(calls[2].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/a-2/"
    );
    expect(calls[2].init?.method).toBe("POST");
  });

  it("falls back to page length when pagination metadata is absent", async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      app_id: `other-${index}`,
      app_name: `other-${index}`,
      answer_url: ""
    }));
    const calls = mockFetchSequence([
      { body: { objects: firstPage } },
      {
        body: {
          objects: [
            {
              app_id: "a-2",
              app_name: "cloudflare-agents-12025551234",
              answer_url: ""
            }
          ]
        }
      },
      { body: {} },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    expect(calls[1].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/?limit=20&offset=20"
    );
    expect(calls[2].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Application/a-2/"
    );
  });

  it("creates an application named for the full phone number", async () => {
    const calls = mockFetchSequence([
      {
        body: {
          objects: [{ app_id: "a-1", app_name: "other", answer_url: "" }]
        }
      },
      { body: { app_id: "new-app" } },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    expect(calls[1].init?.method).toBe("POST");
    const createBody = JSON.parse(calls[1].init?.body as string) as Record<
      string,
      unknown
    >;
    expect(createBody.app_name).toBe("cloudflare-agents-12025551234");
    expect(createBody.answer_url).toBe(config.answerUrl);
    const assignBody = JSON.parse(calls[2].init?.body as string) as Record<
      string,
      unknown
    >;
    expect(assignBody.app_id).toBe("new-app");
  });

  it("does not reuse the application of a different phone number", async () => {
    // An app exists, but for another number — matching by exact name (not the
    // shared prefix) must skip it and create this number's own app.
    const calls = mockFetchSequence([
      {
        body: {
          objects: [
            {
              app_id: "other-num",
              app_name: "cloudflare-agents-19998887777",
              answer_url: ""
            }
          ]
        }
      },
      { body: { app_id: "new-app" } },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    expect(calls[1].init?.method).toBe("POST");
    const createBody = JSON.parse(calls[1].init?.body as string) as Record<
      string,
      unknown
    >;
    expect(createBody.app_name).toBe("cloudflare-agents-12025551234");
  });

  it("assigns the number with the leading + stripped", async () => {
    const calls = mockFetchSequence([
      { body: { objects: [] } },
      { body: { app_id: "new-app" } },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    expect(calls[2].url).toBe(
      "https://api.plivo.com/v1/Account/MA123/Number/12025551234/"
    );
  });

  it("sends Basic auth on every request", async () => {
    const calls = mockFetchSequence([
      { body: { objects: [] } },
      { body: { app_id: "new-app" } },
      { body: {} }
    ]);

    await setupPlivoApplication(config);

    const expected = `Basic ${btoa("MA123:secret-token")}`;
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe(expected);
    }
  });

  it("throws when listing applications fails", async () => {
    mockFetchSequence([{ ok: false, status: 401 }]);
    await expect(setupPlivoApplication(config)).rejects.toThrow(
      /Failed to list applications: 401/
    );
  });

  it("throws when updating the application fails", async () => {
    mockFetchSequence([
      {
        body: {
          objects: [
            {
              app_id: "a-2",
              app_name: "cloudflare-agents-12025551234",
              answer_url: ""
            }
          ]
        }
      },
      { ok: false, status: 500 }
    ]);
    await expect(setupPlivoApplication(config)).rejects.toThrow(
      /Failed to update application: 500/
    );
  });

  it("throws when creating the application fails", async () => {
    mockFetchSequence([{ body: { objects: [] } }, { ok: false, status: 400 }]);
    await expect(setupPlivoApplication(config)).rejects.toThrow(
      /Failed to create application: 400/
    );
  });

  it("throws when assigning the phone number fails", async () => {
    mockFetchSequence([
      { body: { objects: [] } },
      { body: { app_id: "new-app" } },
      { ok: false, status: 404 }
    ]);
    await expect(setupPlivoApplication(config)).rejects.toThrow(
      /Failed to assign phone number: 404/
    );
  });
});
