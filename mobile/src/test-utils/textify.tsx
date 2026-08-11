import type { ReactNode } from 'react';
import { Text } from 'react-native';

// The RN test renderer rejects bare strings outside a <Text> component; heroui
// stubs wrap every children position with this so text renders anywhere.
export function Textify({ children }: { children?: ReactNode }) {
  if (typeof children === 'string' || typeof children === 'number') {
    return <Text>{children}</Text>;
  }
  if (Array.isArray(children) && children.every((child) => typeof child === 'string' || typeof child === 'number')) {
    return <Text>{children}</Text>;
  }
  return children;
}
