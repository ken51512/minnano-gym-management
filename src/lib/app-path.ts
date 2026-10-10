const configuredBasePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** Build a same-origin application URL that also works below the Pages subpath. */
export function appPath(path = "/"): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const basePath = configuredBasePath.replace(/\/+$/, "");
  return `${basePath}${normalizedPath}`;
}

export function appAbsoluteUrl(origin: string, path: string): string {
  return new URL(appPath(path), origin).toString();
}
