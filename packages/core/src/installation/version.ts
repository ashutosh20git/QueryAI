declare global {
  const QUERYAI_VERSION: string
  const QUERYAI_CHANNEL: string
}

export const InstallationVersion = typeof QUERYAI_VERSION === "string" ? QUERYAI_VERSION : "local"
export const InstallationChannel = typeof QUERYAI_CHANNEL === "string" ? QUERYAI_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
