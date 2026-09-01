/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The auction house Worker — a different origin from this console. */
  readonly VITE_API_BASE?: string;
  /** The floor's page origin, probed for cross-origin tool discovery. */
  readonly VITE_FLOOR_ORIGIN?: string;
  readonly VITE_ROOM?: string;
  /** Which bidder persona this console runs as: you | ada | rex | nia. */
  readonly VITE_PERSONA?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
