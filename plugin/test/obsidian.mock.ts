export const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
export const requestUrl = async () => { throw new Error("requestUrl is not available in unit tests"); };
export class TFolder {}
