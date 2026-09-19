import { AlertCircle, RefreshCw } from "lucide-react";
import Button from "./Button";

export default function ErrorState({
  title = "Something went wrong",
  description,
  onRetry,
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-50">
        <AlertCircle className="h-5 w-5 text-danger-600" />
      </span>
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-ink-500">{description}</p>}
      {onRetry && (
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={onRetry} className="mt-2">
          Try again
        </Button>
      )}
    </div>
  );
}
