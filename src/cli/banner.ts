export const BANNER_LINES = [
  "███████╗ ██████╗ ██╗   ██╗ █████╗ ██████╗      ██████╗ ██████╗ ██████╗ ███████╗",
  "██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔══██╗    ██╔════╝██╔═══██╗██╔══██╗██╔════╝",
  "███████╗██║   ██║██║   ██║███████║██║  ██║    ██║     ██║   ██║██║  ██║█████╗  ",
  "╚════██║██║▄▄ ██║██║   ██║██╔══██║██║  ██║    ██║     ██║   ██║██║  ██║██╔══╝  ",
  "███████║╚██████╔╝╚██████╔╝██║  ██║██████╔╝    ╚██████╗╚██████╔╝██████╔╝███████╗",
  "╚══════╝ ╚══▀▀═╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝      ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
];

export const BANNER = BANNER_LINES.join("\n");

export function bannerSubtitle(
  version: string,
  providerName: string,
  model: string,
): string {
  return `  v${version}  ·  ${providerName}/${model}  ·  /help for slash commands  ·  Ctrl-C to abort/exit`;
}
