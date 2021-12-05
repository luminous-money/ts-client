import { HttpError } from "@wymp/http-errors";
import {
  HttpMethods,
  SimpleHttpClientInterface,
  SimpleHttpClientRequestConfig,
  SimpleHttpClientResponseInterface,
  SimpleLoggerInterface,
} from "@wymp/ts-simple-interfaces";
import { Auth, Api } from "@wymp/types";
import { ErrorResult, LoginResult, NextableResponse, StorageApi } from "./Types";

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
    protected clientId: string,

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
   *
   *
   *
   *
   *
   * Session Management
   *
   *
   *
   *
   */

  /**
   * Create a user
   */
  public async createUser(
    name: string,
    email: string,
    password: string,
    passwordConf: string
  ): Promise<void> {
    // Log any existing session out
    await this.logout();

    // Now try to create the user
    const state = this.generateLoginStateParam();
    const res = await this.http.request<Api.Response>({
      method: "post",
      baseURL: this.baseUrl,
      url: "/accounts/v1/users",
      throwErrors: false,
      headers: {
        Authorization: this.authBasic,
        "Content-Type": "application/json",
      },
      data: {
        data: {
          type: "users",
          name,
          email,
          password,
          state,
          referrer: this.clientId,
        },
      },
    });

    // If we got an error, throw
    if (res.data.t === "error") {
      throw this.inflateError(res.data);
    }

    // Otherwise, we must have gotten a session. Store it and return success.
    this.storeSession(<Auth.Api.Authn.Session>res.data.data);
  }

  /**
   * Takes the user's email and password and attempts to obtain a session token with it. If there is
   * already an active session, removes the session (live and stored) and replaces it with the new
   * one.
   */
  public async login(email: string, password: string): Promise<LoginResult> {
    // Log any existing session out
    await this.logout();

    // Now try to log in
    const state = this.generateLoginStateParam();
    const res = await this.http.request<Api.Response>({
      method: "post",
      baseURL: this.baseUrl,
      url: "/accounts/v1/sessions/login/password",
      throwErrors: false,
      headers: {
        Authorization: this.authBasic,
        "Content-Type": "application/json",
      },
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
      if (res.status === 401) {
        this.log.warning(`Failed login. Response body: ${JSON.stringify(res.data)}`);
        return this.inflateError(res.data, "dressed");
      }
      throw this.inflateError(res.data);
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
    this.storeSession(data);
    return { status: "success" };
  }

  /**
   * Use a 32-character hex code (received from the `login` method) and a TOTP obtained from the
   * user to execute the 2fa step of the login process. This _should_ return an active session or
   * an error. The client will throw an error if some additional step is requested.
   *
   * Additionally, it should be noted that the 2fa flow is not well defined at the time of this
   * writing, because 2fa is not yet implemented in the standard auth gateway.
   */
  public async totp(stateCode: string, totp: string): Promise<LoginResult> {
    const res = await this.http.request<Api.Response>({
      method: "post",
      baseURL: this.baseUrl,
      url: "/accounts/v1/sessions/login/totp",
      throwErrors: false,
      headers: {
        Authorization: this.authBasic,
        "Content-Type": "application/json",
      },
      data: {
        data: {
          t: "totp-step",
          totp,
          state: stateCode,
        },
      },
    });

    // If we got an error....
    if (res.data.t === "error") {
      if (res.status === 401) {
        this.log.warning(`Failed totp step. Response body: ${JSON.stringify(res.data)}`);
        return this.inflateError(res.data, "dressed");
      }
      throw this.inflateError(res.data);
    }

    // Otherwise, if we got a step, we need to throw on that, too, since we don't know how to
    // handle it
    const data = <Auth.Api.Authn.Session | Auth.Api.Authn.StepResponse>res.data.data;
    if (data.t === "step") {
      throw new Error(
        `Error with Luminous API: Returned unexpected step '${data.step}' after 'totp' step, ` +
          `which we don't know how to handle.`
      );
    }

    // Otherwise, we must have gotten a session. Store it and return success.
    this.storeSession(data);
    return { status: "success" };
  }

  /** Log out of a currently logged in session (if exists) */
  public async logout(): Promise<void> {
    this.log.debug(`Logging out`);
    if (this.session) {
      // Clear creds from storage
      this.storage.removeItem(this.storageKey);

      // Do the logout
      this.log.debug(`Calling API for logout`);
      const res = await this.http.request<Api.Response>({
        method: "post",
        baseURL: this.baseUrl,
        url: "/accounts/v1/sessions/logout",
        throwErrors: false,
        headers: { Authorization: `${this.authBasic},Bearer ${this.session.token}` },
      });
      this.log.debug(`Got response from logout endpoint`);

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
  }

  /** Perform a throw-away call to validate the session, if there is one */
  public async loggedIn(): Promise<boolean> {
    if (!this.session) {
      return false;
    }

    const res = await this.call("get", "/accounts/v1/users/current");

    if (res.status < 300) {
      return true;
    } else if (res.status === 401) {
      return false;
    } else {
      throw this.inflateError(<Api.ErrorResponse>res.data);
    }
  }

  /**
   *
   *
   *
   *
   * Data methods
   *
   *
   *
   *
   */

  /** get an API result */
  public async get<T>(
    endpoint: string,
    params?: Api.Client.CollectionParams
  ): Promise<Exclude<Api.Response<T>, Api.ErrorResponse>> {
    const res = await this.call<T>("get", endpoint, {
      params: params ? this.condenseParams(params) : {},
    });
    const data = res.data;
    if (data.t === "error") {
      throw this.inflateError(data);
    } else {
      return data;
    }
  }

  /** post data to the API */
  public async post<T, I = T>(
    endpoint: string,
    data?: I
  ): Promise<Exclude<Api.Response<T>, Api.ErrorResponse>> {
    const res = await this.call<T>("post", endpoint, data && { data: { data } });
    const resData = res.data;
    if (resData.t === "error") {
      throw this.inflateError(resData);
    } else {
      if (resData.t === "collection" || resData.t === "null") {
        throw new Error(`Unexpected response type from API: '${resData.t}'. Expecting 'single'.`);
      }
      return resData;
    }
  }

  /** update data in the API */
  public async patch<T, I = T>(
    endpoint: string,
    data: Partial<I>
  ): Promise<Exclude<Api.Response<T>, Api.ErrorResponse>> {
    const res = await this.call<T>("patch", endpoint, { data: { data } });
    const resData = res.data;
    if (resData.t === "error") {
      throw this.inflateError(resData);
    } else {
      if (resData.t === "collection" || resData.t === "null") {
        throw new Error(`Unexpected response type from API: '${resData.t}'. Expecting 'single'.`);
      }
      return resData;
    }
  }

  /** delete data in the API */
  public async delete<T>(endpoint: string): Promise<Api.Response<T>> {
    const res = await this.call<T>("delete", endpoint);
    const resData = res.data;
    if (resData.t === "error") {
      throw this.inflateError(resData);
    } else {
      return resData;
    }
  }

  /**
   * This is just like the `get` method, except it is meant to be used for paginated collection
   * responses, and it allows you to pass in the response in order to get the next page of results
   * for the same parameters.
   *
   * Note that you can also use it to get an _initial_ page of responses, just like the `get` method.
   */
  public async next<T>(
    endpoint: string,
    params?: Api.Client.CollectionParams
  ): Promise<NextableResponse<T> | null>;
  public async next<T>(nextable: NextableResponse<T>): Promise<NextableResponse<T> | null>;
  public async next<T>(
    endpointOrNextable: string | NextableResponse<T>,
    _params?: Api.Client.CollectionParams
  ): Promise<NextableResponse<T> | null> {
    // Get the endpoint and params
    const endpoint =
      typeof endpointOrNextable === "string" ? endpointOrNextable : endpointOrNextable.endpoint;
    const params =
      (typeof endpointOrNextable === "string" ? _params : endpointOrNextable.params) || {};

    // If we passed a NextableResponse, then we need to adjust the parameters to get the next page
    if (typeof endpointOrNextable !== "string") {
      const nextable = endpointOrNextable;
      const cursor = nextable.response.meta.pg.nextCursor;

      // If there is no next cursor, just return null, since there are no additional pages
      if (!cursor) {
        return null;
      }

      // Otherwise, set the page parameters
      params.pg = {
        size: nextable.response.meta.pg.size,
        cursor,
      };

      // Add in sort, if applicable
      if (nextable.response.meta.pg.sort) {
        params.sort = nextable.response.meta.pg.sort;
      }
    }

    // Now make the call and return the result
    const res = await this.get<T>(endpoint, params);
    if (res.t !== "collection") {
      throw new Error(
        `The 'next' method is only meant to handle collection responses. The call 'GET ` +
          `${endpointOrNextable}' returned a '${res.t}' response.`
      );
    }
    return {
      endpoint,
      params,
      response: res,
    };
  }

  /**
   *
   *
   *
   *
   * Internal methods
   *
   *
   *
   *
   */

  /**
   * Use the current session to make the given HTTP call to the API and return to the result. This
   * method automatically tries to refresh the session if it receives a 401 for a given call. If
   * the call still fails, the error is thrown.
   */
  protected async call<T = unknown>(
    method: HttpMethods,
    endpoint: string,
    _req: SimpleHttpClientRequestConfig = {}
  ): Promise<SimpleHttpClientResponseInterface<Api.Response<T>>> {
    // Normalize any incoming authorization header and combine with existing auth info
    const incomingAuth = Object.entries(_req.headers || {}).find(
      e => e[0].toLowerCase() === "authorization"
    );
    if (incomingAuth && _req.headers) {
      delete _req.headers[incomingAuth[0]];
    }
    const authHeader =
      this.authBasic +
      (incomingAuth && `,${incomingAuth[1]}`) +
      (this.session && `,Bearer ${this.session.token}`);

    // Also normalize the content-type header
    const incomingContent = Object.entries(_req.headers || {}).find(
      e => e[0].toLowerCase() === "content-type"
    );
    if (incomingContent && _req.headers) {
      delete _req.headers[incomingContent[0]];
    }
    const contentHeader = (incomingContent && incomingContent[1]) || "application/json";

    // Create final config for request
    const req = {
      ..._req,
      method,
      baseURL: this.baseUrl,
      url: endpoint,
      headers: {
        ..._req.headers,
        Authorization: authHeader,
        "Content-Type": contentHeader,
      },
      throwErrors: false,
    };

    // Try the call
    const res = await this.http.request<Api.Response<T>>(req);

    // If we got a success response, or if we don't have an active session, or if the error is not a
    // 401, then return the response
    if (res.status < 300 || !this.session || res.status !== 401) {
      return res;
    }

    // Otherwise, try a refresh
    const refresh = await this.refresh();

    // If the refresh call didn't work, return the response
    if (refresh !== true) {
      return refresh;
    }

    // If the refresh call did work, then try the original call again with the new session and just
    // return whatever the response is
    req.headers.Authorization = authHeader.replace(/Bearer [^,]+/, `Bearer ${this.session.token}`);
    return await this.http.request<Api.Response<T>>(req);
  }

  /** Refresh an active session */
  protected async refresh(): Promise<SimpleHttpClientResponseInterface<Api.ErrorResponse> | true> {
    if (!this.session) {
      throw HttpError.withStatus(
        401,
        "You must log in and obtain a session before attempting to refresh a session",
        "LOG_IN"
      );
    }

    const res = await this.http.request<
      Api.SingleResponse<Auth.Api.Authn.Session> | Api.ErrorResponse
    >({
      method: "post",
      baseURL: this.baseUrl,
      url: "/accounts/v1/sessions/refresh",
      headers: {
        Authorization: this.authBasic,
        "Content-Type": "application/json",
      },
      data: {
        data: {
          t: "refresh",
          refreshToken: this.session.refresh,
        },
      },
      throwErrors: false,
    });

    // If no errors, store the session and return true
    if (res.data.t !== "error") {
      this.storeSession(res.data.data);
      return true;
    }

    // Otherwise, return the response
    return <SimpleHttpClientResponseInterface<Api.ErrorResponse>>res;
  }

  /** Store a new session */
  protected storeSession(data: Auth.Api.Authn.Session): void {
    this.session = data;
    this.storage.setItem(this.storageKey, JSON.stringify(this.session));
  }

  /** Accepts a string and returns the base64 representation of it */
  protected toBase64(str: string): string {
    if (Buffer as any) {
      return (Buffer as any).from(str, "utf8").toString("base64");
    } else {
      return (btoa as any)(str);
    }
  }

  /** Generates a 32-character hex string for use as a "state" parameter in the login flow */
  protected generateLoginStateParam() {
    return [...Array(32)].map(() => Math.floor(Math.random() * 16).toString(16)).join("");
  }

  /** Type-checks the credentials extracted from storage on instantiation */
  protected checkCreds(creds: any): creds is Auth.Api.Authn.Session {
    return (
      creds !== null &&
      typeof creds === "object" &&
      creds.t === "session" &&
      typeof creds.token === "string" &&
      typeof creds.refresh === "string"
    );
  }

  /** Inflate and optionally dress an error from an error HTTP response */
  protected inflateError(res: Api.ErrorResponse): HttpError;
  protected inflateError(res: Api.ErrorResponse, state: "raw"): HttpError;
  protected inflateError(res: Api.ErrorResponse, state: "dressed"): ErrorResult;
  protected inflateError(
    res: Api.ErrorResponse,
    state: "dressed" | "raw" = "raw"
  ): HttpError | ErrorResult {
    const error = HttpError.withStatus(
      res.error.status,
      res.error.detail,
      res.error.code || undefined,
      res.error.obstructions
    );

    return state === "raw" ? error : { status: "error", error };
  }

  /**
   * Condense a complex array of parameters into a flat set of key-value pairs. E.g:
   *
   * ```
   * const params = this.condenseParams({
   *   pg: {
   *     size: 5,
   *     cursor: "abcde==",
   *   }
   * })
   *
   * // params is equal to:
   * {
   *   "pg[size]": 5,
   *   "pg[cursor]": "abcde==",
   * }
   *
   */
  protected condenseParams(p: any): { [k: string]: string | number } {
    const params: { [k: string]: string | number } = {};

    // Create the function that will do the work
    const condense = (key: string, obj: any) => {
      if (obj) {
        if (typeof obj === "string" || typeof obj === "number") {
          params[key] = obj;
        } else if (typeof obj === "object") {
          for (const k in obj) {
            condense(`${key}[${k}]`, obj[k]);
          }
        }
      }
    };

    // Now kick us off
    for (const k in p) {
      condense(k, p[k]);
    }

    // And return the result
    return params;
  }
}
