export type SharedBlueprintV1 = {
  v: 1;
  p: number;
  m: 0 | 1;
  n: Array<[id: number, kindIndex: number, col: number, row: number]>;
  e: Array<[fromId: number, toId: number, modeIndex: number, label?: string]>;
  c: number[];
};

export const maximumSharedBlueprintLength = 32_768;

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeSharedBlueprint(payload: SharedBlueprintV1) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

export function decodeSharedBlueprint(value: string): unknown | null {
  if (!value || value.length > maximumSharedBlueprintLength || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(base64UrlToBytes(value));
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}
