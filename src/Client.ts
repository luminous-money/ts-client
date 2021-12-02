import { HttpError } from "@wymp/http-errors";
import { SimpleHttpClientInterface, SimpleLoggerInterface } from "@wymp/ts-simple-interfaces";
import { Auth, Api } from "@wymp/types";
import { LoginResult, StorageApi } from "./Types";

/**
 * This is a typescript client for interacting with the Luminous Money APIs. It is a somewhat bare-
 * bones client and only seeks to provide some additional support around user management, error
 * handling, logging, and other such things to make development against the Luminous REST APIs more
 * robust.
 */
export class Client {
  /** A session object from a successful authentication */
  protected session: Auth.Api.Authn.Session | null = null;

  /** Shorthand auth basic string for API calls */
  protected authBasic: string;

  public constructor(
    /** The client id to use for the connection */
    clientId: string,

    /** The secret to use for the connection. May be null if this is a front-end connection. */
    secret: string | null,

    /** The base URL for API interactions */
    protected baseUrl: string,

    /** The HTTP client to use for http calls */
    protected http: SimpleHttpClientInterface,

    /**
     * A storage object to use for storing credentials. This will usually be `window.localStorage`
     * or `window.sessionStorage` on the front-end, but could be anything.
     */
    protected storage: StorageApi,

    /** A logger to use for logging errors and other info */
    protected log: SimpleLoggerInterface,

    /**
     * An optional key to use for the storage key.
     */
    protected storageKey: string = "@luminous-money/client::credentials"
  ) {
    // On instantiation, see if there are credentials stored in storage and "inflate" them, if so
    const credString = this.storage.getItem(this.storageKey);
    if (credString) {
      const creds = JSON.parse(credString);
      if (!this.checkCreds(creds)) {
        this.log.warning(`Stored credentials are not formatted correctly: ${credString}`);
        this.storage.removeItem(this.storageKey);
      } else {
        this.session = creds;
      }
    }

    // Convert credentials into auth basic string
    this.authBasic = `Basic ${this.toBase64(`${clientId}:${secret || ""}`)}`;
  }

  /**
   * Takes the user's email and password and attempts to obtain a session token with it. If there is
   * already an active session, removes the session (live and stored) and replaces it with the new
   * one.
   */
  public async login(email: string, password: string): Promise<LoginResult> {
    // Check to see if there's an existing session and log out, if so
    await this.logout();

    // Now try to log in
    const state = this.generateLoginStateParam();
    const res = await this.http.request<Api.Response>({
      method: "post",
      baseURL: this.baseUrl,
      url: "/accounts/v1/sessions/login/password",
      throwErrors: false,
      headers: { Authorization: this.authBasic },
      data: {
        data: {
          t: "password-step",
          email,
          password,
          state,
        },
      },
    });

    // If we got an error....
    if (res.data.t === "error") {
      const error = HttpError.withStatus(
        res.status,
        res.data.error.detail,
        res.data.error.code || undefined,
        res.data.error.obstructions
      );

      // If it was an auth error, return an error status
      if (res.status === 401) {
        this.log.warning(`Failed login. Response body: ${JSON.stringify(res.data)}`);
        return {
          status: "error",
          error,
        };
      } else {
        // For any other sort of error, throw
        throw error;
      }
    }

    // Otherwise, if we got a step...
    const data = <Auth.Api.Authn.Session | Auth.Api.Authn.StepResponse>res.data.data;
    if (data.t === "step") {
      // Make sure it's one we know how to handle (if not, throw)
      if (data.step !== "totp") {
        throw new Error(
          `Error with Luminous API: Returned unexpected step '${data.step}', which we ` +
            `don't know how to handle.`
        );
      }

      // If it's TOTP, return the "2fa" status
      return {
        status: "2fa",
        code: data.state,
      };
    }

    // Otherwise, we must have gotten a session. Store it and return success.
    this.session = data;
    this.storage.setItem(this.storageKey, JSON.stringify(this.session));
    return { status: "success" };
  }

  /** Log out of a currently logged in session (if exists) */
  public async logout(): Promise<true> {
    if (this.session) {
      // Clear creds from storage
      this.storage.removeItem(this.storageKey);

      // Do the logout
      const res = await this.http.request<Api.Response>({
        method: "post",
        baseURL: this.baseUrl,
        url: "/accounts/v1/session/logout",
        throwErrors: false,
        headers: { Authorization: `${this.authBasic},Bearer ${this.session.token}` },
      });

      // Throw on errors
      if (res.data.t === "error") {
        throw new Error(
          `Error with Luminous API: Returned unexpected response on logout: ` +
            JSON.stringify(res.data)
        );
      }

      // Clear the credentials from memory
      this.session = null;

      // Log some info
      this.log.notice(`Logout successful`);
      this.log.debug(`Logout response string: ${JSON.stringify(res.data)}`);
    }

    return true;
  }

  /** Accepts a string and returns the base64 representation of it */
  protected toBase64(str: string): string {
    if (Buffer as any) {
      return (Buffer as any).fromString(str, "utf8").toString("base64");
    } else {
      return (btoa as any)(str);
    }
  }

  protected generateLoginStateParam() {
    return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  protected checkCreds(creds: any): creds is Auth.Api.Authn.Session {
    return (
      creds !== null &&
      typeof creds === "object" &&
      creds.t === "session" &&
      typeof creds.token === "string" &&
      typeof creds.refresh === "string"
    );
  }
}
