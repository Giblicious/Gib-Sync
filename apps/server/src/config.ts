import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_URL: z.string().url(),
  DATA_DIR: z.string().default("/data"),
  GIBSYNC_SETUP_TOKEN: z.string().min(24),
  GIBSYNC_SERVER_SECRET: z.string().min(32),
  SEAFILE_URL: z.string().url(),
  SEAFILE_USERNAME: z.string().min(1),
  SEAFILE_PASSWORD: z.string().min(1),
  SEAFILE_LIBRARY: z.string().default("Gib Sync"),
  PAIRING_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(300),
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(1073741824)
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);

