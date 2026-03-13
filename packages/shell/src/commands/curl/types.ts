/**
 * Types for curl command
 */

export interface FormField {
  name: string;
  value: string;
  filename?: string;
  contentType?: string;
}

export interface CurlOptions {
  method: string;
  headers: Record<string, string>;
  data?: string;
  dataBinary: boolean;
  formFields: FormField[];
  user?: string;
  uploadFile?: string;
  cookieJar?: string;
  outputFile?: string;
  useRemoteName: boolean;
  headOnly: boolean;
  includeHeaders: boolean;
  silent: boolean;
  showError: boolean;
  failSilently: boolean;
  followRedirects: boolean;
  writeOut?: string;
  verbose: boolean;
  timeoutMs?: number;
  url?: string;
}
