import { useState, useEffect, type FormEvent } from "react";
import { useAuth } from "../lib/authContext.js";
import { apiClient, ApiClientError } from "../lib/apiClient.js";
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
import { toast } from "./ui/Toast.js";
import type { UserPrivateDto } from "@pairprep/shared";
import { User, Shield, Mail, CheckCircle2 } from "lucide-react";

export interface ProfileModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProfileModal({ open, onOpenChange }: ProfileModalProps) {
  const { user, refreshMe } = useAuth();
  const [displayName, setDisplayName] = useState(user?.displayName || "");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.displayName) {
      setDisplayName(user.displayName);
    }
  }, [user]);

  if (!user) return null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = displayName.trim();

    if (!trimmed || trimmed.length < 1 || [...trimmed].length > 40) {
      setError("Display name must be between 1 and 40 characters.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await apiClient.patch<UserPrivateDto>("/me", {
        displayName: trimmed,
      });

      await refreshMe();
      toast.success("Profile updated successfully");
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError("Failed to update profile. Please try again.");
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
              <User className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wider">
                Account Settings
              </span>
            </div>
            <ModalTitle>Edit Profile</ModalTitle>
            <ModalDescription>
              Manage your display name and view authenticated account credentials.
            </ModalDescription>
          </ModalHeader>

          {error && (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive-text"
            >
              {error}
            </div>
          )}

          <div className="space-y-4">
            <Input
              id="profile-display-name"
              label="Display Name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={40}
              required
              helperText="1–40 characters visible in collaborative rooms and scorecards."
              disabled={isSubmitting}
            />

            <div className="rounded-xl border border-border-subtle bg-surface-subtle p-3.5 space-y-2 text-xs">
              <div className="flex items-center justify-between text-text-secondary">
                <span className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5 text-text-subtle" /> Auth Provider
                </span>
                <span className="font-mono uppercase font-semibold text-text-primary">
                  {user.provider}
                </span>
              </div>

              {user.email && (
                <div className="flex items-center justify-between text-text-secondary pt-1 border-t border-border-subtle">
                  <span className="flex items-center gap-1.5">
                    <Mail className="h-3.5 w-3.5 text-text-subtle" /> Registered Email
                  </span>
                  <span className="font-mono text-text-primary truncate max-w-[180px]">
                    {user.email}
                  </span>
                </div>
              )}
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
              <CheckCircle2 className="h-4 w-4 mr-1.5" /> Save Changes
            </Button>
          </ModalFooter>
        </form>
      </ModalContent>
    </Modal>
  );
}
