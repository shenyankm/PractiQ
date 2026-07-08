declare module '@heroui/react' {
  import type { ComponentType, ReactNode } from 'react';

  type AnyProps = Record<string, unknown> & { children?: ReactNode };

  export const Button: ComponentType<AnyProps>;
  export const Link: ComponentType<AnyProps>;
  export const Input: ComponentType<AnyProps>;
  export const Label: ComponentType<AnyProps>;
  export const Card: ComponentType<AnyProps>;
  export const CardContent: ComponentType<AnyProps>;
  export const CardHeader: ComponentType<AnyProps>;
  export const CardTitle: ComponentType<AnyProps>;
  export const ProgressBar: ComponentType<AnyProps>;
}
