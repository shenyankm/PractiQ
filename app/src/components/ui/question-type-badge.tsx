import * as React from "react";
import { Badge } from "./badge";
import { modeNames } from "../../api";
import { questionKinds } from "../../english";
import { t } from "../../i18n";
import { cn } from "cn";

export interface QuestionTypeBadgeProps extends React.ComponentProps<typeof Badge> {
  answerMode?: string | null;
  questionKind?: string | null;
  choiceVariant?: "single" | "multiple" | string | null;
  fallback?: string;
}

export function QuestionTypeBadge({
  answerMode,
  questionKind,
  choiceVariant,
  fallback,
  variant = "outline",
  className,
  ...props
}: QuestionTypeBadgeProps) {
  const modes = modeNames();
  const kinds = questionKinds();
  const name =
    (questionKind && kinds[questionKind as keyof typeof kinds]) ||
    (answerMode && modes[answerMode]) ||
    fallback ||
    t("未知题型");

  const choiceSuffix =
    answerMode === "choice"
      ? choiceVariant === "multiple"
        ? t(" · 多选")
        : choiceVariant === "single"
          ? t(" · 单选")
          : ""
      : "";

  return (
    <Badge variant={variant} className={cn("shrink-0", className)} {...props}>
      {name}
      {choiceSuffix}
    </Badge>
  );
}
