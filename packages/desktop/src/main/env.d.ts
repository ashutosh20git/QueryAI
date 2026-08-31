interface ImportMetaEnv {
  readonly QUERYAI_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:queryai-server" {
  export namespace Server {
    export const listen: typeof import("../../../queryai/dist/types/src/node").Server.listen
    export type Listener = import("../../../queryai/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../queryai/dist/types/src/node").Config.get
    export type Info = import("../../../queryai/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../queryai/dist/types/src/node").bootstrap
}
