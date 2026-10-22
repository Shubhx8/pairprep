import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, Server } from "node:http";
import express from "express";
import { setupGracefulShutdown } from "../index.js";

describe("Robust Graceful Shutdown Handling (T01)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shutdown: allows an in-flight request to complete before clean exit with code 0", async () => {
    const testApp = express();
    let requestStarted = false;
    let requestFinished = false;

    testApp.get("/slow-work", async (_req, res) => {
      requestStarted = true;
      await new Promise((r) => setTimeout(r, 60));
      requestFinished = true;
      res.status(200).json({ status: "done" });
    });

    const server: Server = createServer(testApp);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const onShutdown = vi.fn();
    const { handleShutdown } = setupGracefulShutdown(server, onShutdown);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (() => undefined) as unknown as (
          code?: string | number | null | undefined
        ) => never
      );

    // Launch in-flight request using native fetch so connection starts immediately
    const inFlightPromise = fetch(`http://127.0.0.1:${port}/slow-work`);

    // Wait until server actually received and began processing the request
    while (!requestStarted) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Now trigger shutdown while the request is actively in-flight
    handleShutdown("SIGTERM");

    // In-flight request must successfully complete
    const response = await inFlightPromise;
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "done" });
    expect(requestFinished).toBe(true);

    // Allow event loop and server.close to complete after connection drains
    await vi.waitFor(() => {
      expect(onShutdown).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  it("shutdown: forces exit after 10 seconds if in-flight requests do not drain (using fake timers)", () => {
    vi.useFakeTimers();

    const dummyServer = {
      // Mock server.close that intentionally never invokes its callback (simulating stuck connections)
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
    } as unknown as Server;

    const { handleShutdown } = setupGracefulShutdown(dummyServer);

    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (() => undefined) as unknown as (
          code?: string | number | null | undefined
        ) => never
      );

    handleShutdown("SIGTERM");

    expect(dummyServer.close).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();

    // Fast-forward by 10 seconds
    vi.advanceTimersByTime(10000);

    // Must force exit with code 1 after timeout
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("shutdown: ignores second SIGTERM signal and does not double-close server", () => {
    const dummyServer = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
    } as unknown as Server;

    const { handleShutdown } = setupGracefulShutdown(dummyServer);

    // Send first SIGTERM
    handleShutdown("SIGTERM");
    expect(dummyServer.close).toHaveBeenCalledTimes(1);

    // Send second duplicate SIGTERM
    handleShutdown("SIGTERM");
    // close must NOT be called again
    expect(dummyServer.close).toHaveBeenCalledTimes(1);
  });

  it("shutdown: closes idle keep-alive connections via server.closeIdleConnections()", () => {
    const closeIdleConnectionsSpy = vi.fn();
    const dummyServer = {
      close: vi.fn(),
      closeIdleConnections: closeIdleConnectionsSpy,
    } as unknown as Server;

    const { handleShutdown } = setupGracefulShutdown(dummyServer);

    handleShutdown("SIGTERM");

    expect(closeIdleConnectionsSpy).toHaveBeenCalledTimes(1);
    expect(dummyServer.close).toHaveBeenCalledTimes(1);
  });
});
