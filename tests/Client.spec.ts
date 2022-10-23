import { HttpMethods, SimpleHttpClientResponseInterface } from "@wymp/ts-simple-interfaces";
import { MockSimpleLogger, MockSimpleHttpClient } from "@wymp/ts-simple-interfaces-testing";
import { Auth, Api } from "@wymp/types";
import { Client } from "../src";
import { MockStorage } from "./MockStorage";

enum UserRoles {
  EndUser = "END_USER",
  Employee = "EMPLOYEE",
  SysAdmin = "SYSADMIN",
}

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

  const UserRes = (status: number = 200, vals?: Partial<Auth.Api.User<UserRoles>>) => ({
    status,
    headers: {},
    config: {},
    data: {
      t: "single",
      data: <Auth.Api.User<UserRoles>>(<any>{
        type: "users" as const,
        id: "abcde12345",
        name: "Jim Chavo",
        ...vals,
      }),
    },
  });

  const UserCollRes = (vals?: Partial<Auth.Api.User<UserRoles>>) =>
    <SimpleHttpClientResponseInterface<Api.CollectionResponse<Auth.Api.User<UserRoles>>>>{
      status: 200,
      headers: {},
      config: {},
      data: {
        t: "collection",
        data: [<Auth.Api.User<UserRoles>>(<any>{
            type: "users" as const,
            id: "abcde12345",
            name: "Jim Chavo",
            ...vals,
          })],
        meta: {
          pg: {
            size: 25,
            nextCursor: "2",
            prevCursor: null,
          },
        },
      },
    };

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
        expect(auth).toMatch(new RegExp(`^Basic [^,]+,Bearer session:${creds.token}$`));
      });

      test("throws on error response", async () => {
        (client as any).session = { ...creds };

        // Set an error response
        http.setNextResponse("post https://example.com/accounts/v1/sessions/logout", Http500Res());

        await expect(() => client.logout()).rejects.toThrow("Something went wrong");
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

      ["INCORRECT-PASSWORD", "EMAIL-NOT-FOUND"].map(code => {
        test(`returns error when API returns error with code '${code}'`, async () => {
          // Set the response to our session
          http.setNextResponse(
            "post https://example.com/accounts/v1/sessions/login/password",
            Http401Res({ code })
          );

          // Try to log in
          const result = await client.login("me@example.com", "abcde12345");

          // Verify error response
          expect(result.status).toBe("error");
          if (result.status === "error") {
            expect(result.error).toBeDefined();
            expect(result.error.subcode).toBe(code);
          }
        });
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
    test.todo("Test ability to add headers to all requests");
    describe("Session Auto-Refresh", () => {
      const params: Array<[HttpMethods, Function]> = [
        ["get", (c: Client) => c.get("/accounts/v1/users/current")],
        ["post", (c: Client) => c.post("/accounts/v1/users/current", null)],
        ["patch", (c: Client) => c.patch("/accounts/v1/users/current", {})],
        ["delete", (c: Client) => c.delete("/accounts/v1/users/current")],
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
          http.setNextResponse(
            `${method} https://example.com/accounts/v1/users/current`,
            UserRes()
          );

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

    describe("get", () => {
      // Set credentials before each test
      beforeEach(() => {
        (client as any).session = { ...creds };
      });

      test("returns a response", async () => {
        // Set the response
        const userRes = UserRes();
        http.setNextResponse(`get https://example.com/accounts/v1/users/current`, userRes);

        // get and verify response
        const res = await client.get<Auth.Api.User<UserRoles>>("/accounts/v1/users/current");
        expect(res).toMatchObject(userRes.data);
      });
    });

    describe("post", () => {
      // Set credentials before each test
      beforeEach(() => {
        (client as any).session = { ...creds };
      });

      test("returns a response", async () => {
        // Set the response
        const userRes = UserRes(201);
        http.setNextResponse(`post https://example.com/accounts/v1/users`, userRes);

        // post and verify response
        const res = await client.post<{
          tx: Auth.Api.User<UserRoles>;
          rx: Auth.Api.User<UserRoles>;
        }>("/accounts/v1/users", userRes.data.data);
        expect(res).toMatchObject(userRes.data);
      });
    });

    describe("patch", () => {
      // Set credentials before each test
      beforeEach(() => {
        (client as any).session = { ...creds };
      });

      test("returns a response", async () => {
        // Set the response
        const userRes = UserRes();
        http.setNextResponse(`patch https://example.com/accounts/v1/users/current`, userRes);

        // post and verify response
        const res = await client.patch<{
          tx: Auth.Api.User<UserRoles>;
          rx: Auth.Api.User<UserRoles>;
        }>("/accounts/v1/users/current", userRes.data.data);
        expect(res).toMatchObject(userRes.data);
      });
    });

    describe("delete", () => {
      // Set credentials before each test
      beforeEach(() => {
        (client as any).session = { ...creds };
      });

      test("returns a response", async () => {
        // Set the response
        http.setNextResponse(`delete https://example.com/accounts/v1/users/current`, {
          status: 200,
          headers: {},
          config: {},
          data: { t: "null", data: null },
        });

        // post and verify response
        const res = await client.delete("/accounts/v1/users/current");
        expect(res).toMatchObject({ t: "null", data: null });
      });
    });

    describe("next", () => {
      // Set credentials before each test
      beforeEach(() => {
        (client as any).session = { ...creds };
      });

      test("response successfully chains", async () => {
        // Set the response
        let userRes = UserCollRes();
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);

        // make the request, then verify the request and response
        let nextable = await client.next<Auth.Api.User<UserRoles>>("/accounts/v1/users");
        // shouldn't have sent a pagination parameter this time
        expect(http.requestLog[0]?.params!["pg[cursor]"]).not.toBeDefined();
        // verify that we returned a collection and that it had a nextCursor defined
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.nextCursor).toBe("2");

        // Update response and get the next response
        userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = "3";
        userRes.data.meta.pg.prevCursor = "1";
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);
        nextable = await client.next<Auth.Api.User<UserRoles>>(nextable!);

        // verify the request parameters
        expect(http.requestLog[1]?.params!["pg[cursor]"]).toBe("2");
        expect(http.requestLog[1]?.params!["pg[size]"]).toBe(25);
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.nextCursor).toBe("3");
        expect(nextable?.response.meta?.pg?.prevCursor).toBe("1");

        // Update response and get the next response
        userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = null;
        userRes.data.meta.pg.prevCursor = "2";
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);
        nextable = await client.next<Auth.Api.User<UserRoles>>(nextable!);

        // verify the request parameters
        expect(http.requestLog[2]?.params!["pg[cursor]"]).toBe("3");
        expect(http.requestLog[2]?.params!["pg[size]"]).toBe(25);
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.nextCursor).toBe(null);
        expect(nextable?.response.meta?.pg?.prevCursor).toBe("2");
      });

      test("returns null when no more pages left", async () => {
        // Set the response
        let userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = null;
        userRes.data.meta.pg.prevCursor = null;
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);

        // make the request, then verify the request and response
        let nextable = await client.next<Auth.Api.User<UserRoles>>("/accounts/v1/users");
        // shouldn't have sent a pagination parameter this time
        expect(http.requestLog[0]?.params!["pg[cursor]"]).not.toBeDefined();
        // verify that we returned a collection and that it had a nextCursor defined
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.nextCursor).toBe(null);

        // Update response and get the next response
        nextable = await client.next<Auth.Api.User<UserRoles>>(nextable!);
        expect(nextable).toBe(null);
      });

      test.todo("preserves passed-in parameters across runs");
      test.todo("successfully merges next params into passed-in page params");
    });

    describe("prev", () => {
      // Set credentials before each test
      beforeEach(() => {
        (client as any).session = { ...creds };
      });

      test("response successfully chains", async () => {
        // Set the response
        let userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = "4";
        userRes.data.meta.pg.prevCursor = "2";
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);

        // make the request, then verify the request and response
        let nextable = await client.prev<Auth.Api.User<UserRoles>>("/accounts/v1/users");
        // shouldn't have sent a pagination parameter this time
        expect(http.requestLog[0]?.params!["pg[cursor]"]).not.toBeDefined();
        // verify that we returned a collection and that it had a nextCursor defined
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.prevCursor).toBe("2");

        // Update response and get the next response
        userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = "3";
        userRes.data.meta.pg.prevCursor = "1";
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);
        nextable = await client.prev<Auth.Api.User<UserRoles>>(nextable!);

        // verify the request parameters
        expect(http.requestLog[1]?.params!["pg[cursor]"]).toBe("2");
        expect(http.requestLog[1]?.params!["pg[size]"]).toBe(25);
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.nextCursor).toBe("3");
        expect(nextable?.response.meta?.pg?.prevCursor).toBe("1");

        // Update response and get the next response
        userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = "2";
        userRes.data.meta.pg.prevCursor = null;
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);
        nextable = await client.prev<Auth.Api.User<UserRoles>>(nextable!);

        // verify the request parameters
        expect(http.requestLog[2]?.params!["pg[cursor]"]).toBe("1");
        expect(http.requestLog[2]?.params!["pg[size]"]).toBe(25);
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.nextCursor).toBe("2");
        expect(nextable?.response.meta?.pg?.prevCursor).toBe(null);
      });

      test("returns null when no more pages left", async () => {
        // Set the response
        let userRes = UserCollRes();
        userRes.data.meta.pg.nextCursor = null;
        userRes.data.meta.pg.prevCursor = null;
        http.setNextResponse(`get https://example.com/accounts/v1/users`, userRes);

        // make the request, then verify the request and response
        let nextable = await client.prev<Auth.Api.User<UserRoles>>("/accounts/v1/users");
        // shouldn't have sent a pagination parameter this time
        expect(http.requestLog[0]?.params!["pg[cursor]"]).not.toBeDefined();
        // verify that we returned a collection and that it had a nextCursor defined
        expect(nextable?.response.t).toBe("collection");
        expect(nextable?.response.meta?.pg?.prevCursor).toBe(null);

        // Update response and get the next response
        nextable = await client.prev<Auth.Api.User<UserRoles>>(nextable!);
        expect(nextable).toBe(null);
      });

      test.todo("preserves passed-in parameters across runs");
      test.todo("successfully merges next params into passed-in page params");
    });

    describe("findIncluded", () => {
      const inc: Array<{ id: string; type: string }> = [
        {
          id: "aaaaa",
          type: "users",
        },
        {
          id: "bbbbb",
          type: "users",
        },
        {
          id: "ccccc",
          type: "users",
        },
        {
          id: "aaaaa",
          type: "pets",
        },
        {
          id: "ddddd",
          type: "pets",
        },
        {
          id: "eeeee",
          type: "pets",
        },
      ];

      test("can find included by id, type, or both", () => {
        // id
        const obj = client.findIncluded(inc, { id: "aaaaa" });
        expect(obj).toBeDefined();
        expect(obj!.id).toBe("aaaaa");
        expect(obj!.type).toBe("users");

        // type
        const arr = client.findIncluded(inc, { type: "users" });
        expect(arr).toBeDefined();
        expect(Array.isArray(arr)).toBe(true);
        expect(arr).toHaveLength(3);

        // type and id
        const obj2 = client.findIncluded(inc, { id: "aaaaa", type: "pets" });
        expect(obj2).toBeDefined();
        expect(obj2!.id).toBe("aaaaa");
        expect(obj2!.type).toBe("pets");
      });

      test("returns undefined when given undefined", () => {
        expect(client.findIncluded(undefined, { id: "aaaaa" })).not.toBeDefined();
      });
    });
  });
});
