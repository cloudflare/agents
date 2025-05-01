export async function createResponsePayload(response: Response) {
  let body: string | undefined;

  // Check if the response has a body and read it
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    body = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // Decode the value and append it to the body
      // Use the decoder to convert the Uint8Array to a string
      // and append it to the body
      body += decoder.decode(value, { stream: true });
    }
  }

  // Create the payload object
  return {
    status: response.status,
    statusText: response.statusText,
    headers: headersToObject(response.headers),
    body,
  };
}

export async function createRequestPayload(
  request: Request<unknown, CfProperties<unknown>>
) {
  let body: string | undefined;

  // Check if the response has a body and read it
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8");
    body = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // Decode the value and append it to the body
      // Use the decoder to convert the Uint8Array to a string
      // and append it to the body
      body += decoder.decode(value, { stream: true });
    }
  }

  // Create the payload object
  return {
    method: request.method,
    url: request.url,
    headers: headersToObject(request.headers),
    body,
  };
}

function headersToObject(headers: Headers) {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => {
    result[key] = value;
  });

  return result;
}
