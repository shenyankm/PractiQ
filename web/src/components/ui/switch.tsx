import type { ComponentProps } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

export function Switch(props: ComponentProps<typeof SwitchPrimitive.Root>) {
  return <SwitchPrimitive.Root data-slot="switch" {...props}>
    <SwitchPrimitive.Thumb data-slot="switch-thumb" />
  </SwitchPrimitive.Root>;
}
