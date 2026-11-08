import * as React from "react";
import { cn } from "cn";
import { t } from "../../i18n";
import { Button } from "./button";

export interface ListPaginationProps extends React.ComponentProps<"nav"> {
  offset: number;
  total: number;
  pageSize?: number;
  itemCount?: number;
  disabled?: boolean;
  onOffsetChange: (newOffset: number) => void;
  ariaLabel?: string;
  label?: React.ReactNode;
}

export function ListPagination({
  offset,
  total,
  pageSize = 30,
  itemCount,
  disabled = false,
  onOffsetChange,
  ariaLabel,
  label,
  className,
  ...props
}: ListPaginationProps) {
  if (total <= pageSize) return null;
  const currentCount = itemCount ?? Math.min(pageSize, Math.max(0, total - offset));
  const defaultLabel = t("{0}–{1} / {2} 条", {
    0: total ? offset + 1 : 0,
    1: offset + currentCount,
    2: total,
  });

  return (
    <nav
      aria-label={ariaLabel}
      className={cn("flex flex-1 flex-wrap items-center justify-between gap-3", className)}
      {...props}
    >
      {label !== undefined ? (
        label
      ) : (
        <span role="status" className="text-sm tabular-nums text-muted-foreground">
          {defaultLabel}
        </span>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={disabled || offset === 0}
          onClick={() => onOffsetChange(Math.max(0, offset - pageSize))}
        >
          {t("上一页")}
        </Button>
        <Button
          variant="outline"
          disabled={disabled || offset + pageSize >= total}
          onClick={() => onOffsetChange(offset + pageSize)}
        >
          {t("下一页")}
        </Button>
      </div>
    </nav>
  );
}
