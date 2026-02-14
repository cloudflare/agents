/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly REACT_COMPILER: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
