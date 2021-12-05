import { HttpMethods } from "@wymp/ts-simple-interfaces";
import { MockSimpleLogger, MockSimpleHttpClient } from "@wymp/ts-simple-interfaces-testing";
import { Client } from "../src";
import { MockStorage } from "./MockStorage";

describe("Client", () => {
  let log: MockSimpleLogger;
  let http: MockSimpleHttpClient;
  let storage: MockStorage;
  let client: Client;
  const storageKey = "@luminous-money/client::credentials";
  const creds = {
    t: "session",
    token: "aaaabbbb",
    refresh: "11112222",
  };

  beforeEach(() => {
    log = new MockSimpleLogger();
    http = new MockSimpleHttpClient();
    storage = new MockStorage();
    client = new Client("abcde", "12345", "https://example.com", http, storage, log);
  });

  // Some convenience values
  const Http401Res = (vals?: { code?: string; title?: string; detail?: string }) => ({
    status: 401,
    headers: {},
    config: {},
    data: {
      t: "error",
      error: {
        status: 401,
        code: "NOT_AUTHORIZED",
        title: "Not Authorized",
        detail: "Invalid login credentials",
        obstructions: [],
        ...(vals || {}),
      },
    },
  });

  const Http500Res = (vals?: { code?: string; title?: string; detail?: string }) => ({
    status: 500,
    headers: {},
    config: {},
    data: {
      t: "error",
      error: {
        status: 500,
        code: "INTERNAL_SERVER_ERROR",
        title: "Internal Server Error",
        detail: "Something went wrong",
        obstructions: [],
        ...(vals || {}),
      },
    },
  });

  describe("Construction", () => {
    test("gets credentials out of storage on instantiation", () => {
      storage.setItem(storageKey, JSON.stringify(creds));
      client = new Client("abcde", "12345", "https://example.com", http, storage, log);
      expect((client as any).session).toMatchObject(creds);
    });

    test("handles bad stored crednetials gracefully", () => {
      storage.setItem(storageKey, JSON.stringify({ t: "bad" }));
      client = new Client("abcde", "12345", "https://example.com", http, storage, log);
      expect((client as any).session).toBe(null);
      expect(storage.getItem(storageKey)).toBe(null);
    });
  });

  describe("Session Management", () => {
    describe("createUser", () => {
      test("can successfully create a user", async () => {
        // Set a success response
        http.setNextResponse("post https://example.com/accounts/v1/users", {
          status: 201,
          headers: {},
          config: {},
          data: { data: { ...creds } },
        });

        await client.createUser("Jim Chavo", "me@example.com", "abcde", "abcde");

        expect((client as any).session).toMatchObject(creds);
      });

      test("throws on user creation errors", async () => {
        // Set an error response
        http.setNextResponse("post https://example.com/accounts/v1/users", {
          status: 409,
          headers: {},
          config: {},
          data: {
            t: "error",
            error: {
              status: 409,
              code: "DUPLICATE_RESOURCE",
              title: "Duplicate Resource",
              detail: "A user with this email already exists in our system",
              obstructions: [],
            },
          },
        });

        await expect(() =>
          client.createUser("Jim Chavo", "me@example.com", "abcde", "abcde")
        ).rejects.toThrow("email already exists");
      });
    });

    describe("logout", () => {
      test("does not choke when called and not logged in", async () => {
        await expect(client.logout()).resolves.toBeUndefined();
      });

      test("can successfully log out of a session", async () => {
        (client as any).session = { ...creds };

        // Set a success response
        http.setNextResponse("post https://example.com/accounts/v1/sessions/logout", {
          status: 200,
          headers: {},
          config: {},
          data: { data: null },
        });

        // Run the logout and check
        await client.logout();
        expect((client as any).session).toBe(null);

        // Also verify that the API call looks right
        const req = http.requestLog[0];
        expect(req.method).toBe("post");
        expect(req.url).toMatch(/\/sessions\/logout$/);
        const auth = req.headers && (req.headers.Authorization || req.headers.authorization);
        expect(auth).toBeDefined();
        expect(auth).toMatch(new RegExp(`^Basic [^,]+,Bearer ${creds.token}$`));
      });

      test("throws on error response", async () => {
        (client as any).session = { ...creds };

        // Set an error response
        http.setNextResponse("post https://example.com/accounts/v1/sessions/logout", Http500Res());

        await expect(() => client.logout()).rejects.toThrow("unexpected response on logout");
      });
    });

    describe("login", () => {
      test("successfully logs a user in and stores session", async () => {
        // Set the response to our session
        http.setNextResponse("post https://example.com/accounts/v1/sessions/login/password", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: { ...creds },
          },
        });

        // Log in
        const result = await client.login("me@example.com", "abcde12345");

        // Verify success response
        expect(result).toMatchObject({ status: "success" });

        // Verify that the request looks right
        const req = http.requestLog[0];
        expect(req.method).toBe("post");
        expect(req.url).toMatch(/\/sessions\/login\/password$/);
        const auth = req.headers && (req.headers.Authorization || req.headers.authorization);
        expect(auth).toBeDefined();
        expect(auth).toMatch(new RegExp(`^Basic [^,]+$`));

        // Finally, verify that the session got stored
        expect(storage.getItem(storageKey)).toBe(JSON.stringify(creds));
      });

      test("returns error on auth error", async () => {
        // Set the response to our session
        http.setNextResponse(
          "post https://example.com/accounts/v1/sessions/login/password",
          Http401Res()
        );

        // Try to log in
        const result = await client.login("me@example.com", "abcde12345");

        // Verify error response
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error).toBeDefined();
          expect(result.error.message).toMatch(/Invalid login/);
        }
      });

      test("throws error on non-auth error", async () => {
        // Set the response to our session
        http.setNextResponse(
          "post https://example.com/accounts/v1/sessions/login/password",
          Http500Res()
        );

        // Try to log in
        await expect(() => client.login("me@example.com", "abcde12345")).rejects.toThrow(
          "Something went wrong"
        );
      });

      test("throws error when step other than totp is returned", async () => {
        // Set the response to our session
        http.setNextResponse("post https://example.com/accounts/v1/sessions/login/password", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: {
              t: "step",
              step: "email",
              state: "abcde12345",
            },
          },
        });

        // Attempt to log in
        await expect(() => client.login("me@example.com", "abcde12345")).rejects.toThrow(
          "unexpected step 'email'"
        );
      });

      test("returns 2fa response when totp step requested", async () => {
        // Set the response to our session
        http.setNextResponse("post https://example.com/accounts/v1/sessions/login/password", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: {
              t: "step",
              step: "totp",
              state: "abcde12345",
            },
          },
        });

        // Log in
        const result = await client.login("me@example.com", "abcde12345");

        // Verify success response
        expect(result).toMatchObject({
          status: "2fa",
          code: "abcde12345",
        });
      });
    });

    describe("totp", () => {
      test("executes 2fa successfully and stores session", async () => {
        // Set the response to our session
        http.setNextResponse("post https://example.com/accounts/v1/sessions/login/totp", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: { ...creds },
          },
        });

        // Do 2fa
        const result = await client.totp("abcde12345", "123456");

        // Verify success response
        expect(result).toMatchObject({ status: "success" });

        // Verify that the request looks right
        const req = http.requestLog[0];
        expect(req.method).toBe("post");
        expect(req.url).toMatch(/\/sessions\/login\/totp/);
        expect(req.data).toMatchObject({
          data: {
            t: "totp-step",
            totp: "123456",
            state: "abcde12345",
          },
        });
        const auth = req.headers && (req.headers.Authorization || req.headers.authorization);
        expect(auth).toBeDefined();
        expect(auth).toMatch(new RegExp(`^Basic [^,]+$`));

        // Finally, verify that the session got stored
        expect(storage.getItem(storageKey)).toBe(JSON.stringify(creds));
      });

      test("returns error on auth error", async () => {
        // Set the response to our session
        http.setNextResponse(
          "post https://example.com/accounts/v1/sessions/login/totp",
          Http401Res({ detail: "Invalid TOTP" })
        );

        // Try to log in
        const result = await client.totp("abcde12345", "123456");

        // Verify error response
        expect(result.status).toBe("error");
        if (result.status === "error") {
          expect(result.error).toBeDefined();
          expect(result.error.message).toMatch(/Invalid TOTP/);
        }
      });

      test("throws error on non-auth error", async () => {
        // Set the response to our session
        http.setNextResponse(
          "post https://example.com/accounts/v1/sessions/login/totp",
          Http500Res()
        );

        // Try to log in
        await expect(() => client.totp("abcde12345", "123456")).rejects.toThrow(
          "Something went wrong"
        );
      });

      test("throws error when another step is returned", async () => {
        // Set the response to our session
        http.setNextResponse("post https://example.com/accounts/v1/sessions/login/totp", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: {
              t: "step",
              step: "email",
              state: "abcde12345",
            },
          },
        });

        // Attempt to log in
        await expect(() => client.totp("abcde12345", "123456")).rejects.toThrow(
          "unexpected step 'email'"
        );
      });
    });

    describe("loggedIn", () => {
      test("returns true when session token is valid", async () => {
        // Set the response to our call
        http.setNextResponse("get https://example.com/accounts/v1/users/current", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: {
              type: "users",
              id: "abcde12345",
              // ....
            },
          },
        });

        // Set session token
        (client as any).session = { ...creds };

        // Verify that the call returns true
        await expect(client.loggedIn()).resolves.toBe(true);
      });

      test("returns true when session token is invalid but refresh token is valid", async () => {
        // Set our initial ("expired") credentials
        (client as any).session = { ...creds };

        // Set the initial (401) response to our call
        http.setNextResponse("get https://example.com/accounts/v1/users/current", Http401Res());

        // Set the successful refresh call
        http.setNextResponse("post https://example.com/accounts/v1/sessions/refresh", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: { ...creds },
          },
        });

        // Set the final successful response
        http.setNextResponse("get https://example.com/accounts/v1/users/current", {
          status: 200,
          headers: {},
          config: {},
          data: {
            t: "single",
            data: {
              type: "users",
              id: "abcde12345",
              // ....
            },
          },
        });

        // Verify that the call returns true
        await expect(client.loggedIn()).resolves.toBe(true);
      });

      test("returns false when session and refresh tokens are invalid", async () => {
        // Set our initial ("expired") credentials
        (client as any).session = { ...creds };

        // Set the initial (401) response to our call
        http.setNextResponse("get https://example.com/accounts/v1/users/current", Http401Res());

        // Set the failed refresh call
        http.setNextResponse("post https://example.com/accounts/v1/sessions/refresh", Http401Res());

        // Verify that the call returns false
        await expect(client.loggedIn()).resolves.toBe(false);
      });

      test("returns false when no session provided", async () => {
        // Verify that the call returns false
        await expect(client.loggedIn()).resolves.toBe(false);
      });

      test("throws an error on non-auth API errors during primary call", async () => {
        // Set our initial credentials
        (client as any).session = { ...creds };

        // Set the error response
        http.setNextResponse("get https://example.com/accounts/v1/users/current", Http500Res());

        // Verify that it throws
        await expect(client.loggedIn()).rejects.toThrow("Something went wrong");
      });

      test("throws an error on non-auth API errors during refresh call", async () => {
        // Set our initial (expired) credentials
        (client as any).session = { ...creds };

        // Set the auth error response
        http.setNextResponse("get https://example.com/accounts/v1/users/current", Http401Res());

        // Set the refresh error response
        http.setNextResponse("post https://example.com/accounts/v1/sessions/refresh", Http500Res());

        // Verify that it throws
        await expect(client.loggedIn()).rejects.toThrow("Something went wrong");
      });
    });
  });

  describe("Data Methods", () => {
    describe("Session Auto-Refresh", () => {
      const params: Array<[HttpMethods, Function]> = [
        ["get", (c: Client) => c.get("/accounts/v1/users/current")],
      ];
      for (const [method, call] of params) {
        test(`'${method}' method returns success when session token is invalid but refresh token is valid`, async () => {
          // Set our initial ("expired") credentials
          (client as any).session = { ...creds };

          // Set the initial (401) response to our call
          http.setNextResponse(
            `${method} https://example.com/accounts/v1/users/current`,
            Http401Res()
          );

          // Set the successful refresh call
          http.setNextResponse("post https://example.com/accounts/v1/sessions/refresh", {
            status: 200,
            headers: {},
            config: {},
            data: {
              t: "single",
              data: { ...creds },
            },
          });

          // Set the final successful response
          http.setNextResponse(`${method} https://example.com/accounts/v1/users/current`, {
            status: 200,
            headers: {},
            config: {},
            data: {
              t: "single",
              data: {
                type: "users",
                id: "abcde12345",
                // ....
              },
            },
          });

          // Verify that the call returns true
          await expect(call(client)).resolves.toBeDefined();
        });

        test(`'${method}' method throws error when session and refresh tokens are invalid`, async () => {
          // Set our initial ("expired") credentials
          (client as any).session = { ...creds };

          // Set the initial (401) response to our call
          http.setNextResponse(
            `${method} https://example.com/accounts/v1/users/current`,
            Http401Res()
          );

          // Set the failed refresh call
          http.setNextResponse(
            `post https://example.com/accounts/v1/sessions/refresh`,
            Http401Res()
          );

          // Verify that the call returns false
          await expect(call(client)).rejects.toThrow("Invalid login credentials");
        });

        test(`'${method}' method throws error on non-auth API errors during primary call`, async () => {
          // Set our initial credentials
          (client as any).session = { ...creds };

          // Set the error response
          http.setNextResponse(
            `${method} https://example.com/accounts/v1/users/current`,
            Http500Res()
          );

          // Verify that it throws
          await expect(call(client)).rejects.toThrow("Something went wrong");
        });

        test(`'${method}' method throws error on non-auth API errors during refresh call`, async () => {
          // Set our initial (expired) credentials
          (client as any).session = { ...creds };

          // Set the auth error response
          http.setNextResponse(
            `${method} https://example.com/accounts/v1/users/current`,
            Http401Res()
          );

          // Set the refresh error response
          http.setNextResponse(
            "post https://example.com/accounts/v1/sessions/refresh",
            Http500Res()
          );

          // Verify that it throws
          await expect(call(client)).rejects.toThrow("Something went wrong");
        });
      }
    });
  });
});
