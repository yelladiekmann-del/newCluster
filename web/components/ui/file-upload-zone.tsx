"use client";

import { useRef } from "react";
import { Upload, CheckCircle2 } from "lucide-react";

interface FileUploadZoneProps {
  accept: string;
  onFile: (file: File) => void;
  loaded?: boolean;
  loadedLabel?: string;
  replaceLabel?: string;
  idleLabel?: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export function FileUploadZone({
  accept,
  onFile,
  loaded = false,
  loadedLabel = "File loaded",
  replaceLabel = "Drop a new file to replace",
  idleLabel = "Drop file here or browse",
  hint,
  disabled = false,
  disabledReason,
}: FileUploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function openPicker() {
    if (disabled) return;
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    input.click();
  }

  function handleFile(file: File | null | undefined) {
    if (!file || disabled) return;
    onFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 border rounded-xl p-6 transition-colors ${
        disabled
          ? "opacity-50 cursor-not-allowed border-dashed border-border"
          : loaded
          ? "border-primary/40 bg-primary/5 hover:bg-primary/8 cursor-pointer"
          : "border-dashed border-border hover:border-primary/60 hover:bg-muted/40 cursor-pointer"
      }`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={openPicker}
      onKeyDown={
        disabled
          ? undefined
          : (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                openPicker();
              }
            }
      }
      onDrop={
        disabled
          ? undefined
          : (e) => {
              e.preventDefault();
              handleFile(e.dataTransfer.files[0]);
            }
      }
      onDragOver={disabled ? undefined : (e) => e.preventDefault()}
    >
      {loaded ? (
        <>
          <CheckCircle2 className="h-5 w-5 text-primary" />
          <span className="text-sm text-primary font-medium">{loadedLabel}</span>
          <span className="text-xs text-muted-foreground">{replaceLabel}</span>
        </>
      ) : (
        <>
          <Upload className="h-5 w-5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground text-center">
            {idleLabel.includes("browse") ? (
              <>
                {idleLabel.replace(" or browse", "")}{" "}
                or <span className="text-primary">browse</span>
              </>
            ) : (
              idleLabel
            )}
          </span>
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </>
      )}
      {disabledReason && (
        <span className="text-xs text-muted-foreground text-center">
          {disabledReason}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          handleFile(e.target.files?.[0]);
        }}
      />
    </div>
  );
}
