import { Button, Text, View } from "@tarojs/components";
import "./status-panel.css";

interface StatusPanelProps {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function StatusPanel({
  title,
  detail,
  actionLabel,
  onAction,
}: StatusPanelProps): JSX.Element {
  return (
    <View className="status-panel card">
      <Text className="status-title">{title}</Text>
      <Text className="status-detail">{detail}</Text>
      {actionLabel && onAction ? (
        <Button className="secondary-button status-action" onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </View>
  );
}
