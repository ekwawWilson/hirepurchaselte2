import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 max-w-full px-2.5 py-1 text-xs font-semibold ring-1 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 truncate",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground ring-transparent hover:bg-primary/80",
        secondary: "bg-gray-100 text-gray-600 ring-gray-200/60 hover:bg-gray-200",
        destructive: "bg-red-50 text-red-700 ring-red-200/60 hover:bg-red-100",
        success: "bg-emerald-50 text-emerald-700 ring-emerald-200/60 hover:bg-emerald-100",
        outline: "text-foreground bg-white ring-gray-200",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants }
