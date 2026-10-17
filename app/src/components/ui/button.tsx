import * as React from "react";
import type { VariantProps } from "class-variance-authority";
import { cn } from "cn";
import { buttonVariants } from "../../../../shared/ui";
import { Slot } from "radix-ui";

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  onMouseDown,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-button=""
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      onMouseDown={event => {
        onMouseDown?.(event);
        // WebKit does not focus mouse-pressed buttons; dialogs need a stable invoker.
        if (!event.defaultPrevented && event.button === 0 && !props.disabled) event.currentTarget.focus({ preventScroll: true });
      }}
      {...props}
    />
  );
}

export { Button };
