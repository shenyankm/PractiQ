import { Button, Empty, Loading, Tag } from "@taroify/core";
import { Image, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import type { PropsWithChildren, ReactNode } from "react";
import "./ui.css";

export function Page({ children, tab = false, className = "" }: PropsWithChildren<{ tab?: boolean; className?: string }>): JSX.Element {
  return <View className={`page-shell ${tab ? "page-shell-with-tab" : ""} ${className}`.trim()}>{children}</View>;
}

export function PageHeader({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: ReactNode }): JSX.Element {
  return (
    <View className="app-page-header">
      <View className="app-page-header-copy">
        {eyebrow ? <Text className="eyebrow">{eyebrow}</Text> : null}
        <Text className="page-title">{title}</Text>
        {subtitle ? <Text className="page-subtitle">{subtitle}</Text> : null}
      </View>
      {action ? <View className="app-page-header-action">{action}</View> : null}
    </View>
  );
}

export function BrandMark({ src, compact = false }: { src?: string; compact?: boolean }): JSX.Element {
  return (
    <View className={`brand-mark ${compact ? "brand-mark-compact" : ""}`} aria-label="PractiQ">
      {src ? <Image className="brand-mark-image" src={src} mode="aspectFit" /> : <Text>PQ</Text>}
    </View>
  );
}

export function Section({ title, description, action, children }: PropsWithChildren<{ title: string; description?: string; action?: ReactNode }>): JSX.Element {
  return (
    <View className="app-section">
      <View className="app-section-heading">
        <View className="app-section-copy">
          <Text className="app-section-title">{title}</Text>
          {description ? <Text className="app-section-description">{description}</Text> : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

export function StateView({ phase, title, detail, actionLabel, onAction }: { phase: "loading" | "empty" | "error"; title: string; detail: string; actionLabel?: string; onAction?: () => void }): JSX.Element {
  if (phase === "loading") {
    return (
      <View className="app-state app-surface" aria-live="polite">
        <Loading size="32px" />
        <Text className="app-state-title">{title}</Text>
        <Text className="app-state-detail">{detail}</Text>
      </View>
    );
  }
  return (
    <View className="app-state app-surface" aria-live="polite">
      <Empty>
        <Empty.Image src={phase === "error" ? "network" : "default"} />
        <Empty.Description>{title}</Empty.Description>
      </Empty>
      <Text className="app-state-detail">{detail}</Text>
      {actionLabel && onAction ? <Button color="primary" shape="round" block onClick={onAction}>{actionLabel}</Button> : null}
    </View>
  );
}

export function ErrorNotice({ children }: PropsWithChildren): JSX.Element {
  return <Text className="app-error" aria-live="polite">{children}</Text>;
}

export function MetricCard({ label, value, unit, tone = "primary" }: { label: string; value: string | number; unit?: string; tone?: "primary" | "success" | "warning" }): JSX.Element {
  return (
    <View className={`metric-card app-surface metric-card-${tone}`}>
      <Text className="metric-label">{label}</Text>
      <View className="metric-value-line">
        <Text className="metric-value app-number">{value}</Text>
        {unit ? <Text className="metric-unit">{unit}</Text> : null}
      </View>
    </View>
  );
}

export function StatusTag({ children, tone = "primary" }: PropsWithChildren<{ tone?: "primary" | "success" | "warning" | "danger" | "neutral" }>): JSX.Element {
  const colors = { primary: "primary", success: "success", warning: "warning", danger: "danger", neutral: "default" } as const;
  return <Tag color={colors[tone]} variant="outlined" size="medium">{children}</Tag>;
}

export function EntityCard({ title, meta, description, badge, onClick, footer }: { title: string; meta?: string; description?: string | null; badge?: ReactNode; onClick?: () => void; footer?: ReactNode }): JSX.Element {
  return (
    <View className={`entity-card app-surface ${onClick ? "entity-card-action" : ""}`} onClick={onClick} role={onClick ? "button" : undefined}>
      <View className="app-row">
        <Text className="entity-title">{title}</Text>
        {badge}
      </View>
      {meta ? <Text className="entity-meta">{meta}</Text> : null}
      <Text className={`entity-description ${description ? "" : "entity-description-empty"}`}>{description || "暂无说明"}</Text>
      {footer ? <View className="entity-footer">{footer}</View> : null}
    </View>
  );
}

export function StickyActions({ children }: PropsWithChildren): JSX.Element {
  return <View className="sticky-actions"><View className="sticky-actions-inner">{children}</View></View>;
}

export async function confirmDanger(title: string, content: string, confirmText = "确认"): Promise<boolean> {
  const result = await Taro.showModal({ title, content, confirmText, confirmColor: "#B55242" });
  return result.confirm;
}

export function PermissionGate({ allowed, fallback, children }: PropsWithChildren<{ allowed: boolean; fallback?: ReactNode }>): JSX.Element {
  if (allowed) return <>{children}</>;
  return <>{fallback ?? <StateView phase="error" title="没有访问权限" detail="当前账号无法查看或操作此内容。" />}</>;
}
