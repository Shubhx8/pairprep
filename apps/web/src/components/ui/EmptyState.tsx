import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

export interface EmptyStateProps {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: ReactNode;
  headingLevel?: "h1" | "h2" | "h3" | "h4";
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = "h3",
  className,
}: EmptyStateProps) {
  const HeadingTag = headingLevel;

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center p-8 text-center bg-surface border border-border-subtle rounded-xl min-h-[220px]",
        className
      )}
    >
      {icon && <div className="mb-3 text-text-subtle">{icon}</div>}
      <HeadingTag className="text-base font-semibold text-text-primary">
        {title}
      </HeadingTag>
      <p className="text-sm text-text-secondary mt-1 max-w-sm">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
