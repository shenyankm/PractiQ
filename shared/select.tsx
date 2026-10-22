import * as React from "react";
import { Select as SelectPrimitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "cn";

type SelectProps = Pick<React.ComponentProps<"select">, "id" | "disabled" | "lang" | "title" | "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid"> & {
  className?: string;
  children: React.ReactNode;
  size?: "sm" | "default";
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};
const desktopQuery = "(pointer: fine)";
function subscribeDesktop(listener: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function isDesktop() { return window.matchMedia(desktopQuery).matches; }
function serverDesktop() { return false; }

export function SelectControl({ className, children, size = "default", value, defaultValue, onValueChange, ...props }: SelectProps) {
  const desktop = React.useSyncExternalStore(subscribeDesktop, isDesktop, serverDesktop);
  const options = React.Children.toArray(children).filter(React.isValidElement<React.ComponentProps<"option">>);
  const [localValue, setLocalValue] = React.useState(() => defaultValue ?? String(options.find(option => !option.props.disabled)?.props.value ?? ""));
  const selected = value ?? localValue;
  function change(next: string) {
    if (value === undefined) setLocalValue(next);
    onValueChange?.(next);
  }
  const controlClass = "flex w-full min-w-0 items-center justify-between gap-2 rounded-lg border border-input bg-card px-2.5 py-1 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive";
  // Radix reserves empty item values; a prefix preserves empty filters without collisions.
  return <div data-slot="select-wrapper" data-size={size} className={cn("relative w-fit max-w-full min-w-0", className)}>
    {desktop ? <SelectPrimitive.Root value={`value:${selected}`} onValueChange={next => change(next.slice(6))} disabled={props.disabled}>
      <SelectPrimitive.Trigger {...props} data-slot="select-trigger" data-size={size} data-value={selected} className={controlClass}>
        <span className="min-w-0 flex-1 truncate text-left"><SelectPrimitive.Value data-slot="select-value" /></span>
        <SelectPrimitive.Icon asChild><ChevronDown data-slot="select-icon" className="size-4 shrink-0 text-muted-foreground" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content data-slot="select-content" position="popper" align="start" sideOffset={4} className="z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-none">
          <SelectPrimitive.ScrollUpButton className="flex h-6 items-center justify-center"><ChevronUp className="size-4" /></SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="grid gap-1 p-1">
            {options.map(option => <SelectPrimitive.Item key={String(option.props.value ?? "")} data-slot="select-item" data-value={String(option.props.value ?? "")} value={`value:${option.props.value ?? ""}`} disabled={option.props.disabled} lang={option.props.lang} className="relative flex min-h-9 cursor-default items-center rounded-lg py-2 pr-8 pl-3 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:bg-secondary data-[state=checked]:text-primary data-[disabled]:pointer-events-none data-[disabled]:opacity-50">
              <span className="min-w-0 break-words"><SelectPrimitive.ItemText>{option.props.children}</SelectPrimitive.ItemText></span>
              <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center"><Check className="size-4" /></SelectPrimitive.ItemIndicator>
            </SelectPrimitive.Item>)}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="flex h-6 items-center justify-center"><ChevronDown className="size-4" /></SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root> : <>
      <select {...props} data-slot="native-select" data-size={size} data-value={selected} className={cn(controlClass, "appearance-none pr-8")} value={selected} onChange={event => change(event.target.value)}>{children}</select>
      <ChevronDown aria-hidden="true" data-slot="select-icon" className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
    </>}
  </div>;
}

export function SelectOption(props: React.ComponentProps<"option">) { return <option {...props} />; }
