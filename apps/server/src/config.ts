import { z } from "zod";

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  PUBLIC_URL: z.string().url(),
  DATA_DIR: z.string().default("/data"),
  GIBSYNC_SETUP_TOKEN: z.string().min(24).optional(),
  GIBSYNC_SERVER_SECRET: z.string().min(32),
  GIBSYNC_RELEASE_DIGEST:z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  GIBSYNC_CANARY_USERNAME:z.string().trim().min(1).max(320).transform(value=>value.toLowerCase()).optional(),
  GIBSYNC_CANARY_LIBRARY_ID:z.string().uuid().optional(),
  GIBSYNC_CANARY_URL:z.string().url().optional(),
  SEAFILE_URL: z.string().url(),
  SEAFILE_PUBLIC_URL: z.string().url().optional(),
  SEAFILE_USERNAME: z.string().min(1),
  SEAFILE_PASSWORD: z.string().min(1),
  SEAFILE_LIBRARY: z.string().default("Gib Sync"),
  SEAFILE_ALLOWED_HOSTS: z.string().optional(),
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(1073741824),
  GIBSYNC_MIN_CLIENT_VERSION:z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).default("0.8.55"),
  GIBSYNC_RECOMMENDED_CLIENT_VERSION:z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).default("0.8.71")
}).superRefine((config,context)=>{if(Boolean(config.GIBSYNC_CANARY_USERNAME)!==Boolean(config.GIBSYNC_CANARY_LIBRARY_ID)||config.GIBSYNC_CANARY_URL&&!config.GIBSYNC_CANARY_USERNAME)context.addIssue({code:"custom",message:"Canary account and library must be configured together"});if(config.GIBSYNC_CANARY_URL&&new URL(config.GIBSYNC_CANARY_URL).host!==new URL(config.SEAFILE_URL).host)context.addIssue({code:"custom",message:"Canary URL must use the configured backend host"});});

export type Config = z.infer<typeof schema>;
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => schema.parse(env);

export function allowedSeafileHosts(config: Config): Set<string> {
  const configured = config.SEAFILE_ALLOWED_HOSTS?.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  return new Set(configured?.length ? configured : [new URL(config.SEAFILE_PUBLIC_URL ?? config.SEAFILE_URL).host.toLowerCase()]);
}
