/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_ROOM?: string;
  /** Bidder origins allowed to call this page's tools. Mirrors ALLOWED_ORIGINS. */
  readonly VITE_BIDDER_ORIGINS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
