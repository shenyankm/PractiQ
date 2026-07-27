import { Alert, Button } from '@heroui/react';

export function PageState({
  loading,
  error,
  retry
}: {
  loading: boolean;
  error: string;
  retry: () => void;
}) {
  if (loading) return <p role="status">加载中…</p>;
  if (!error) return null;
  return (
    <Alert status="danger">
      <Alert.Content>
        <Alert.Title>加载失败</Alert.Title>
        <Alert.Description>{error}</Alert.Description>
      </Alert.Content>
      <Button size="sm" onPress={retry}>重试</Button>
    </Alert>
  );
}
