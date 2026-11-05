import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import type { UserPrivateDto } from "@pairprep/shared";
import { apiClient, ApiClientError } from "./apiClient.js";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface AuthContextValue {
  user: UserPrivateDto | null;
  status: AuthStatus;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (provider: "google" | "github", returnTo?: string) => void;
  logout: () => Promise<void>;
  refreshMe: () => Promise<UserPrivateDto | null>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserPrivateDto | null>(null);
  const [status, setStatus] = useState<AuthStatus>("loading");

  const refreshMe = useCallback(async (): Promise<UserPrivateDto | null> => {
    try {
      const me = await apiClient.get<UserPrivateDto>("/me");
      setUser(me);
      setStatus("authenticated");
      return me;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setUser(null);
        setStatus("anonymous");
        return null;
      }
      setUser(null);
      setStatus("anonymous");
      return null;
    }
  }, []);

  useEffect(() => {
    let isMounted = true;
    refreshMe().then(() => {
      if (!isMounted) return;
    });
    return () => {
      isMounted = false;
    };
  }, [refreshMe]);

  const login = useCallback((provider: "google" | "github", returnTo?: string) => {
    const params = new URLSearchParams();
    if (returnTo) {
      params.set("returnTo", returnTo);
    }
    const query = params.toString() ? `?${params.toString()}` : "";
    window.location.assign(`/api/v1/auth/${provider}${query}`);
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiClient.post("/auth/logout");
    } finally {
      setUser(null);
      setStatus("anonymous");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      status,
      isLoading: status === "loading",
      isAuthenticated: status === "authenticated",
      login,
      logout,
      refreshMe,
    }),
    [user, status, login, logout, refreshMe]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
