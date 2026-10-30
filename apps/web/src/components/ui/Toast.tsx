import { Toaster as SonnerToaster, toast } from "sonner";

export { toast };

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      className="toaster group"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "group toast bg-surface text-text-primary border border-border-subtle shadow-xl rounded-lg font-sans p-4 flex items-center gap-3 w-full",
          description: "text-text-secondary text-xs",
          actionButton:
            "bg-primary text-primary-fg hover:bg-primary-hover font-semibold text-xs px-3 py-1.5 rounded-md",
          cancelButton:
            "bg-surface text-text-secondary hover:bg-surface-hover border border-border-input text-xs px-3 py-1.5 rounded-md",
          success: "text-success",
          error: "text-destructive-text",
          warning: "text-warning",
          info: "text-text-primary",
        },
      }}
    />
  );
}
