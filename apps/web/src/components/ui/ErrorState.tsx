import { AlertCircle } from "lucide-react";
import { Button } from "./Button.js";
import { cn } from "../../lib/utils.js";

export interface ErrorStateProps {
  title?: string;
  message: string;
  requestId?: string;
  onRetry?: () => void;
  headingLevel?: "h1" | "h2" | "h3" | "h4";
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  message,
  requestId,
  onRetry,
  headingLevel = "h3",
  className,
}: ErrorStateProps) {
  const HeadingTag = headingLevel;

  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center p-8 text-center bg-surface border border-border-subtle rounded-xl min-h-[220px]",
        className
      )}
    >
      <div className="mb-3 text-destructive-text">
        <AlertCircle className="h-8 w-8" />
      </div>
      <HeadingTag className="text-base font-semibold text-text-primary">
        {title}
      </HeadingTag>
      <p className="text-sm text-text-secondary mt-1 max-w-sm font-mono break-words">
        {message}
      </p>
      {requestId && (
        <p className="text-xs text-text-subtle font-mono mt-2">Request ID: {requestId}</p>
      )}
      {onRetry && (
        <div className="mt-4">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
