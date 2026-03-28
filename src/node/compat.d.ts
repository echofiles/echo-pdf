declare const process: {
  cwd(): string
  versions?: {
    node?: string
  }
}

interface ImportMeta {
  url: string
}

declare module "node:crypto" {
  interface Hash {
    update(data: string | ArrayBuffer | ArrayBufferView): Hash
    digest(encoding: "hex"): string
  }

  export function createHash(algorithm: string): Hash
}

declare module "node:fs/promises" {
  export interface FileStat {
    size: number
    mtimeMs: number
  }

  export function mkdir(
    path: string,
    options?: {
      recursive?: boolean
    }
  ): Promise<string | undefined>

  export function readFile(path: string, encoding: "utf-8"): Promise<string>
  export function readFile(path: string): Promise<Uint8Array>
  export function writeFile(path: string, data: string | Uint8Array, encoding?: "utf-8"): Promise<void>
  export function stat(path: string): Promise<FileStat>
}

declare module "node:module" {
  export function createRequire(filename: string): {
    resolve(specifier: string): string
  }
}

declare module "node:path" {
  export function resolve(...paths: string[]): string
  export function join(...paths: string[]): string
  export function dirname(path: string): string
  export function basename(path: string): string

  const pathApi: {
    resolve: typeof resolve
    join: typeof join
    dirname: typeof dirname
    basename: typeof basename
  }

  export default pathApi
}
