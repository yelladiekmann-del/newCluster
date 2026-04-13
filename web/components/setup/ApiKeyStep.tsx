"use client";

import { useState } from "react";
import { CheckCircle2, Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useSession } from "@/lib/store/session";
import { toast } from "sonner";

export function ApiKeyStep() {
  const { apiKey, setApiKey } = useSession();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(!apiKey);
  const [show, setShow] = useState(false);

  function save() {
    if (!draft.trim()) return;
    setApiKey(draft.trim());
    sessionStorage.setItem("hy_gemini_key", draft.trim());
    setEditing(false);
    setDraft("");
    toast.success("API key saved");
  }

  return (
    <Card>
      <CardContent className="pt-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold">1. Gemini API Key</Label>
          {apiKey && !editing && (
            <Badge variant="secondary" className="text-xs text-primary gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Saved · Gemini 2.5 Flash accessible
            </Badge>
          )}
        </div>

        {editing ? (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Input
                type={show ? "text" : "password"}
                placeholder="AIza…"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && save()}
                className="pr-10 font-mono text-sm"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button onClick={save} disabled={!draft.trim()} size="sm">
              Save
            </Button>
            {apiKey && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  setDraft("");
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">
              {"•".repeat(20)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing(true)}
              className="text-xs h-7"
            >
              Change
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
