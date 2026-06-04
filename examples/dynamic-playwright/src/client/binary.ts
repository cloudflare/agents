type BinaryValue = {
  __dynamic_puppeteer_binary_v1__?: "Uint8Array";
  __dynamic_playwright_binary_v1__?: "Uint8Array";
  data: string;
};

export function isBinaryValue(value: unknown): value is BinaryValue {
  return (
    !!value &&
    typeof value === "object" &&
    ((value as Record<string, unknown>).__dynamic_puppeteer_binary_v1__ ===
      "Uint8Array" ||
      (value as Record<string, unknown>).__dynamic_playwright_binary_v1__ ===
        "Uint8Array") &&
    typeof (value as Record<string, unknown>).data === "string"
  );
}

export function binaryToObjectUrl(value: BinaryValue): string {
  const binary = atob(value.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
}
