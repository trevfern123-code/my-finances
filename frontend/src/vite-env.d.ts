/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_API_BASE_URL: string;
  /** Local release verification only; see main.tsx. */
  readonly VITE_UPDATE_DEBUG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
