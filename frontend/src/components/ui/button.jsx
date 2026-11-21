import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva } from "class-variance-authority";

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-semibold transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/60 focus-visible:ring-offset-2 focus-visible:ring-offset-mil-bg-deep disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-brand text-mil-bg-deep shadow-sm hover:bg-brand-light",
        destructive:
          "bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90",
        // Neutral hovers: the shadcn default hovered to bg-accent, which is
        // solid gold here, so every ghost icon button flashed gold.
        outline:
          "border border-input bg-transparent text-mil-soft shadow-xs hover:border-mil-line-strong hover:bg-mil-bg-elevated hover:text-mil-bright",
        secondary:
          "border border-mil-line bg-mil-bg-elevated text-mil-fg shadow-xs hover:border-mil-line-strong hover:text-mil-bright",
        ghost: "text-mil-soft hover:bg-mil-bg-elevated hover:text-mil-bright",
        link: "text-primary underline-offset-4 hover:underline",
        // Command variants. Sentence-case labels at normal tracking: the old
        // wide-tracked capitals made every button shout equally loud.
        // `commandPrimary` is the one gold call to action on a surface;
        // `command` a raised secondary; `commandOutline` the quiet option
        // beside it; `commandDanger` destructive confirms.
        commandPrimary:
          "bg-brand text-mil-bg-deep hover:bg-brand-light",
        command:
          "border border-mil-line-strong bg-mil-bg-elevated text-mil-fg hover:border-brand/45 hover:text-brand-light",
        commandOutline:
          "border border-mil-line bg-transparent text-mil-soft hover:border-mil-line-strong hover:bg-mil-bg-elevated hover:text-mil-bright",
        commandDanger:
          "border border-red-500/30 bg-red-500/10 text-red-200 hover:bg-red-500/20 focus-visible:ring-red-400/50",
      },
      size: {
        // Mobile-first tap targets. Phones get a 44px control (the iOS/Android
        // minimum and WCAG 2.5.5 target size) while `sm:` restores the original
        // density from the tablet breakpoint up, so desktop layouts are
        // pixel-identical to before. `sm` is intentionally left at h-8: it is the
        // dense toolbar size used by ~20 admin surfaces, and header call sites
        // that need a 44px phone control compensate their own padding.
        default: "h-11 px-4 py-2 sm:h-9",
        sm: "h-8 rounded-md px-3 text-xs",
        // `sm` density from the tablet breakpoint up, a 44px target on phones:
        // for small buttons that are primary controls on a mobile screen.
        smTouch: "h-11 rounded-md px-3 text-xs sm:h-8",
        lg: "h-11 px-8 sm:h-10",
        icon: "h-11 w-11 sm:h-9 sm:w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : "button"
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props} />
  );
})
Button.displayName = "Button"

export { Button, buttonVariants }
