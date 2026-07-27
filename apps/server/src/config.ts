import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_URL: z.string().url(),
  DATA_DIR: z.string().default("/data"),
  GIBSYNC_SETUP_TOKEN: z.string().min(24).optional(),
  GIBSYNC_SERVER_SECRET: z.string().min(32),
  SEAFILE_URL: z.string().url(),
  SEAFILE_PUBLIC_URL: z.string().url().optional(),
  SEAFILE_USERNAME: z.string().min(1),
  SEAFILE_PASSWORD: z.string().min(1),
  SEAFILE_LIBRARY: z.string().default("Gib Sync"),
  SEAFILE_ALLOWED_HOSTS: z.string().optional(),
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(1073741824),
  GIBSYNC_MIN_CLIENT_VERSION:z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).default("0.8.19"),
  GIBSYNC_RECOMMENDED_CLIENT_VERSION:z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).default("0.8.21")
});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);

export function allowedSeafileHosts(config: Config): Set<string> {
  const configured = config.SEAFILE_ALLOWED_HOSTS?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return new Set(configured?.length ? configured : [new URL(config.SEAFILE_PUBLIC_URL ?? config.SEAFILE_URL).host.toLowerCase()]);
}
