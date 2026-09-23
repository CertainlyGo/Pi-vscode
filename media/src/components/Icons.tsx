import type { JSX } from "react";

export type IconName =
  | "send"
  | "stop"
  | "plus"
  | "history"
  | "ellipsis"
  | "chevron-right"
  | "chevron-down"
  | "check"
  | "close"
  | "spinner"
  | "file"
  | "terminal"
  | "edit"
  | "search"
  | "folder"
  | "copy"
  | "branch"
  | "brain"
  | "warning"
  | "info"
  | "error"
  | "trash"
  | "diff"
  | "sparkle"
  | "refresh"
  | "chip"
  | "key"
  | "compact"
  | "arrow-down";

const PATHS: Record<IconName, string> = {
  send: "M3 11.5 20.5 3.5 12.5 21 10.2 13.3 3 11.5Z",
  stop: "M6 6h12v12H6z",
  plus: "M12 5v14M5 12h14",
  history: "M12 8v4l3 2M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3 4v4h4",
  ellipsis: "M6 12h.01M12 12h.01M18 12h.01",
  "chevron-right": "M9 5l7 7-7 7",
  "chevron-down": "M5 9l7 7 7-7",
  check: "M4.5 12.5 9 17l10.5-10.5",
  close: "M6 6l12 12M18 6L6 18",
  spinner: "M12 3a9 9 0 1 0 9 9",
  file: "M6 3h7l5 5v13H6zM13 3v5h5",
  terminal: "M4 6h16v12H4zM7 10l2.5 2L7 14M12 15h5",
  edit: "M4 20h4l10-10-4-4L4 16v4zM13.5 6.5l4 4",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4.5 4.5",
  folder: "M3 6h6l2 2h10v11H3z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  branch: "M7 4v10a4 4 0 0 0 4 4h6M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 12a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  brain: "M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V15a3 3 0 0 0 4 2.8V20M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V15a3 3 0 0 1-4 2.8V20M12 4v16",
  warning: "M12 4 2.5 20h19L12 4zM12 10v4M12 17h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v5M12 8h.01",
  error: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9l6 6M15 9l-6 6",
  trash: "M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13",
  diff: "M6 3v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM18 21V9M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z",
  refresh: "M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4",
  chip: "M8 8h8v8H8zM4 10h4M4 14h4M16 10h4M16 14h4M10 4v4M14 4v4M10 16v4M14 16v4",
  key: "M14.5 4a4.5 4.5 0 0 0-4.3 5.8L3 17v3h3l1.2-1.2 1.3 1.3 1.4-1.4-1.3-1.3 1.3-1.3 1.3 1.3 1.4-1.4-1.3-1.3.9-.9A4.5 4.5 0 1 0 14.5 4zm1.2 3.6h.01",
  compact: "M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5",
  "arrow-down": "M12 5v14M6 13l6 6 6-6",
};

interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 16, className }: IconProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
