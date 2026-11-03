import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  ModalFooter,
} from "./ui/Modal.js";
import { Button } from "./ui/Button.js";
import { Input } from "./ui/Input.js";
import { apiClient, ApiClientError } from "../lib/apiClient.js";
import type { RoomDto, SupportedLanguage } from "@pairprep/shared";
import { Code2, Sparkles, AlertCircle } from "lucide-react";

export interface CreateRoomDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (room: RoomDto) => void;
}

export function CreateRoomDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateRoomDialogProps) {
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<SupportedLanguage>("python");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);

    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await apiClient.post<{ room: RoomDto; currentMember: unknown }>(
        "/rooms",
        {
          title: title.trim() || undefined,
          language,
          type: "practice",
        },
        { idempotencyKey }
      );

      onOpenChange(false);
      setTitle("");
      onCreated?.(res.room);
      navigate(`/r/${res.room.slug}`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.status === 429 && err.retryAfterSec) {
          setError(
            `Rate limit reached. Please wait ${err.retryAfterSec}s before creating another room.`
          );
        } else {
          setError(err.message);
        }
      } else {
        setError("An unexpected error occurred while creating the room.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent className="max-w-md">
        <form onSubmit={handleSubmit} className="space-y-5">
          <ModalHeader>
            <div className="flex items-center gap-2 text-primary mb-1">
              <Sparkles className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wider">
                Instant Room
              </span>
            </div>
            <ModalTitle>Create a Practice Room</ModalTitle>
            <ModalDescription>
              Start a shared collaborative workspace. You will receive an unguessable link
              to share with your partner.
            </ModalDescription>
          </ModalHeader>

          {error && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-text"
            >
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-4">
            <Input
              id="room-title"
              label="Room Title (Optional)"
              placeholder="e.g. Binary Search Tree Practice"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={100}
              helperText="Give your room a memorable name or leave blank for a default."
              disabled={isSubmitting}
            />

            <div>
              <label
                htmlFor="room-language"
                className="block text-sm font-medium text-text-primary mb-1.5"
              >
                Programming Language
              </label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { id: "python", label: "Python" },
                  { id: "javascript", label: "JavaScript" },
                  { id: "cpp", label: "C++" },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setLanguage(item.id as SupportedLanguage)}
                    className={`flex items-center justify-center gap-1.5 rounded-lg border py-2.5 px-3 text-xs font-medium transition-colors cursor-pointer ${
                      language === item.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border-subtle bg-surface hover:bg-surface-hover text-text-secondary"
                    }`}
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border-subtle bg-surface-subtle p-3 text-xs text-text-subtle">
              <span className="font-semibold text-text-primary">Mode: Practice</span> ·
              Collaborative coding with disposable sandbox execution and live
              synchronization.
            </div>
          </div>

          <ModalFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" isLoading={isSubmitting}>
              Create Room
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
