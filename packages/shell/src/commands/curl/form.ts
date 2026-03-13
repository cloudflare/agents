/**
 * Form data handling for curl command
 */

import type { FormField } from "./types";

/**
 * URL-encode form data in curl's --data-urlencode format
 * Supports: name=content, =content, name@file, @file
 */
export function encodeFormData(input: string): string {
  // Check for name=value format
  const eqIndex = input.indexOf("=");
  if (eqIndex >= 0) {
    const name = input.slice(0, eqIndex);
    const value = input.slice(eqIndex + 1);
    if (name) {
      return `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;
    }
    return encodeURIComponent(value);
  }
  // Plain value
  return encodeURIComponent(input);
}

/**
 * Parse -F/--form field specification
 * Supports: name=value, name=@file, name=<file, name=value;type=mime
 */
export function parseFormField(spec: string): FormField | null {
  const eqIndex = spec.indexOf("=");
  if (eqIndex < 0) return null;

  const name = spec.slice(0, eqIndex);
  let value = spec.slice(eqIndex + 1);
  let filename: string | undefined;
  let contentType: string | undefined;

  // Check for ;type= suffix
  const typeMatch = value.match(/;type=([^;]+)$/);
  if (typeMatch) {
    contentType = typeMatch[1];
    value = value.slice(0, -typeMatch[0].length);
  }

  // Check for ;filename= suffix
  const filenameMatch = value.match(/;filename=([^;]+)/);
  if (filenameMatch) {
    filename = filenameMatch[1];
    value = value.replace(filenameMatch[0], "");
  }

  // @ means file upload, < means file content
  if (value.startsWith("@") || value.startsWith("<")) {
    filename = filename ?? value.slice(1).split("/").pop();
    // Value will be replaced with file content in execute
  }

  return { name, value, filename, contentType };
}

/**
 * Generate multipart form data body and boundary
 */
export function generateMultipartBody(
  fields: FormField[],
  fileContents: Map<string, string>
): { body: string; boundary: string } {
  const boundary = `----CurlFormBoundary${Date.now().toString(36)}`;
  const parts: string[] = [];

  for (const field of fields) {
    let value = field.value;

    // Replace file references with content
    if (value.startsWith("@") || value.startsWith("<")) {
      const filePath = value.slice(1);
      value = fileContents.get(filePath) ?? "";
    }

    let part = `--${boundary}\r\n`;
    if (field.filename) {
      part += `Content-Disposition: form-data; name="${field.name}"; filename="${field.filename}"\r\n`;
      if (field.contentType) {
        part += `Content-Type: ${field.contentType}\r\n`;
      }
    } else {
      part += `Content-Disposition: form-data; name="${field.name}"\r\n`;
    }
    part += `\r\n${value}\r\n`;
    parts.push(part);
  }

  parts.push(`--${boundary}--\r\n`);
  return { body: parts.join(""), boundary };
}
