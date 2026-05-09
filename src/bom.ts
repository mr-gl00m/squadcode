const UTF8_BOM = String.fromCharCode(0xfeff);

export function detectAndStripBom(content: string): {
  content: string;
  bom: string;
} {
  if (content.charCodeAt(0) === 0xfeff) {
    return { content: content.slice(1), bom: UTF8_BOM };
  }
  return { content, bom: "" };
}

export function restoreBom(content: string, bom: string): string {
  return bom + content;
}
